import type { GlyphFace } from '../../graphics/text/coverageGlyphFit';

/** Source font measurements are private assets, just like the menu artwork. */
export interface YrMenuFont {
  version: 1;
  lineHeight: number;
  spacing: number;
  /** [advance, ink left, ink top, ink width, ink height]; null is verified absence. */
  glyphs: Readonly<Record<string, readonly [number, number, number, number, number] | null>>;
  /** Optional identical source-bitmap aliases, such as a narrow fullwidth comma. */
  aliases?: Readonly<Record<string, string>>;
  /** Prebuilt smooth source contours in ink-local coordinates, filled even-odd. */
  outlines?: Readonly<Record<string, string>>;
  /**
   * Lit source-bitmap pixels per visible glyph. When present (and without
   * outlines), smooth host-font glyphs are fitted to this ink weight.
   */
  inkArea?: Readonly<Record<string, number>>;
}

export interface YrMenuTextGlyph {
  text: string;
  x: number;
  advance: number;
  ink: { x: number; y: number; width: number; height: number };
  font: string;
  path?: string;
  /** Candidate host faces, lightest first, for ink-weight fitting. */
  faces: readonly GlyphFace[];
  /** Source ink area in square source pixels when the font supplies it. */
  inkArea?: number;
  /** Largest axis stretch allowed when fitting the host glyph to its box. */
  maxAnisotropy: number;
}

// The game's small Latin glyphs have bold stems; Chinese glyphs have
// full-height one-pixel strokes. Weight ladders span both so the fitter can
// reach the measured source ink without relying on one host weight.
const LATIN_FACES: readonly GlyphFace[] = [
  { weight: 400, family: 'Arial, Helvetica, sans-serif' },
  { weight: 700, family: 'Arial, Helvetica, sans-serif' },
  { weight: 900, family: '"Arial Black", Arial, sans-serif' },
];
const CJK_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const CJK_FACES: readonly GlyphFace[] = [100, 200, 300, 400, 500, 600].map((weight) => ({
  weight,
  family: CJK_FAMILY,
}));

export interface YrMenuTextLine {
  glyphs: YrMenuTextGlyph[];
  width: number;
}

/** Only closed, bounded absolute paths are accepted from the private font asset. */
function validOutline(path: string, width: number, height: number): boolean {
  if (path.length === 0) return width === 0 && height === 0;
  if (path.length > 100_000 || !/^[MLQCZ\d.,\s]+$/.test(path)) return false;
  const tokens = path.match(/[MLQCZ]|(?:\d+(?:\.\d+)?|\.\d+)/g);
  if (!tokens || tokens.join('') !== path.replace(/[\s,]/g, '')) return false;
  let open = false;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]!;
    if (command === 'Z') {
      if (!open) return false;
      open = false;
      continue;
    }
    if (command === 'M') {
      if (open) return false;
      open = true;
    } else if (!open) return false;
    const count = command === 'M' || command === 'L' ? 2 : command === 'Q' ? 4 : command === 'C' ? 6 : 0;
    if (!count || i + count > tokens.length) return false;
    for (let part = 0; part < count; part++) {
      const value = Number(tokens[i++]!);
      if (!Number.isFinite(value) || value < 0 || value > (part % 2 === 0 ? width : height)) return false;
    }
  }
  return !open;
}

/** Reject incomplete/corrupt measurements instead of silently choosing host-font geometry. */
export function parseYrMenuFont(value: unknown): YrMenuFont | null {
  if (typeof value !== 'object' || value === null) return null;
  const font = value as Partial<YrMenuFont>;
  if (
    font.version !== 1 ||
    !Number.isInteger(font.lineHeight) ||
    font.lineHeight! < 1 ||
    font.lineHeight! > 256 ||
    !Number.isInteger(font.spacing) ||
    font.spacing! < -32 ||
    font.spacing! > 32 ||
    !font.glyphs ||
    typeof font.glyphs !== 'object' ||
    Array.isArray(font.glyphs)
  )
    return null;
  for (const [code, glyph] of Object.entries(font.glyphs)) {
    if (!/^(0|[1-9]\d*)$/.test(code) || Number(code) > 65535) return null;
    if (glyph === null) continue;
    if (
      !Array.isArray(glyph) ||
      glyph.length !== 5 ||
      !glyph.every((part) => Number.isInteger(part) && part >= 0 && part <= 256) ||
      glyph[0]! + font.spacing! < 0 ||
      glyph[1]! + glyph[3]! > glyph[0]! ||
      glyph[2]! + glyph[4]! > font.lineHeight! ||
      (glyph[3] === 0) !== (glyph[4] === 0)
    )
      return null;
  }
  if (font.aliases !== undefined) {
    if (!font.aliases || typeof font.aliases !== 'object' || Array.isArray(font.aliases)) return null;
    for (const [code, alias] of Object.entries(font.aliases)) {
      if (
        !/^(0|[1-9]\d*)$/.test(code) ||
        Number(code) > 65535 ||
        !Object.hasOwn(font.glyphs, code) ||
        typeof alias !== 'string' ||
        alias.length !== 1 ||
        !Object.hasOwn(font.glyphs, String(alias.charCodeAt(0)))
      )
        return null;
      const glyph = font.glyphs[code];
      const target = font.glyphs[String(alias.charCodeAt(0))];
      if (!glyph || !target || glyph.some((part, index) => part !== target[index])) return null;
    }
  }
  if (font.inkArea !== undefined) {
    if (!font.inkArea || typeof font.inkArea !== 'object' || Array.isArray(font.inkArea)) return null;
    for (const [code, area] of Object.entries(font.inkArea)) {
      const metric = Object.hasOwn(font.glyphs, code) ? font.glyphs[code] : undefined;
      if (!metric || !Number.isInteger(area) || area < 1 || area > metric[3] * metric[4]) return null;
    }
  }
  if (font.outlines !== undefined) {
    if (!font.outlines || typeof font.outlines !== 'object' || Array.isArray(font.outlines)) return null;
    for (const [code, path] of Object.entries(font.outlines)) {
      const metric = Object.hasOwn(font.glyphs, code) ? font.glyphs[code] : undefined;
      if (!metric || typeof path !== 'string' || !validOutline(path, metric[3], metric[4])) return null;
    }
  }
  return font as YrMenuFont;
}

/**
 * Preserve the installed game's UTF-16 glyph advances and ink boxes. A missing
 * metadata entry is unknown, while an explicit null is the original's absent
 * glyph with no fallback: it draws nothing and consumes no width. Never remove
 * punctuation by language or by a particular caption.
 */
export function layoutYrMenuText(text: string, font: YrMenuFont): YrMenuTextLine[] | null {
  const lines: YrMenuTextLine[] = [{ glyphs: [], width: 0 }];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 || code === 10) {
      if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
      lines.push({ glyphs: [], width: 0 });
      continue;
    }
    if (!Object.hasOwn(font.glyphs, String(code))) return null;
    const metric = font.glyphs[String(code)];
    if (metric === null) continue;
    if (!metric) return null;
    const [advance, x, y, width, height] = metric;
    const path = font.outlines?.[String(code)];
    // Once a traced font is selected, a missing contour must keep the complete
    // screen original instead of mixing source outlines with host-face glyphs.
    if (font.outlines && width > 0 && path === undefined) return null;
    const inkArea = font.inkArea?.[String(code)];
    // Likewise a weight-fitted font never mixes in an unfitted glyph.
    if (font.inkArea && width > 0 && inkArea === undefined) return null;
    const line = lines[lines.length - 1]!;
    const glyph = font.aliases?.[String(code)] ?? text[i]!;
    // Output ink is fitted to the supplied source box, so the host font cannot
    // widen a narrow combo or list row.
    const latin = glyph.charCodeAt(0) < 256;
    line.glyphs.push({
      text: glyph,
      x: line.width,
      advance: advance + font.spacing,
      ink: { x, y, width, height },
      font: latin ? '900 16px "Arial Black", Arial, sans-serif' : '16px "PingFang SC", "Microsoft YaHei", sans-serif',
      ...(path === undefined ? {} : { path }),
      faces: latin ? LATIN_FACES : CJK_FACES,
      ...(inkArea === undefined ? {} : { inkArea }),
      // Narrow Latin glyphs (j, f, slashes) need tall boxes; Chinese
      // one-stroke glyphs must not stretch a thin bar to a 2-pixel box.
      maxAnisotropy: latin ? 4 : 1.5,
    });
    line.width += advance + font.spacing;
  }
  return lines;
}
