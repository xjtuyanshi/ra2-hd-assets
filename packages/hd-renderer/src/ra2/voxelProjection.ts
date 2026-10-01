import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  Texture,
  Vector2,
  Vector4,
} from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, type AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import {
  parseVoxelProjectionIndex,
  parseVoxelProjectionManifest,
  type ProjectionPartManifest,
  type ProjectionPartName,
  type VoxelProjectionManifest,
} from './voxelProjectionMath';

export interface VoxelProjectionPart {
  manifest: VoxelProjectionManifest;
  spec: ProjectionPartManifest;
  colour: Texture;
  paint: Texture;
  pivots: ShaderNode;
  rects: ShaderNode;
}

export interface VoxelProjectionAsset {
  manifest: VoxelProjectionManifest;
  parts: { body?: VoxelProjectionPart; turret?: VoxelProjectionPart };
}

/** Building bodies use sprites; their voxel projection manifests only require the turret atlas. */
export function manifestPartsFor(type: string): ProjectionPartName[] {
  return type.endsWith(':turret') ? ['turret'] : ['body'];
}

/** Frame tables are uniforms, so only the two colour and two paint atlas reads cost texture samples. */
export function createVoxelProjectionPart(
  manifest: VoxelProjectionManifest,
  name: ProjectionPartName,
  colour: Texture,
  paint: Texture,
): VoxelProjectionPart {
  const spec = manifest.parts[name];
  if (!spec) throw new Error(`Missing projection part: ${name}`);
  return {
    manifest,
    spec,
    colour,
    paint,
    pivots: uniformArray(
      spec.frames.map((f) => new Vector2(...f.pivot)),
      'vec2',
    ),
    rects: uniformArray(
      spec.frames.map((f) => new Vector4(...f.rect)),
      'vec4',
    ),
  };
}

/** Object light level of the XMP29U2 noon bakes (see VoxelProjectionState.levelRef). */
export const VOXEL_PROJECTION_LEVEL_REF = 1.7;
/** Default mip LOD bias magnitude for the projected redraw atlases (see VoxelProjectionState.sharpen). */
export const VOXEL_PROJECTION_SHARPEN = 0.5;

export class VoxelProjectionState {
  readonly relight = uniform(0);
  readonly blend = uniform(1);
  readonly strength = uniform(1);
  /** Linear-light gain and saturation of the redraw before the engine's light level (review/grading knobs). */
  readonly gain = uniform(1);
  readonly saturation = uniform(1);
  /**
   * Negative mip LOD bias (in levels) for the redraw atlases. The redraws are drawn about three times larger than the
   * game shows them, so trilinear filtering lands between mips and softens the invented detail; a half-level bias
   * keeps edges and highlights crisp at game scale without visible shimmer.
   */
  readonly sharpen = uniform(VOXEL_PROJECTION_SHARPEN);
  /** Mesh-normal form shading (0..1) and camera glint strength applied to the projected house paint only. */
  readonly paintShade = uniform(0.85);
  readonly paintSpec = uniform(0.5);
  /**
   * Form light for the whole redraw (not only house paint). The image-model redraws are lit almost evenly, so at game
   * scale a vehicle reads as a flat painting while the target look has dark lower hulls, bright top faces and glossy
   * edges. formShade multiplies the redraw by the smooth mesh's Lambert term against the current sun (normalised to 1
   * at n.l = 0.65), formAO applies the mesh's voxel occlusion (crevices, the hull under the turret), spec adds a
   * luminance-gated Blinn-Phong glint toward the iso camera, and contrast is a hue-preserving luminance power around
   * linear mid grey (full strength below it, about a third above it so light hulls do not clip). Defaults were
   * chosen by 1:1 game-scale comparison with the approved S2 target frames; formShade:0,formAO:0,spec:0,contrast:1
   * is the plain projection.
   */
  readonly formShade = uniform(0.85);
  readonly formAO = uniform(0.75);
  readonly spec = uniform(0.5);
  readonly contrast = uniform(1.35);
  /**
   * Light level the redraws were baked under. The bakes are screenshots of the engine look, so their colours already
   * carry the bake map's object light level; the projected colour is scaled by level / levelRef instead of level.
   * 1.7 matches the median brightness of the XMP29U2 noon bakes (measured in Chrome against the redraw frames).
   */
  readonly levelRef = uniform(VOXEL_PROJECTION_LEVEL_REF);
  readonly libraries = new Map<string, VoxelProjectionLibrary>();
}

const states = new WeakMap<AtmosphereNodes, VoxelProjectionState>();
export function voxelProjectionFor(nodes: AtmosphereNodes = DEFAULT_ATMOSPHERE_NODES): VoxelProjectionState {
  let state = states.get(nodes);
  if (!state) {
    state = new VoxelProjectionState();
    states.set(nodes, state);
  }
  return state;
}

/** No colour conversion or Y flip at upload: the shader decodes sRGB exactly like the engine LUT. */
async function loadAtlas(url: string, size: readonly number[], signal: AbortSignal): Promise<Texture> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
    imageOrientation: 'none',
  });
  if (signal.aborted || bitmap.width !== size[0] || bitmap.height !== size[1]) {
    bitmap.close();
    throw new Error(`${url}: cancelled or atlas dimensions differ from manifest`);
  }
  const texture = new Texture(bitmap);
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  // Retain the decoded bitmap for context reuploads until its texture's owner is destroyed.
  texture.addEventListener('dispose', () => bitmap.close());
  return texture;
}

/** Lazy, shared per-context assets. Failed/absent types settle once and preserve the caller's current material. */
export class VoxelProjectionLibrary {
  private readonly abort = new AbortController();
  private readonly warnings = new Set<string>();
  private readonly pending = new Map<string, Promise<VoxelProjectionAsset | null>>();
  private readonly loaded = new Map<string, VoxelProjectionAsset>();
  private readonly textures = new Set<Texture>();
  private disposed = false;
  private readonly index: Promise<Record<string, string> | null>;

  constructor(readonly base: string) {
    this.index = this.json(`${base}/index.json`)
      .then(parseVoxelProjectionIndex)
      .catch((error: unknown) => {
        this.warn('index', error);
        return null;
      });
  }

  private async json(url: string): Promise<unknown> {
    const response = await fetch(url, { signal: this.abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  private warn(key: string, error: unknown): void {
    if (this.disposed || this.warnings.has(key)) return;
    this.warnings.add(key);
    console.warn(`[HD] voxel projection ${this.base}/${key}: ${String(error)}; keeping the current look`);
  }

  get(type: string, required: readonly ProjectionPartName[] = ['body']): VoxelProjectionAsset | null {
    if (this.disposed) return null;
    const asset = this.loaded.get(type);
    if (!asset) return null;
    if (required.some((part) => !asset.parts[part])) {
      this.warn(type, 'incomplete part set');
      return null;
    }
    return asset;
  }

  async loadType(
    type: string,
    required: readonly ProjectionPartName[] = ['body'],
  ): Promise<VoxelProjectionAsset | null> {
    if (this.disposed) return null;
    let pending = this.pending.get(type);
    if (!pending) {
      pending = this.load(type);
      this.pending.set(type, pending);
    }
    await pending;
    return this.get(type, required);
  }

  private async load(type: string): Promise<VoxelProjectionAsset | null> {
    try {
      const index = await this.index;
      if (!index || this.disposed) return null;
      const file = Object.hasOwn(index, type) ? index[type] : undefined;
      if (!file) {
        this.warn(type, 'type is absent from index');
        return null;
      }
      const manifest = parseVoxelProjectionManifest(await this.json(`${this.base}/${file}`), manifestPartsFor(type));
      if (manifest.type !== type) throw new Error('manifest type mismatch');
      const directory = `${this.base}/${file.slice(0, file.lastIndexOf('/') + 1)}`;
      const names = Object.keys(manifest.parts) as ProjectionPartName[];
      // Wait for every in-flight texture, including failures, before publishing or cleaning up a partial load.
      const results = await Promise.allSettled(
        names.flatMap((name) => {
          const part = manifest.parts[name]!;
          return [
            loadAtlas(directory + part.colour, part.size, this.abort.signal),
            loadAtlas(directory + part.paint, part.size, this.abort.signal),
          ];
        }),
      );
      const textures = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure || this.disposed) {
        for (const texture of textures) texture.dispose();
        if (failure) throw failure.reason;
        return null;
      }
      const parts: VoxelProjectionAsset['parts'] = {};
      names.forEach((name, i) => {
        parts[name] = createVoxelProjectionPart(manifest, name, textures[i * 2]!, textures[i * 2 + 1]!);
      });
      for (const texture of textures) this.textures.add(texture);
      const asset = { manifest, parts };
      this.loaded.set(type, asset);
      return asset;
    } catch (error) {
      this.warn(type, error);
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const texture of this.textures) texture.dispose();
    this.textures.clear();
    this.loaded.clear();
    this.pending.clear();
  }
}

export function voxelProjectionLibrary(base: string, nodes: AtmosphereNodes): VoxelProjectionLibrary {
  const root = base.replace(/\/$/, '');
  const libraries = voxelProjectionFor(nodes).libraries;
  let library = libraries.get(root);
  if (!library) {
    library = nodes.own(new VoxelProjectionLibrary(root));
    libraries.set(root, library);
  }
  return library;
}

export function projectionParts(roles: readonly { role: 'body' | 'turret' | 'barrel' }[]): ProjectionPartName[] {
  return [...new Set(roles.map(({ role }) => (role === 'body' ? ('body' as const) : ('turret' as const))))];
}
