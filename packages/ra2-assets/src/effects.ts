/**
 * HD effect art sidecar: the contract between `pnpm hd:effects` (node/effectsLibrary.ts, reads the player's own
 * install) and an HD renderer that draws the engine's live anims, projectiles, debris, overlays and smudges with their
 * ORIGINAL art. Everything under gameres/hd-cache/_library/common/effects/ is derived from EA assets and must never be
 * committed or redistributed.
 *
 * Layout (theater-independent data plus per-theater variants in one place):
 *   effects/effects.json          this file (EffectLibrary)
 *   effects/effects-<n>.png       indexed sprite atlas pages (R8, value = palette index, 0 = transparent), each at most
 *                                 LIBRARY_ATLAS_MAX square, exactly like the type library's pages
 *   effects/palettes/<key>.png    256x1 RGB palettes ("anim" = anim.pal; "unit.<theater>", "iso.<theater>",
 *                                 "theater.<theater>" for art that uses a theater palette)
 *   effects/voxels/<ID>.json      voxel models (VoxelModel from manifest.ts) of VoxelAnims debris and voxel projectiles
 *
 * Engine facts the fields encode (YR 1.001; the reader-side evidence is in src/games/yr/effectsReader.ts):
 *   - An anim draws SHP frame Start + stage. One iteration is End frames (art End=, else the SHP body frame count,
 *     halved when Shadow=yes); loops run LoopStart..LoopEnd - 1 and LoopCount=-1 loops until removed.
 *   - The stage advances every `rateFrames` logic frames (animRateFrames): floor(900 / Rate) with the default
 *     Rate=900, and for Normalized=yes anims that value scaled by NORMALIZED_RATE_FACTOR (measured, see there).
 *   - Translucent=yes draws at 50 %; Translucency=25/50/75 draws at 75/50/25 % opacity; Flat=yes lies on the ground;
 *     AltPalette=yes uses the theater unit palette with the owner's remap, otherwise anim.pal.
 */
import type { AtlasRef, SpriteEntry } from './manifest.ts';
import type { TheaterId } from './theater.ts';

export const EFFECT_LIBRARY_VERSION = 1;

/** Optional redrawn flipbooks in common/effects-hd/effects-hd.json, indexed by the native SHP frame numbers. */
export interface EffectHdLibrary {
  version: 1;
  /** RGBA atlas pages: PREMULTIPLIED colour (sRGB-encoded, so light with no coverage can be stored) and coverage. */
  pages: { file: string; width: number; height: number }[];
  anims: Record<string, EffectHdAnim>;
}

export interface EffectHdAnim {
  /** HD texels per native (engine) pixel, e.g. 2. */
  scale: number;
  /** One entry per native SHP frame index (same length as the native frame list); null = an empty native frame. */
  frames: (EffectHdFrame | null)[];
}

export interface EffectHdFrame {
  page: number;
  /** Texel rect in the page: x, y, w, h (HD texels). */
  rect: [number, number, number, number];
  /**
   * Top-left relative to the native SHP canvas centre, in NATIVE pixels (possibly fractional), like SpriteFrame.offset.
   * The rect covers rect.w / scale by rect.h / scale native pixels.
   */
  offset: [number, number];
}

/** Engine draw layer of an anim (AnimTypeClass::Layer; attached anims are drawn in `ground`). */
export type EffectLayer = 'underground' | 'surface' | 'ground' | 'air' | 'top';

export interface EffectLibrary {
  version: typeof EFFECT_LIBRARY_VERSION;
  /** Theaters whose variants this file holds. */
  theaters: TheaterId[];
  /** Palette key -> 256x1 PNG (relative path). */
  palettes: Record<string, string>;
  /** Palette key -> original file (e.g. { anim: "anim.pal", "unit.temperate": "unittem.pal" }). */
  paletteSources: Record<string, string>;
  /** Indexed atlas pages; SpriteFrame.page indexes this list (absent = page 0). */
  spriteAtlases: AtlasRef[];
  /**
   * SHP art keyed "anim:<ID>", "bullet:<ID>", "overlay:<ID>", "smudge:<ID>", "particle:<ID>", with "@<theater>"
   * appended when the art resolves differently per theater. Every body frame, plus shadow frames when the SHP has a
   * shadow half.
   */
  sprites: Record<string, SpriteEntry>;
  /**
   * Every [Animations] entry and every anim id rules or art reference, keyed by anim id, plus the SHP art the
   * executable loads by file name (node/effectsLibrary.ts ENGINE_ANIM_ART, e.g. OREGATH: the sparks under a harvesting
   * miner), recorded with the anim defaults.
   */
  anims: Record<string, EffectAnim>;
  /** BulletTypes with art (SHP or voxel), keyed by rules id. */
  bullets: Record<string, EffectBullet>;
  /** OverlayTypes and SmudgeTypes art (all frames) for runtime cell changes (ore growth, craters, walls). */
  overlays: Record<string, EffectCellArt>;
  smudges: Record<string, EffectCellArt>;
  /** Voxel models by id (VoxelAnims debris such as TIRE, voxel projectiles), relative paths. */
  voxels: Record<string, string>;
  /** ParticleTypes art (smoke, gas, fire particles), keyed by particle type id. */
  particles: Record<string, EffectParticle>;
  /** Rules timing of SHP vehicles the type library does not record (see hd-renderer live/shpUnits.ts). */
  shpUnits: Record<string, { walkRate?: number; idleRate?: number }>;
  /**
   * Building types that store ore (rules Refinery=yes or Storage > 0): their ActiveAnimTwo..Four layers show the
   * house's storage level, so a renderer without that engine state must not draw them. Every other building plays
   * ActiveAnimTwo..Four whenever it is active (CAOILD_F, the oil derrick's flame, is in every native anim list).
   */
  storageBuildings: string[];
  extractor: { tool: string; counts: Record<string, number>; warnings: string[] };
}

/** A sprite id, or one per theater when the art resolves to different files. */
export type EffectSpriteRef = string | Partial<Record<TheaterId, string>>;

export interface EffectAnim {
  sprite: EffectSpriteRef;
  /** "anim" (anim.pal) or "unit" (AltPalette=yes: the map theater's unit palette, remapped by the anim owner). */
  palette: 'anim' | 'unit';
  /** First SHP frame of the anim (art Start=). */
  start: number;
  /** Frames in one iteration (AnimTypeClass::End as the engine resolves it). */
  frameCount: number;
  /** Loop range (absolute SHP frames, LoopEnd exclusive) and LoopCount (-1 = forever). */
  loopStart: number;
  loopEnd: number;
  loopCount: number;
  /**
   * Art RandomLoopDelay=min,max (logic frames): the anim rests on its loop's first frame for a random time between
   * loops (ore twinkles TWNK1 120,300: 95 % of 1,300 reader samples showed frame 0).
   */
  loopDelay?: [min: number, max: number];
  /** Raw art Rate= (frames per minute, 900 = one per logic frame) and Normalized=. */
  rate: number;
  normalized: boolean;
  /** Logic frames per stage step as the engine derives it (animRateFrames). */
  rateFrames: number;
  reverse?: boolean;
  translucent?: boolean;
  /** 0, 25, 50 or 75 (percent see-through). */
  translucency?: number;
  flat?: boolean;
  layer: EffectLayer;
  /** Art Shadow=yes: the sprite's shadow frames are drawn under the anim. */
  shadow?: boolean;
  /** Art XDrawOffset / YDrawOffset (screen pixels) and ZAdjust (depth bias, raw). */
  drawOffset?: [x: number, y: number];
  zAdjust?: number;
  /** Anim that follows when this one ends (art Next=). */
  next?: string;
  /** Art Scorch=yes / Crater=yes (the engine leaves a smudge where it plays). */
  scorch?: boolean;
  crater?: boolean;
  /**
   * Width in pixels of the bright fire/white core (hotW) and of every visible (non-soot) pixel (visW): the widest 2..98
   * percentile extent over all frames. Used to keep HD garnish inside the original's footprint.
   */
  hotW: number;
  visW: number;
}

export interface EffectBullet {
  /** SHP art (anim palette), or a voxel model id in EffectLibrary.voxels (art Voxel=yes). */
  sprite?: EffectSpriteRef;
  voxel?: string;
  /** rules Rotates=yes: SHP frames are directions (frame = facing index), otherwise frame = BulletClass::AnimFrame. */
  rotates?: boolean;
  /** Body frame count of the SHP. */
  frames?: number;
  palette: 'anim' | 'unit';
  translucent?: boolean;
}

export interface EffectCellArt {
  /** Theater variants: overlays and smudges are theater art. */
  sprite: EffectSpriteRef;
  /** Palette key without the theater suffix ("iso", "theater", "unit"). */
  palette: 'iso' | 'theater' | 'unit';
  remap?: boolean;
  /** Draw on the ground (overlay DrawFlat / tiberium, every smudge). */
  flat?: boolean;
  /** Screen offset of the canvas centre from the cell's top corner (overlays, smudges). */
  drawOffset: [x: number, y: number];
}

export interface EffectParticle {
  sprite: EffectSpriteRef;
  palette: 'anim' | 'unit';
  translucent?: boolean;
  translucency?: number;
}

/**
 * Engine factor between the plain and the Normalized=yes step length, measured at GameSpeed=3 from the StageClass
 * Rate the effects reader reports: GAPOWR_A (Rate 220) 7, NAREFNL1 (200) 7, NATSLA_A (450) 3, NAPOWR_A (300) 5,
 * TWLT070/PIFFPIFF/S_CLSN22 (default 900) 2, while plain anims read floor(900 / Rate) (CAOILD_A 220 -> 4, CAOILD_F
 * 300 -> 3, CAAIRP_A 50 -> 18, DEATH_A 10 -> 90, FIRE01 450 -> 2). round(floor(900 / Rate) * k) matches all of them
 * for k in [1.625, 1.75). The reader's own `rate` field (bridge H1) replaces this estimate when it is available.
 */
export const NORMALIZED_RATE_FACTOR = 1.69;

/** Logic frames per stage step of an anim from its art Rate= (default 900) and Normalized= (see the module notes). */
export function animRateFrames(rate: number | undefined, normalized: boolean): number {
  const plain = Math.max(1, Math.floor(900 / Math.max(1, rate ?? 900)));
  return normalized ? Math.max(1, Math.round(plain * NORMALIZED_RATE_FACTOR)) : plain;
}

/**
 * SHP frame the engine shows `age` logic frames after the anim was created, or null once it has ended (fallback when
 * the bridge does not pass the exact frame). Loops repeat LoopStart..LoopEnd - 1; the last iteration runs to the end.
 */
export function animFrameAt(
  anim: Pick<
    EffectAnim,
    'start' | 'frameCount' | 'loopStart' | 'loopEnd' | 'loopCount' | 'rateFrames' | 'reverse' | 'loopDelay'
  >,
  age: number,
  /** Stable per-instance number (the anim's uid): picks its RandomLoopDelay, whose real draw the reader does not see. */
  seed = 0,
): number | null {
  if (age < 0) return null;
  if (anim.loopDelay && anim.loopCount < 0) {
    // Rest on the loop's first frame for the delay, then play the loop once; repeat.
    const [lo, hi] = anim.loopDelay;
    const delay = lo + (Math.abs(Math.imul(seed | 0, 2654435761) >>> 0) % Math.max(1, hi - lo + 1));
    const loopLength = Math.max(1, anim.loopEnd - anim.loopStart) * Math.max(1, anim.rateFrames);
    const phase = age % (delay + loopLength);
    if (phase < delay) return anim.loopStart;
    return anim.loopStart + Math.floor((phase - delay) / Math.max(1, anim.rateFrames));
  }
  const stage = Math.floor(age / Math.max(1, anim.rateFrames));
  const count = Math.max(1, anim.frameCount);
  const loopFirst = Math.max(0, Math.min(count - 1, anim.loopStart - anim.start));
  const loopLast = Math.max(loopFirst + 1, Math.min(count, anim.loopEnd - anim.start));
  const loopLength = loopLast - loopFirst;
  // The first iteration starts at frame 0 and ends at LoopEnd; the middle ones repeat LoopStart..LoopEnd - 1; the last
  // one (a single iteration is also the last) runs from LoopStart to the end.
  let offset: number;
  const iterations = anim.loopCount < 0 ? Infinity : Math.max(1, anim.loopCount);
  if (iterations === 1) {
    if (stage >= count) return null;
    offset = stage;
  } else if (stage < loopLast) offset = stage;
  else {
    const repeat = stage - loopLast;
    const middle = (iterations - 2) * loopLength;
    if (repeat < middle) offset = loopFirst + (repeat % loopLength);
    else {
      const tail = repeat - middle;
      if (loopFirst + tail >= count) return null;
      offset = loopFirst + tail;
    }
  }
  if (anim.reverse) offset = count - 1 - offset;
  return anim.start + offset;
}

/** Resolve a sprite reference for a theater (theater-independent refs pass through). */
export function effectSprite(ref: EffectSpriteRef | undefined, theater: TheaterId): string | undefined {
  if (!ref) return undefined;
  return typeof ref === 'string' ? ref : ref[theater];
}
