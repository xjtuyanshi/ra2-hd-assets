import type { TerrainDepth } from '../terrainDepth';
import { NOT_CAPTURED_CODE } from '../objectDepth';
import { DirtyAttribute } from '../dirtyAttribute';
import { InstancedQuad } from '../instancedQuad';
import {
  Color,
  LessDepth,
  MeshBasicNodeMaterial,
  NormalBlending,
  type OrthographicCamera,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu';
import {
  Fn,
  Discard,
  If,
  cameraFar,
  cameraNear,
  clamp,
  cos,
  exp,
  float,
  floor,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  positionGeometry,
  positionWorld,
  pow,
  luminance,
  round,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { LightingClass, MapObject, SpriteFrame } from '../../../ra2-assets/src/manifest';
import {
  DEFAULT_ATMOSPHERE_NODES,
  moonlit,
  localLightHeadroom,
  objectLightAt,
  pavedAt,
  puddleNoise,
} from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import { type HdAtlas, type Ra2Cache } from './cache';
import { objectLevelAt, srgbScale, terrainGradeAt } from './mapLighting';
import { ENGINE_SHADOW_OPACITY } from './voxelShadow';
import { cardDepthNode, SPRITE_DECAL_LIFT } from './cardDepth';
import { NATIVE_UNIT_RENDER_ORDER, type NativeSpriteDepth } from './nativeDepth';
import { comparePainterOrder, spritePainterBias, type PainterObject } from './painterOrder';
import {
  GLASS_REFLECTANCE,
  classRoughness,
  contactShade,
  foundationBase,
  glassReflection,
  groundCrystalColour,
  highlightRoughness,
  poweredOcclusion,
  relightFactor,
  sampleMaterial,
  spriteLookFor,
  sunHighlight,
  type SpriteMaterialAtlas,
} from './spriteLook';

export interface SpriteInstance {
  /** World-space anchor: the engine's draw point for this object (canvas centre goes here). */
  anchor: Vector3;
  frame: SpriteFrame;
  /** Palette row key; remappable art uses its house row (see paletteFor). */
  palette: string;
  /** World units to pull the card towards the camera so terrain around the base never cuts it (see cardPush). */
  push: number;
  shadow: boolean;
  /** Body-card alpha multiplier, default 1. Shadows and ground extras keep their own opacity. */
  opacity?: number;
  /** Infantry's inline SHP footprint stays at the draw point; enhanced opacity is fixed at 0.78. */
  infantryShadow?: boolean;
  /** Lay the art on the ground as a decal (ore, smudges, flat overlays) instead of a camera-facing card. */
  flat?: boolean;
  /** Flat decals only: 0..1 ground-crystal relighting, highlights and animated sparkle; absent = unchanged art. */
  glint?: number;
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
  /** Map-light sample in world X/Z; defaults to the draw anchor. Cell copies can select a texel centre. */
  lightSample?: readonly [number, number];
  /** Optional traversal tie-break and building foundation. Decals/shadows retain physical ground depth. */
  painter?: PainterObject;
  painterPart?: number;
  /** Horizontal high-bridge depth at this height above the draw anchor; leaves screen placement unchanged. */
  deckHeight?: number;
  /** Original-engine body template, horizontal part or bitmap-bottom card; absent preserves analytic depth. */
  nativeDepth?: NativeSpriteDepth;
  /** Test-only native parts such as DoorAnim retain color but never obscure later units through depth writes. */
  depthWrite?: boolean;
  /**
   * Enhanced-look ground decals (see spriteLook.ts), drawn only while their effect is on: 'contact' darkens the ground
   * around `painter.foundation`, 'reflection' mirrors `frame` (an upright card's art) on wet paving below its base.
   */
  kind?: 'contact' | 'reflection';
}

const LIGHTING_CODE: Record<LightingClass, number> = { ambient: 0, full: 1, none: 2 };

/** World units of depth bias per 15 screen rows of a ground-crystal decal (see placement). */
const CRYSTAL_DECAL_ROW_BIAS = 0.002;

/** flags.x of an instance: 0 card, 1 decal, 2 shadow, 3 contact shade, 4 wet reflection. */
function instanceCode(s: SpriteInstance): number {
  if (s.kind === 'contact') return 3;
  if (s.kind === 'reflection') return 4;
  return s.shadow ? 2 : s.flat ? 1 : 0;
}

/** Draw rank: decals (and contact shades), shadows, wet reflections, then upright cards back to front. */
function instanceRank(s: SpriteInstance): number {
  if (s.kind === 'reflection') return 2;
  return s.flat || s.kind === 'contact' ? 0 : s.shadow ? 1 : 3;
}

/** Draw passes of a sprite layer: the main one, and the enhanced look's ground passes (SpriteLayer.groundPasses). */
type GroundPass = 'main' | 'under' | 'over' | 'readOnly' | 'unit' | 'translucent';

/**
 * How far (world units along the view) the enhanced look's 'over' pass pulls SHP shadows and wet reflections in front
 * of their ground plane. Everything stays behind an upright card's base (CARD_CLEARANCE) and ahead of the ground
 * at every sample of 4x MSAA down to 1 engine px per pixel (the farthest sample, 0.375 px from the pixel centre, sees
 * ground 0.0153 nearer); zoomed further out, the nearest samples of a pixel can miss its shadow. Shadows step up with
 * their coverage (five levels): a later, denser shadow still darkens an earlier fringe.
 */
export const GROUND_PULL = { shadow: [0.019, 0.027], reflection: 0.0285 } as const;
export const INFANTRY_SHADOW_OPACITY = 0.8;
/**
 * Coverage ramp of infantry contact shadows. The original draws them as solid palette-index-12 blobs inside the body
 * frames; the filtered/upscaled mask is only ~0.5 at the blob's own edge, so a linear ramp left half of every blob
 * lighter than the core (V<40 px 0.51x / 0.55x of the original for Initiates / Slaves on the same frozen frames; with
 * this ramp 0.60x / 0.61x, opacity alone saturated at 0.55x). Coverage >= `to` is the full core, the soft fringe
 * stays at the blob's edge (P-L5H-1). The rest of the gap is the HD bodies covering more of their own blob and the
 * original's near-black body pixels, not a missing shadow.
 */
export const INFANTRY_SHADOW_RAMP = { from: 0.02, to: 0.35 } as const;

/** CPU twin of the enhanced infantry shadow alpha for a filtered mask coverage (0..1). */
export function infantryShadowAlpha(coverage: number): number {
  const t = Math.min(
    1,
    Math.max(0, (coverage - INFANTRY_SHADOW_RAMP.from) / (INFANTRY_SHADOW_RAMP.to - INFANTRY_SHADOW_RAMP.from)),
  );
  return t * t * (3 - 2 * t) * INFANTRY_SHADOW_OPACITY;
}

/**
 * Filtered coverage of a frame's 1x indexed mask at `texel` (quadratic B-spline over the 3x3 texels around it, texels
 * outside the frame rect empty): the same weights as the sprite colour's coverage.
 */
function frameCoverage(atlas: Texture, atlasSize: ShaderNode, texel: ShaderNode, rect: ShaderNode): ShaderNode {
  const k0: ShaderNode = floor(texel);
  const t0: ShaderNode = texel.sub(k0).sub(0.5);
  const weights = (o: number): ShaderNode =>
    o === 0
      ? float(0.75).sub(t0.mul(t0))
      : o < 0
        ? float(0.5).sub(t0).mul(float(0.5).sub(t0)).mul(0.5)
        : float(0.5).add(t0).mul(float(0.5).add(t0)).mul(0.5);
  const lo: ShaderNode = rect.xy;
  const hi: ShaderNode = rect.xy.add(rect.zw);
  let coverage: ShaderNode = float(0);
  for (const oy of [-1, 0, 1]) {
    for (const ox of [-1, 0, 1]) {
      const k: ShaderNode = k0.add(vec2(ox, oy));
      const inside: ShaderNode = step(lo, k).mul(float(1).sub(step(hi, k)));
      const occupied: ShaderNode = step(0.5, texture(atlas, k.add(0.5).div(atlasSize)).r.mul(255));
      coverage = coverage.add(weights(ox).x.mul(weights(oy).y).mul(occupied).mul(inside.x).mul(inside.y));
    }
  }
  return coverage;
}

const planeSize = new Vector2();
const probe = new Vector3();

/**
 * Coefficients (c0, cx, cy, cY) with which an orthographic camera's normalised depth of the horizontal plane at height
 * Y, seen through the pixel centre (x, y) of a width x height target (pixels, y down), is c0 + cx x + cy y + cY Y.
 */
export function groundPlaneDepth(camera: OrthographicCamera, width: number, height: number, out: Vector4): Vector4 {
  const inverse = camera.projectionMatrixInverse;
  const world = camera.matrixWorld.elements;
  const range = camera.far - camera.near;
  const depthAt = (x: number, y: number, planeY: number): number => {
    // View-space x and y of the pixel (orthographic: independent of the NDC depth used here).
    probe.set((2 * x) / width - 1, 1 - (2 * y) / height, 0.5).applyMatrix4(inverse);
    // World height along the view ray: y_w = m10 x + m11 y + m12 z + m13; solve for the view z on the plane.
    const z = (planeY - world[1]! * probe.x - world[5]! * probe.y - world[13]!) / world[9]!;
    return (-z - camera.near) / range;
  };
  const c0 = depthAt(0, 0, 0);
  return out.set(c0, depthAt(1, 0, 0) - c0, depthAt(0, 1, 0) - c0, depthAt(0, 0, 1) - c0);
}

/** Darkening of SHP shadows: the engine halves the displayed colour under them (see ENGINE_SHADOW_OPACITY). */
const SHADOW_OPACITY = ENGINE_SHADOW_OPACITY;

/**
 * Placement push for camera-facing geometry (also used by lighting/shadows). Fragment occlusion is reconstructed
 * independently by cardDepth.ts; native bitmap bounds affect that profile, never this placement offset. A pixel d world
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
  readonly mesh: InstancedQuad;
  /** Test-only sprite parts share every instance buffer; visible only when such a part exists. */
  readonly readOnlyMesh: InstancedQuad;
  /** Ground cards follow test-only parts, so a door cannot paint over a unit that passed the body. */
  readonly unitMesh: InstancedQuad;
  /** Translucent bodies follow native unit color, retaining depth tests without writing an opaque silhouette. */
  readonly translucentMesh: InstancedQuad;
  /**
   * The enhanced look's ground passes ('under', 'over'; children of `mesh`, shown by HdRenderer only while the look is
   * on). They share this layer's instance buffers.
   */
  readonly groundPasses: InstancedQuad[];
  /** Ground-plane depth coefficients of the 'over' pass (see groundPlaneDepth), set per draw. */
  private readonly planeCoefficients = uniform(new Vector4());
  /** Scene light level applied to unlit sprites (1 = the original's full-bright daylight). */
  readonly light = uniform(new Color(1, 1, 1));
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  readonly capacity: number;
  private readonly anchor: DirtyAttribute;
  private readonly rect: DirtyAttribute;
  private readonly params: DirtyAttribute;
  /**
   * x: card/decal/shadow/contact/reflection (instanceCode); y: object light; z: map lighting class; w: bounded
   * traversal bias in world units for cards, ground-crystal weight for plain flat decals, or infantry shadow marker.
   * The second vec4 holds foundation width/height and draw-point offsets; width -1 selects an elevated deck.
   * Capture-enabled layers retain their relative anchor code at scalar 8. Two additional vec4s hold the native
   * depth mode/profile and owner offsets/pass (0 ordinary, 1 test-only, 2 ground unit, 3 + opacity translucent).
   * All attributes share one buffer: stride 16, or 17 with
   * capture, so native depth adds no vertex buffer (WebGPU allows eight).
   */
  private readonly flags: DirtyAttribute;
  private instances: readonly SpriteInstance[] = [];
  private readonly orderedCards: SpriteInstance[] = [];
  private instanceCount = 0;
  private readonly uploaded: SpriteInstance[] = [];

  /** Current records; static layers keep these and their depth profiles until the layer itself changes. */
  getInstances(): readonly SpriteInstance[] {
    return this.instances;
  }

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
     * Optional HD version of the same atlas (same layout, normalized UVs unchanged at any scale): full-colour art with
     * house-paint pixels written as a grey ramp, plus a mask of those pixels (see packages/ra2-assets spriteHd).
     * Shadows keep using the indexed atlas.
     */
    hd: HdAtlas | null = null,
    /**
     * Lit-window mask over the same atlas (R = lit, G = variant; ra2-assets windows.ts), same normalized UVs as the
     * indexed and HD atlases. Null: no windows.
     */
    windows: Texture | null = null,
    /**
     * Material atlas over the same atlas (sprites@2x-normals.png: world normal, specular class, occlusion; see
     * spriteLook.ts), same normalized UVs; its pixel dimensions can differ from both colour and indexed atlases.
     * Null: the enhanced look has no per-pixel normals for this layer (shadows, contact shades and reflections still
     * follow it).
     */
    materials: SpriteMaterialAtlas | null = null,
    private readonly capture: TerrainDepth | null = null,
  ) {
    const nodes = cache.nodes ?? DEFAULT_ATMOSPHERE_NODES;
    const { referenceLevel, windowGain } = nodes;
    const look = spriteLookFor(nodes);
    this.capacity = Math.max(1, capacity, instances.length);
    const count = this.capacity;
    // Pack related fields into shared vertex buffers. Capacity never introduces an unused instance matrix.
    this.anchor = new DirtyAttribute(new Float32Array(count * 5), 5);
    this.rect = new DirtyAttribute(new Float32Array(count * 4), 4);
    this.params = new DirtyAttribute(new Float32Array(count * 4), 4);
    const nativeOffset = capture ? 9 : 8;
    this.flags = new DirtyAttribute(new Float32Array(count * (nativeOffset + 8)), nativeOffset + 8);

    const atlasSize = vec2(atlas.width, atlas.height);
    const paletteRows = float(cache.paletteAtlas.image.height);
    const aAnchor: ShaderNode = instancedBufferAttribute(this.anchor.interleaved(), 'vec3', 5, 0);
    const aRect: ShaderNode = instancedBufferAttribute(this.rect, 'vec4');
    const aParams: ShaderNode = instancedBufferAttribute(this.params, 'vec4');
    const aLightSample: ShaderNode = instancedBufferAttribute(this.anchor.interleaved(), 'vec2', 5, 3);
    const aFlags: ShaderNode = instancedBufferAttribute(this.flags.interleaved(), 'vec4', this.flags.itemSize, 0);
    const aOcclusion: ShaderNode = instancedBufferAttribute(this.flags.interleaved(), 'vec4', this.flags.itemSize, 4);
    const aNative: ShaderNode = instancedBufferAttribute(
      this.flags.interleaved(),
      'vec4',
      this.flags.itemSize,
      nativeOffset,
    );
    const aNativeOffset: ShaderNode = instancedBufferAttribute(
      this.flags.interleaved(),
      'vec4',
      this.flags.itemSize,
      nativeOffset + 4,
    );
    const aFlat: ShaderNode = aFlags.x;
    const bodyOpacity: ShaderNode = aNativeOffset.w
      .greaterThanEqual(3)
      .select(aNativeOffset.w.sub(3), 1)
      .toVar('spriteBodyOpacity');
    const isInfantryShadow: ShaderNode = step(1.5, aFlat)
      .mul(float(1).sub(step(2.5, aFlat)))
      .mul(step(0.5, aFlags.w));
    // The map's light for this instance's class, times its own extra light, in the palette's sRGB scale (see
    // mapLighting.ts): 'ambient' takes the level, 'full' the per-channel grade, 'none' nothing.
    const isFull: ShaderNode = step(0.5, aFlags.z).mul(float(1).sub(step(1.5, aFlags.z)));
    const isNone: ShaderNode = step(1.5, aFlags.z);
    const grade: ShaderNode = mix(
      mix(vec3(objectLevelAt(cache.mapLight, aLightSample)), terrainGradeAt(cache.mapLight, aLightSample), isFull),
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
    const vCard: ShaderNode = float(1).sub(uv().y);
    const pushAmount: ShaderNode = aParams.w;
    // Enhanced-look instance kinds (codes 3 and 4) and the art's base line under a column (the foundation's front edges
    // for buildings, the draw point's row otherwise), for mirror images on wet ground.
    const isContact: ShaderNode = step(2.5, aFlat).mul(float(1).sub(step(3.5, aFlat)));
    const isReflection: ShaderNode = step(3.5, aFlat);
    // occlusion.zw hold the draw point's offset from the foundation (d = x - z, -x - z), zero for map buildings.
    const baseRow = (px: ShaderNode): ShaderNode =>
      select(
        aOcclusion.x.greaterThan(0),
        foundationBase(px.add(aOcclusion.z.mul(30)), aOcclusion.x, aOcclusion.y).add(aOcclusion.w.mul(15)),
        float(0),
      );
    // Foundation origin and centre on the ground relative to the draw point (world x/z), or the draw point itself.
    const foundationOrigin: ShaderNode = vec2(aOcclusion.w.sub(aOcclusion.z), aOcclusion.z.add(aOcclusion.w)).mul(0.5);
    const baseCentre: ShaderNode = select(
      aOcclusion.x.greaterThan(0),
      foundationOrigin.add(vec2(aOcclusion.x.mul(0.5), aOcclusion.y.mul(0.5))),
      vec2(0, 0),
    );
    // A reflection's quad spans the rows from the base line down to the mirror image of the frame's top.
    const reflectionRows = (): ShaderNode => {
      const top: ShaderNode = aParams.y;
      const bottom: ShaderNode = select(
        aOcclusion.x.greaterThan(0),
        aOcclusion.x.add(aOcclusion.y).mul(15).add(aOcclusion.w.mul(15)),
        float(0),
      );
      return vec2(float(0).min(bottom), bottom.mul(2).sub(top));
    };
    // Reflections sample the art at the row mirrored about the base line of their column.
    const reflectedV = (): ShaderNode => {
      const rows: ShaderNode = reflectionRows();
      const px: ShaderNode = aParams.x.add(u.mul(aRect.z));
      const qy: ShaderNode = rows.x.add(vCard.mul(rows.y.sub(rows.x)));
      const base: ShaderNode = baseRow(px);
      // Rain-ruffled water: the mirror row wobbles, more with distance from the base (a blurred, broken image).
      const ripple: ShaderNode = sin(qy.mul(0.7).add(px.mul(0.11)))
        .mul(0.6)
        .add(sin(qy.mul(0.23).sub(px.mul(0.05))).mul(0.9))
        .mul(max(qy.sub(base), 0).mul(0.05).add(0.4));
      const source: ShaderNode = base.mul(2).sub(qy).add(ripple);
      return source.sub(aParams.y).div(max(aRect.w, 1));
    };
    const v: ShaderNode = select(isReflection.greaterThan(0.5), reflectedV(), vCard);
    const cardDepth = (): ShaderNode =>
      cardDepthNode(
        aParams.x.add(u.mul(aRect.z)),
        aParams.y.add(vCard.mul(aRect.w)),
        aOcclusion,
        pushAmount,
        aFlags.w,
        aFlat.greaterThan(0.5),
        { data: aNative, offset: aNativeOffset, template: cache.depthTemplate },
      );
    material.depthNode = cardDepth();
    // Vertex stage: corners from the untouched geometry attribute (+-0.5).
    const gu: ShaderNode = positionGeometry.x.add(0.5);
    const gv: ShaderNode = float(0.5).sub(positionGeometry.y);
    // Enhanced-look ground passes (see SpriteLayer.groundPasses): with the look on, the main pass draws only upright
    // cards; decals and contact shades go to the 'under' pass, SHP shadows and wet reflections to the 'over' pass.
    const enhancedOn: ShaderNode = step(0.5, look.enabled);
    const underKind: ShaderNode = step(0.5, aFlat)
      .mul(float(1).sub(step(1.5, aFlat)))
      .add(isContact);
    const overKind: ShaderNode = step(1.5, aFlat)
      .mul(float(1).sub(step(2.5, aFlat)))
      .add(isReflection);
    const skipIn = (pass: GroundPass): ShaderNode =>
      pass === 'translucent'
        ? aNativeOffset.w.greaterThanEqual(3).select(0, 1)
        : pass === 'readOnly'
          ? aNativeOffset.w.equal(1).select(0, 1)
          : pass === 'unit'
            ? aNativeOffset.w.equal(2).select(0, 1)
            : pass === 'main'
              ? enhancedOn.mul(step(0.5, aFlat)).add(step(0.5, aNativeOffset.w))
              : float(1)
                  .sub(enhancedOn.mul(pass === 'under' ? underKind : overKind))
                  .add(step(0.5, aNativeOffset.w));
    const placement = (pass: GroundPass): ShaderNode =>
      Fn(() => {
        const px = aParams.x.add(gu.mul(aRect.z));
        const py = aParams.y.add(gv.mul(aRect.w));
        const card = aAnchor
          .add(this.cameraRight.mul(px.div(ppu)))
          .sub(this.cameraUp.mul(py.div(ppu)))
          .add(this.toCamera.mul(pushAmount));
        // Ground decal: invert the engine projection at the anchor's height (1 px right = (1/60, -1/60) cells,
        // 1 px down = (1/30, 1/30) cells), so the art covers exactly the same screen pixels while lying on the ground.
        // Ground-crystal decals (ore cells whose art spills over the cell edge) overlap their neighbours in one plane.
        // Where a pass writes depth, the decal drawn first would reject the overlap of the next one by rounding, which
        // cuts nuggets along straight lines. A depth bias by the pixel's screen row relative to the anchor makes the
        // decal anchored lower on screen (the front cell, drawn later in painter order) win; at most a few thousandths
        // of a cell, well inside SPRITE_DECAL_LIFT.
        const crystalDecal: ShaderNode = step(0.5, aFlat)
          .mul(float(1).sub(step(1.5, aFlat)))
          .mul(step(1e-4, aFlags.w));
        const rowBias: ShaderNode = clamp(py.div(15), -3, 3).mul(-CRYSTAL_DECAL_ROW_BIAS).mul(crystalDecal);
        const decal = aAnchor
          .add(vec3(px.div(60).add(py.div(30)), SPRITE_DECAL_LIFT, py.div(30).sub(px.div(60))))
          .add(this.toCamera.mul(rowBias));
        const placed = aFlat.greaterThan(0.5).select(decal, card);
        // Enhanced look (spriteLook.ts). Shadows follow the sun: their ground offsets turn and stretch about the object's
        // base (the foundation's centre, or the draw point); the faithful path keeps the untouched decal.
        const isShadowKind: ShaderNode = step(1.5, aFlat).mul(float(1).sub(step(2.5, aFlat)));
        const centre: ShaderNode = baseCentre;
        const offset: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60))).sub(centre);
        const m: ShaderNode = look.shadowMatrix;
        const turned: ShaderNode = centre.add(
          vec2(m.x.mul(offset.x).add(m.z.mul(offset.y)), m.y.mul(offset.x).add(m.w.mul(offset.y))),
        );
        const followed = aAnchor.add(vec3(turned.x, SPRITE_DECAL_LIFT, turned.y));
        // Inline infantry footprints share the body's screen offsets; rotating them would detach them from its feet.
        const follow: ShaderNode = isShadowKind
          .mul(float(1).sub(isInfantryShadow))
          .mul(step(1e-4, look.shadowFollow))
          .mul(look.enabled);
        // Contact shades and reflections exist only while their effect is on; otherwise they collapse to a point.
        const rows: ShaderNode = reflectionRows();
        const qy = rows.x.add(gv.mul(rows.y.sub(rows.x)));
        const mirrored = aAnchor.add(vec3(px.div(60).add(qy.div(30)), SPRITE_DECAL_LIFT, qy.div(30).sub(px.div(60))));
        const contactOn: ShaderNode = step(1e-4, look.occlusion).mul(look.enabled);
        const reflectionOn: ShaderNode = step(1e-4, look.reflections.mul(look.wetness)).mul(look.enabled);
        const hidden: ShaderNode = isContact
          .mul(float(1).sub(contactOn))
          .add(isReflection.mul(float(1).sub(reflectionOn)))
          .add(skipIn(pass));
        const enhanced = select(
          isReflection.greaterThan(0.5),
          mirrored,
          select(follow.greaterThan(0.5), followed, placed),
        );
        return select(hidden.greaterThan(0.5), aAnchor, enhanced);
      })();
    material.positionNode = placement('main');
    // One colour graph per material (the main pass and the enhanced look's ground passes below).
    const colourNode = (): ShaderNode =>
      Fn(() => {
        const texel = vec2(aRect.x.add(u.mul(aRect.z)), aRect.y.add(v.mul(aRect.w))).toVar();
        const atlasUv = texel.div(atlasSize);
        const paletteColour = (i: ShaderNode): ShaderNode =>
          texture(cache.paletteAtlas, vec2(i.add(0.5).div(256), aParams.z.add(0.5).div(paletteRows))).rgb;
        const isShadow: ShaderNode = step(1.5, aFlat).mul(float(1).sub(step(2.5, aFlat)));

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
        // Existing building/vehicle shadows retain indexed coverage. Only the new infantry page supplies HD alpha.
        const shadowCoverage: ShaderNode = hd
          ? mix(clamp(coverage, 0, 1), max(clamp(coverage, 0, 1), texture(hd.color, atlasUv).a), isInfantryShadow)
          : clamp(coverage, 0, 1);
        const shadow: ShaderNode = vec4(0, 0, 0, shadowCoverage.mul(SHADOW_OPACITY));
        const edge: ShaderNode = smoothstep(0.35, 0.65, coverage);
        // Local light at the ground point under this pixel (decals: the pixel itself; upright art: straight below it on
        // screen, down to the anchor's ground line), fading with the pixel's height above that ground.
        const px = aParams.x.add(u.mul(aRect.z)).toVar();
        const py = aParams.y.add(v.mul(aRect.w)).toVar();
        const flat = aFlat.greaterThan(0.5);
        const down = select(flat, py, max(py, 0));
        const ground = aAnchor.xz.add(vec2(px.div(60).add(down.div(30)), down.div(30).sub(px.div(60)))).toVar();
        const height = select(flat, float(0), max(py.negate(), 0).div(ppu));
        // Upright building art takes ground-only light (a building's own source) inside its own foundation: the
        // pixel's ground projection, clamped a little inside the foundation (objectLightAt).
        const building: ShaderNode = step(0.5, aOcclusion.x).mul(float(1).sub(step(0.5, aFlat)));
        const inset: ShaderNode = min(aOcclusion.xy.mul(0.5), 0.35);
        const projected: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60)));
        const own: ShaderNode = aAnchor.xz
          .add(foundationOrigin)
          .add(clamp(projected.sub(foundationOrigin), inset, max(aOcclusion.xy.sub(inset), inset)));
        const local: ShaderNode = objectLightAt(ground, own, building, nodes)
          .div(referenceLevel)
          .mul(exp(height.mul(-0.45)));
        // The map's light, then the scene light on the night-desaturated colour (house paint keeps its colour) and local
        // lights on the full colour.
        const shade = (c: ShaderNode, paint: ShaderNode): ShaderNode => {
          const lit: ShaderNode = objectLit(c);
          const base = mix(moonlit(lit, nodes), lit, paint).mul(this.light);
          return base.add(localLightHeadroom(base, lit.mul(local), nodes.localLightCap));
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
        let lit: ShaderNode;
        let litAlpha: ShaderNode;
        let litGlow: ShaderNode;
        if (!hd) {
          const shown: ShaderNode = mix(fill, index, step(0.5, index));
          const paint: ShaderNode = step(15.5, shown).mul(step(shown, 31.5));
          lit = shade(paletteColour(shown), paint).toVar();
          litGlow = glow.mul(edge).toVar();
          litAlpha = edge.toVar();
          art = vec4(lit.add(litGlow), litAlpha);
        } else {
          const hdArt: ShaderNode = texture(hd.color, atlasUv);
          const paint: ShaderNode = texture(hd.remap, atlasUv).r;
          // House paint was written as grey(i) = 255 - (i - 16) * 15 in sRGB; invert it to a fractional remap index and
          // take the instance's house colours from its palette row, blending between neighbouring entries.
          const grey = pow(hdArt.g.max(0), 1 / 2.2).mul(255);
          const remapIndex = clamp(float(16).add(float(255).sub(grey).div(15)), 16, 31);
          const i0 = floor(remapIndex);
          let house: ShaderNode = mix(paletteColour(i0), paletteColour(i0.add(1).min(31)), remapIndex.sub(i0));
          if ((hd.paintSaturation ?? 1) < 1) {
            // Palette samples are linear; preserve Rec.709 luminance and the encoded shading. Default pages add no nodes.
            const greyHouse = house.dot(vec3(0.2126, 0.7152, 0.0722));
            house = mix(vec3(greyHouse), house, hd.paintSaturation!);
          }
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
          lit = shade(mix(colour.mul(limit), colour, solid), paint).toVar();
          litGlow = vec3(glow).toVar();
          litAlpha = hdArt.a.mul(edge).toVar();
          art = vec4(lit.add(litGlow), litAlpha);
        }
        const result: ShaderNode = mix(art, shadow, isShadow).toVar();
        // Enhanced look (spriteLook.ts): skipped entirely in the faithful default, so its colours stay untouched.
        If(look.enabled.greaterThan(0.5), () => {
          const flatArt: ShaderNode = aFlat.greaterThan(0.5);
          const view: ShaderNode = this.toCamera;
          const sun: ShaderNode = look.sunDirection;
          const wet: ShaderNode = look.wetness;
          // Upright art with material data: relight as a delta on the baked shading, occlusion, highlights, glass.
          if (materials) {
            const m = sampleMaterial(materials, atlasUv);
            const weight: ShaderNode = m.has.mul(float(1).sub(step(0.5, aFlat)));
            const factor: ShaderNode = mix(vec3(1), relightFactor(m.normal, look), look.relight.mul(weight));
            const occlusion: ShaderNode = mix(
              float(1),
              poweredOcclusion(m.ao, look.aoPower),
              look.occlusion.mul(weight),
            );
            const base: ShaderNode = lit.mul(factor).mul(occlusion);
            const glass: ShaderNode = smoothstep(0.75, 0.98, m.spec).mul(weight);
            // Glass: a street-level mirror (see glassReflection) with sky, cloud streaks and a sun glint, tinted by the
            // pane. Its own strength (look.glass) is independent of the facade highlights (look.specular).
            const facade: ShaderNode = vec2(ground.x.add(ground.y), py.div(ppu).negate());
            const pane = glassReflection(m.normal, view, sun, facade, lit, look);
            const reflectance: ShaderNode = look.glass
              .mul(glass.mul(GLASS_REFLECTANCE))
              .add(look.specular.mul(wet.mul(weight).mul(0.05)));
            const roughness: ShaderNode = highlightRoughness(classRoughness(m.spec, wet), look.specularSize);
            // Facades and roofs: a physical GGX highlight, weak on matte classes.
            const highlight: ShaderNode = sunHighlight(m.normal, sun, view, roughness, float(0.03))
              .mul(look.sunLight)
              .mul(look.specularSize.mul(look.specularSize))
              .mul(
                look.specular
                  .mul(weight)
                  .mul(mix(float(0.25), float(1), m.spec))
                  .mul(float(1).sub(glass))
                  .mul(occlusion),
              );
            // Glints only on the full inside of a pane (not its softer rim), so they never sparkle as single pixels.
            const core: ShaderNode = smoothstep(0.92, 0.99, m.spec).mul(weight);
            const glint: ShaderNode = pane.glint.mul(look.sunLight).mul(look.glass.mul(core).mul(occlusion));
            const sky: ShaderNode = pane.sky.mul(occlusion);
            const relit: ShaderNode = mix(base, sky, reflectance).add(highlight).add(glint);
            result.assign(select(flatArt, result, vec4(relit.add(litGlow), litAlpha)));
            const isDecal: ShaderNode = step(0.5, aFlat).mul(float(1).sub(step(1.5, aFlat)));
            const crystal: ShaderNode = aFlags.w.mul(isDecal).mul(m.has);
            // Use colour-atlas pixels, not material pixels: material sidecars may have a different resolution.
            const hdScale = hd
              ? ((hd.color.image as { width?: number } | null)?.width ?? atlas.width) / atlas.width
              : 1;
            const crystalColour = groundCrystalColour(
              lit,
              m,
              crystal,
              texel.mul(hdScale),
              view,
              look,
              aAnchor.xz,
              (pixel) => sampleMaterial(materials, pixel.div(hdScale).div(atlasSize)),
            );
            result.assign(select(crystal.greaterThan(0), vec4(crystalColour.add(litGlow), litAlpha), result));
          }
          // Both crisp and softened shadows share the enhanced opacity; faithful keeps the engine's alpha above.
          const shadowOpacity: ShaderNode = mix(
            look.shadowDarkness.mul(SHADOW_OPACITY).min(0.9),
            INFANTRY_SHADOW_OPACITY,
            isInfantryShadow,
          );
          If(
            isShadow.greaterThan(0.5).and(look.shadowDarkness.notEqual(1).or(isInfantryShadow.greaterThan(0.5))),
            () => {
              const ramped: ShaderNode = mix(
                shadowCoverage,
                smoothstep(INFANTRY_SHADOW_RAMP.from, INFANTRY_SHADOW_RAMP.to, shadowCoverage),
                isInfantryShadow,
              );
              const alpha: ShaderNode = ramped.mul(shadowOpacity);
              result.assign(vec4(0, 0, 0, alpha));
            },
          );
          // Shadows grow a penumbra with distance from their object's base (golden-hour softness).
          If(
            isShadow.greaterThan(0.5).and(isInfantryShadow.lessThan(0.5)).and(look.shadowSoftness.greaterThan(1e-4)),
            () => {
              const offset: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60)));
              const reach: ShaderNode = length(offset.sub(baseCentre));
              const radius: ShaderNode = look.shadowSoftness.mul(reach).mul(2.2).min(6);
              const soft: ShaderNode = float(0).toVar();
              for (let i = 0; i < 8; i++) {
                const angle = (i / 8) * Math.PI * 2 + 0.4;
                const r = i % 2 === 0 ? 1 : 0.55;
                const k: ShaderNode = floor(texel.add(vec2(cos(angle), sin(angle)).mul(radius.mul(r))));
                const inside: ShaderNode = step(lo, k).mul(float(1).sub(step(hi, k)));
                const occupied: ShaderNode = step(0.5, texture(atlas.texture, k.add(0.5).div(atlasSize)).r.mul(255));
                soft.addAssign(occupied.mul(inside.x).mul(inside.y));
              }
              const blended: ShaderNode = mix(clamp(coverage, 0, 1), soft.div(8), smoothstep(0.3, 1.5, radius));
              result.assign(vec4(0, 0, 0, blended.mul(shadowOpacity)));
            },
          );
          // Contact shade: soft darkening of the ground around a foundation.
          If(isContact.greaterThan(0.5), () => {
            const local: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60))).sub(
              foundationOrigin,
            );
            const shadeAlpha: ShaderNode = contactShade(local, aOcclusion.x, aOcclusion.y)
              .mul(look.occlusion)
              .mul(0.42)
              .toVar();
            If(look.contactShade.notEqual(1), () => {
              shadeAlpha.assign(shadeAlpha.mul(look.contactShade).min(0.85));
            });
            result.assign(vec4(0, 0, 0, shadeAlpha));
          });
          // Wet reflection: the lit art mirrored about its base line, on paved ground only, fading with distance.
          If(isReflection.greaterThan(0.5), () => {
            const rows: ShaderNode = reflectionRows();
            const qy: ShaderNode = rows.x.add(vCard.mul(rows.y.sub(rows.x)));
            const base: ShaderNode = baseRow(px);
            const below: ShaderNode = qy.sub(base);
            const tall: ShaderNode = max(base.sub(aParams.y), 8);
            // Wet paving mirrors only the lower part of what stands on it: the image fades within about a quarter of
            // the object's height (at most 42 engine px), sharpest in puddles.
            const fade: ShaderNode = exp(below.div(tall.mul(0.28).min(42)).negate()).mul(step(0, below));
            const surface: ShaderNode = pavedAt(positionWorld.xz, nodes);
            const puddle: ShaderNode = puddleNoise(positionWorld);
            const strength: ShaderNode = look.reflections
              .mul(wet)
              .mul(surface)
              .mul(mix(float(0.14), float(0.7), puddle))
              .mul(fade);
            result.assign(vec4(lit.mul(0.9), litAlpha.mul(strength)));
          });
        });
        return vec4(result.rgb, result.a.mul(bodyOpacity));
      })();
    const mainColour = colourNode();
    if (capture) {
      // Every vertex of an instance shares the anchor code, including across its SHP component pages.
      const code: ShaderNode = varying(
        instancedBufferAttribute(this.flags.interleaved(), 'float', this.flags.itemSize, 8),
        'objectDepthInstanceCode',
      ).setInterpolation('flat', 'either');
      material.userData.objectDepthCodeNode = code;
      const kind: ShaderNode = varying(aFlat, 'objectDepthInstanceKind').setInterpolation('flat', 'either');
      material.colorNode = Fn(() => {
        // This object-group gate is recomputed for the actual capture target/camera. Main/mirror output and depth
        // use the original nodes unchanged. Ground-pass children never receive capture layers or this discard.
        If(capture.captureEnabled.greaterThan(0).and(code.equal(NOT_CAPTURED_CODE).or(kind.notEqual(0))), () =>
          Discard(),
        );
        return mainColour;
      })();
    } else material.colorNode = mainColour;

    this.mesh = new InstancedQuad(material, count);
    this.mesh.renderOrder = 4;
    this.mesh.name = 'ra2-sprites';

    const readOnlyMaterial = new MeshBasicNodeMaterial();
    readOnlyMaterial.name = 'ra2-sprites-read-only';
    readOnlyMaterial.transparent = true;
    readOnlyMaterial.blending = NormalBlending;
    readOnlyMaterial.alphaTest = material.alphaTest;
    readOnlyMaterial.positionNode = placement('readOnly');
    readOnlyMaterial.colorNode = colourNode();
    readOnlyMaterial.depthNode = cardDepth();
    readOnlyMaterial.depthWrite = false;
    this.readOnlyMesh = new InstancedQuad(readOnlyMaterial, count, this.mesh.geometry);
    this.readOnlyMesh.name = 'ra2-sprites-read-only';
    const main = this.mesh;
    Object.defineProperty(this.readOnlyMesh, 'renderOrder', {
      get: () => main.renderOrder + 0.001,
      set: () => {},
      configurable: true,
    });
    this.mesh.add(this.readOnlyMesh);

    const unitMaterial = new MeshBasicNodeMaterial();
    unitMaterial.name = 'ra2-sprites-ground-units';
    unitMaterial.transparent = true;
    unitMaterial.blending = NormalBlending;
    unitMaterial.alphaTest = material.alphaTest;
    unitMaterial.positionNode = placement('unit');
    unitMaterial.colorNode = material.colorNode;
    unitMaterial.depthNode = cardDepth();
    unitMaterial.userData.objectDepthCodeNode = material.userData.objectDepthCodeNode;
    this.unitMesh = new InstancedQuad(unitMaterial, count, this.mesh.geometry);
    this.unitMesh.name = 'ra2-sprites-ground-units';
    this.unitMesh.renderOrder = NATIVE_UNIT_RENDER_ORDER;
    this.mesh.add(this.unitMesh);

    const translucentMaterial = new MeshBasicNodeMaterial();
    translucentMaterial.name = 'ra2-sprites-translucent';
    translucentMaterial.transparent = true;
    translucentMaterial.blending = NormalBlending;
    translucentMaterial.alphaTest = material.alphaTest;
    translucentMaterial.positionNode = placement('translucent');
    translucentMaterial.colorNode = colourNode();
    translucentMaterial.depthNode = cardDepth();
    translucentMaterial.depthWrite = false;
    this.translucentMesh = new InstancedQuad(translucentMaterial, count, this.mesh.geometry);
    this.translucentMesh.name = 'ra2-sprites-translucent';
    this.translucentMesh.renderOrder = NATIVE_UNIT_RENDER_ORDER + 0.001;
    this.mesh.add(this.translucentMesh);

    // Enhanced-look ground passes. In one draw call every ground decal wrote depth on the same plane (0.02 above the
    // ground), so coplanar decals z-fought: SHP shadows over contact shades, bibs and each other passed or failed by
    // rounding, and with shadows turning with the sun the pattern changed every minute of game time (whole shadows
    // popping, ladder stripes). The decals also sat 0.04 world units in front of the ground at their pixel, nearer
    // than an upright card's base (CARD_CLEARANCE 0.03), so a turned shadow hid the bottom rails of fences. With the
    // look on, the ground art is drawn in two passes before the cards (renderOrder just below this mesh's):
    //  - 'under': contact shades and decals (bibs, smudges, ore) in their draw order, without depth writes;
    //  - 'over': SHP shadows and wet reflections, depth-tested against a depth computed exactly from the pixel and the
    //    anchor's ground plane (identical for every instance on that plane), pulled forward by less than a card's
    //    clearance and by more for denser shadow (LessDepth): overlapping shadows darken a pixel once, a denser one
    //    may darken a fringe further, and nothing on the ground can hide a card.
    // The faithful look keeps the single pass (both ground passes are hidden, see HdRenderer).
    // The ground plane's depth under a pixel is affine in the pixel's coordinates and the plane's height for the
    // orthographic camera: depth = c0 + cx * x + cy * y + cY * height. The coefficients are set per draw from the
    // camera and target actually rendering (onBeforeRender below), so a pass with another camera (a reflection's
    // mirrored one) gets its own.
    const planeCoefficients = this.planeCoefficients;
    const planeDepth = Fn(() => {
      // The anchor's height, snapped to 1/64 level so interpolation rounding can never split one plane in two.
      const level: ShaderNode = round(aAnchor.y.div(LEVEL_HEIGHT).mul(64)).div(64).mul(LEVEL_HEIGHT);
      const c: ShaderNode = planeCoefficients;
      const ground: ShaderNode = c.x
        .add(c.y.mul(screenCoordinate.x))
        .add(c.z.mul(screenCoordinate.y))
        .add(c.w.mul(level));
      const texel = vec2(aRect.x.add(uv().x.mul(aRect.z)), aRect.y.add(vCard.mul(aRect.w)));
      const indexedCoverage = frameCoverage(atlas.texture, atlasSize, texel, aRect);
      const coverage = hd
        ? mix(indexedCoverage, max(indexedCoverage, texture(hd.color, texel.div(atlasSize)).a), isInfantryShadow)
        : indexedCoverage;
      const level5: ShaderNode = floor(clamp(coverage, 0, 1).mul(4).add(0.5));
      const pull: ShaderNode = select(
        isReflection.greaterThan(0.5),
        float(GROUND_PULL.reflection),
        float(GROUND_PULL.shadow[0]).add(level5.mul((GROUND_PULL.shadow[1] - GROUND_PULL.shadow[0]) / 4)),
      );
      return ground.sub(pull.div(cameraFar.sub(cameraNear)));
    })();
    const passMaterial = (pass: GroundPass): MeshBasicNodeMaterial => {
      const m = new MeshBasicNodeMaterial();
      m.name = `ra2-sprites-${pass}`;
      m.transparent = true;
      m.blending = NormalBlending;
      m.alphaTest = material.alphaTest;
      m.positionNode = placement(pass);
      m.colorNode = colourNode();
      if (pass === 'under') {
        m.depthNode = cardDepth();
        m.depthWrite = false;
      } else {
        m.depthNode = planeDepth;
        m.depthFunc = LessDepth;
      }
      return m;
    };
    this.groundPasses = (['under', 'over'] as const).map((pass, i) => {
      const passMesh = new InstancedQuad(passMaterial(pass), count, this.mesh.geometry);
      passMesh.visible = false;
      passMesh.name = `ra2-sprites-${pass}`;
      // Just before this layer's own pass, whatever renderOrder its owner gives the layer later.
      const main = this.mesh;
      Object.defineProperty(passMesh, 'renderOrder', {
        get: () => main.renderOrder - 0.02 + i * 0.01,
        set: () => {},
        configurable: true,
      });
      this.mesh.add(passMesh);
      look.groundPasses.add(passMesh);
      if (pass === 'over')
        passMesh.onBeforeRender = (renderer, _scene, camera) => {
          const target = renderer.getRenderTarget();
          if (target) planeSize.set(target.width, target.height);
          else renderer.getDrawingBufferSize(planeSize);
          groundPlaneDepth(camera as OrthographicCamera, planeSize.x, planeSize.y, this.planeCoefficients.value);
        };
      return passMesh;
    });
    material.addEventListener('dispose', () => {
      readOnlyMaterial.dispose();
      unitMaterial.dispose();
      translucentMaterial.dispose();
      for (const passMesh of this.groundPasses) (passMesh.material as MeshBasicNodeMaterial).dispose();
    });
    this.mesh.addEventListener('dispose', () => {
      this.readOnlyMesh.dispose();
      this.unitMesh.dispose();
      this.translucentMesh.dispose();
      capture?.setCaptured(this.mesh, false);
      capture?.setCaptured(this.unitMesh, false);
      for (const passMesh of this.groundPasses) {
        look.groundPasses.delete(passMesh);
        passMesh.dispose();
      }
    });
    this.setInstances(instances);
  }

  /** With unchanged membership/metadata, interpolation only updates the retained records and skips ordering. */
  setInstances(instances: readonly SpriteInstance[], reorder = true): void {
    this.instances = instances;
    const cards = this.orderedCards;
    // Instanced meshes are not sorted by Three. Back-to-front within each page preserves soft-edge blending;
    // physical fragment depth resolves opaque overlaps between pages and voxel meshes independently of draw calls.
    if (reorder || instances.length !== this.instanceCount) {
      cards.length = 0;
      for (const instance of instances) if (instanceRank(instance) === 3) cards.push(instance);
      cards.sort(compareCards);
    }
    this.instanceCount = instances.length;
    // Stable partition by rank: the former stable sort's exact order, without a copied/sorted array.
    let count = 0;
    let readOnly = false;
    let units = false;
    let translucent = false;
    for (let rank = 0; rank < 4 && count < this.capacity; rank++) {
      const list = rank === 3 ? cards : instances;
      for (let j = 0; j < list.length && count < this.capacity; j++) {
        const s = list[j]!;
        if (instanceRank(s) !== rank) continue;
        const i = count++;
        if (this.capture) this.uploaded[i] = s;
        this.anchor.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
        this.anchor.setComponent(i, 3, s.lightSample?.[0] ?? s.anchor.x);
        this.anchor.setComponent(i, 4, s.lightSample?.[1] ?? s.anchor.z);
        this.rect.setXYZW(i, s.frame.rect[0], s.frame.rect[1], s.frame.rect[2], s.frame.rect[3]);
        this.params.setXYZW(i, s.frame.offset[0], s.frame.offset[1], this.cache.paletteRow.get(s.palette) ?? 0, s.push);
        this.flags.setXYZW(
          i,
          instanceCode(s),
          s.light ?? 1,
          LIGHTING_CODE[s.lighting ?? 'ambient'],
          instanceCode(s) === 1
            ? Math.max(0, Math.min(1, s.glint ?? 0))
            : s.shadow && s.infantryShadow
              ? 1
              : s.flat || s.shadow || s.kind
                ? 0
                : spritePainterBias(s.painter, s.painterPart),
        );
        const foundation = s.painter?.foundation;
        const dx = foundation ? s.anchor.x - s.painter!.x : 0;
        const dz = foundation ? s.anchor.z - s.painter!.z : 0;
        if (this.capture) this.flags.setComponent(i, 8, NOT_CAPTURED_CODE);
        this.flags.setComponent(i, 4, s.deckHeight !== undefined ? -1 : (foundation?.[0] ?? 0));
        this.flags.setComponent(i, 5, s.deckHeight ?? foundation?.[1] ?? 0);
        this.flags.setComponent(i, 6, dx - dz);
        this.flags.setComponent(i, 7, -dx - dz);
        const native = !s.flat && !s.shadow && !s.kind ? s.nativeDepth : undefined;
        const at = this.capture ? 9 : 8;
        this.flags.setComponent(i, at, native?.mode === 'body' ? 1 : native?.mode === 'ground' ? 2 : native ? 3 : 0);
        this.flags.setComponent(
          i,
          at + 1,
          native?.mode === 'body' ? native.origin[0] : native?.mode === 'card' ? native.bottom : 0,
        );
        this.flags.setComponent(
          i,
          at + 2,
          native?.mode === 'body' ? native.origin[1] : native?.mode === 'card' ? native.bonus : 0,
        );
        this.flags.setComponent(
          i,
          at + 3,
          native?.mode === 'body' ? native.base : native?.mode === 'ground' ? native.bonus : 0,
        );
        this.flags.setComponent(i, at + 4, native?.offset?.[0] ?? 0);
        this.flags.setComponent(i, at + 5, native?.offset?.[1] ?? 0);
        this.flags.setComponent(i, at + 6, native?.anchorPush ?? 0);
        const opacity = instanceCode(s) === 0 ? Math.max(0, Math.min(1, s.opacity ?? 1)) : 1;
        const blending = opacity < 1;
        const testOnly = !blending && s.depthWrite === false && instanceCode(s) === 0;
        const unit = !testOnly && native?.mode === 'card' && !foundation;
        this.flags.setComponent(i, at + 7, blending ? 3 + opacity : testOnly ? 1 : unit ? 2 : 0);
        readOnly ||= testOnly;
        units ||= !blending && unit;
        translucent ||= blending;
      }
    }
    if (this.capture) this.uploaded.length = count;
    this.mesh.count = count;
    this.readOnlyMesh.count = count;
    this.readOnlyMesh.visible = readOnly;
    this.unitMesh.count = count;
    this.unitMesh.visible = units;
    this.translucentMesh.count = count;
    this.translucentMesh.visible = translucent;
    for (const passMesh of this.groundPasses) passMesh.count = count;
    this.anchor.flush();
    this.rect.flush();
    this.params.flush();
    this.flags.flush();
  }
  /** Update only the retained anchor code; main/mirror colours and surface depth are unchanged. */
  updateCaptureCodes(codeFor: (instance: SpriteInstance) => number): void {
    if (!this.capture) return;
    let captured = false;
    let unitsCaptured = false;
    for (let i = 0; i < this.uploaded.length; i++) {
      const instance = this.uploaded[i]!;
      const value =
        instanceCode(instance) === 0 && instance.depthWrite !== false && (instance.opacity ?? 1) >= 1
          ? codeFor(instance)
          : NOT_CAPTURED_CODE;
      this.flags.setComponent(i, 8, value);
      captured ||= value !== NOT_CAPTURED_CODE;
      unitsCaptured ||=
        value !== NOT_CAPTURED_CODE && instance.nativeDepth?.mode === 'card' && !instance.painter?.foundation;
    }
    this.flags.flush();
    this.capture.setCaptured(this.mesh, captured);
    this.capture.setCaptured(this.unitMesh, unitsCaptured);
  }
}

function compareCards(a: SpriteInstance, b: SpriteInstance): number {
  if (a.painter && b.painter)
    return comparePainterOrder(a.painter, b.painter) || (a.painterPart ?? 0) - (b.painterPart ?? 0);
  if (a.painter || b.painter) return Number(!!a.painter) - Number(!!b.painter);
  return a.anchor.x + a.anchor.z - b.anchor.x - b.anchor.z;
}

/**
 * World anchor for a map object's engine draw point: the projected top corner of its cell plus `drawOffset`, lifted
 * back onto the ground plane at the object's level so the card sits where the engine draws it.
 */
export function objectAnchor(object: MapObject, out = new Vector3()): Vector3 {
  const sx = (object.x - object.y) * 30;
  const sy = (object.x + object.y) * 15 - object.z * 15;
  const dx = object.drawOffset?.[0] ?? 0;
  const dy = object.drawOffset?.[1] ?? 15;
  const diff = (sx + dx) / 30;
  const sum = (sy + dy + object.z * 15) / 15;
  return out.set((sum + diff) / 2, object.z * LEVEL_HEIGHT, (sum - diff) / 2);
}
