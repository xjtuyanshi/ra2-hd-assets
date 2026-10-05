import { DataTexture, LinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { float, sRGBTransferEOTF, sRGBTransferOETF, texture, vec2, vec3, vec4 } from 'three/tsl';
import {
  engineCellLight,
  engineLighting,
  engineShade,
  engineShadeRows,
  type CellGrid,
  type CellLight,
  type EngineLight,
  type EngineLighting,
} from '../../../ra2-assets/src/lights';
import type { AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';

/**
 * The map's own [Lighting] and light sources, applied the way the engine applies them by day.
 *
 * The engine lights every cell with its cell formula (YR 1.001 @0x484180, ported exactly as engineCellLight in
 * ra2-assets lights.ts): intensity I = Ambient - Ground + Level x z plus every light source in reach (lamp posts such
 * as INGALITE add up to their LightIntensity at the post, fading linearly over LightVisibility), and a per-channel tint
 * normalised by its largest channel. It multiplies the 8-bit palette colours of what it draws there, in the palette's
 * own (sRGB) scale, clipped at white:
 * - terrain-class art (tiles, overlays, smudges, trees and other terrain objects) takes I x M x tint, M being the
 *   largest channel of the summed Red/Green/Blue (CellClass +0x10C and the tinted converter);
 * - objects (buildings, vehicles, infantry, aircraft) take I only (CellClass +0x10A), without the tint and without M,
 *   plus their own extra light (rules ExtraUnitLight / ExtraInfantryLight / ExtraAircraftLight, added, not multiplied).
 *   On a map whose Red/Green/Blue are all below 1 (HillBtwn 0.8/0.8/0.75) objects are 1.25x the terrain's level; on
 *   one above 1 (XMP30S6 1/1/1.5) they are 0.67x. Evidence: docs/remaster/research/yr-scene-lighting.md.
 * Measured on same-moment captures of XMP29U2 (Ambient 1, Red/Green/Blue 1/0.8/0.68): original terrain is the HD
 * palette colour times 1.00/0.81/0.66 per channel while the oil derrick and every tank keep equal channel ratios, and
 * ground next to the INGALITE posts is 1.345x the palette colour against 1.340 predicted.
 *
 * Terrain intensities are drawn through the engine's shade rows (ra2-assets engineShade: 53 rows, one row = 1/26 of
 * the palette, truncated), which makes a dim map up to one row darker than the continuous formula.
 *
 * MapLightGrade keeps that light per cell in a small texture (one texel per cell, linear-filtered) which the map's
 * terrain, sprite and voxel materials sample by world position; each material references its own map's texture, so
 * two maps alive at once never share state. The HD lights (sun, sky, time of day, weather) act on top of it, relative
 * to clear noon. The renderer sets the grade's weight every frame (1 by day): the night presentation (lighting.ts,
 * mapLights.ts) owns maps staged as night and every night hour, where it derives its level, tint and
 * light-source pools from the same [Lighting]; applying both would light the map twice. The weight is baked into the
 * texels (re-encoded only when it changes), so no shader uniform is involved. Dusk keeps the complete engine grade
 * at its authored golden hour; its separate light field does not duplicate the sources.
 */

/** The engine clamps a cell's intensity to 2; texels store multiplier / MAP_LIGHT_RANGE in 8 bits. */
const MAP_LIGHT_RANGE = 2;
/** Weight changes smaller than this keep the current texels (half an 8-bit step of a multiplier of 1). */
const WEIGHT_STEP = MAP_LIGHT_RANGE / 255 / 2;

/** The engine's light of one map: per-cell texture, rebuilt when its light sources or its weight change. */
export class MapLightGrade {
  readonly texture: DataTexture;
  readonly width: number;
  readonly height: number;
  readonly lighting: EngineLighting;
  private readonly grid: CellGrid;
  private light: CellLight;
  /** The map's [Lighting] alone, without light sources (see setSourceWeight). */
  private readonly plain: CellLight;
  private key = '';
  private weight = 1;
  private sourceWeight = 1;

  /** `lighting` in raw INI or engine precision (both accepted); `sources`: the map's light sources. */
  constructor(grid: CellGrid, lighting: EngineLighting, sources: readonly EngineLight[] = []) {
    this.width = grid.width;
    this.height = grid.height;
    // Cells outside the map rhombus still get the plain light (never black), so filtering at its edge stays level.
    this.grid = { ...grid, exists: new Uint8Array(grid.width * grid.height).fill(1) };
    this.lighting = engineLighting(lighting);
    this.texture = new DataTexture(
      new Uint8Array(grid.width * grid.height * 4),
      grid.width,
      grid.height,
      RGBAFormat,
      UnsignedByteType,
    );
    this.texture.colorSpace = NoColorSpace;
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.light = {
      intensity: new Float32Array(grid.width * grid.height),
      tint: new Float32Array(grid.width * grid.height * 3),
      level: new Float32Array(grid.width * grid.height),
    };
    this.plain = engineCellLight(this.grid, this.lighting, []);
    this.setSources(sources, true);
  }

  /** Replace the light sources (live matches: the light-emitting buildings standing now); cheap when unchanged. */
  setSources(sources: readonly EngineLight[], force = false): void {
    const key = sources.map((s) => `${s.position.join(',')}:${s.radius}:${s.intensity}:${s.tint.join(',')}`).join(';');
    if (!force && key === this.key) return;
    this.key = key;
    this.light = engineCellLight(this.grid, this.lighting, sources, this.light);
    this.encode();
  }

  /** How much of the engine light applies (0 = neutral, 1 = the engine's); re-encodes only on a visible change. */
  setWeight(weight: number): void {
    const w = Math.min(1, Math.max(0, weight));
    if (w === this.weight) return;
    if (Math.abs(w - this.weight) < WEIGHT_STEP && w !== 0 && w !== 1) return;
    this.weight = w;
    this.encode();
  }

  /**
   * Share of the light sources' own contribution (1 = the engine's light, 0 = the map's [Lighting] alone); a look's
   * daytime choice (HdSettings.mapSourcesByDay). Re-encodes only on a visible change, like setWeight.
   */
  setSourceWeight(weight: number): void {
    const w = Math.min(1, Math.max(0, weight));
    if (w === this.sourceWeight) return;
    if (Math.abs(w - this.sourceWeight) < WEIGHT_STEP && w !== 0 && w !== 1) return;
    this.sourceWeight = w;
    this.encode();
  }

  /** The current weight (see setWeight). */
  get currentWeight(): number {
    return this.weight;
  }

  private encode(): void {
    const data = this.texture.image.data as Uint8Array;
    const w = this.weight;
    const encode = (v: number) => Math.max(0, Math.min(255, Math.round(((1 + (v - 1) * w) / MAP_LIGHT_RANGE) * 255)));
    const s = this.sourceWeight;
    const { intensity, tint, level } = this.light;
    const plain = this.plain;
    for (let c = 0; c < this.width * this.height; c++) {
      // Terrain shows the shade row the engine picks for the cell, not the continuous intensity (engineShade). The
      // object level stays continuous: objects add their own extra light before the row is picked, and the level is
      // sampled between cells.
      const i = terrainShade(intensity[c]!, tint, c);
      const p = terrainShade(plain.intensity[c]!, plain.tint, c);
      for (let k = 0; k < 3; k++) {
        const full = i * tint[c * 3 + k]!;
        // Exactly the engine's value at the default share of 1.
        data[c * 4 + k] = encode(s === 1 ? full : p * plain.tint[c * 3 + k]! + (full - p * plain.tint[c * 3 + k]!) * s);
      }
      // Alpha: the object level (the engine's I without tint or its largest channel), weighted like the terrain light.
      const o = level[c]!;
      data[c * 4 + 3] = encode(s === 1 ? o : plain.level[c]! + (o - plain.level[c]!) * s);
    }
    this.texture.needsUpdate = true;
  }

  /** Engine light of a cell (unweighted, diagnostics): terrain multiplier per channel and object multiplier. */
  at(x: number, y: number): { terrain: [number, number, number]; objects: number } {
    const cx = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(this.height - 1, Math.floor(y)));
    const c = cy * this.width + cx;
    const i = this.light.intensity[c]!;
    const t = this.light.tint;
    return { terrain: [i * t[c * 3]!, i * t[c * 3 + 1]!, i * t[c * 3 + 2]!], objects: this.light.level[c]! };
  }

  /** Weighted light at world (x, z) as a shader node: rgb = terrain multiplier (sRGB scale). */
  sample(xz: ShaderNode): ShaderNode {
    return texture(this.texture, xz.div(vec2(this.width, this.height))).rgb.mul(MAP_LIGHT_RANGE);
  }

  /** Weighted object level at world (x, z) as a shader node (sRGB scale). */
  sampleLevel(xz: ShaderNode): ShaderNode {
    return texture(this.texture, xz.div(vec2(this.width, this.height))).a.mul(MAP_LIGHT_RANGE);
  }

  /** Both at once (one texture read): rgb = terrain multiplier, a = object level. */
  sampleBoth(xz: ShaderNode): ShaderNode {
    return texture(this.texture, xz.div(vec2(this.width, this.height))).mul(MAP_LIGHT_RANGE);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** The engine's drawn terrain multiplier of cell `c` for a continuous terrain intensity (see engineShade). */
function terrainShade(intensity: number, tint: Float32Array, c: number): number {
  return engineShade(intensity, engineShadeRows([tint[c * 3]!, tint[c * 3 + 1]!, tint[c * 3 + 2]!]));
}

/**
 * Terrain multiplier (rgb) and object level (a) at a world position (x, z) from one texture read, for materials that
 * choose between them per instance; all 1 without a map grade.
 */
export function mapLightAt(grade: MapLightGrade | null | undefined, xz: ShaderNode): ShaderNode {
  return grade ? grade.sampleBoth(xz) : vec4(1);
}

/** Terrain-class multiplier (level x tint, sRGB scale) at a world position (x, z); 1 without a map grade. */
export function terrainGradeAt(grade: MapLightGrade | null | undefined, xz: ShaderNode): ShaderNode {
  return grade ? grade.sample(xz) : vec3(1);
}

/**
 * Object multiplier (level only, sRGB scale) at a world position (x, z); 1 without a map grade. This is the engine's
 * object level I, kept in the grade's alpha channel: NOT the terrain multiplier's largest channel, which carries the
 * tint's largest channel M as well (they are equal only on maps whose largest Red/Green/Blue is exactly 1).
 */
export function objectLevelAt(grade: MapLightGrade | null | undefined, xz: ShaderNode): ShaderNode {
  return grade ? grade.sampleLevel(xz) : float(1);
}

/**
 * Multiply a linear colour by `k` in sRGB scale and clip at white, like the engine's palette lighting. A linear-space
 * multiply by the same factor would darken mid-tones about twice as much (0.8 in sRGB is 0.6 in linear light).
 */
export function srgbScale(colour: ShaderNode, k: ShaderNode | number): ShaderNode {
  return sRGBTransferEOTF((sRGBTransferOETF(colour) as ShaderNode).mul(k).min(1));
}

/** The map grade each palette's art is drawn under (palettes belong to one map cache; see cache.ts). */
const gradeOfPalette = new WeakMap<Uint8Array, MapLightGrade>();
const nodesOfPalette = new WeakMap<Uint8Array, AtmosphereNodes>();

export function setPaletteGrade(palette: Uint8Array, grade: MapLightGrade | null): void {
  if (grade) gradeOfPalette.set(palette, grade);
  else gradeOfPalette.delete(palette);
}

export function paletteGrade(palette: Uint8Array | null | undefined): MapLightGrade | null {
  return (palette && gradeOfPalette.get(palette)) || null;
}

/** Bind CPU palettes to their renderer context so existing voxel-builder calls inherit the correct shader inputs. */
export function setPaletteNodes(palette: Uint8Array, nodes: AtmosphereNodes): void {
  nodesOfPalette.set(palette, nodes);
}

export function paletteNodes(palette: Uint8Array | null): AtmosphereNodes | undefined {
  return palette ? nodesOfPalette.get(palette) : undefined;
}
