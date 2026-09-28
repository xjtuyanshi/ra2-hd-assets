/**
 * House colour remap (pure). SHP art and voxels mark house-coloured pixels with palette indices 16..31, a bright to
 * dark ramp. The engine replaces them with a 16-shade ramp derived from the owning house's `[Colors]` HSV entry
 * (rules: `Name=H,S,V`, each 0..255). We reproduce it by keeping each remap entry's brightness relative to the
 * first (brightest) entry of the palette's own ramp and swapping in the house hue and saturation — an approximation
 * of the engine's ColorScheme generation that matches it closely for the stock palettes.
 */
export const REMAP_START = 16;
export const REMAP_COUNT = 16;

export type Rgb = [number, number, number];
export type Hsv = [number, number, number];

/** Parse an rules `[Colors]` value "H,S,V" (0..255 each). */
export function parseHsv(value: string): Hsv | undefined {
  const parts = value.split(',').map((p) => Number.parseInt(p.trim(), 10));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return undefined;
  const clamp = (n: number): number => Math.max(0, Math.min(255, n));
  return [clamp(parts[0]!), clamp(parts[1]!), clamp(parts[2]!)];
}

/** HSV (0..255 each; hue wraps at 256) to 8-bit RGB. */
export function hsvToRgb([h, s, v]: Hsv): Rgb {
  const hue = ((h % 256) / 256) * 6;
  const sat = s / 255;
  const val = v / 255;
  const i = Math.floor(hue);
  const f = hue - i;
  const p = val * (1 - sat);
  const q = val * (1 - sat * f);
  const t = val * (1 - sat * (1 - f));
  const table: [number, number, number][] = [
    [val, t, p],
    [q, val, p],
    [p, val, t],
    [p, q, val],
    [t, p, val],
    [val, p, q],
  ];
  const [r, g, b] = table[i % 6]!;
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * 16 RGB entries replacing palette indices 16..31 for a house of colour `hsv`. `paletteRgb` is the 768-byte 8-bit
 * palette whose own remap ramp provides the brightness profile.
 */
export function remapRamp(paletteRgb: Uint8Array, hsv: Hsv): Rgb[] {
  const bright = (i: number): number => {
    const p = (REMAP_START + i) * 3;
    return Math.max(paletteRgb[p]!, paletteRgb[p + 1]!, paletteRgb[p + 2]!);
  };
  const top = Math.max(1, bright(0));
  const out: Rgb[] = [];
  for (let i = 0; i < REMAP_COUNT; i++) {
    const v = Math.round((hsv[2] * bright(i)) / top);
    out.push(hsvToRgb([hsv[0], hsv[1], Math.min(255, v)]));
  }
  return out;
}

/** Copy of `paletteRgb` with the remap range replaced by `ramp`. */
export function applyRemap(paletteRgb: Uint8Array, ramp: readonly Rgb[]): Uint8Array {
  const out = Uint8Array.from(paletteRgb);
  ramp.forEach((c, i) => out.set(c, (REMAP_START + i) * 3));
  return out;
}

/** True when palette index `i` is house-remappable. */
export function isRemapIndex(i: number): boolean {
  return i >= REMAP_START && i < REMAP_START + REMAP_COUNT;
}

/** One slot of the engine's runtime ColorScheme array (see colorSchemeSlots). */
export interface ColorSchemeSlot {
  name: string;
  hsv: Hsv;
  /** 0 = first copy (index 2k), 1 = second copy (index 2k + 1). */
  copy: 0 | 1;
}

/**
 * The runtime ColorScheme array of YR 1.001 (YRpp: DynamicVectorClass<ColorScheme*> ColorScheme::Array) built from the
 * rules `[Colors]` entries: two consecutive schemes per entry, in file order, so entry k owns indices 2k and 2k + 1.
 * HouseClass::ColorSchemeIndex points at the second copy.
 *
 * Evidence (read-only dump of the running game's array after a skirmish start on the player's install): 42 schemes for
 * the 21 stock rulesmd [Colors] entries; each pair's remap colours have exactly the hue of entry k (e.g. pair 2 =
 * LightGrey's pure greys, pair 10 = DarkBlue); the observed house indices 3, 11, 13, 21, 25 and 5 are all odd and a
 * house shown blue on screen had 21 = DarkBlue. YRpp notes the same duplication (ShadeCount 1 and 53 copies).
 *
 * Not verified: a repeated key (kept once, at its first position, with its last value, like the INI parser) and a map
 * with its own [Colors] section (the array would be rebuilt from the merged section). Unparsable values keep their
 * slot with HSV 0,0,0 so later indices stay aligned.
 */
export function colorSchemeSlots(entries: readonly { key: string; value: string }[]): ColorSchemeSlot[] {
  const order: string[] = [];
  const values = new Map<string, { name: string; value: string }>();
  for (const { key, value } of entries) {
    const k = key.trim().toLowerCase();
    if (!k) continue;
    if (!values.has(k)) order.push(k);
    values.set(k, { name: values.get(k)?.name ?? key.trim(), value });
  }
  const out: ColorSchemeSlot[] = [];
  for (const k of order) {
    const { name, value } = values.get(k)!;
    const hsv = parseHsv(value) ?? [0, 0, 0];
    out.push({ name, hsv, copy: 0 }, { name, hsv: [...hsv], copy: 1 });
  }
  return out;
}
