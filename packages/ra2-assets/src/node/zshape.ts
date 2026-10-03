/** Metadata-only migration for existing type libraries; never reads or rewrites their atlases. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDING_LAYER_KEYS, buildingLayerArt } from '../art.ts';
import type { LibraryBuilding, LibraryDepthTemplate, LibraryType } from '../library.ts';
import { THEATERS, type TheaterId } from '../theater.ts';
import { decodeDepthTemplate, readBuildingZShape, readTypeDepthFlags, readYDrawOffset } from '../zshape.ts';
import { ArtSource, type InstallView } from './artSource.ts';
import { GameInstall } from './install.ts';

export interface ZShapeTheaterPatch {
  depthTemplate: LibraryDepthTemplate;
  /** Installer merges zShape into building.zShape and the two flags into the type itself. */
  types: Record<string, Pick<LibraryType, 'harvester' | 'refinery'> & { zShape?: LibraryBuilding['zShape'] }>;
  /** Existing building layers are matched by their art key, independently of the sprite filenames. */
  layers: Record<string, Record<string, { yDrawOffset: number }>>;
}

/** Resolve rules Image= and art sections exactly as the ordinary library does, including its fallback. */
export function collectZShapePatch(inst: InstallView, theater: TheaterId): Omit<ZShapeTheaterPatch, 'depthTemplate'> {
  const src = new ArtSource(inst, THEATERS[theater], () => {});
  const types: ZShapeTheaterPatch['types'] = {};
  const layers: ZShapeTheaterPatch['layers'] = {};
  for (const [kind, list] of [
    ['building', 'BuildingTypes'],
    ['vehicle', 'VehicleTypes'],
  ] as const) {
    const ids = new Set(
      src.rules
        .readRegistry(list)
        .map((id) => id.trim())
        .filter(Boolean),
    );
    for (const id of ids) {
      const patch: ZShapeTheaterPatch['types'][string] = readTypeDepthFlags(kind, src.rules.getSection(id));
      if (kind === 'building') {
        const { sec } = src.artOf(id);
        const zShape = readBuildingZShape(sec);
        if (zShape) patch.zShape = zShape;
        const layerPatches: Record<string, { yDrawOffset: number }> = {};
        for (const key of BUILDING_LAYER_KEYS) {
          const layer = buildingLayerArt(sec, key);
          if (!layer) continue;
          const yDrawOffset = readYDrawOffset(src.art.getSection(layer.anim));
          if (yDrawOffset) layerPatches[key] = { yDrawOffset };
        }
        if (Object.keys(layerPatches).length) layers[id] = layerPatches;
      }
      if (Object.keys(patch).length) types[id] = patch;
    }
  }
  return { types, layers };
}

/** Replace the staging inode: earlier installations may have hard-linked its binary into a farm. */
function writeStagingFile(dir: string, name: string, data: Uint8Array | string): void {
  const temp = join(dir, `.${name}-${process.pid}.tmp`);
  try {
    writeFileSync(temp, data, { flag: 'wx' });
    renameSync(temp, join(dir, name));
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Extract all selected theaters before publishing staging, so a missing/different template cannot yield a partial patch. */
export function extractZShapeStaging(opts: {
  gameDir: string;
  outDir: string;
  theaters?: readonly TheaterId[];
}): Partial<Record<TheaterId, ZShapeTheaterPatch>> {
  const theaters = opts.theaters?.length ? opts.theaters : (Object.keys(THEATERS) as TheaterId[]);
  const patches: Partial<Record<TheaterId, ZShapeTheaterPatch>> = {};
  let template: ReturnType<typeof decodeDepthTemplate> | undefined;
  for (const theater of theaters) {
    const inst = GameInstall.open(opts.gameDir, theater);
    const bytes = inst.read('buildngz.sha');
    if (bytes === undefined) throw new Error(`${theater}: BUILDNGZ.SHA not found in the mounted install`);
    const decoded = decodeDepthTemplate(bytes);
    if (
      template &&
      (decoded.width !== template.width ||
        decoded.height !== template.height ||
        !Buffer.from(decoded.pixels).equals(template.pixels))
    )
      throw new Error(`${theater}: BUILDNGZ.SHA differs between theaters; one staging binary cannot represent both`);
    template = decoded;
    patches[theater] = {
      depthTemplate: { file: 'buildngz.bin', width: decoded.width, height: decoded.height },
      ...collectZShapePatch(inst, theater),
    };
  }
  if (!template) throw new Error('No theaters selected');
  mkdirSync(opts.outDir, { recursive: true });
  writeStagingFile(opts.outDir, 'buildngz.bin', template.pixels);
  writeStagingFile(opts.outDir, 'zshape-patch.json', JSON.stringify(patches, null, 2) + '\n');
  return patches;
}
