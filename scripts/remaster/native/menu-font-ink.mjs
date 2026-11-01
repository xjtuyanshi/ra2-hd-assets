#!/usr/bin/env node
// Adds source ink areas to a reviewed HD-menu font metrics asset.
//
// Usage: node menu-font-ink.mjs <game.fnt> <metrics.json> <out.json> [--drop-outlines]
//
// The input metrics are the reviewed advances/ink boxes (private asset). This
// tool reads the same installed Westwood Unicode bitmap font, recomputes every
// listed glyph's ink box from its bitmap, rejects any disagreement, and writes
// `inkArea` (lit source pixels per UTF-16 code). The runtime uses those areas to
// fit smooth host-font glyphs to the original stroke weight. Outputs stay
// private: they are derived from the supplied install and never enter Git.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [fntPath, metricsPath, outPath, ...flags] = process.argv.slice(2);
if (!fntPath || !metricsPath || !outPath || flags.some((flag) => flag !== '--drop-outlines')) {
  console.error('Usage: menu-font-ink.mjs <game.fnt> <metrics.json> <out.json> [--drop-outlines]');
  process.exit(2);
}
const bytes = readFileSync(fntPath);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
// Header (seven little-endian words): 'fonT', a format word, row stride in
// bytes, glyph height, line height, glyph count and record size. A UTF-16
// index table of 1-based record numbers follows; records are a width byte
// plus `height` rows. Only the layout observed in the supplied font is accepted.
const HEADER = 28;
const magic = bytes.subarray(0, 4).toString('latin1');
if (magic !== 'fonT') throw new Error(`Unsupported font signature ${JSON.stringify(magic)}`);
const [, stride, glyphHeight, lineHeight, glyphCount, recordSize] = [4, 8, 12, 16, 20, 24].map((at) =>
  view.getUint32(at, true),
);
const tableOffset = HEADER - 8;
const dataOffset = HEADER + 65536 * 2;
if (recordSize !== 1 + stride * glyphHeight || dataOffset + glyphCount * recordSize > bytes.length)
  throw new Error('Unexpected font table layout');

function bitmap(code) {
  const index = view.getUint16(tableOffset + 8 + code * 2, true);
  if (index === 0) return null;
  const at = dataOffset + (index - 1) * recordSize;
  const width = bytes[at];
  const rows = [];
  for (let y = 0; y < glyphHeight; y++) {
    const row = [];
    for (let x = 0; x < stride * 8; x++) row.push((bytes[at + 1 + y * stride + (x >> 3)] >> (7 - (x & 7))) & 1);
    rows.push(row);
  }
  return { width, rows };
}

const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
if (metrics.version !== 1 || metrics.lineHeight !== lineHeight) throw new Error('Metrics do not match this font');
const inkArea = {};
let checked = 0;
for (const [code, metric] of Object.entries(metrics.glyphs)) {
  if (metric === null || metric[3] === 0) continue;
  const glyph = bitmap(Number(code));
  if (!glyph) throw new Error(`Glyph ${code} is listed but absent from the font`);
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  let area = 0;
  glyph.rows.forEach((row, y) =>
    row.forEach((bit, x) => {
      if (!bit) return;
      area++;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }),
  );
  const box = [left, top, right - left + 1, bottom - top + 1];
  if (box.some((value, index) => value !== metric[index + 1]))
    throw new Error(`Glyph ${code} ink box ${box} disagrees with reviewed metrics ${metric.slice(1)}`);
  inkArea[code] = area;
  checked++;
}
const output = { ...metrics, inkArea };
if (flags.includes('--drop-outlines')) delete output.outlines;
writeFileSync(outPath, JSON.stringify(output));
console.log(
  JSON.stringify({
    source: fntPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lineHeight,
    glyphCount,
    checked,
    outlines: 'outlines' in output,
  }),
);
