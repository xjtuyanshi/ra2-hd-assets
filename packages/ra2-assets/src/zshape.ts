/** Native RA2/YR depth inputs; the byte transform and INI keys belong to the game's art format. */
import { ShpFile } from 'ra2-formats';
import type { ArtSectionView } from './art.ts';
import type { LibraryBuilding, LibraryKind, LibraryType } from './library.ts';

/**
 * YR 1.001 loader 0x45E8F0 transforms frame 0 in place, over its frame rectangle (not the SHP canvas).
 * Consumers reinterpret the stored bytes as signed int8. Zero is a valid correction, never transparency.
 */
export function decodeDepthTemplate(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  try {
    const shp = ShpFile.parse(bytes);
    if (!shp.count) throw new Error('no frame 0');
    const frame = shp.frame(0);
    if (!frame.cx || !frame.cy || frame.pixels.length !== frame.cx * frame.cy) throw new Error('frame 0 is empty');
    const pixels = frame.pixels.map((raw) => (raw === 0 ? 0 : (raw - 65) & 255));
    return { width: frame.cx, height: frame.cy, pixels };
  } catch (cause) {
    throw new Error(`BUILDNGZ.SHA: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

const integer = (raw: string | undefined): number => {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? value : 0;
};

/** Defaults are absent from JSON. Plain ZAdjust does not feed the native building-body depth calculation. */
export function readBuildingZShape(section: ArtSectionView | undefined): LibraryBuilding['zShape'] {
  const move = section?.getString('ZShapePointMove', '').split(',');
  const pointMove: [number, number] = [integer(move?.[0]), integer(move?.[1])];
  const normalZAdjust = integer(section?.getString('NormalZAdjust', ''));
  if (!pointMove[0] && !pointMove[1] && !normalZAdjust) return undefined;
  return {
    ...(pointMove[0] || pointMove[1] ? { pointMove } : {}),
    ...(normalZAdjust ? { normalZAdjust } : {}),
  };
}

/** AnimType YDrawOffset affects both the native anim's screen position and its depth adjustment. */
export function readYDrawOffset(section: ArtSectionView | undefined): number {
  return integer(section?.getString('YDrawOffset', ''));
}

/** Match the existing art extractor's native first-letter boolean convention, with kind-specific rules fields. */
export function readTypeDepthFlags(
  kind: LibraryKind,
  section: ArtSectionView | undefined,
): Pick<LibraryType, 'harvester' | 'refinery'> {
  const yes = (key: string): boolean => /^(y|t|1)/i.test(section?.getString(key, '').trim() ?? '');
  return {
    ...(kind === 'vehicle' && yes('Harvester') ? { harvester: true as const } : {}),
    ...(kind === 'building' && yes('Refinery') ? { refinery: true as const } : {}),
  };
}
