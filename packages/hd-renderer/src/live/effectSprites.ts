import {
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
  type Texture,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  float,
  floor,
  instancedBufferAttribute,
  max,
  min,
  mix,
  positionGeometry,
  pow,
  sRGBTransferEOTF,
  sRGBTransferOETF,
  screenUV,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';
import type { SpriteFrame } from '../../../ra2-assets/src/manifest';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import type { Ra2Cache } from '../ra2/cache';

/** How an effect frame is drawn. */
export type EffectDraw = 'card' | 'flat' | 'shadow';
/**
 * Draw pass, following the engine's layers: `ground` is depth-tested against units and buildings (and decals lie on
 * the terrain), `air` is drawn after every ground object like the engine's air layer, `top` over everything.
 */
export type EffectPass = 'ground' | 'air' | 'top';

export interface EffectInstance {
  /** World anchor: the engine draw point (the SHP canvas centre goes here). */
  anchor: Vector3;
  frame: SpriteFrame;
  /** Palette row key (house-remapped for AltPalette art). */
  palette: string;
  /** Opacity: 1, or the art's translucency at its stage (see animAlpha). */
  alpha: number;
  /** World units to pull a card towards the camera (see cardPush). */
  push: number;
  draw: EffectDraw;
  pass: EffectPass;
  /** Painter order inside a pass (engine screen y; larger draws later). */
  depth: number;
  /** Fire-coloured pixels may glow slightly (anim palette art). */
  glow: boolean;
}

/** Fire-coloured pixels (hue 15..65 degrees, value > 0.7) are brightened by this, just over the bloom threshold. */
export const FX_GLOW = 1.25;
const CAPACITY = 4096;
/** Quads are one texel larger on every side, so the filtered edge can fade out instead of being cut. */
const MARGIN = 1;
const RENDER_ORDER: Record<EffectPass, number> = { ground: 6, air: 7, top: 8 };

/**
 * The engine's own anim art (explosions, muzzle flashes, smoke, corpses, debris) as camera-facing cards or ground
 * decals, one instanced mesh per atlas page and pass. Same placement maths as ra2/sprites.ts (a card of w x h pixels
 * covers exactly the pixels the engine draws), with its own material:
 *   - edges: the indexed mask is filtered bilinearly (four taps, confined to the frame) and sharpened with
 *     smoothstep(0.35, 0.65), and the colour is the coverage-weighted mean of the opaque taps, so magnified art has
 *     smooth, fringe-free edges instead of 1x stair steps;
 *   - opacity from the anim's translucency, mixed in display space like the engine's 50/25/75 % mix of 16-bit
 *     colours (see colorNode);
 *   - colour lit by the scene light like other original art, fire-coloured pixels self-lit and FX_GLOW brighter.
 */
export class EffectSpriteLayer {
  readonly root = new Group();
  readonly light = uniform(new Color(1, 1, 1));
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  /**
   * The scene drawn so far, for the display-space mix of translucent cards. One node shared by every page mesh: three
   * copies the framebuffer once per render for each distinct node (NodeUpdateType.RENDER, keyed by the node), and each
   * copy ends and restarts the scene pass (costly under MSAA). With one node the copy happens once, before the first
   * translucent card; later meshes mix against that copy, so a translucent card over another card or over HD garnish
   * drawn after it blends linearly with those, a small difference. Meshes with only opaque cards use a material without
   * it, and empty meshes are hidden, so a frame without translucent cards copies nothing.
   */
  readonly backdrop: ShaderNode = viewportSharedTexture(screenUV);
  private readonly meshes = new Map<string, PageMesh>();
  /** Pages that failed to load and were already reported (their instances are skipped, not retried per frame). */
  private readonly failedPages = new Set<number>();

  constructor(
    private readonly cache: Ra2Cache,
    /**
     * Atlas page textures: the page, 'loading' while it loads, or null when it failed or does not exist (settled: its
     * instances are skipped until the source reports it again).
     */
    private readonly pageSource: (page: number) => EffectPage | 'loading' | null,
    /** Called with pages no mesh has drawn for MESH_IDLE_SECONDS, so their textures can be released. */
    private readonly releasePage: (page: number) => void = () => {},
  ) {
    this.root.name = 'live-effect-sprites';
  }

  /**
   * Replace every instance; instances whose page is still loading are skipped. Returns false when some were skipped
   * for a page that is still loading, so the caller sets them again on a later frame; pages that failed are settled
   * (skipped, warned about once). `now` (seconds) ages idle meshes: a mesh left empty for MESH_IDLE_SECONDS is
   * disposed, and its page released when no other mesh uses it.
   */
  setInstances(instances: readonly EffectInstance[], now = performance.now() / 1000): boolean {
    const groups = new Map<string, EffectInstance[]>();
    for (const instance of instances) {
      const page = instance.frame.page ?? 0;
      const key = `${page}:${instance.pass}`;
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(instance);
    }
    let complete = true;
    for (const [key, list] of groups) {
      const mesh = this.mesh(key);
      if (mesh === 'loading') complete = false;
      else if (mesh) mesh.set(list, this.cache, now);
    }
    const idle: string[] = [];
    for (const [key, mesh] of this.meshes) {
      if (groups.has(key)) continue;
      mesh.set([], this.cache, now);
      if (now - mesh.lastUsed > MESH_IDLE_SECONDS) idle.push(key);
    }
    if (idle.length) this.evict(idle);
    return complete;
  }

  /** Instances currently drawn (for diagnostics). */
  get count(): number {
    let n = 0;
    for (const mesh of this.meshes.values()) n += mesh.mesh.count;
    return n;
  }

  /** Page meshes alive, and how many of them hold translucent cards now (diagnostics, perf checks). */
  meshStats(): { meshes: number; visible: number; translucent: number } {
    let visible = 0;
    let translucent = 0;
    for (const mesh of this.meshes.values()) {
      if (mesh.mesh.visible) visible++;
      if (mesh.mesh.visible && mesh.translucent) translucent++;
    }
    return { meshes: this.meshes.size, visible, translucent };
  }

  private mesh(key: string): PageMesh | 'loading' | null {
    const known = this.meshes.get(key);
    if (known) return known;
    const [pageText, pass] = key.split(':') as [string, EffectPass];
    const page = Number(pageText);
    const atlas = this.pageSource(page);
    if (atlas === 'loading') return 'loading';
    if (!atlas) {
      if (!this.failedPages.has(page)) {
        this.failedPages.add(page);
        console.warn(`[HD] effect atlas page ${page} could not be loaded: its effects are not drawn`);
      }
      return null;
    }
    this.failedPages.delete(page);
    const mesh = new PageMesh(this, this.cache, atlas, pass);
    this.meshes.set(key, mesh);
    this.root.add(mesh.mesh);
    return mesh;
  }

  /** Dispose idle meshes; release pages that no remaining mesh draws from. */
  private evict(keys: readonly string[]): void {
    const pages = new Set<number>();
    for (const key of keys) {
      const mesh = this.meshes.get(key)!;
      this.meshes.delete(key);
      this.root.remove(mesh.mesh);
      mesh.dispose();
      pages.add(Number(key.split(':')[0]));
    }
    for (const key of this.meshes.keys()) pages.delete(Number(key.split(':')[0]));
    for (const page of pages) this.releasePage(page);
  }
}

/** An atlas page as the layer draws it. */
export interface EffectPage {
  texture: Texture;
  width: number;
  height: number;
}

/** Seconds a page mesh may stay empty before it is disposed (and its page released when nothing else uses it). */
export const MESH_IDLE_SECONDS = 90;

class PageMesh {
  readonly mesh: InstancedMesh;
  /** Whether the current instances include translucent cards (the mesh then uses the display-space mix). */
  translucent = false;
  /** Seconds (setInstances clock) the mesh last drew anything; set on its first instances. */
  lastUsed = -Infinity;
  private readonly anchor: InstancedBufferAttribute;
  private readonly rect: InstancedBufferAttribute;
  private readonly params: InstancedBufferAttribute;
  private readonly style: InstancedBufferAttribute;
  private readonly opaqueMaterial: MeshBasicNodeMaterial;
  /** Built on the first translucent card (pages of opaque art never compile it). */
  private translucentMaterial: MeshBasicNodeMaterial | null = null;

  constructor(
    private readonly layer: EffectSpriteLayer,
    private readonly cache: Ra2Cache,
    private readonly atlas: EffectPage,
    private readonly pass: EffectPass,
  ) {
    this.anchor = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.rect = new InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    // x, y = frame offset from the canvas centre (px); z = palette row; w = push.
    this.params = new InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    // x = opacity; y = 0 card, 1 decal, 2 shadow decal; z = glow allowed.
    this.style = new InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    this.opaqueMaterial = this.buildMaterial(false);
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), this.opaqueMaterial, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER[pass];
    this.mesh.name = `live-effects-${pass}`;
    this.mesh.count = 0;
    // Hidden while empty: a hidden mesh runs no node updates (a visible one with count 0 still would).
    this.mesh.visible = false;
  }

  /**
   * The card material. `translucent` mixes cards with alpha < 1 into the scene below in display space (the engine's
   * 16-bit colour mix) and needs the layer's backdrop copy; the opaque variant draws the same art without it.
   */
  private buildMaterial(translucent: boolean): MeshBasicNodeMaterial {
    const { layer, cache, atlas } = this;
    const aAnchor: ShaderNode = instancedBufferAttribute(this.anchor, 'vec3');
    const aRect: ShaderNode = instancedBufferAttribute(this.rect, 'vec4');
    const aParams: ShaderNode = instancedBufferAttribute(this.params, 'vec4');
    const aStyle: ShaderNode = instancedBufferAttribute(this.style, 'vec4');
    const atlasSize = vec2(atlas.width, atlas.height);
    const paletteRows = float(cache.paletteAtlas.image.height);
    const ppu = float(PIXELS_PER_CELL_EDGE);
    const margin = float(MARGIN);

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = this.pass === 'ground';
    material.blending = NormalBlending;
    const u: ShaderNode = uv().x;
    const v: ShaderNode = float(1).sub(uv().y);
    const gu: ShaderNode = positionGeometry.x.add(0.5);
    const gv: ShaderNode = float(0.5).sub(positionGeometry.y);
    material.positionNode = Fn(() => {
      const px = aParams.x.sub(margin).add(gu.mul(aRect.z.add(margin.mul(2))));
      const py = aParams.y.sub(margin).add(gv.mul(aRect.w.add(margin.mul(2))));
      const card = aAnchor
        .add(layer.cameraRight.mul(px.div(ppu)))
        .sub(layer.cameraUp.mul(py.div(ppu)))
        .add(layer.toCamera.mul(aParams.w));
      // Ground decal: invert the engine projection at the anchor's height (see ra2/sprites.ts).
      const decal = aAnchor.add(vec3(px.div(60).add(py.div(30)), 0.025, py.div(30).sub(px.div(60))));
      return aStyle.y.greaterThan(0.5).select(decal, card);
    })();
    material.colorNode = Fn(() => {
      // Continuous atlas texel coordinate of this fragment, then the four texel centres around it.
      const tx = aRect.x.sub(margin).add(u.mul(aRect.z.add(margin.mul(2))));
      const ty = aRect.y.sub(margin).add(v.mul(aRect.w.add(margin.mul(2))));
      const p = vec2(tx, ty).sub(0.5);
      const i0 = floor(p);
      const f = p.sub(i0);
      const tap = (dx: number, dy: number) => {
        const at = i0.add(vec2(dx, dy));
        const index: ShaderNode = floor(texture(atlas.texture, at.add(0.5).div(atlasSize)).r.mul(255).add(0.5));
        // Taps outside the frame (padding, neighbouring frames) never count.
        const inside = at.x
          .greaterThanEqual(aRect.x)
          .and(at.y.greaterThanEqual(aRect.y))
          .and(at.x.lessThan(aRect.x.add(aRect.z)))
          .and(at.y.lessThan(aRect.y.add(aRect.w)));
        const opaque: ShaderNode = inside.and(index.greaterThan(0.5)).select(float(1), float(0));
        const colour: ShaderNode = texture(
          cache.paletteAtlas,
          vec2(index.add(0.5).div(256), aParams.z.add(0.5).div(paletteRows)),
        ).rgb;
        return { opaque, colour };
      };
      const t00 = tap(0, 0);
      const t10 = tap(1, 0);
      const t01 = tap(0, 1);
      const t11 = tap(1, 1);
      const w00 = float(1).sub(f.x).mul(float(1).sub(f.y)).mul(t00.opaque);
      const w10 = f.x.mul(float(1).sub(f.y)).mul(t10.opaque);
      const w01 = float(1).sub(f.x).mul(f.y).mul(t01.opaque);
      const w11 = f.x.mul(f.y).mul(t11.opaque);
      const coverage: ShaderNode = w00.add(w10).add(w01).add(w11);
      const mask: ShaderNode = smoothstep(0.35, 0.65, coverage);
      const art: ShaderNode = t00.colour
        .mul(w00)
        .add(t10.colour.mul(w10))
        .add(t01.colour.mul(w01))
        .add(t11.colour.mul(w11))
        .div(max(coverage, 1e-4));
      // Fire: warm hue (15..65 degrees) and bright, judged on the display-referred palette colour.
      const s: ShaderNode = pow(art.max(0), vec3(1 / 2.2));
      const hi: ShaderNode = max(s.r, max(s.g, s.b));
      const lo: ShaderNode = min(s.r, min(s.g, s.b));
      const warm: ShaderNode = s.r
        .greaterThanEqual(hi)
        .and(s.g.sub(lo).greaterThanEqual(s.r.sub(lo).mul(0.25)))
        .and(hi.greaterThan(0.7))
        .and(hi.sub(lo).greaterThan(hi.mul(0.2)));
      const fire: ShaderNode = warm.and(aStyle.z.greaterThan(0.5)).select(float(1), float(0));
      const lit: ShaderNode = art.mul(mix(layer.light, vec3(FX_GLOW), fire));
      const isShadow = aStyle.y.greaterThan(1.5);
      const shadow = vec4(0, 0, 0, mask.mul(0.5).mul(aStyle.x));
      const a: ShaderNode = mask.mul(aStyle.x);
      if (!translucent) return isShadow.select(shadow, vec4(lit, a));
      // The engine's translucent draw mixes 16-bit DISPLAY colours (e.g. 50 % of the art, 50 % of what is below), so
      // do the mix in display (sRGB-encoded) space against the scene drawn so far: a linear mix is brighter and lifts
      // the dark channel, turning an orange edge over grey pavement salmon-pink. Normal blending then adds
      // a * C + (1 - a) * dst, with C chosen so the result over that background is exactly the display-space mix. The
      // exposure is a per-channel scale, which a power-law transfer function carries through the mix unchanged, so
      // the unexposed scene values can be mixed directly.
      const below: ShaderNode = layer.backdrop.rgb.max(0);
      const belowDisplay: ShaderNode = sRGBTransferOETF(below);
      const artDisplay: ShaderNode = sRGBTransferOETF(lit.max(0));
      const mixed: ShaderNode = sRGBTransferEOTF(mix(belowDisplay, artDisplay, a));
      const colour: ShaderNode = mixed.sub(below.mul(float(1).sub(a))).div(max(a, 1e-4));
      return isShadow.select(shadow, vec4(colour, a));
    })();
    return material;
  }

  set(instances: readonly EffectInstance[], cache: Ra2Cache, now: number): void {
    if (instances.length) this.lastUsed = now;
    // An idle mesh that stays idle uploads nothing.
    if (instances.length === 0 && this.mesh.count === 0) return;
    // Decals first, then shadows, then cards; each in the engine's painter order (screen y).
    const rank = (s: EffectInstance) => (s.draw === 'flat' ? 0 : s.draw === 'shadow' ? 1 : 2);
    const ordered = [...instances].sort((a, b) => rank(a) - rank(b) || a.depth - b.depth).slice(0, CAPACITY);
    let translucent = false;
    ordered.forEach((s, i) => {
      this.anchor.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
      this.rect.setXYZW(i, s.frame.rect[0], s.frame.rect[1], s.frame.rect[2], s.frame.rect[3]);
      this.params.setXYZW(i, s.frame.offset[0], s.frame.offset[1], cache.paletteRow.get(s.palette) ?? 0, s.push);
      this.style.setXYZW(i, s.alpha, s.draw === 'shadow' ? 2 : s.draw === 'flat' ? 1 : 0, s.glow ? 1 : 0, 0);
      if (s.alpha < 1 && s.draw !== 'shadow') translucent = true;
    });
    // Only the live range is uploaded (instances past `count` are never drawn).
    for (const attribute of [this.anchor, this.rect, this.params, this.style]) {
      attribute.clearUpdateRanges();
      if (ordered.length) {
        attribute.addUpdateRange(0, ordered.length * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
    this.translucent = translucent;
    if (translucent) this.translucentMaterial ??= this.buildMaterial(true);
    this.mesh.material = translucent ? this.translucentMaterial! : this.opaqueMaterial;
    this.mesh.count = ordered.length;
    this.mesh.visible = ordered.length > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.opaqueMaterial.dispose();
    this.translucentMaterial?.dispose();
    this.mesh.dispose();
  }
}

const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;

/**
 * World anchor of an engine draw point: a lepton coordinate projected like the engine (sx = (x - y) * 30 / 256,
 * sy = (x + y) * 15 / 256 - z * 15 / 104), shifted by a screen offset in pixels, and lifted back to the point's own
 * height, so a camera-facing card there covers the pixels the engine draws.
 */
export function engineAnchor(
  x: number,
  y: number,
  z: number,
  offset: readonly [number, number] = [0, 0],
  out = new Vector3(),
): Vector3 {
  const level = z / LEPTONS_PER_LEVEL;
  const sx = ((x - y) * 30) / LEPTONS_PER_CELL + offset[0];
  const sy = ((x + y) * 15) / LEPTONS_PER_CELL - level * 15 + offset[1];
  // screenToCell (ra2/cache.ts) at the same level.
  const diff = sx / 30;
  const sum = (sy + level * 15) / 15;
  return out.set((sum + diff) / 2, level * LEVEL_HEIGHT, (sum - diff) / 2);
}

/** Engine screen y of a lepton coordinate: the painter order key (larger is drawn later). */
export function engineDepth(x: number, y: number, z: number): number {
  return ((x + y) * 15) / LEPTONS_PER_CELL - (z / LEPTONS_PER_LEVEL) * 15;
}

/**
 * Opacity of an anim from its art flags (the engine's translucent draw modes) at stage `stage` of an iteration of
 * `end` stages (AnimTypeClass::End). Translucent=yes art fades in steps as it plays, checked before Translucency=:
 * gamemd 1.001's AnimClass draw (0x42308d..0x4230fb) compares the anim's stage (AnimClass+0xAC) with End (type+0x2C0)
 * times 0.6, 0.4 and 0.2 (doubles at 0x7e3558, 0x7e3550, 0x7e3548) and above them draws at 25, 50 and 75 % opacity
 * (blitter flags 6, 4, 2); up to 0.2 x End it is opaque, so an explosion's bright early frames are drawn solid.
 * Translucency=25/50/75 is a constant 75/50/25 % opacity.
 */
export function animAlpha(art: { translucent?: boolean; translucency?: number }, stage = 0, end = 1): number {
  if (art.translucent) {
    if (stage > end * 0.6) return 0.25;
    if (stage > end * 0.4) return 0.5;
    if (stage > end * 0.2) return 0.75;
    return 1;
  }
  if (art.translucency === 25) return 0.75;
  if (art.translucency === 50) return 0.5;
  if (art.translucency === 75) return 0.25;
  return 1;
}
