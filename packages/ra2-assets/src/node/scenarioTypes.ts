/**
 * Scenario types (Node only): the types whose picture depends on the scenario's own rules, bound to the art the
 * theatre library already holds (see ScenarioType in ../library.ts for the contract).
 *
 * The engine reads a map file as one more rules pass after rulesmd.ini. A scenario can therefore register types of
 * its own (stock YR examples: DeepFrze's capturable Grand Cannon GTGCANA with Image=GTGCAN; the numbered tech power
 * plants CAPOWR01.. of the Allied campaign with Image=CAPOWR; the T-Rex clone DNOAA) and change stock ones (EB2 makes
 * the lamp-post dummy INGRNLMP visible). Art keys live in artmd.ini only, so such a type always draws with art some
 * stock type also uses; what can differ is everything the library extractor derives from rules: turret, turret
 * placement, unloading image, visibility and the depth flags.
 *
 * Both sides are built with the library extractor's own per-type code (createTypeBuilder), once over rulesmd.ini and
 * once over rulesmd.ini under the scenario, so the two cannot drift apart: a stock type is listed only when the two
 * records differ, and a donor is accepted only when its art-derived part is identical. Voxel donors may hold extra
 * turret variants, but their default parts and every variant the scenario requests must match unchanged.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IniFile } from 'ra2-formats';
import {
  SCENARIO_TYPES_FILE,
  SCENARIO_TYPES_VERSION,
  type LibraryKind,
  type LibraryType,
  type ScenarioType,
  type ScenarioTypesSidecar,
} from '../library.ts';
import { THEATERS, type TheaterId } from '../theater.ts';
import { ArtSource, type InstallView } from './artSource.ts';
import { createTypeBuilder, TYPE_LISTS, type TypeBuilder } from './library.ts';

export interface CollectedScenarioTypes {
  types: Record<string, ScenarioType>;
  /** Scenario types left to the renderer's fallback, with the reason. */
  warnings: string[];
}

const upper = (s: string): string => s.trim().toUpperCase();
const unique = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

/** One side of the comparison: a type builder, the warnings of its last build and its records by `kind:id`. */
class Side {
  private readonly builder: TypeBuilder;
  private readonly records = new Map<string, LibraryType | null>();
  private readonly voxelHashes = new Map<string, string>();
  private messages: string[] = [];
  readonly reasons = new Map<string, string>();

  constructor(
    inst: InstallView,
    readonly src: ArtSource,
  ) {
    this.builder = createTypeBuilder(inst, src, (m) => this.messages.push(m));
  }

  type(kind: LibraryKind, id: string): LibraryType | undefined {
    const key = `${kind}:${id}`;
    if (!this.records.has(key)) {
      this.messages = [];
      const record = this.builder.build(kind, id) ?? null;
      this.records.set(key, record);
      // The builder words its reason as "<kind> <id>: skipped, <why>".
      if (!record) this.reasons.set(key, this.messages.join('; ').replace(`${kind} ${id}: skipped, `, ''));
    }
    return this.records.get(key) ?? undefined;
  }

  /** Content identity of a voxel model: two ids with the same parts hash alike. */
  voxel(id: string | undefined): string | undefined {
    if (!id) return undefined;
    let hash = this.voxelHashes.get(id);
    if (hash === undefined) {
      const model = this.builder.voxelModels.get(id);
      hash = model
        ? createHash('sha1')
            .update(JSON.stringify({ ...model, id: '' }))
            .digest('hex')
        : `missing:${id}`;
      this.voxelHashes.set(id, hash);
    }
    return hash;
  }

  /** A donor may contain unused variants; every requested part and all other model fields must still match. */
  supportsVoxel(id: string | undefined, requested: Side, requestedId: string | undefined): boolean {
    if (this.voxel(id) === requested.voxel(requestedId)) return true;
    if (!id || !requestedId) return false;
    const donor = this.builder.voxelModels.get(id);
    const wanted = requested.builder.voxelModels.get(requestedId);
    if (!donor || !wanted) return false;
    const { turretVariants: donorVariants, ...donorBase } = donor;
    const { turretVariants: wantedVariants, ...wantedBase } = wanted;
    return (
      JSON.stringify({ ...donorBase, id: '' }) === JSON.stringify({ ...wantedBase, id: '' }) &&
      Object.entries(wantedVariants ?? {}).every(
        ([index, parts]) => JSON.stringify(donorVariants?.[index]) === JSON.stringify(parts),
      )
    );
  }

  /** The art-derived part of a record, voxel ids replaced by their content. */
  art(type: LibraryType, includeVoxel = true): string {
    const {
      turret: _turret,
      invisible: _invisible,
      harvester: _harvester,
      refinery: _refinery,
      unloadingVoxel: _unloadingVoxel,
      deployingAnim: _deployingAnim,
      building,
      voxel,
      ...rest
    } = type;
    const { turretVoxel: _turretVoxel, ...body } = building ?? {};
    return JSON.stringify({
      ...rest,
      voxel: includeVoxel ? this.voxel(voxel) : undefined,
      building: building ? body : undefined,
    });
  }

  /** The whole record, voxel ids replaced by their content. */
  full(type: LibraryType): string {
    const turret = type.building?.turretVoxel;
    return JSON.stringify({
      art: this.art(type),
      turret: !!type.turret,
      invisible: !!type.invisible,
      harvester: !!type.harvester,
      refinery: !!type.refinery,
      unloadingVoxel: this.voxel(type.unloadingVoxel),
      deployingAnim: type.deployingAnim,
      turretVoxel: turret ? { ...turret, voxel: this.voxel(turret.voxel) } : undefined,
    });
  }

  section(kind: LibraryKind, id: string): string {
    return (kind === 'infantry' ? this.src.infantryArtOf(id) : this.src.artOf(id)).section.toUpperCase();
  }
}

/**
 * Every type the scenario registers, and every stock type whose record changes under the scenario's rules, as
 * entries bound to stock library art. `inst` must be mounted for the map's theatre.
 */
export function collectScenarioTypes(
  inst: InstallView,
  theaterId: TheaterId,
  scenario: IniFile,
): CollectedScenarioTypes {
  const theater = THEATERS[theaterId];
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const stock = new Side(inst, new ArtSource(inst, theater, () => {}));
  const scen = new Side(inst, new ArtSource(inst, theater, () => {}, [scenario]));
  const types: Record<string, ScenarioType> = {};

  for (const [kind, list] of TYPE_LISTS) {
    const stockIds = unique(stock.src.rules.readRegistry(list));
    const stockSet = new Set(stockIds.map(upper));
    const added = unique(scenario.readRegistry(list)).filter((id) => !stockSet.has(upper(id)));
    const stockOf = (wanted: (id: string) => boolean): string[] => stockIds.filter(wanted);
    /** A stock model with matching default art and every scenario variant, among `candidates` (stock voxel ids). */
    const stockVoxel = (voxel: string, candidates: (string | undefined)[]): string | undefined =>
      candidates.find((c) => c !== undefined && stock.supportsVoxel(c, scen, voxel));

    for (const id of [...stockOf((s) => !!scenario.getSection(s)), ...added]) {
      if (types[id]) continue;
      const isStock = stockSet.has(upper(id));
      const built = scen.type(kind, id);
      const same = isStock ? stock.type(kind, id) : undefined;
      if (!built) {
        // A type without art draws nothing in the engine either; only a stock picture the scenario removes is a loss.
        if (same)
          warn(`${kind} ${id}: the scenario's rules leave it without art: ${scen.reasons.get(`${kind}:${id}`)}`);
        continue;
      }
      if (same && stock.full(same) === scen.full(built)) continue;

      const section = scen.section(kind, id);
      const wanted = scen.art(built, false);
      const donor = [...(isStock ? [id] : []), ...stockOf((s) => s !== id && stock.section(kind, s) === section)].find(
        (candidate) => {
          const record = stock.type(kind, candidate);
          return (
            !!record && stock.art(record, false) === wanted && stock.supportsVoxel(record.voxel, scen, built.voxel)
          );
        },
      );
      if (!donor) {
        warn(
          `${kind} ${id}: no stock type has its art (art section ${section}), so the theatre library cannot draw it`,
        );
        continue;
      }
      const donorType = stock.type(kind, donor)!;
      const entry: ScenarioType = { kind, art: donor };
      if (built.turret) entry.turret = true;
      if (built.invisible) entry.invisible = true;
      if (built.harvester) entry.harvester = true;
      if (built.refinery) entry.refinery = true;

      if (built.deployingAnim) {
        const users = [
          donor,
          ...stockOf((s) => `anim:${(stock.src.rulesGet(s, 'DeployingAnim') ?? '').trim()}` === built.deployingAnim),
        ];
        if (users.some((s) => stock.type(kind, s)?.deployingAnim === built.deployingAnim))
          entry.deployingAnim = built.deployingAnim;
        else warn(`${kind} ${id}: deploying anim ${built.deployingAnim} belongs to no stock type; it is not drawn`);
      }
      if (built.unloadingVoxel) {
        const unloading = (scen.src.rulesGet(id, 'UnloadingClass') ?? '').trim();
        const sameClass = stockOf((s) => upper(s) === upper(unloading));
        const voxel = stockVoxel(built.unloadingVoxel, [
          donorType.unloadingVoxel,
          ...sameClass.map((s) => stock.type(kind, s)?.voxel),
          ...stockOf((s) => upper(stock.src.rulesGet(s, 'UnloadingClass') ?? '') === upper(unloading)).map(
            (s) => stock.type(kind, s)?.unloadingVoxel,
          ),
        ]);
        if (voxel) entry.unloadingVoxel = voxel;
        else
          warn(
            `${kind} ${id}: unloading image ${unloading} matches no stock voxel model; it keeps its travelling image`,
          );
      }
      const turret = built.building?.turretVoxel;
      if (turret) {
        const anim = upper(scen.src.rulesGet(id, 'TurretAnim') ?? '');
        const voxel = stockVoxel(turret.voxel, [
          donorType.building?.turretVoxel?.voxel,
          ...stockOf((s) => upper(stock.src.rulesGet(s, 'TurretAnim') ?? '') === anim).map(
            (s) => stock.type(kind, s)?.building?.turretVoxel?.voxel,
          ),
        ]);
        if (voxel) entry.turretVoxel = { voxel, offset: turret.offset, zAdjust: turret.zAdjust };
        else warn(`${kind} ${id}: turret model ${anim} belongs to no stock type; the turret is not drawn`);
      }
      types[id] = entry;
    }
  }
  return { types, warnings };
}

/** The sidecar of one map cache, or undefined when the scenario changes no type's picture and nothing went wrong. */
export function scenarioTypesSidecar(
  inst: InstallView,
  theaterId: TheaterId,
  scenario: IniFile,
  source: string,
): ScenarioTypesSidecar | undefined {
  const { types, warnings } = collectScenarioTypes(inst, theaterId, scenario);
  if (!Object.keys(types).length && !warnings.length) return undefined;
  return { version: SCENARIO_TYPES_VERSION, theater: theaterId, source, types, warnings };
}

/**
 * Write (or, for `undefined`, remove) `<dir>/scenario-types.json`, replacing the directory entry in one rename so a
 * symbolic link of a copy-on-write cache farm is replaced, never written through. `dir` itself must be a real
 * directory: a linked map directory belongs to another cache (realise it with python/cache_farm.py, or write to a
 * staging directory and install the file from there). `ownsDirectory` lifts that refusal for a caller that has just
 * written the whole directory itself (the map extraction), where a link is the caller's own choice of destination.
 */
export function writeScenarioTypes(
  dir: string,
  sidecar: ScenarioTypesSidecar | undefined,
  ownsDirectory = false,
): void {
  const file = join(dir, SCENARIO_TYPES_FILE);
  if (!ownsDirectory && existsSync(dir) && lstatSync(dir).isSymbolicLink())
    throw new Error(
      `${dir} is a symbolic link into another cache: refusing to write ${SCENARIO_TYPES_FILE} through it`,
    );
  if (!sidecar) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${SCENARIO_TYPES_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(sidecar, null, 1) + '\n');
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
