import {
  Color,
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
  clamp,
  exp,
  float,
  floor,
  instancedBufferAttribute,
  max,
  mix,
  positionGeometry,
  pow,
  luminance,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { LightingClass, MapObject, SpriteFrame } from '../../../ra2-assets/src/manifest';
import { moonlit, objectLight, referenceLevel, windowGain } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import { ra2Screen, screenToCell, type Ra2Cache } from './cache';
import { objectLevelAt, srgbScale, terrainGradeAt } from './mapLighting';
import { ENGINE_SHADOW_OPACITY } from './voxelShadow';

export interface SpriteInstance {
  /** World-space anchor: the engine's draw point for this object (canvas centre goes here). */
  anchor: Vector3;
  frame: SpriteFrame;
  /** Palette row key; remappable art uses its house row (see paletteFor). */
  palette: string;
  /** World units to pull the card towards the camera so terrain around the base never cuts it (see cardPush). */
  push: number;
  shadow: boolean;
  /** Lay the art on the ground as a decal (ore, smudges, flat overlays) instead of a camera-facing card. */
  flat?: boolean;
  /**
   * Extra object light on top of the map's (default 1), applied to the palette colour in its own (sRGB) scale and
   * clamped at white, like the engine's palette lighting.
   */
  light?: number;
  /**
   * How the map's [Lighting] applies (see mapLighting.ts): 'ambient' (default) = level only, for buildings, units,
   * infantry and aircraft; 'full' = level and per-channel colour, for terrain-class art (overlays, smudges, trees);
   * 'none' = unlit (ore, gems).
   */
  lighting?: LightingClass;
}

const LIGHTING_CODE: Record<LightingClass, number> = { ambient: 0, full: 1, none: 2 };

/** Darkening of SHP shadows: the engine halves the displayed colour under them (see ENGINE_SHADOW_OPACITY). */
const SHADOW_OPACITY = ENGINE_SHADOW_OPACITY;

/**
 * Push that makes a camera-facing card draw over its own footprint, as the engine's painter order does. A pixel d world
 * units below the anchor on screen sees ground d * cot(30°) nearer to the camera than the anchor, so the card must come
 * forward at least that far for its lowest pixel.
 */
export function cardPush(frame: SpriteFrame): number {
  const below = Math.max(0, frame.offset[1] + frame.rect[3]) / PIXELS_PER_CELL_EDGE;
  return below * Math.sqrt(3) + 0.03;
}

/**
 * Original SHP art as camera-facing cards. With the fixed orthographic camera a card of w x h pixels / PPU world units
 * covers exactly the pixels the engine would draw, so placement matches the original frame for frame. Colour comes
 * from the palette atlas at draw time (index 0 transparent, 16-31 house-remapped), which is also where HD
 * replacements will later plug in.
 */
export class SpriteLayer {
  readonly mesh: InstancedMesh;
  /** Scene light level applied to unlit sprites (1 = the original's full-bright daylight). */
  readonly light = uniform(new Color(1, 1, 1));
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  readonly capacity: number;
  private readonly anchor: InstancedBufferAttribute;
  private readonly rect: InstancedBufferAttribute;
  private readonly params: InstancedBufferAttribute;
  /**
   * x: 0 = upright card, 1 = ground decal, 2 = shadow decal; y: object light; z: map lighting class (LIGHTING_CODE).
   * One buffer: WebGPU allows 8 vertex buffers.
   */
  private readonly flags: InstancedBufferAttribute;

  /** `capacity` > instances.length reserves room for setInstances (live objects). */
  constructor(
    private readonly cache: Ra2Cache,
    instances: SpriteInstance[],
    capacity = instances.length,
    /** Indexed atlas to read frames from (a type-library page); defaults to the map cache's sprite atlas. */
    atlas: { texture: Texture; width: number; height: number } = {
      texture: cache.spriteAtlas,
      width: cache.manifest.spriteAtlas.width,
      height: cache.manifest.spriteAtlas.height,
    },
    /**
     * Optional 2x HD version of the same atlas (same layout, normalized UVs unchanged): full-colour art with house-paint
     * pixels written as a grey ramp, plus a mask of those pixels (see packages/ra2-assets spriteHd). Shadows keep using
     * the indexed atlas.
     */
    hd: { color: Texture; remap: Texture } | null = null,
    /**
     * Lit-window mask over the same atlas (R = lit, G = variant; ra2-assets windows.ts), same normalized UVs as the
     * indexed and HD atlases. Null: no windows.
     */
    windows: Texture | null = null,
  ) {
    this.capacity = Math.max(1, capacity, instances.length);
    const count = this.capacity;
    this.anchor = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.rect = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.params = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.flags = new InstancedBufferAttribute(new Float32Array(count * 3), 3);

    const atlasSize = vec2(atlas.width, atlas.height);
    const paletteRows = float(cache.paletteAtlas.image.height);
    const aAnchor: ShaderNode = instancedBufferAttribute(this.anchor, 'vec3');
    const aRect: ShaderNode = instancedBufferAttribute(this.rect, 'vec4');
    const aParams: ShaderNode = instancedBufferAttribute(this.params, 'vec4');
    const aFlags: ShaderNode = instancedBufferAttribute(this.flags, 'vec3');
    const aFlat: ShaderNode = aFlags.x;
    // The map's light for this instance's class, times its own extra light, in the palette's sRGB scale (see
    // mapLighting.ts): 'ambient' takes the level, 'full' the per-channel grade, 'none' nothing.
    const isFull: ShaderNode = step(0.5, aFlags.z).mul(float(1).sub(step(1.5, aFlags.z)));
    const isNone: ShaderNode = step(1.5, aFlags.z);
    const grade: ShaderNode = mix(
      mix(vec3(objectLevelAt(cache.mapLight, aAnchor.xz)), terrainGradeAt(cache.mapLight, aAnchor.xz), isFull),
      vec3(1),
      isNone,
    ).mul(aFlags.y);
    const objectLit = (c: ShaderNode): ShaderNode => srgbScale(c, grade);
    const ppu = float(PIXELS_PER_CELL_EDGE);

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = NormalBlending;
    // Edges are soft (filtered coverage, see colorNode) and blend; only fully clear fragments are discarded. No
    // alpha-to-coverage: under MSAA it turns the translucent shadows opaque.
    material.alphaTest = 0.04;
    // Raster-relative coordinates from the quad's own UVs (u right, v down). positionLocal cannot be used here: once
    // positionNode is set it refers to the displaced position in the fragment stage.
    const u: ShaderNode = uv().x;
    const v: ShaderNode = float(1).sub(uv().y);
    const pushAmount: ShaderNode = aParams.w;
    // Vertex stage: corners from the untouched geometry attribute (+-0.5).
    const gu: ShaderNode = positionGeometry.x.add(0.5);
    const gv: ShaderNode = float(0.5).sub(positionGeometry.y);
    material.positionNode = Fn(() => {
      const px = aParams.x.add(gu.mul(aRect.z));
      const py = aParams.y.add(gv.mul(aRect.w));
      const card = aAnchor
        .add(this.cameraRight.mul(px.div(ppu)))
        .sub(this.cameraUp.mul(py.div(ppu)))
        .add(this.toCamera.mul(pushAmount));
      // Ground decal: invert the engine projection at the anchor's height (1 px right = (1/60, -1/60) cells,
      // 1 px down = (1/30, 1/30) cells), so the art covers exactly the same screen pixels while lying on the ground.
      const decal = aAnchor.add(vec3(px.div(60).add(py.div(30)), 0.02, py.div(30).sub(px.div(60))));
      return aFlat.greaterThan(0.5).select(decal, card);
    })();
    material.colorNode = Fn(() => {
      const texel = vec2(aRect.x.add(u.mul(aRect.z)), aRect.y.add(v.mul(aRect.w)));
      const atlasUv = texel.div(atlasSize);
      const paletteColour = (i: ShaderNode): ShaderNode =>
        texture(cache.paletteAtlas, vec2(i.add(0.5).div(256), aParams.z.add(0.5).div(paletteRows))).rgb;
      const isShadow: ShaderNode = step(1.5, aFlat);

      // Coverage of the 1x indexed mask, filtered with a quadratic B-spline (the average of four bilinear taps half a
      // texel apart) over the 3x3 texels around this point, texels outside the frame's rect counting as empty. Its
      // edges run as straight lines at any zoom instead of magnified stair steps. `index` is the texel under this
      // point; `fill` the index of the strongest opaque neighbour, used just outside the art (concave corners) so the
      // soft edge never shows palette entry 0. Everything is accumulated in variables and blended arithmetically, so
      // the shared taps are computed once, in order.
      const k0: ShaderNode = floor(texel).toVar();
      const t0: ShaderNode = texel.sub(k0).sub(0.5).toVar();
      const weights = (o: number): ShaderNode =>
        o === 0
          ? float(0.75).sub(t0.mul(t0))
          : o < 0
            ? float(0.5).sub(t0).mul(float(0.5).sub(t0)).mul(0.5)
            : float(0.5).add(t0).mul(float(0.5).add(t0)).mul(0.5);
      const lo: ShaderNode = aRect.xy;
      const hi: ShaderNode = aRect.xy.add(aRect.zw);
      const coverage: ShaderNode = float(0).toVar();
      const index: ShaderNode = float(0).toVar();
      const fill: ShaderNode = float(0).toVar();
      const fillWeight: ShaderNode = float(0).toVar();
      for (const oy of [-1, 0, 1]) {
        for (const ox of [-1, 0, 1]) {
          const k: ShaderNode = k0.add(vec2(ox, oy));
          const inside: ShaderNode = step(lo, k).mul(float(1).sub(step(hi, k)));
          const i: ShaderNode = floor(texture(atlas.texture, k.add(0.5).div(atlasSize)).r.mul(255).add(0.5)).toVar();
          const occupied: ShaderNode = step(0.5, i).mul(inside.x).mul(inside.y).toVar();
          const w: ShaderNode = weights(ox).x.mul(weights(oy).y).mul(occupied).toVar();
          coverage.addAssign(w);
          if (ox === 0 && oy === 0) {
            index.assign(i.mul(occupied));
          } else {
            const stronger: ShaderNode = step(fillWeight.add(1e-6), w);
            fill.assign(mix(fill, i, stronger));
            fillWeight.assign(max(fillWeight, w));
          }
        }
      }
      // Shadows take the filtered coverage itself: solid shadow art stays solid with a soft edge, and the stippled
      // shadows of trees and bushes become an even half shadow (their average at 1x) instead of blotches.
      const shadow: ShaderNode = vec4(0, 0, 0, clamp(coverage, 0, 1).mul(SHADOW_OPACITY));
      const edge: ShaderNode = smoothstep(0.35, 0.65, coverage);
      // Local light at the ground point under this pixel (decals: the pixel itself; upright art: straight below it on
      // screen, down to the anchor's ground line), fading with the pixel's height above that ground.
      const px = aParams.x.add(u.mul(aRect.z));
      const py = aParams.y.add(v.mul(aRect.w));
      const flat = aFlat.greaterThan(0.5);
      const down = select(flat, py, max(py, 0));
      const ground = aAnchor.xz.add(vec2(px.div(60).add(down.div(30)), down.div(30).sub(px.div(60))));
      const height = select(flat, float(0), max(py.negate(), 0).div(ppu));
      const local: ShaderNode = objectLight(ground)
        .div(referenceLevel)
        .mul(exp(height.mul(-0.45)));
      // The map's light, then the scene light on the night-desaturated colour (house paint keeps its colour) and local
      // lights on the full colour.
      const shade = (c: ShaderNode, paint: ShaderNode): ShaderNode => {
        const lit: ShaderNode = objectLit(c);
        return mix(moonlit(lit), lit, paint).mul(this.light).add(lit.mul(local));
      };
      // Lit windows at night: warm amber panes (85 %) or a dimmer cool white (15 %) by the window's variant, each pane
      // with its own brightness; variants above 0.85 stay dark. Kept below the tone mapper's shoulder so panes stay
      // amber instead of washing out to white.
      let glow: ShaderNode = vec3(0, 0, 0);
      if (windows) {
        const mask: ShaderNode = texture(windows, atlasUv);
        const variant = mask.g.div(0.85);
        const brightness = float(0.9).add(variant.mul(7.3).fract().mul(0.4));
        const tint = mix(vec3(1.0, 0.64, 0.27), vec3(0.62, 0.68, 0.8), step(0.85, variant));
        const upright = select(flat, float(0), float(1));
        glow = tint.mul(brightness).mul(mask.r).mul(step(mask.g, 0.85)).mul(windowGain).mul(upright);
      }
      let art: ShaderNode;
      if (!hd) {
        const shown: ShaderNode = mix(fill, index, step(0.5, index));
        const paint: ShaderNode = step(15.5, shown).mul(step(shown, 31.5));
        art = vec4(shade(paletteColour(shown), paint).add(glow.mul(edge)), edge);
      } else {
        const hdArt: ShaderNode = texture(hd.color, atlasUv);
        const paint: ShaderNode = texture(hd.remap, atlasUv).r;
        // House paint was written as grey(i) = 255 - (i - 16) * 15 in sRGB; invert it to a fractional remap index and
        // take the instance's house colours from its palette row, blending between neighbouring entries.
        const grey = pow(hdArt.g.max(0), 1 / 2.2).mul(255);
        const remapIndex = clamp(float(16).add(float(255).sub(grey).div(15)), 16, 31);
        const i0 = floor(remapIndex);
        const house = mix(paletteColour(i0), paletteColour(i0.add(1).min(31)), remapIndex.sub(i0));
        const colour = mix(hdArt.rgb, house, paint);
        // The upscaler saw the art over a flat background, so HD texels next to transparent ones carry a light fringe
        // of it (pale rings around the holes in foliage). Within about one original texel of any transparent texel the
        // HD colour keeps its own hue but is never brighter than the original's texel there (the palette colour of the
        // nearest opaque texel): the pale fringe goes, without a rim of raw palette colours (bright green dots,
        // salmon outlines) around the silhouette.
        const nearest: ShaderNode = paletteColour(mix(fill, index, step(0.5, index)));
        const solid: ShaderNode = smoothstep(0.8, 1.0, coverage);
        const limit: ShaderNode = luminance(nearest)
          .div(max(luminance(colour), 1e-4))
          .min(1);
        art = vec4(shade(mix(colour.mul(limit), colour, solid), paint).add(glow), hdArt.a.mul(edge));
      }
      return mix(art, shadow, isShadow);
    })();

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'ra2-sprites';
    this.setInstances(instances);
  }

  /** Replace every instance (up to `capacity`); cheap enough to call once per presented frame. */
  setInstances(instances: readonly SpriteInstance[]): void {
    // Decals first, then shadows, then upright art, so later layers sit on top of earlier ones.
    const layer = (s: SpriteInstance) => (s.flat ? 0 : s.shadow ? 1 : 2);
    const ordered = [...instances].sort((a, b) => layer(a) - layer(b)).slice(0, this.capacity);
    ordered.forEach((s, i) => {
      this.anchor.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
      this.rect.setXYZW(i, s.frame.rect[0], s.frame.rect[1], s.frame.rect[2], s.frame.rect[3]);
      this.params.setXYZW(i, s.frame.offset[0], s.frame.offset[1], this.cache.paletteRow.get(s.palette) ?? 0, s.push);
      this.flags.setXYZ(i, s.shadow ? 2 : s.flat ? 1 : 0, s.light ?? 1, LIGHTING_CODE[s.lighting ?? 'ambient']);
    });
    for (const attribute of [this.anchor, this.rect, this.params, this.flags]) attribute.needsUpdate = true;
    this.mesh.count = ordered.length;
    // Upload only the live range (instances past `count` are never drawn), not the whole capacity every frame.
    for (const attribute of [this.anchor, this.rect, this.params, this.flags]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, ordered.length) * attribute.itemSize);
    }
  }
}

/**
 * World anchor for a map object's engine draw point: the projected top corner of its cell plus `drawOffset`, lifted
 * back onto the ground plane at the object's level so the card sits where the engine draws it.
 */
export function objectAnchor(object: MapObject): Vector3 {
  const [sx, sy] = ra2Screen(object.x, object.y, object.z);
  const [dx, dy] = object.drawOffset ?? [0, 15];
  const [x, y] = screenToCell(sx + dx, sy + dy, object.z);
  return new Vector3(x, object.z * LEVEL_HEIGHT, y);
}
