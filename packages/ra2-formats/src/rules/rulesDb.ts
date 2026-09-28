// The Vanguard typed rules database.
//
// Turns a parsed rulesmd.ini (+ optional artmd.ini for building footprints)
// into a typed, sim-consumable game database. The simulation reads ONLY this
// layer, never raw INI.
//
// DANGLING REFERENCES
// -------------------
// Vanilla rulesmd.ini contains references to weapons/warheads/projectiles that
// are not defined (leftover from Tiberian Sun, typos, etc.). The engine
// tolerates these; so do we. Unknown references are collected into
// {@link RulesDb.diagnostics} rather than throwing, so a full retail rules file
// loads cleanly.

import type { IniFile, IniSection } from '../ini/iniFile.js';
import { parseDecimalToFx, parsePercentInt } from './decimal.js';
import {
  ARMOR_CLASSES,
  ARMOR_CLASS_COUNT,
  LEPTONS_PER_CELL,
  type ArmorClass,
  type BuildingType,
  type GeneralRules,
  type ProjectileType,
  type RulesDiagnostic,
  type TechnoKind,
  type TechnoType,
  type TypeLists,
  type UnitType,
  type WarheadType,
  type WeaponType,
} from './types.js';

/** Case-insensitive map keyed by lower-cased id, preserving insertion order. */
class CiMap<V> {
  private readonly m = new Map<string, V>();
  set(key: string, value: V): void {
    this.m.set(key.toLowerCase(), value);
  }
  get(key: string): V | undefined {
    return this.m.get(key.toLowerCase());
  }
  has(key: string): boolean {
    return this.m.has(key.toLowerCase());
  }
  values(): IterableIterator<V> {
    return this.m.values();
  }
  get size(): number {
    return this.m.size;
  }
}

/**
 * Whether a weapon/warhead/projectile ref is the RA2 "no object" sentinel.
 * Vanilla uses `none` / `<none>` for empty weapon slots; these must not be
 * treated as dangling references.
 */
function isNoneRef(id: string): boolean {
  const v = id.trim().toLowerCase();
  return v === '' || v === 'none' || v === '<none>';
}

/** Deduplicate a list preserving first-seen order (case-insensitive). */
function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Map an INI Armor= string to an ArmorClass, defaulting to `none`. */
function parseArmor(raw: string): ArmorClass {
  const v = raw.trim().toLowerCase();
  return (ARMOR_CLASSES as readonly string[]).includes(v) ? (v as ArmorClass) : 'none';
}

/**
 * The typed, resolved rules database. Construct via {@link RulesDb.build}.
 */
export class RulesDb {
  private constructor(
    /** Ordered, deduped TypeList registries. */
    readonly typeLists: TypeLists,
    /** [General] constants. */
    readonly general: GeneralRules,
    private readonly technos: CiMap<TechnoType>,
    private readonly weapons: CiMap<WeaponType>,
    private readonly warheads: CiMap<WarheadType>,
    private readonly projectiles: CiMap<ProjectileType>,
    /** Non-fatal parse problems (dangling refs, malformed tables, ...). */
    readonly diagnostics: readonly RulesDiagnostic[],
  ) {}

  /** Look up a TechnoType by id (case-insensitive). */
  getTechno(id: string): TechnoType | undefined {
    return this.technos.get(id);
  }
  /** Look up a WeaponType by id (case-insensitive). */
  getWeapon(id: string): WeaponType | undefined {
    return this.weapons.get(id);
  }
  /** Look up a WarheadType by id (case-insensitive). */
  getWarhead(id: string): WarheadType | undefined {
    return this.warheads.get(id);
  }
  /** Look up a ProjectileType by id (case-insensitive). */
  getProjectile(id: string): ProjectileType | undefined {
    return this.projectiles.get(id);
  }

  /** All TechnoTypes, in registration order across the type lists. */
  allTechnos(): TechnoType[] {
    return [...this.technos.values()];
  }
  /** All weapons. */
  allWeapons(): WeaponType[] {
    return [...this.weapons.values()];
  }
  /** All warheads. */
  allWarheads(): WarheadType[] {
    return [...this.warheads.values()];
  }
  /** All projectiles. */
  allProjectiles(): ProjectileType[] {
    return [...this.projectiles.values()];
  }

  /** Count of parsed TechnoTypes. */
  get technoCount(): number {
    return this.technos.size;
  }
  /** Count of parsed weapons. */
  get weaponCount(): number {
    return this.weapons.size;
  }
  /** Count of parsed warheads. */
  get warheadCount(): number {
    return this.warheads.size;
  }
  /** Count of parsed projectiles. */
  get projectileCount(): number {
    return this.projectiles.size;
  }

  /**
   * Resolve the full firing chain for a techno's primary (or secondary)
   * weapon: weapon -> warhead -> projectile. Any link that is absent yields
   * `undefined` for that field; unknown refs are already recorded in
   * {@link diagnostics} at build time.
   */
  resolveTechno(
    id: string,
    slot: 'primary' | 'secondary' = 'primary',
  ):
    | {
        techno: TechnoType;
        weapon?: WeaponType;
        warhead?: WarheadType;
        projectile?: ProjectileType;
      }
    | undefined {
    const techno = this.technos.get(id);
    if (!techno) return undefined;
    const weaponId = slot === 'primary' ? techno.primary : techno.secondary;
    const weapon = weaponId ? this.weapons.get(weaponId) : undefined;
    const warhead = weapon?.warhead ? this.warheads.get(weapon.warhead) : undefined;
    const projectile = weapon?.projectile ? this.projectiles.get(weapon.projectile) : undefined;
    const out: {
      techno: TechnoType;
      weapon?: WeaponType;
      warhead?: WarheadType;
      projectile?: ProjectileType;
    } = { techno };
    if (weapon) out.weapon = weapon;
    if (warhead) out.warhead = warhead;
    if (projectile) out.projectile = projectile;
    return out;
  }

  /**
   * Build the typed database from a parsed rulesmd.ini. `art` (parsed
   * artmd.ini) is optional and supplies building Foundation footprints; when
   * absent, foundation dimensions are 0.
   */
  static build(rules: IniFile, art?: IniFile): RulesDb {
    const diagnostics: RulesDiagnostic[] = [];

    const typeLists: TypeLists = {
      infantry: dedupe(rules.readRegistry('InfantryTypes')),
      vehicles: dedupe(rules.readRegistry('VehicleTypes')),
      buildings: dedupe(rules.readRegistry('BuildingTypes')),
      aircraft: dedupe(rules.readRegistry('AircraftTypes')),
      superWeapons: dedupe(rules.readRegistry('SuperWeaponTypes')),
      countries: dedupe(rules.readRegistry('Countries')),
      sides: dedupe(rules.readRegistry('Sides')),
    };

    const general = parseGeneral(rules);

    // --- Weapons, warheads, projectiles -------------------------------------
    // In vanilla rules, weapons/warheads/projectiles are referenced by section
    // name from unit definitions. We parse a section on first reference (lazily
    // discovering the ref graph) plus any that are pre-listed. To keep it
    // simple and complete we scan for every section referenced by a techno and
    // resolve on demand, caching results.
    const weapons = new CiMap<WeaponType>();
    const warheads = new CiMap<WarheadType>();
    const projectiles = new CiMap<ProjectileType>();

    const ensureWarhead = (id: string, from: string): void => {
      if (isNoneRef(id) || warheads.has(id)) return;
      const sec = rules.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'unknown-warhead',
          from,
          ref: id,
          message: `Weapon '${from}' references undefined Warhead '${id}'.`,
        });
        return;
      }
      warheads.set(id, parseWarhead(id, sec, diagnostics));
    };

    const ensureProjectile = (id: string, from: string): void => {
      if (isNoneRef(id) || projectiles.has(id)) return;
      const sec = rules.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'unknown-projectile',
          from,
          ref: id,
          message: `Weapon '${from}' references undefined Projectile '${id}'.`,
        });
        return;
      }
      projectiles.set(id, parseProjectile(id, sec));
    };

    const ensureWeapon = (id: string, from: string): void => {
      if (isNoneRef(id) || weapons.has(id)) return;
      const sec = rules.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'unknown-weapon',
          from,
          ref: id,
          message: `'${from}' references undefined Weapon '${id}'.`,
        });
        return;
      }
      const weapon = parseWeapon(id, sec);
      weapons.set(id, weapon);
      if (weapon.warhead) ensureWarhead(weapon.warhead, id);
      if (weapon.projectile) ensureProjectile(weapon.projectile, id);
    };

    // --- Foundations from artmd.ini -----------------------------------------
    // artmd.ini maps a building's Image (or its own id) to a Foundation=WxH.
    // We look up by building id first, then by its Image= if present.
    const foundationOf = (
      buildingId: string,
      imageId: string | undefined,
    ): { w: number; h: number } => {
      if (!art) return { w: 0, h: 0 };
      const artSec = art.getSection(imageId ?? buildingId) ?? art.getSection(buildingId);
      if (!artSec) return { w: 0, h: 0 };
      const raw = artSec.getString('Foundation', '').trim().toLowerCase();
      const m = /^(\d+)x(\d+)$/.exec(raw);
      if (!m) return { w: 0, h: 0 };
      return { w: Number.parseInt(m[1]!, 10), h: Number.parseInt(m[2]!, 10) };
    };

    // --- TechnoTypes --------------------------------------------------------
    const technos = new CiMap<TechnoType>();

    const parseAndStore = (id: string, kind: TechnoKind): void => {
      const sec = rules.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'unknown-type',
          from: `${kind}Types`,
          ref: id,
          message: `Type list registers '${id}' but no [${id}] section exists.`,
        });
        return;
      }
      let techno: TechnoType;
      if (kind === 'building') {
        techno = parseBuilding(id, sec, general, foundationOf(id, sec.getString('Image').trim() || undefined));
      } else if (kind === 'infantry' || kind === 'vehicle') {
        techno = parseUnit(id, sec, kind, general);
      } else {
        // Aircraft share the TechnoType layer but have no UnitType movement
        // extras in the v1 slice; store the common fields directly.
        techno = parseTechnoCommon(id, sec, kind, general);
      }
      technos.set(id, techno);
      if (techno.primary) ensureWeapon(techno.primary, id);
      if (techno.secondary) ensureWeapon(techno.secondary, id);
    };

    for (const id of typeLists.infantry) parseAndStore(id, 'infantry');
    for (const id of typeLists.vehicles) parseAndStore(id, 'vehicle');
    for (const id of typeLists.buildings) parseAndStore(id, 'building');
    for (const id of typeLists.aircraft) parseAndStore(id, 'aircraft');

    return new RulesDb(typeLists, general, technos, weapons, warheads, projectiles, diagnostics);
  }
}

// ---------------------------------------------------------------------------
// Section parsers (module-private)
// ---------------------------------------------------------------------------

/** Expand Prerequisite= entries against [General] alias groups. */
function expandPrerequisites(
  raw: readonly string[],
  aliases: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const group = aliases.get(entry.toLowerCase());
    if (group) {
      out.push(...group);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Shared TechnoType fields. */
function parseTechnoCommon(
  id: string,
  sec: IniSection,
  kind: TechnoKind,
  general: GeneralRules,
): TechnoType {
  const t: TechnoType = {
    id,
    kind,
    cost: sec.getInt('Cost', 0),
    strength: sec.getInt('Strength', 0),
    armor: parseArmor(sec.getString('Armor', 'none')),
    techLevel: sec.getInt('TechLevel', -1),
    prerequisite: expandPrerequisites(sec.getList('Prerequisite'), general.prerequisiteAliases),
    owner: sec.getList('Owner'),
    requiredHouses: sec.getList('RequiredHouses'),
    forbiddenHouses: sec.getList('ForbiddenHouses'),
    speed: sec.getInt('Speed', 0),
    // Default Sight to 1 (not 0): a 0-default silently produces a BLIND unit that reveals
    // only its own cell(s) if a ruleset omits `Sight=`, which is a footgun (fog never opens
    // ahead of it). Retail units carry explicit Sight, so this default only bites malformed/
    // partial rules — 1 cell is the minimal sane fallback there.
    sight: sec.getInt('Sight', 1),
    // BuildTimeMultiplier= is a decimal factor (default 1.0). Absent -> 65536 (Q16.16 1.0),
    // so a type that omits the key builds at the global BuildSpeed rate with no scaling.
    buildTimeMultiplier: parseDecimalToFx(sec.getString('BuildTimeMultiplier', '1'), 65536),
    points: sec.getInt('Points', 0),
    soylent: sec.getInt('Soylent', 0),
    crewed: sec.getBool('Crewed', false),
    trainable: sec.getBool('Trainable', true),
    guardRange: sec.getInt('GuardRange', 0),
  };
  const primary = sec.getString('Primary').trim();
  const secondary = sec.getString('Secondary').trim();
  // exactOptionalPropertyTypes: only attach when present and not the `none`
  // sentinel (an empty weapon slot).
  return {
    ...t,
    ...(isNoneRef(primary) ? {} : { primary }),
    ...(isNoneRef(secondary) ? {} : { secondary }),
  };
}

function parseUnit(
  id: string,
  sec: IniSection,
  kind: 'infantry' | 'vehicle',
  general: GeneralRules,
): UnitType {
  const base = parseTechnoCommon(id, sec, kind, general);
  const locomotor = sec.getString('Locomotor').trim();
  const movementZone = sec.getString('MovementZone').trim();
  const deploysInto = sec.getString('DeploysInto').trim();
  const undeploysInto = sec.getString('UndeploysInto').trim();
  return {
    ...base,
    kind,
    passengers: sec.getInt('Passengers', 0),
    harvester: sec.getBool('Harvester', false),
    weeder: sec.getBool('Weeder', false),
    turret: sec.getBool('Turret', false),
    deployer: sec.getBool('Deployer', false),
    ...(locomotor ? { locomotor } : {}),
    ...(movementZone ? { movementZone } : {}),
    ...(deploysInto ? { deploysInto } : {}),
    ...(undeploysInto ? { undeploysInto } : {}),
  };
}

function parseBuilding(
  id: string,
  sec: IniSection,
  general: GeneralRules,
  foundation: { w: number; h: number },
): BuildingType {
  const base = parseTechnoCommon(id, sec, 'building', general);
  const factory = sec.getString('Factory').trim();
  const buildCat = sec.getString('BuildCat').trim();
  return {
    ...base,
    kind: 'building',
    power: sec.getInt('Power', 0),
    powered: sec.getBool('Powered', false),
    storage: sec.getInt('Storage', 0),
    radar: sec.getBool('Radar', false),
    weaponsFactory: sec.getBool('WeaponsFactory', false),
    adjacent: sec.getInt('Adjacent', 1),
    foundationWidth: foundation.w,
    foundationHeight: foundation.h,
    capturable: sec.getBool('Capturable', false),
    baseNormal: sec.getBool('BaseNormal', true),
    ...(factory ? { factory } : {}),
    ...(buildCat ? { buildCat } : {}),
  };
}

function parseWeapon(id: string, sec: IniSection): WeaponType {
  const projectile = sec.getString('Projectile').trim();
  const warhead = sec.getString('Warhead').trim();
  const report = sec.getString('Report').trim();
  // Range is in cells (may be fractional, e.g. 4.5). Convert to leptons using
  // string->fixed then floor*256 with integer math so partial cells survive.
  const rangeCells = sec.getString('Range', '0');
  const rangeFx = parseDecimalToFx(rangeCells, 0);
  // leptons = round(cells * 256). rangeFx is cells*65536; *256 / 65536 = *256>>16.
  const range = Math.trunc((rangeFx * LEPTONS_PER_CELL) / 65536);
  return {
    id,
    damage: sec.getInt('Damage', 0),
    rof: sec.getInt('ROF', 0),
    range,
    burst: sec.getInt('Burst', 1),
    ...(isNoneRef(projectile) ? {} : { projectile }),
    ...(isNoneRef(warhead) ? {} : { warhead }),
    ...(report ? { report } : {}),
  };
}

/**
 * Parse a Verses= table to a length-11 integer-percent array aligned to
 * {@link ARMOR_CLASSES}. RA2 tolerates short tables: missing trailing entries
 * default to 100% (full damage). Entries may be written with or without a
 * trailing `%` (`100%,60%,...` or `100,60,...`); both are accepted.
 */
function parseVerses(id: string, raw: string, diagnostics: RulesDiagnostic[]): number[] {
  const verses = new Array<number>(ARMOR_CLASS_COUNT).fill(100);
  const trimmed = raw.trim();
  if (trimmed === '') return verses;
  const parts = trimmed.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length > ARMOR_CLASS_COUNT) {
    diagnostics.push({
      kind: 'malformed-verses',
      from: id,
      ref: raw,
      message: `Warhead '${id}' Verses has ${parts.length} entries (>${ARMOR_CLASS_COUNT}); extras ignored.`,
    });
  }
  for (let i = 0; i < parts.length && i < ARMOR_CLASS_COUNT; i++) {
    verses[i] = parsePercentInt(parts[i]!, 100);
  }
  return verses;
}

function parseWarhead(id: string, sec: IniSection, diagnostics: RulesDiagnostic[]): WarheadType {
  return {
    id,
    verses: parseVerses(id, sec.getString('Verses', ''), diagnostics),
    spread: parseDecimalToFx(sec.getString('Spread', '0'), 0),
    cellSpread: parseDecimalToFx(sec.getString('CellSpread', '0'), 0),
    wall: sec.getBool('Wall', false),
    wood: sec.getBool('Wood', false),
    infDeath: sec.getInt('InfDeath', 0),
  };
}

function parseProjectile(id: string, sec: IniSection): ProjectileType {
  return {
    id,
    inviso: sec.getBool('Inviso', false),
    arcing: sec.getBool('Arcing', false),
    aa: sec.getBool('AA', false),
    ag: sec.getBool('AG', true),
    vertical: sec.getBool('Vertical', false),
    rot: sec.getInt('ROT', 0),
  };
}

/**
 * Parse `RefundPercent` to an integer percent, accepting both the vanilla
 * percent form (`50%` -> 50) and a bare fraction below 1 (`0.5` -> 50). A value
 * with an explicit `%` is taken verbatim; a `%`-less value that is a proper
 * fraction strictly below 1 is scaled by 100. A `%`-less value >= 1 is treated
 * as an already-whole percent and floored as-is (`1` -> 1, `2` -> 2). Exact
 * integer/fixed-point math, no float rounding.
 */
function parseRefundPercent(raw: string): number {
  const s = raw.trim();
  if (s.endsWith('%')) return parsePercentInt(s, 0);
  const fx = parseDecimalToFx(s, 0);
  // fx is value*65536. If value < 1 (fx < 65536) it's a fraction: *100.
  // Otherwise it is already a whole-number percent (rare), taken as-is.
  if (fx > 0 && fx < 65536) return Math.trunc((fx * 100) / 65536);
  return fx >> 16;
}

/**
 * Parse the `[General]` constants the v1 sim slice needs, including the
 * PrerequisiteX alias groups used to expand Prerequisite= references.
 */
function parseGeneral(rules: IniFile): GeneralRules {
  const g = rules.getSection('General');
  const aliases = new Map<string, readonly string[]>();
  if (g) {
    // Collect every key beginning with "Prerequisite" whose remainder names an
    // alias group (PrerequisitePower, PrerequisiteFactory, PrerequisiteBarracks,
    // PrerequisiteRadar, PrerequisiteTech, PrerequisiteProc, ...). The plain
    // "Prerequisite" key (if any) is not an alias group and is skipped.
    for (const entry of g.entries) {
      const key = entry.key;
      const lower = key.toLowerCase();
      if (!lower.startsWith('prerequisite') || lower === 'prerequisite') continue;
      const aliasName = lower.slice('prerequisite'.length);
      if (aliasName === '') continue;
      const members = entry.value
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      if (members.length > 0) aliases.set(aliasName, members);
    }
  }

  const str = (k: string, d = ''): string => (g ? g.getString(k, d) : d);
  const baseUnit = str('BaseUnit').split(',').map((s) => s.trim()).filter((s) => s !== '')[0];
  const harvesterUnit = str('HarvesterUnit').split(',').map((s) => s.trim()).filter((s) => s !== '')[0];

  return {
    buildSpeed: parseDecimalToFx(str('BuildSpeed', '0'), 0),
    buildupTime: parseDecimalToFx(str('BuildupTime', '0'), 0),
    growthRate: parseDecimalToFx(str('GrowthRate', '0'), 0),
    tiberiumGrows: g ? g.getBool('TiberiumGrows', false) : false,
    // RefundPercent in vanilla [General] is written as a percentage (`50%`);
    // Ares mods sometimes use a bare fraction (`0.5`). parsePercentInt strips a
    // trailing `%` and floors, so `50%` -> 50. A bare fraction like `0.5`
    // (meaning 50%) would floor to 0 under percent semantics, so we special-case
    // a `%`-less value below 1 as a fraction.
    refundPercent: parseRefundPercent(str('RefundPercent', '0')),
    reloadRate: parseDecimalToFx(str('ReloadRate', '0'), 0),
    prerequisiteAliases: aliases,
    ...(baseUnit ? { baseUnit } : {}),
    ...(harvesterUnit ? { harvesterUnit } : {}),
  };
}
