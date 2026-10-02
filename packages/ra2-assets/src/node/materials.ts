/**
 * Material data for the HD renderer derived from the player's install (Node only): the voxel lighting table
 * (voxels.vpl), written as a small sidecar into the type library's common directory, and per map a colour-matched HD
 * terrain image with a materials.json sidecar pointing at it. New files only: nothing here rewrites a map manifest or
 * a theater library.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HdCacheManifest } from '../manifest.ts';
import { MAP_MATERIALS_FILE, type MapMaterials } from '../mapMaterials.ts';
import { parseVpl, type VoxelLightingFile, type VoxelLightingFit } from '../vpl.ts';
import { GameInstall } from './install.ts';
import { decodePng, encodePng } from './png.ts';
import { colourMatchTerrain } from './terrainColour.ts';

export const VOXEL_LIGHTING_JSON = 'voxels-vpl.json';
export const VOXEL_LIGHTING_PNG = 'voxels-vpl.png';

/**
 * The engine's voxel shade (YR 1.001): TechnoClass (@0x706F4D) has @0x753D00 / @0x7586F0 compute, per normal table
 * entry, section = int(16 * (max(0, N.L) + max(0, b / (3 - 2 b)))) with L = VoxelLightSource (@0x887470) in model
 * space, b = N.H and H = normalize(L + (0, 0, 1)) in model space (the view vector is the identity matrix at @0x887430
 * applied to +Z, i.e. the model's up axis). L in HD world axes is voxelLightSource (-0.5, -0.707, 0.5) taken through
 * the default voxel matrix at 0xB44318 (see derivedVoxelLight in the renderer); a free per-pixel light search against
 * same-moment captures of the original lands within 6 degrees of it.
 */
export const VOXEL_LIGHTING_FIT: VoxelLightingFit = {
  light: [0.2014, -0.362, 0.9101],
  sectionScale: 16,
  specular: 3,
  source: 'gamemd.exe YR 1.001 @0x7586F0 (section = int(16 (max(0, N.L) + max(0, b / (3 - 2b)))), light @0x887470',
};

export interface VoxelLightingResult {
  json: string;
  png: string;
  file: VoxelLightingFile;
}

/** Read voxels.vpl from the install and write the sidecar pair into `outDir` (e.g. <library>/common). */
export function extractVoxelLighting(options: { gameDir: string; outDir: string }): VoxelLightingResult {
  // The theater only selects terrain archives; voxels.vpl lives in the common archives.
  const install = GameInstall.open(options.gameDir, 'temperate');
  const bytes = install.read('voxels.vpl');
  if (!bytes) throw new Error('voxels.vpl not found in the mounted install');
  const vpl = parseVpl(bytes);
  mkdirSync(options.outDir, { recursive: true });
  const png = join(options.outDir, VOXEL_LIGHTING_PNG);
  writeFileSync(png, encodePng({ width: 256, height: vpl.sectionCount, channels: 1, data: vpl.table }));
  const file: VoxelLightingFile = {
    version: 1,
    source: 'voxels.vpl',
    header: {
      remapStart: vpl.remapStart,
      remapEnd: vpl.remapEnd,
      sectionCount: vpl.sectionCount,
      unknown: vpl.unknown,
    },
    table: { file: VOXEL_LIGHTING_PNG, width: 256, height: vpl.sectionCount },
    fit: VOXEL_LIGHTING_FIT,
  };
  const json = join(options.outDir, VOXEL_LIGHTING_JSON);
  writeFileSync(json, `${JSON.stringify(file, null, 2)}\n`);
  return { json, png, file };
}

export interface TerrainColourResult {
  file: string;
  materials: string;
  width: number;
  height: number;
}

/**
 * Write `<mapDir>/<hd file>-cm.png` (the manifest's HD terrain image with the original composite's low-frequency
 * colour, see terrainColour.ts) and point `<mapDir>/materials.json` at it. The manifest is read, never written.
 */
export function colourMatchMapTerrain(options: { mapDir: string; sigma?: number }): TerrainColourResult {
  const manifest = JSON.parse(readFileSync(join(options.mapDir, 'manifest.json'), 'utf8')) as HdCacheManifest;
  const ref = manifest.terrainMap;
  if (!ref) throw new Error(`${options.mapDir}: the manifest has no terrainMap (run hd:terrain-map first)`);
  const sourceFile = join(options.mapDir, 'terrain-map.png');
  if (!existsSync(sourceFile)) throw new Error(`${sourceFile} not found`);
  const hd = decodePng(new Uint8Array(readFileSync(join(options.mapDir, ref.file))));
  const source = decodePng(new Uint8Array(readFileSync(sourceFile)));
  const sigma = options.sigma ?? 2;
  const matched = colourMatchTerrain(hd, source, sigma);
  const file = `${ref.file.replace(/\.png$/i, '')}-cm.png`;
  writeFileSync(join(options.mapDir, file), encodePng(matched));
  const materialsPath = join(options.mapDir, MAP_MATERIALS_FILE);
  const previous = existsSync(materialsPath) ? (JSON.parse(readFileSync(materialsPath, 'utf8')) as MapMaterials) : null;
  const materials: MapMaterials = {
    ...previous,
    version: 1,
    terrainMap: file,
    notes: `terrainMap: ${ref.file} with the low-frequency Lab colour of terrain-map.png (Gaussian sigma ${sigma} original px)`,
  };
  writeFileSync(materialsPath, `${JSON.stringify(materials, null, 2)}\n`);
  return { file: join(options.mapDir, file), materials: materialsPath, width: matched.width, height: matched.height };
}
