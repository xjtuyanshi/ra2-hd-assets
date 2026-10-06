import {
  Color,
  CustomBlending,
  DataTexture,
  Group,
  LinearFilter,
  MeshBasicNodeMaterial,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type Texture,
  Vector2,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  clamp,
  float,
  floor,
  attribute,
  length,
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
import type { EffectHdFrame } from '../../../ra2-assets/src/effects';
import type { SpriteFrame } from '../../../ra2-assets/src/manifest';
import { DirtyAttribute } from '../dirtyAttribute';
import { InstancedQuad, instancedQuadGeometry } from '../instancedQuad';
import { bindSlotsBeforeRender, samplingClass, slotMaterial, textureSlot } from '../materialSlots';
import type { ShaderNode } from '../tsl';
import type { TerrainDepth } from '../terrainDepth';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import type { Ra2Cache } from '../ra2/cache';
import { cardDepthNode, EFFECT_DECAL_LIFT } from '../ra2/cardDepth';
import {
  fireballDepthBiasNode,
  fireballRadius,
  packEffectDrawRadius,
  unpackEffectDrawRadiusNode,
} from '../ra2/fireballDepth';
import { MAX_PAINTER_BIAS, spritePainterBias, type PainterObject } from '../ra2/painterOrder';
import type { EffectCategory } from './effectTable';

/** How an effect frame is drawn. */
export type EffectDraw = 'card' | 'flat' | 'shadow';
/**
 * Draw pass, following the engine's layers: Ground and Air both test object/terrain Z. Air composites later,
 * without writing depth. Non-flat Air cards pull ahead of terrain-class pixels in the main view; against units and
 * buildings explosions keep their bounded spherical front and other art keeps anchor depth. Top is untested.
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
  /** Legacy effect-only ordering (projected screen y); kept for back-to-front transparency within an effect page. */
  depth: number;
  /** Fire-coloured pixels may glow slightly (anim palette art). */
  glow: boolean;
  /** Tracked anim classification, independent of whether native or HD art supplies its frame. */
  category?: EffectCategory;
  /**
   * Extra world units the card's depth comes towards the camera (a merged building-death fireball engulfs the building
   * it stands in, see FIREBALL_MERGE in effects.ts). Placement is unchanged.
   */
  depthBias?: number;
  /** Ground effects use the same physical card depth profile as trees and units. */
  painter?: PainterObject;
  painterPart?: number;
  /** Optional RGBA replacement: engine frames remain the clock, with a presentation-rate blend within one stage. */
  hd?: {
    frame: EffectHdFrame;
    next: EffectHdFrame | null;
    scale: number;
    /** Display size around the native canvas centre; atlas sampling stays in native pixels. Defaults to 1. */
    size?: number;
    blend0: number;
    t0: number;
    stageSeconds: number;
  };
}

/** Fire-coloured pixels (hue 15..65 degrees, value > 0.7) are brightened by this, just over the bloom threshold. */
export const FX_GLOW = 1.25;
/**
 * Redrawn RGBA fire is self-lit (smoke and debris keep the scene's sprite light), in two tiers. Orange and red flame is
 * shown at about its painted colour (HD_FX_FIRE): the display clips each channel at 1, so any HDR gain on a saturated
 * orange raises green towards red and turns the whole fireball pale yellow with a hard orange outline (the look the art
 * director rejected as "too few colours"). Only the white-yellow core (display green and blue both high) is pushed
 * into HDR (HD_FX_EMISSIVE), where it clips to white-hot and feeds the bloom. Both are display-referred: the material
 * divides them by the renderer's exposure (EffectSpriteLayer.displayScale).
 */
export const HD_FX_FIRE = 1.0;
/** Flame grade of redrawn fire: share of the temperature re-map (0 = the redraw's own colours) and the heat gamma. */
export const HD_FX_GRADE = 0.85;
export const HD_FX_GAMMA = 1.25;
/**
 * Display-referred (sRGB) flame colour by heat 0..1: dark red-brown, deep red, orange, yellow-orange, yellow, white-hot.
 * The stops sit where heat = dot(display colour, (0.25, 0.5, 0.25)) puts those colours. L5 used a red-heavy ramp with
 * a heat gamma of 2.3, which turned the redraws' whole mid-life fireball red-orange around a dark core (review crop at
 * 0.7 s: mean flame hue 23.6 degrees, 58 % red, against the target painting's 29.1 degrees and 40 %). The fix-round
 * ramp keeps red for the coolest flame only (the fringe), spends the middle heats on orange and yellow-orange, and
 * reaches a warm white for the core, as in the target painting.
 */
const FLAME_STOPS: readonly [number, [number, number, number]][] = [
  [0, [0.16, 0.03, 0.01]],
  [0.24, [0.72, 0.16, 0.03]],
  [0.4, [1.0, 0.5, 0.09]],
  [0.56, [1.0, 0.64, 0.16]],
  [0.74, [1.0, 0.83, 0.4]],
  [1, [1.0, 0.97, 0.86]],
];
function flameRampDisplay(heat: ShaderNode): ShaderNode {
  let rgb: ShaderNode = vec3(...FLAME_STOPS[0]![1]);
  for (let i = 1; i < FLAME_STOPS.length; i++) {
    const [t0] = FLAME_STOPS[i - 1]!;
    const [t1, c1] = FLAME_STOPS[i]!;
    rgb = mix(rgb, vec3(...c1), clamp(heat.sub(t0).div(t1 - t0), 0, 1));
  }
  return rgb;
}
/**
 * HDR gain of the white-hot core. The volumetric redraws paint separate white-hot patches between orange flame and
 * soot; a gain of 2 let the bloom merge them into one white blob over the soot, so the core sits just over the bloom
 * threshold. The heat gamma above (2.3) likewise keeps more of the flame orange, red and crimson.
 */
export const HD_FX_EMISSIVE = 1.4;
/**
 * Exponents applied to the anim's translucency fade (animAlphaSmooth) on redrawn frames: smoke keeps more body than the
 * fade asks for and flame most of it, because the redrawn frames already thin out on their own.
 */
export const HD_FX_FADE = { smoke: 0.25, flame: 0.12 };
/** Half-width of the frame crossfade around mid-stage (EffectSpriteLayer.hdBlendWidth; 0.5 = a whole-stage blend). */
export const HD_FX_BLEND_WIDTH = 0.25;
const CAPACITY = 4096;
/** Quads are one texel larger on every side, so the filtered edge can fade out instead of being cut. */
const MARGIN = 1;
const RENDER_ORDER: Record<EffectPass, number> = { ground: 6, air: 7, top: 8 };
const DRAW_RANK: Record<EffectDraw, number> = { flat: 0, shadow: 1, card: 2 };

export interface EffectDisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Displayed crop union in screen-plane world units, including HD size and the shader's same-page successor rule. */
export function effectDisplayBounds(instance: EffectInstance, out: EffectDisplayBounds): void {
  const hd = instance.hd;
  const frame = hd?.frame ?? instance.frame;
  const next = hd && hd.next && hd.next.page === frame.page ? hd.next : frame;
  const scale = hd?.scale ?? 1;
  const display = (hd?.size ?? 1) / PIXELS_PER_CELL_EDGE;
  const x = Math.min(frame.offset[0], next.offset[0]);
  const y = Math.min(frame.offset[1], next.offset[1]);
  out.x = x * display;
  out.y = y * display;
  out.width = (Math.max(frame.offset[0] + frame.rect[2] / scale, next.offset[0] + next.rect[2] / scale) - x) * display;
  out.height = (Math.max(frame.offset[1] + frame.rect[3] / scale, next.offset[1] + next.rect[3] / scale) - y) * display;
}
/** Eligible Air explosion radius from the displayed frame union; different-page HD successors are held. */
export function effectSphereRadius(instance: EffectInstance): number {
  if (
    instance.draw !== 'card' ||
    instance.pass !== 'air' ||
    (instance.category !== 'explosion' && instance.category !== 'collapse')
  )
    return 0;
  const hd = instance.hd;
  if (!hd)
    return fireballRadius(instance.frame.rect[2] / PIXELS_PER_CELL_EDGE, instance.frame.rect[3] / PIXELS_PER_CELL_EDGE);
  const frame = hd.frame;
  const next = hd.next?.page === frame.page ? hd.next : frame;
  const width =
    Math.max(frame.offset[0] + frame.rect[2] / hd.scale, next.offset[0] + next.rect[2] / hd.scale) -
    Math.min(frame.offset[0], next.offset[0]);
  const height =
    Math.max(frame.offset[1] + frame.rect[3] / hd.scale, next.offset[1] + next.rect[3] / hd.scale) -
    Math.min(frame.offset[1], next.offset[1]);
  const display = (hd.size ?? 1) / PIXELS_PER_CELL_EDGE;
  return fireballRadius(width * display, height * display);
}
const cardPainterBias = (instance: EffectInstance): number => {
  if (instance.draw !== 'card' || instance.pass === 'top') return 0;
  // Keep the traversal budget against units/facades; the separate whole-object combination restores Air engulf ordering.
  return instance.pass === 'air' ? MAX_PAINTER_BIAS : spritePainterBias(instance.painter, instance.painterPart);
};
const compareCards = (a: EffectInstance, b: EffectInstance): number => {
  const rank = DRAW_RANK[a.draw] - DRAW_RANK[b.draw];
  if (rank) return rank;
  return a.depth - b.depth;
};
interface PageGroup {
  key: string;
  instances: EffectInstance[];
}

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
  /** Native Top art composites after the visibility mask, in the renderer's transparent top pass. */
  readonly topRoot = new Group();
  readonly light = uniform(new Color(1, 1, 1));
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  /** Renderer seconds, updated each presentation without rebuilding the engine's card instances. */
  readonly now = uniform(0);
  /** Self-light of redrawn flame and of its white-hot core (HD_FX_FIRE, HD_FX_EMISSIVE; uniforms for look reviews). */
  readonly hdFireGain = uniform(HD_FX_FIRE);
  readonly hdHotGain = uniform(HD_FX_EMISSIVE);
  /** 1 / the renderer's mean exposure (HdRenderer.meanExposure): the self-lit gains above are display-referred. */
  readonly displayScale = uniform(1);
  /** Flame grade of redrawn fire (see HdPageMesh): share of the temperature re-map and the gamma on flame heat. */
  readonly hdFireGrade = uniform(HD_FX_GRADE);
  readonly hdFireGamma = uniform(HD_FX_GAMMA);
  /** Exponents on the anim's translucency fade for redrawn smoke and flame (HD_FX_FADE; uniforms for look reviews). */
  readonly hdSmokeFade = uniform(HD_FX_FADE.smoke);
  readonly hdFlameFade = uniform(HD_FX_FADE.flame);
  /**
   * Half-width of the crossfade between consecutive redrawn frames, centred on the middle of the engine stage (0.5 =
   * a linear blend over the whole stage). Chaotic flame blended across a whole stage reads as a soft double exposure.
   */
  readonly hdBlendWidth = uniform(HD_FX_BLEND_WIDTH);
  /**
   * The scene drawn so far, for the display-space mix of translucent cards. One node shared by every page mesh: three
   * copies the framebuffer once per render for each distinct node (NodeUpdateType.RENDER, keyed by the node), and each
   * copy ends and restarts the scene pass (costly under MSAA). With one node the copy happens once, before the first
   * translucent card; later meshes mix against that copy, so a translucent card over another card or over HD garnish
   * drawn after it blends linearly with those, a small difference. Meshes with only opaque cards use a material without
   * it, and empty meshes are hidden, so a frame without translucent cards copies nothing.
   */
  readonly backdrop: ShaderNode = viewportSharedTexture(screenUV);
  /**
   * Whether translucent cards mix with the scene in display space (see `backdrop`). Off, they blend in linear light
   * like every other card and no copy of the frame is made: half-transparent art over mid-tones comes out a little
   * lighter, and the multisampled scene pass is not ended and restarted for the copy (2 to 3 ms at 3120x2096). A
   * renderer short of frame time switches it off (LiveView, from HdRenderer.quality); it applies from the next time
   * the instances are set.
   */
  backdropMix = true;
  private readonly meshes = new Map<string, PageMesh | HdPageMesh>();
  /**
   * Shader graphs by kind and pass (see materialSlots.ts): every page mesh of a kind draws with a clone of its
   * graph's material, bound to its own page before each draw. Pages differ in size and texture only; as shader text
   * (the atlas size was a literal) each of the 48 effect pages had a shader module and a pipeline of its own per
   * pass, built when its first anim played and again whenever its mesh had been idle and was disposed.
   */
  private readonly graphs = new Map<string, EffectGraph>();
  /**
   * Page meshes that went idle, by graph: the next page of that kind and pass draws with one of them (its buffers,
   * its materials and the shaders three built for it), bound to the new page. Disposing an idle mesh, as before,
   * dropped the built shader and the pipeline with the last mesh of a kind, and the next battle built them again in
   * the frame of its first explosion.
   */
  private readonly spare = new Map<EffectGraph, (PageMesh | HdPageMesh)[]>();
  /** Pages that failed to load and were already reported (their instances are skipped, not retried per frame). */
  private readonly failedPages = new Set<string>();
  private readonly pageGroups = new Map<string, Record<EffectPass, PageGroup>>();
  private readonly groups: PageGroup[] = [];
  private readonly idle: string[] = [];
  private readonly releaseCandidates = new Set<string>();

  constructor(
    private readonly cache: Ra2Cache,
    /**
     * Atlas page textures: the page, 'loading' while it loads, or null when it failed or does not exist (settled: its
     * instances are skipped until the source reports it again).
     */
    private readonly pageSource: (page: number) => EffectPage | 'loading' | null,
    /** Called with pages no mesh has drawn for MESH_IDLE_SECONDS, so their textures can be released. */
    private readonly releasePage: (page: number) => void = () => {},
    /** Optional RGBA pages; HD instances are skipped entirely when this source is absent. */
    private readonly hdPageSource?: (page: number) => EffectPage | 'loading' | null,
    private readonly releaseHdPage: (page: number) => void = () => {},
    readonly terrainDepth?: TerrainDepth,
  ) {
    this.root.name = 'live-effect-sprites';
    this.topRoot.name = 'live-top-effect-sprites';
  }

  /**
   * Replace every instance; instances whose page is still loading are skipped. Returns false when some were skipped
   * for a page that is still loading, so the caller sets them again on a later frame; pages that failed are settled
   * (skipped, warned about once). `now` (seconds) ages idle meshes: a mesh left empty for MESH_IDLE_SECONDS is
   * disposed, and its page released when no other mesh uses it.
   */
  setInstances(instances: readonly EffectInstance[], now = performance.now() / 1000): boolean {
    for (const group of this.groups) group.instances.length = 0;
    for (const instance of instances) {
      if (instance.hd && !this.hdPageSource) continue;
      const page = instance.hd ? `hd:${instance.hd.frame.page}` : `${instance.frame.page ?? 0}`;
      let groups = this.pageGroups.get(page);
      if (!groups) {
        groups = {
          ground: { key: `${page}:ground`, instances: [] },
          air: { key: `${page}:air`, instances: [] },
          top: { key: `${page}:top`, instances: [] },
        };
        this.pageGroups.set(page, groups);
        this.groups.push(groups.ground, groups.air, groups.top);
      }
      groups[instance.pass].instances.push(instance);
    }
    let complete = true;
    this.idle.length = 0;
    for (const { key, instances: list } of this.groups) {
      const mesh = list.length ? this.mesh(key) : this.meshes.get(key);
      if (mesh === 'loading') complete = false;
      else if (mesh) {
        mesh.set(list, this.cache, now);
        if (!list.length && now - mesh.lastUsed > MESH_IDLE_SECONDS) this.idle.push(key);
      }
    }
    // `now` = Infinity empties the layer for good (the view is disposed): nothing is kept for reuse.
    if (this.idle.length || now === Infinity) this.evict(this.idle, now === Infinity);
    return complete;
  }

  /**
   * Put one idle page mesh of every kind and pass into the scene (indexed opaque, indexed translucent, redrawn RGBA;
   * hidden, without instances), so that a warm frame (HdRenderer.warm) builds their shaders and pipelines before the
   * view is shown: a match's first explosion otherwise builds them in the frame that shows it, once per render pass
   * that draws the scene. The meshes then wait as spares for the first pages of their kind.
   */
  warm(): void {
    if (this.warmed) return;
    this.warmed = true;
    const indexed = placeholderPage(false);
    const redrawn = placeholderPage(true);
    for (const pass of ['ground', 'air', 'top'] as const) {
      const meshes: (PageMesh | HdPageMesh)[] = [
        new PageMesh(this, this.cache, indexed, pass),
        new PageMesh(this, this.cache, indexed, pass).warmTranslucent(),
      ];
      if (this.hdPageSource) meshes.push(new HdPageMesh(this, redrawn, pass));
      for (const mesh of meshes) {
        (pass === 'top' ? this.topRoot : this.root).add(mesh.mesh);
        let spare = this.spare.get(mesh.graph);
        if (!spare) this.spare.set(mesh.graph, (spare = []));
        spare.push(mesh);
      }
    }
  }
  private warmed = false;

  /** Instances currently drawn (for diagnostics). */
  get count(): number {
    let n = 0;
    for (const mesh of this.meshes.values()) n += mesh.mesh.instances;
    return n;
  }

  get topVisible(): boolean {
    return this.topRoot.children.some((child) => child.visible && (child as InstancedQuad).instances > 0);
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

  /** The graph of a kind of page mesh ('indexed', 'indexed-translucent' or 'hd') in a pass, built on first use. */
  graph(
    kind: string,
    pass: EffectPass,
    atlas: EffectPage,
    build: (page: EffectGraph) => MeshBasicNodeMaterial,
  ): EffectGraph {
    // The page's sampling class is part of the shader (see samplingClass): pages of another class get another graph.
    const sampling = samplingClass(atlas.texture);
    const key = `${kind}:${pass}:${sampling}`;
    let graph = this.graphs.get(key);
    if (!graph) {
      graph = { atlas: textureSlot(sampling), atlasSize: uniform(new Vector2(1, 1)), material: null! };
      graph.material = build(graph);
      this.graphs.set(key, graph);
    }
    return graph;
  }

  private mesh(key: string): PageMesh | HdPageMesh | 'loading' | null {
    const known = this.meshes.get(key);
    if (known) return known;
    const split = key.lastIndexOf(':');
    const pageKey = key.slice(0, split);
    const pass = key.slice(split + 1) as EffectPass;
    const hd = pageKey.startsWith('hd:');
    const page = Number(hd ? pageKey.slice(3) : pageKey);
    const atlas = hd ? this.hdPageSource?.(page) : this.pageSource(page);
    if (atlas === 'loading') return 'loading';
    if (!atlas) {
      if (!this.failedPages.has(pageKey)) {
        this.failedPages.add(pageKey);
        console.warn(`[HD] effect atlas page ${pageKey} could not be loaded: its effects are not drawn`);
      }
      return null;
    }
    this.failedPages.delete(pageKey);
    const graph = hd ? HdPageMesh.graph(this, atlas, pass) : PageMesh.graph(this, this.cache, atlas, pass);
    const mesh =
      this.spare.get(graph)?.pop()?.reuse(atlas) ??
      (hd ? new HdPageMesh(this, atlas, pass) : new PageMesh(this, this.cache, atlas, pass));
    this.meshes.set(key, mesh);
    (pass === 'top' ? this.topRoot : this.root).add(mesh.mesh);
    return mesh;
  }

  /**
   * Take idle meshes out of the scene and release pages that no remaining mesh draws from. The meshes are kept for
   * the next page of their kind (see `spare`), unless the layer is being emptied for good (`dispose`).
   */
  private evict(keys: readonly string[], dispose = false): void {
    const pages = this.releaseCandidates;
    pages.clear();
    for (const key of keys) {
      const mesh = this.meshes.get(key)!;
      this.meshes.delete(key);
      mesh.mesh.removeFromParent();
      if (dispose) mesh.dispose();
      else {
        let spare = this.spare.get(mesh.graph);
        if (!spare) this.spare.set(mesh.graph, (spare = []));
        spare.push(mesh);
      }
      pages.add(key.slice(0, key.lastIndexOf(':')));
    }
    if (dispose) {
      for (const spare of this.spare.values()) for (const mesh of spare) mesh.dispose();
      this.spare.clear();
    }
    for (const key of this.meshes.keys()) pages.delete(key.slice(0, key.lastIndexOf(':')));
    for (const page of pages)
      if (page.startsWith('hd:')) this.releaseHdPage(Number(page.slice(3)));
      else this.releasePage(Number(page));
  }
}

/** An atlas page as the layer draws it. */
export interface EffectPage {
  texture: Texture;
  width: number;
  height: number;
}

const placeholders: Partial<Record<'indexed' | 'redrawn', EffectPage>> = {};
/** A one-texel page of the sampling class of real pages (indexed: texel loads; redrawn RGBA: filtered samples). */
function placeholderPage(redrawn: boolean): EffectPage {
  const kind = redrawn ? 'redrawn' : 'indexed';
  let page = placeholders[kind];
  if (!page) {
    const texture = new DataTexture(new Uint8Array(4), 1, 1);
    if (redrawn) texture.magFilter = texture.minFilter = LinearFilter;
    texture.needsUpdate = true;
    page = placeholders[kind] = { texture, width: 1, height: 1 };
  }
  return page;
}

/** A shader graph of page meshes: the prototype material and the slots its shader reads the page from. */
interface EffectGraph {
  material: MeshBasicNodeMaterial;
  atlas: ShaderNode;
  atlasSize: ShaderNode;
}

/** A page mesh's own material of a graph: a clone, bound to the mesh's current page before each draw. */
function pageMaterial(graph: EffectGraph, page: () => EffectPage): MeshBasicNodeMaterial {
  return slotMaterial(graph.material, () => {
    const atlas = page();
    graph.atlas.value = atlas.texture;
    (graph.atlasSize.value as Vector2).set(atlas.width, atlas.height);
  });
}

/** Seconds a page mesh may stay empty before it is disposed (and its page released when nothing else uses it). */
export const MESH_IDLE_SECONDS = 90;

class PageMesh {
  readonly mesh: InstancedQuad;
  /** Whether the current instances include translucent cards (the mesh then uses the display-space mix). */
  translucent = false;
  /** Seconds (setInstances clock) the mesh last drew anything; set on its first instances. */
  lastUsed = -Infinity;
  private readonly anchor: DirtyAttribute;
  private readonly rect: DirtyAttribute;
  private readonly params: DirtyAttribute;
  private readonly style: DirtyAttribute;
  private readonly opaqueMaterial: MeshBasicNodeMaterial;
  /** Built on the first translucent card (pages of opaque art never compile it). */
  private translucentMaterial: MeshBasicNodeMaterial | null = null;

  /** The opaque graph of indexed pages like `atlas` in `pass`: also what decides which idle meshes can be reused. */
  static graph(layer: EffectSpriteLayer, cache: Ra2Cache, atlas: EffectPage, pass: EffectPass): EffectGraph {
    return layer.graph('indexed', pass, atlas, (page) => PageMesh.buildMaterial(layer, cache, pass, false, page));
  }

  readonly graph: EffectGraph;

  constructor(
    private readonly layer: EffectSpriteLayer,
    private readonly cache: Ra2Cache,
    private atlas: EffectPage,
    private readonly pass: EffectPass,
  ) {
    this.graph = PageMesh.graph(layer, cache, atlas, pass);
    this.anchor = new DirtyAttribute(new Float32Array(CAPACITY * 3), 3);
    this.rect = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
    // x, y = frame offset from the canvas centre (px); z = palette row; w = push.
    this.params = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
    // x = opacity; y = draw mode + sphere R/4 (see packEffectDrawRadius); z = glow; w = traversal + legacy bias.
    this.style = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
    this.opaqueMaterial = this.material(false);
    const geometry = instancedQuadGeometry();
    geometry.setAttribute('fxAnchor', this.anchor);
    geometry.setAttribute('fxRect', this.rect);
    geometry.setAttribute('fxParams', this.params);
    geometry.setAttribute('fxStyle', this.style);
    this.mesh = new InstancedQuad(this.opaqueMaterial, CAPACITY, geometry);
    this.mesh.onBeforeRender = bindSlotsBeforeRender;
    this.mesh.renderOrder = RENDER_ORDER[pass];
    this.mesh.name = `live-effects-${pass}`;
    // Hidden while empty: a hidden mesh runs no node updates (a visible one with count 0 still would).
    this.mesh.visible = false;
  }

  /**
   * The card material. `translucent` mixes cards with alpha < 1 into the scene below in display space (the engine's
   * 16-bit colour mix) and needs the layer's backdrop copy; the opaque variant draws the same art without it.
   */
  private material(translucent: boolean): MeshBasicNodeMaterial {
    const { layer, cache, pass } = this;
    const graph = translucent
      ? layer.graph('indexed-translucent', pass, this.atlas, (page) =>
          PageMesh.buildMaterial(layer, cache, pass, true, page),
        )
      : this.graph;
    // The mesh's page, whichever it is when the mesh is drawn (an idle mesh is reused for another page).
    return pageMaterial(graph, () => this.atlas);
  }

  /** Draw another page of the same kind with this (idle) mesh. */
  reuse(atlas: EffectPage): this {
    this.atlas = atlas;
    this.lastUsed = -Infinity;
    return this;
  }

  /** Draw with the translucent material from the start (a warm frame builds it; `set` chooses again per frame). */
  warmTranslucent(): this {
    this.translucentMaterial ??= this.material(true);
    this.mesh.material = this.translucentMaterial;
    return this;
  }

  /** The graph's material: instance data by attribute name from the drawn mesh's geometry, the page from `page`. */
  private static buildMaterial(
    layer: EffectSpriteLayer,
    cache: Ra2Cache,
    pass: EffectPass,
    translucent: boolean,
    page: EffectGraph,
  ): MeshBasicNodeMaterial {
    const atlas = { texture: page.atlas as unknown as Texture };
    const aAnchor: ShaderNode = attribute('fxAnchor', 'vec3');
    const aRect: ShaderNode = attribute('fxRect', 'vec4');
    const aParams: ShaderNode = attribute('fxParams', 'vec4');
    const aStyle: ShaderNode = attribute('fxStyle', 'vec4');
    const { draw, radius } = unpackEffectDrawRadiusNode(aStyle.y);
    const atlasSize: ShaderNode = page.atlasSize;
    const paletteRows = float(cache.paletteAtlas.image.height);
    const ppu = float(PIXELS_PER_CELL_EDGE);
    const margin = float(MARGIN);

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = pass !== 'top';
    material.blending = NormalBlending;
    const u: ShaderNode = uv().x;
    const v: ShaderNode = float(1).sub(uv().y);
    const px = aParams.x.sub(margin).add(u.mul(aRect.z.add(margin.mul(2))));
    const py = aParams.y.sub(margin).add(v.mul(aRect.w.add(margin.mul(2))));
    const r = length(
      vec2(px, py)
        .sub(aParams.xy.add(aRect.zw.mul(0.5)))
        .div(ppu),
    );
    material.depthNode = cardDepthNode(
      px,
      py,
      vec4(0),
      aParams.w,
      fireballDepthBiasNode(r, radius, aStyle.w, py),
      draw.greaterThan(0.5),
    );
    // Native Layer=air covers the entire ground layer, including the card's corners beyond its sphere.
    // Per-pass selection also covers smoke/muzzle Air art; flat/shadow instances retain their original depth.
    if (pass === 'air' && layer.terrainDepth)
      material.depthNode = layer.terrainDepth.node(
        material.depthNode,
        aAnchor.xyz,
        draw.equal(0).select(float(1), float(0)),
      );
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
      const decal = aAnchor.add(vec3(px.div(60).add(py.div(30)), EFFECT_DECAL_LIFT, py.div(30).sub(px.div(60))));
      return draw.greaterThan(0.5).select(decal, card);
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
      // Native Top cloud art remains bright over black shroud; it does not inherit the event's scene illumination.
      const lit: ShaderNode = art.mul(
        pass === 'top' ? vec3(layer.displayScale) : mix(layer.light, vec3(FX_GLOW), fire),
      );
      const isShadow = draw.greaterThan(1.5);
      const shadow = vec4(0, 0, 0, mask.mul(0.5).mul(aStyle.x));
      const a: ShaderNode = mask.mul(aStyle.x);
      // Top has a transparent target, not the scene backdrop; normal alpha composition happens after shroud.
      if (!translucent || pass === 'top') return isShadow.select(shadow, vec4(lit, a));
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

  set(instances: EffectInstance[], cache: Ra2Cache, now: number): void {
    if (instances.length) this.lastUsed = now;
    // An idle mesh that stays idle uploads nothing.
    if (instances.length === 0 && this.mesh.instances === 0) return;
    // Preserve the decal/shadow partition; upright Ground cards use shared slots, other passes retain screen-y order.
    instances.sort(compareCards);
    const count = Math.min(instances.length, CAPACITY);
    let translucent = false;
    for (let i = 0; i < count; i++) {
      const s = instances[i]!;
      this.anchor.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
      this.rect.setXYZW(i, s.frame.rect[0], s.frame.rect[1], s.frame.rect[2], s.frame.rect[3]);
      this.params.setXYZW(i, s.frame.offset[0], s.frame.offset[1], cache.paletteRow.get(s.palette) ?? 0, s.push);
      this.style.setXYZW(
        i,
        s.alpha,
        packEffectDrawRadius(s.draw === 'shadow' ? 2 : s.draw === 'flat' ? 1 : 0, effectSphereRadius(s)),
        s.glow ? 1 : 0,
        cardPainterBias(s) + (s.depthBias ?? 0),
      );
      if (s.alpha < 1 && s.draw !== 'shadow') translucent = true;
    }
    this.anchor.flush();
    this.rect.flush();
    this.params.flush();
    this.style.flush();
    translucent &&= this.layer.backdropMix;
    this.translucent = translucent;
    if (translucent) this.translucentMaterial ??= this.material(true);
    this.mesh.material = translucent ? this.translucentMaterial! : this.opaqueMaterial;
    this.mesh.instances = count;
    this.mesh.visible = count > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.opaqueMaterial.dispose();
    this.translucentMaterial?.dispose();
    this.mesh.dispose();
  }
}

/**
 * Redrawn RGBA cards use the native card projection and depth profile, but never read a palette or the scene backdrop.
 * Both frames share an atlas page and are sampled at the same native-pixel position inside their union, so changes in
 * crop or offset cannot stretch either frame during a blend. A different-page successor is held until the next engine
 * stage; the presentation clock interpolates only, and never chooses or advances an engine frame.
 */
class HdPageMesh {
  readonly mesh: InstancedQuad;
  /** HD alpha uses linear premultiplied blending, never the indexed path's display-space backdrop copy. */
  readonly translucent = false;
  lastUsed = -Infinity;
  // WebGPU allows 8 vertex buffers per pipeline: the card geometry's positions take one (uv is derived from them), so
  // the per-instance data is packed into six vec4 attributes.
  /** xyz = world anchor; w = opacity. */
  private readonly anchor = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
  private readonly rect = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
  private readonly nextRect = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
  /** Current and next frame offsets (native pixels). */
  private readonly offsets = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
  /** x = draw mode + sphere R/4 (see packEffectDrawRadius); y = push; z = traversal + legacy bias; w = HD scale. */
  private readonly style = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
  /** x = blend at push; y = push time; z = seconds per engine stage; w = display size. */
  private readonly timing = new DirtyAttribute(new Float32Array(CAPACITY * 4), 4);
  private readonly material: MeshBasicNodeMaterial;
  readonly graph: EffectGraph;

  /** The graph of RGBA pages like `atlas` in `pass`: also what decides which idle meshes can be reused. */
  static graph(layer: EffectSpriteLayer, atlas: EffectPage, pass: EffectPass): EffectGraph {
    return layer.graph('hd', pass, atlas, (page) => HdPageMesh.buildMaterial(layer, page, pass));
  }

  /** Draw another page of the same kind with this (idle) mesh. */
  reuse(atlas: EffectPage): this {
    this.atlas = atlas;
    this.lastUsed = -Infinity;
    return this;
  }

  constructor(
    layer: EffectSpriteLayer,
    private atlas: EffectPage,
    pass: EffectPass,
  ) {
    this.graph = HdPageMesh.graph(layer, atlas, pass);
    this.material = pageMaterial(this.graph, () => this.atlas);
    const geometry = instancedQuadGeometry();
    geometry.setAttribute('fxAnchor', this.anchor);
    geometry.setAttribute('fxRect', this.rect);
    geometry.setAttribute('fxNextRect', this.nextRect);
    geometry.setAttribute('fxOffsets', this.offsets);
    geometry.setAttribute('fxStyle', this.style);
    geometry.setAttribute('fxTiming', this.timing);
    this.mesh = new InstancedQuad(this.material, CAPACITY, geometry);
    this.mesh.onBeforeRender = bindSlotsBeforeRender;
    this.mesh.renderOrder = RENDER_ORDER[pass];
    this.mesh.name = `live-effects-hd-${pass}`;
    this.mesh.visible = false;
  }

  /** The graph's material: instance data by attribute name from the drawn mesh's geometry, the page from `page`. */
  private static buildMaterial(layer: EffectSpriteLayer, page: EffectGraph, pass: EffectPass): MeshBasicNodeMaterial {
    const atlas = { texture: page.atlas as unknown as Texture };
    const aAnchor: ShaderNode = attribute('fxAnchor', 'vec4');
    const aRect: ShaderNode = attribute('fxRect', 'vec4');
    const aNextRect: ShaderNode = attribute('fxNextRect', 'vec4');
    const aOffsets: ShaderNode = attribute('fxOffsets', 'vec4');
    const aStyle: ShaderNode = attribute('fxStyle', 'vec4');
    const { draw, radius } = unpackEffectDrawRadiusNode(aStyle.x);
    const aTiming: ShaderNode = attribute('fxTiming', 'vec4');
    const scale: ShaderNode = aStyle.w;
    // Union of the current and next frame rects in native pixels (top-left, size).
    const lo: ShaderNode = min(aOffsets.xy, aOffsets.zw);
    const hi: ShaderNode = max(aOffsets.xy.add(aRect.zw.div(scale)), aOffsets.zw.add(aNextRect.zw.div(scale)));
    const aBounds: ShaderNode = vec4(lo, hi.sub(lo));
    const atlasSize: ShaderNode = page.atlasSize;
    const ppu = float(PIXELS_PER_CELL_EDGE);
    const margin = float(MARGIN);
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    // Native Air ordering and whole-object engulf use the combination below. The sphere remains the fallback
    // for unclassified surfaces. Only Top is unconditional.
    material.depthTest = pass !== 'top';
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = OneFactor;
    material.blendDstAlpha = OneMinusSrcAlphaFactor;
    material.premultipliedAlpha = false;
    const gu: ShaderNode = positionGeometry.x.add(0.5);
    const gv: ShaderNode = float(0.5).sub(positionGeometry.y);
    const px: ShaderNode = aBounds.x.sub(margin).add(gu.mul(aBounds.z.add(margin.mul(2))));
    const py: ShaderNode = aBounds.y.sub(margin).add(gv.mul(aBounds.w.add(margin.mul(2))));
    const x = px.mul(aTiming.w);
    const y = py.mul(aTiming.w);
    const centre = aBounds.xy.add(aBounds.zw.mul(0.5)).mul(aTiming.w);
    const r = length(vec2(x, y).sub(centre).div(ppu));
    material.depthNode = cardDepthNode(
      x,
      y,
      vec4(0),
      aStyle.y,
      fireballDepthBiasNode(r, radius, aStyle.z, y),
      draw.greaterThan(0.5),
    );
    if (pass === 'air' && layer.terrainDepth)
      material.depthNode = layer.terrainDepth.node(
        material.depthNode,
        aAnchor.xyz,
        draw.equal(0).select(float(1), float(0)),
      );
    material.positionNode = Fn(() => {
      const card = aAnchor.xyz
        .add(layer.cameraRight.mul(x.div(ppu)))
        .sub(layer.cameraUp.mul(y.div(ppu)))
        .add(layer.toCamera.mul(aStyle.y));
      const decal = aAnchor.xyz.add(vec3(x.div(60).add(y.div(30)), EFFECT_DECAL_LIFT, y.div(30).sub(x.div(60))));
      return draw.greaterThan(0.5).select(decal, card);
    })();
    material.colorNode = Fn(() => {
      const sample = (rect: ShaderNode, offset: ShaderNode): ShaderNode => {
        const local: ShaderNode = vec2(px, py).sub(offset).mul(scale);
        const inside = local.x
          .greaterThanEqual(0)
          .and(local.y.greaterThanEqual(0))
          .and(local.x.lessThan(rect.z))
          .and(local.y.lessThan(rect.w));
        const at = rect.xy.add(clamp(local, vec2(0.5), rect.zw.sub(0.5))).div(atlasSize);
        // Clamp to texel centres and use the base level: automatically generated atlas mipmaps can already contain
        // neighbouring frames, even when their sampling UV is clamped. The PNGs need no special mip-safe gutters.
        // The pages hold PREMULTIPLIED colour (sRGB-encoded) and coverage: light a redrawn frame adds over the grey it
        // was painted on (fire glow, electric arcs) has colour with little or no coverage, which straight alpha cannot
        // store.
        const rgba: ShaderNode = texture(atlas.texture, at).level(float(0));
        return inside.select(rgba, vec4(0));
      };
      const current = sample(aRect, aOffsets.xy);
      const next = sample(aNextRect, aOffsets.zw);
      const stage = clamp(aTiming.x.add(layer.now.sub(aTiming.y).div(max(aTiming.z, 1e-4))), 0, 1);
      const blend = smoothstep(float(0.5).sub(layer.hdBlendWidth), float(0.5).add(layer.hdBlendWidth), stage);
      const rgba: ShaderNode = mix(current, next, blend);
      // Judge fire on the straight display-referred colour; light with little coverage (glow, arcs) is emissive too.
      const rgb = rgba.rgb.div(max(rgba.a, 0.02)).min(1);
      const s0 = pow(rgb.max(0), vec3(1 / 2.2));
      const fire = smoothstep(0.42, 0.85, max(s0.r, max(s0.g, s0.b))).mul(smoothstep(0.06, 0.3, s0.r.sub(s0.b)));
      // Low coverage means added light (fire glow over grey, electric arcs) only when it is coloured: the soft rim of
      // redrawn smoke has low coverage too, and self-lit neutral grey there drew a white outline around every smoke
      // cap and fragment (fix-round crops of the collapse bench at 1.6 s).
      const chroma = max(s0.r, max(s0.g, s0.b)).sub(min(s0.r, min(s0.g, s0.b)));
      const glow = float(1)
        .sub(smoothstep(0.1, 0.6, rgba.a))
        .mul(smoothstep(0.08, 0.25, chroma));
      // White-hot cores (every display channel near 1) carry no red-over-blue excess, so the fire test above misses
      // them; scene-lit they turned grey by day and moonlit blue at night. Lit smoke tops stay below this threshold.
      const whiteHot = smoothstep(0.86, 0.96, min(s0.r, min(s0.g, s0.b)));
      const e = max(max(fire, glow), whiteHot);
      // Flame grade: the redrawn fireballs (like the original's) spend their first frames as a pale yellow-white blob.
      // Re-map flame pixels through a temperature ramp with a gamma on their heat, so only the hottest texels stay
      // white-yellow and the rest spread over yellow, orange and red while keeping the drawn texture. Pixels with
      // little coverage (additive glow) keep their colour: their straight colour is not recoverable.
      const heat = s0.dot(vec3(0.25, 0.5, 0.25));
      const graded: ShaderNode = flameRampDisplay(pow(heat, layer.hdFireGamma));
      const gradeWeight = fire.mul(smoothstep(0.15, 0.45, rgba.a)).mul(layer.hdFireGrade);
      const s = mix(s0, graded, gradeWeight);
      const colour = mix(
        rgba.rgb,
        pow(s, vec3(2.2)).mul(rgba.a),
        gradeWeight.greaterThan(0).select(float(1), float(0)),
      );
      // White-hot: the pale core of the flame (display green and blue both high); orange and red keep their hue.
      const hot = smoothstep(0.72, 0.95, s.g).mul(smoothstep(0.35, 0.75, s.b));
      const gain: ShaderNode = mix(layer.hdFireGain, layer.hdHotGain, hot).mul(layer.displayScale);
      const lit = colour.mul(pass === 'top' ? vec3(layer.displayScale) : mix(layer.light, vec3(gain), e));
      // The anim's translucency fade (animAlphaSmooth) is the engine's stand-in for a dissipating cloud; the redrawn
      // frames already thin out, so smoke keeps more body (sqrt of the fade) and flame most of it (fourth root): a
      // half-transparent fireball over grass mixes to an olive murk, and half-transparent smoke reads as a grey veil.
      const fade: ShaderNode = pow(aAnchor.w, mix(layer.hdSmokeFade, layer.hdFlameFade, e));
      return vec4(lit.mul(fade), rgba.a.mul(fade));
    })();
    return material;
  }

  set(instances: EffectInstance[], _cache: Ra2Cache, now: number): void {
    if (instances.length) this.lastUsed = now;
    if (instances.length === 0 && this.mesh.instances === 0) return;
    instances.sort(compareCards);
    const count = Math.min(instances.length, CAPACITY);
    for (let i = 0; i < count; i++) {
      const s = instances[i]!;
      const hd = s.hd!;
      const frame = hd.frame;
      // No successor (or a different atlas page) means hold the current frame, never fade it to transparent.
      const next = hd.next?.page === frame.page ? hd.next : frame;
      this.anchor.setXYZW(i, s.anchor.x, s.anchor.y, s.anchor.z, s.alpha);
      this.rect.setXYZW(i, ...frame.rect);
      this.nextRect.setXYZW(i, ...next.rect);
      this.offsets.setXYZW(i, ...frame.offset, ...next.offset);
      this.style.setXYZW(
        i,
        packEffectDrawRadius(s.draw === 'flat' ? 1 : 0, effectSphereRadius(s)),
        s.push,
        cardPainterBias(s) + (s.depthBias ?? 0),
        hd.scale,
      );
      this.timing.setXYZW(i, hd.blend0, hd.t0, hd.stageSeconds, hd.size ?? 1);
    }
    this.anchor.flush();
    this.rect.flush();
    this.nextRect.flush();
    this.offsets.flush();
    this.style.flush();
    this.timing.flush();
    this.mesh.instances = count;
    this.mesh.visible = count > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
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

/** Projected screen y, retained for legacy effect-only ordering (object Ground slots use the native key). */
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

/**
 * Continuous Translucent=yes opacity for HD flipbooks: retain the opaque first fifth, then linearly join the native
 * step centres (0.2 End, 1), (0.4 End, 0.75), (0.6 End, 0.5) and the softly held tail (End, 0.3). Stages past End keep
 * that tail until the engine removes the anim. Explicit Translucency= and non-translucent art retain animAlpha exactly.
 */
export function animAlphaSmooth(art: { translucent?: boolean; translucency?: number }, stage = 0, end = 1): number {
  if (!art.translucent) return animAlpha(art, stage, end);
  const phase = Math.max(0, Math.min(1, stage / Math.max(1, end)));
  if (phase <= 0.2) return 1;
  if (phase <= 0.6) return 1.25 - phase * 1.25;
  return 0.5 - ((phase - 0.6) / 0.4) * 0.2;
}
