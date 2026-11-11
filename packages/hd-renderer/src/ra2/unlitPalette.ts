import { abs, float, floor, max, min, smoothstep, step } from 'three/tsl';
import type { ShaderNode } from '../tsl';

/**
 * Palette indices that RA2/YR's house colour-scheme converters leave unlit (YR gamemd.exe 1.001, static reading; see
 * docs/remaster/research/yr-unlit-palette.md).
 *
 * ColorScheme (0x68C710) and CreateLightConvert (0x68C860) both build their LightConvertClass through 0x68C3B0, which
 * passes the table 0x83E1AC to the constructor 0x555DA0 (at 0x68C4E2); other converters get the all-ones default
 * 0x829C20 (0x555E33). The table's bytes are 1 for indices 0-239, 0 for 240-254 and 1 for 255, and nothing writes to
 * it. The row builder 0x556090 gives a zero-flag index the untinted multiplier (0x55639A, 0x5563E4, 0x55640A..0x55641D)
 * instead of the tinted ramp: those colours show at their palette value at any object light from about 0.236 up, and
 * no map tint, Ion Storm, nuke or Dominator colour reaches them (the retint 0x53AD00 only changes the lit ramp).
 *
 * The converter is the drawing house's: building bodies and damaged frames (TechnoClass::DrawObject 0x705E00 through
 * GetRemapColour 0x705D70), their ShouldUseCellDrawer anims (0x451A70..0x451AF5), infantry and SHP vehicles/aircraft
 * (0x41C090). TerrainPalette buildings use the cell's iso converter (all indices lit), and standalone anims the plain
 * ANIM.PAL converter (no table). Index 0 is transparent whatever the table says.
 */
export const HOUSE_CONVERTER_UNLIT_INDICES: Readonly<{ first: number; last: number }> = { first: 240, last: 254 };

/** Rows of a 53-shade house converter, and the dark-end threshold row T the builder derives from them (0x5561FC). */
const HOUSE_CONVERTER_ROWS = 53;
const HOUSE_CONVERTER_DARK_ROWS = Math.min(
  Math.floor((HOUSE_CONVERTER_ROWS - 1) / 2),
  Math.max(0, Math.floor((30 * HOUSE_CONVERTER_ROWS) / 200) - 1),
);
/** Neutral ABuffer byte of the lit blitters (cleared to 0x7F at 0x41139F; only alpha-image lights raise it). */
const NEUTRAL_ABUFFER = 127;

/** Whether palette index `index` is one of the house converter's unlit indices. */
export function isHouseConverterUnlitIndex(index: number): boolean {
  return index >= HOUSE_CONVERTER_UNLIT_INDICES.first && index <= HOUSE_CONVERTER_UNLIT_INDICES.last;
}

/**
 * Multiplier (0..1) on the palette value of an unlit index drawn at object light `level` (1 = 1000 per mille), as the
 * lit blitters (0x493CC0, 0x4978C0) pick the converter row: hi = min(254, I x 261 >> 11), row = min(52, lo x hi x 52 /
 * 32258) with the neutral ABuffer byte lo, then the builder's min(1, row / T). 1 from level 0.236 up, sixths below.
 */
export function houseConverterUnlitLevel(level: number): number {
  const intensity = Math.max(0, Math.round(level * 1000));
  const hi = Math.min(254, (intensity * 261) >> 11);
  const row = Math.min(HOUSE_CONVERTER_ROWS - 1, Math.floor((NEUTRAL_ABUFFER * hi * 52) / 32258));
  return Math.min(1, row / HOUSE_CONVERTER_DARK_ROWS);
}

/** Shader twin of houseConverterUnlitLevel for an object light level node. */
export function houseConverterUnlitLevelNode(level: ShaderNode): ShaderNode {
  const intensity: ShaderNode = floor(max(level, 0).mul(1000).add(0.5));
  const hi: ShaderNode = min(floor(intensity.mul(261).div(2048)), 254);
  const row: ShaderNode = min(floor(hi.mul(NEUTRAL_ABUFFER * 52).div(32258)), HOUSE_CONVERTER_ROWS - 1);
  return min(row.div(HOUSE_CONVERTER_DARK_ROWS), 1);
}

/** 1 where the (integer-valued) index node is an unlit index, else 0. */
export function houseConverterUnlitIndexNode(index: ShaderNode): ShaderNode {
  const { first, last } = HOUSE_CONVERTER_UNLIT_INDICES;
  return step(first - 0.5, index).mul(float(1).sub(step(last + 0.5, index)));
}

/**
 * Weight (0..1) of one of the 3x3 index taps in the unlit-share filter: the bilinear tent of the tap at offset (ox, oy)
 * from the texel under the sample, for the sample's offset `t` (-0.5..0.5 per axis) from that texel's centre.
 */
export function unlitTapWeight(ox: number, oy: number, t: readonly [number, number]): number {
  return Math.max(0, 1 - Math.abs(ox - t[0])) * Math.max(0, 1 - Math.abs(oy - t[1]));
}

/** Shader twin of unlitTapWeight. */
export function unlitTapWeightNode(ox: number, oy: number, t: ShaderNode): ShaderNode {
  return max(float(1).sub(abs(float(ox).sub(t.x))), 0).mul(max(float(1).sub(abs(float(oy).sub(t.y))), 0));
}

/**
 * Smoothstep that turns the tent-filtered share of unlit texels among the opaque ones into the pixel's unlit weight:
 * the same band as the silhouette edge (sprites.ts `edge`).
 */
export const UNLIT_SHARE_EDGE: Readonly<{ from: number; to: number }> = { from: 0.35, to: 0.65 };

/**
 * Unlit weight of an HD pixel (CPU twin of the shader): `unlit` and `opaque` are the tent-weighted sums over the 3x3
 * taps of the unlit and of all opaque original texels. The bilinear share is exactly 0.5 on the edge between an
 * unlit texel and a lit one, so the sharpened weight keeps every unlit texel's full square (single-pixel blinkers
 * included) without growing past it: no halo, and a band of about 0.3 original texel instead of a stair-step seam.
 * Transparent neighbours do not count, so an unlit texel on the silhouette stays unlit up to its soft alpha edge.
 */
export function unlitShare(unlit: number, opaque: number): number {
  if (opaque <= 1e-6) return 0;
  const { from, to } = UNLIT_SHARE_EDGE;
  const t = Math.min(1, Math.max(0, (unlit / opaque - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Shader twin of unlitShare. */
export function unlitShareNode(unlit: ShaderNode, opaque: ShaderNode): ShaderNode {
  return smoothstep(UNLIT_SHARE_EDGE.from, UNLIT_SHARE_EDGE.to, unlit.div(max(opaque, 1e-6))).mul(step(1e-6, opaque));
}

/**
 * Whether building art on source palette `palette` (a body, bib, make or attached anim) is drawn through the house
 * converter: every palette but the iso one, which TerrainPalette=yes art uses with the cell's terrain converter
 * (BuildingType +0x1702, DrawObject 0x705EC1..0x705F59, table 0 = all lit).
 */
export function buildingUsesHouseConverter(palette: string): boolean {
  return palette !== 'iso';
}

/** Map objects whose art the engine draws through the house converter: buildings off the iso palette, and units. */
export function mapObjectUsesHouseConverter(kind: string, palette: string): boolean {
  if (kind === 'building') return buildingUsesHouseConverter(palette);
  return kind === 'infantry' || kind === 'vehicle' || kind === 'aircraft';
}
