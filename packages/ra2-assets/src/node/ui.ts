import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Palette, ShpFile } from 'ra2-formats';
import { buildCursorAtlas, rasterizeUiFrame } from '../ui.ts';
import { encodePng } from './png.ts';

export interface CameoDefinition {
  id: string;
  kind: string;
  cameo: string;
  alt?: string;
  name: string;
  uiName: string;
  owner: string[];
  techLevel: number;
  buildable: boolean;
}

export interface CameoEntry extends CameoDefinition {
  pal: string;
  file: string;
  w: number;
  h: number;
}

/** The caller owns registry discovery, archive precedence and palette selection. */
export interface CameoSource {
  shape(name: string): { shape: ShpFile; palette: Palette; pal: string } | undefined;
}

export function writeCameos(options: {
  out: string;
  definitions: readonly CameoDefinition[];
  source: CameoSource;
  size?: { width: number; height: number };
}): CameoEntry[] {
  mkdirSync(join(options.out, 'orig'), { recursive: true });
  const written = new Map<string, { pal: string; file: string; w: number; h: number }>();
  const exportShape = (name: string) => {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Invalid cameo output name: ${name}`);
    const key = name.toLowerCase(),
      previous = written.get(key);
    if (previous) return previous;
    const art = options.source.shape(key);
    if (!art) return { pal: 'missing', file: '', w: 0, h: 0 };
    const raster = rasterizeUiFrame(art.shape, art.palette, 0, options.size);
    const file = `orig/${key}.png`;
    writeFileSync(join(options.out, file), encodePng(raster));
    const result = { pal: art.pal, file, w: raster.width, h: raster.height };
    written.set(key, result);
    return result;
  };
  const entries = options.definitions.map((entry) => {
    const art = exportShape(entry.cameo);
    if (entry.alt) exportShape(entry.alt);
    return {
      ...entry,
      cameo: entry.cameo.toLowerCase(),
      ...(entry.alt ? { alt: entry.alt.toLowerCase() } : {}),
      ...art,
    };
  });
  writeFileSync(join(options.out, 'cameos.json'), JSON.stringify(entries, null, 1));
  return entries;
}

export function writeCursor(options: { out: string; shape: ShpFile; palette: Palette; types?: readonly unknown[] }): {
  frames: number;
  width: number;
  height: number;
} {
  const { image, index } = buildCursorAtlas(options.shape, options.palette, options.types);
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'cursor.png'), encodePng(image));
  writeFileSync(join(options.out, 'cursor.json'), JSON.stringify(index, null, 2));
  return { frames: index.frames.length, width: image.width, height: image.height };
}
