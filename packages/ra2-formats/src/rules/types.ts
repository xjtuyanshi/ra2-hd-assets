// Typed shapes for the Vanguard rules database.
//
// This is the *only* layer the simulation consumes; it never reads raw INI.
// Field meanings follow ModEnc (modenc.renegadeprojects.com) vanilla RA2/YR
// semantics. Non-obvious fields carry a doc comment citing the concept.
//
// UNITS CONVENTION
// ----------------
//   * Decimals that RA2 stores as fractions (BuildSpeed, ROT, Spread, ...) are
//     exposed as raw Q16.16 fixed-point integers (`FxRaw`, value * 65536),
//     matching packages/sim/src/fixed. See decimal.ts.
//   * Percent tables (Verses) are integer percents (100 == full damage).
//   * Ranges are LEPTONS: 1 cell = 256 leptons, so `Range=5` (cells) -> 1280.
//   * Everything else (Cost, Strength, TechLevel, Speed, Sight, ...) is a plain
//     integer, read verbatim.

import type { FxRaw } from './decimal.js';

/** Leptons per cell. RA2 measures sub-cell distances in 1/256-cell leptons. */
export const LEPTONS_PER_CELL = 256;

/**
 * The 11 RA2 armor classes, in the fixed order the engine uses for `Verses=`
 * tables. A warhead's Verses list is index-aligned to this enum: entry `i` is
 * the percent damage that warhead deals to armor class `i`.
 *
 * ModEnc: "Armor" / "Verses". The two trailing `special_*` classes exist in the
 * engine's enum though vanilla units rarely use them.
 */
export const ARMOR_CLASSES = [
  'none',
  'flak',
  'plate',
  'light',
  'medium',
  'heavy',
  'wood',
  'steel',
  'concrete',
  'special_1',
  'special_2',
] as const;

/** One of the 11 armor classes. */
export type ArmorClass = (typeof ARMOR_CLASSES)[number];

/** Number of armor classes / expected length of a full `Verses` table. */
export const ARMOR_CLASS_COUNT = ARMOR_CLASSES.length;

/**
 * Ordered, deduped registries parsed from the TypeList sections. Vanilla
 * rulesmd registers some ids more than once; each list here is in first-seen
 * order with later duplicates removed.
 */
export interface TypeLists {
  readonly infantry: readonly string[];
  readonly vehicles: readonly string[];
  readonly buildings: readonly string[];
  readonly aircraft: readonly string[];
  readonly superWeapons: readonly string[];
  readonly countries: readonly string[];
  readonly sides: readonly string[];
}

/** Which broad category a TechnoType belongs to. */
export type TechnoKind = 'infantry' | 'vehicle' | 'building' | 'aircraft';

/**
 * Fields shared by every buildable/combat object (infantry, vehicles,
 * buildings, aircraft). ModEnc calls this the TechnoType layer.
 */
export interface TechnoType {
  /** INI id, e.g. `HTNK`. Original case as registered. */
  readonly id: string;
  /** Which type list this came from. */
  readonly kind: TechnoKind;
  /** Credits to build. ModEnc: Cost. */
  readonly cost: number;
  /** Hit points. ModEnc: Strength. */
  readonly strength: number;
  /** Armor class this object presents to warheads. ModEnc: Armor. */
  readonly armor: ArmorClass;
  /** Tech level required to build; -1 means unbuildable. ModEnc: TechLevel. */
  readonly techLevel: number;
  /**
   * Prerequisite structures/ids, with `[General]` alias groups
   * (PrerequisitePower, ...) expanded to their member ids. ModEnc: Prerequisite.
   */
  readonly prerequisite: readonly string[];
  /** Owning countries/sides. ModEnc: Owner. */
  readonly owner: readonly string[];
  /** Houses that may own/build this even if Owner would forbid. RequiredHouses. */
  readonly requiredHouses: readonly string[];
  /** Houses explicitly forbidden. ModEnc: ForbiddenHouses. */
  readonly forbiddenHouses: readonly string[];
  /** Movement speed (leptons/frame-ish engine units). ModEnc: Speed. */
  readonly speed: number;
  /** Sight radius in cells. ModEnc: Sight. */
  readonly sight: number;
  /** Primary weapon id, or undefined. ModEnc: Primary. */
  readonly primary?: string;
  /** Secondary weapon id, or undefined. ModEnc: Secondary. */
  readonly secondary?: string;
  /**
   * Per-type build-time multiplier as Q16.16 (value * 65536). ModEnc: BuildTimeMultiplier=.
   * Multiplies this techno's computed build time on top of the global `[General] BuildSpeed`
   * (e.g. HTNK BuildTimeMultiplier=1.5 -> 98304 makes the Rhino take 1.5x as long). Defaults to
   * 1.0 (65536) when the section omits it — no effect.
   */
  readonly buildTimeMultiplier: FxRaw;
  /** AI target-value / veterancy points. ModEnc: Points. */
  readonly points: number;
  /** Credits refunded to a Grinder / Bio Reactor. ModEnc: Soylent. */
  readonly soylent: number;
  /** Can be crewed / ejects survivors. ModEnc: Crewed. */
  readonly crewed: boolean;
  /** Gains veterancy. ModEnc: Trainable. */
  readonly trainable: boolean;
  /** Auto-fire guard radius in cells. ModEnc: GuardRange. */
  readonly guardRange: number;
}

/** Building-only fields. ModEnc: BuildingType. */
export interface BuildingType extends TechnoType {
  readonly kind: 'building';
  /** Power produced (positive) or drawn (negative). ModEnc: Power. */
  readonly power: number;
  /**
   * Requires powered-up base to operate; goes offline (armed defenses hold fire)
   * when the owner is low-power. ModEnc: Powered= (default no). Note this is
   * distinct from Power=: Powered=no structures with a negative Power= still draw
   * power but keep functioning during a shortage (e.g. the Pill Box), whereas
   * Powered=yes structures (Tesla Coil, Prism Cannon, Sentry Gun) shut down.
   */
  readonly powered: boolean;
  /** Ore/credit storage capacity. ModEnc: Storage. */
  readonly storage: number;
  /** Provides radar/minimap. ModEnc: Radar. */
  readonly radar: boolean;
  /** Is a unit factory. ModEnc: Factory (non-empty string) — kept raw. */
  readonly factory?: string;
  /** Is a vehicle weapons factory. ModEnc: WeaponsFactory. */
  readonly weaponsFactory: boolean;
  /** Build sidebar category. ModEnc: BuildCat. */
  readonly buildCat?: string;
  /** Counts as adjacent for placement (Adjacent= extends build radius). */
  readonly adjacent: number;
  /** Footprint width in cells (from artmd.ini Foundation=WxH). 0 if unknown. */
  readonly foundationWidth: number;
  /** Footprint height in cells (from artmd.ini Foundation=WxH). 0 if unknown. */
  readonly foundationHeight: number;
  /** Can be captured by engineers. ModEnc: Capturable. */
  readonly capturable: boolean;
  /** Part of a base for AI/placement purposes. ModEnc: BaseNormal. */
  readonly baseNormal: boolean;
}

/** Infantry/vehicle-only fields. ModEnc: UnitType / InfantryType. */
export interface UnitType extends TechnoType {
  readonly kind: 'infantry' | 'vehicle';
  /** Locomotor CLSID (raw string). ModEnc: Locomotor. */
  readonly locomotor?: string;
  /** Which movement zone the unit occupies. ModEnc: MovementZone. */
  readonly movementZone?: string;
  /** Passenger capacity. ModEnc: Passengers. */
  readonly passengers: number;
  /** Harvests ore. ModEnc: Harvester. */
  readonly harvester: boolean;
  /** Slave-miner style weeder. ModEnc: Weeder. */
  readonly weeder: boolean;
  /**
   * Has a rotating turret that aims independently of the body. ModEnc: Turret=. Turreted
   * vehicles (e.g. the Rhino/Grizzly tanks) swivel a gun turret toward their target while
   * the hull keeps its travel facing; turret-less units aim by rotating the whole body.
   */
  readonly turret: boolean;
  /** Can deploy in place. ModEnc: Deployer. */
  readonly deployer: boolean;
  /** Building id this unit deploys into. ModEnc: DeploysInto. */
  readonly deploysInto?: string;
  /** Unit id this (building) undeploys into. ModEnc: UndeploysInto. */
  readonly undeploysInto?: string;
}

/** A weapon definition. ModEnc: WeaponType. */
export interface WeaponType {
  readonly id: string;
  /** Base damage before Verses. ModEnc: Damage. */
  readonly damage: number;
  /** Rate of fire in game frames between shots. ModEnc: ROF. */
  readonly rof: number;
  /** Range in LEPTONS (Range= is in cells; multiplied by 256). ModEnc: Range. */
  readonly range: number;
  /** Projectile id. ModEnc: Projectile. */
  readonly projectile?: string;
  /** Warhead id. ModEnc: Warhead. */
  readonly warhead?: string;
  /** Firing sound entry. ModEnc: Report. */
  readonly report?: string;
  /** Shots per burst. ModEnc: Burst. */
  readonly burst: number;
}

/** A warhead definition. ModEnc: WarheadType. */
export interface WarheadType {
  readonly id: string;
  /**
   * Damage-vs-armor table: integer percent per armor class, index-aligned to
   * {@link ARMOR_CLASSES}. Always length 11 — missing trailing entries are
   * filled with the RA2 default of 100 (see note in rulesDb parse). ModEnc:
   * Verses.
   */
  readonly verses: readonly number[];
  /** Damage falloff radius as Q16.16 (from Spread=, in cells). ModEnc: Spread. */
  readonly spread: FxRaw;
  /** Cells of full-damage splash. ModEnc: CellSpread (Q16.16). */
  readonly cellSpread: FxRaw;
  /** Damages walls. ModEnc: Wall. */
  readonly wall: boolean;
  /** Damages wooden overlay/walls. ModEnc: Wood. */
  readonly wood: boolean;
  /** Infantry death animation selector. ModEnc: InfDeath. */
  readonly infDeath: number;
}

/** A projectile definition. ModEnc: Projectile. */
export interface ProjectileType {
  readonly id: string;
  /** Invisible/instant-hit. ModEnc: Inviso. */
  readonly inviso: boolean;
  /** Follows a ballistic arc. ModEnc: Arcing. */
  readonly arcing: boolean;
  /** Can target aircraft. ModEnc: AA. */
  readonly aa: boolean;
  /** Can target ground. ModEnc: AG. */
  readonly ag: boolean;
  /** Fired straight up (e.g. some AA). ModEnc: Vertical. */
  readonly vertical: boolean;
  /** Rate of turn (homing agility). ModEnc: ROT. */
  readonly rot: number;
}

/**
 * `[General]` constants the v1 sim slice needs. Fractions are Q16.16.
 * ModEnc: [General].
 */
export interface GeneralRules {
  /** Global build-time multiplier (BuildSpeed=0.7 -> Q16.16). ModEnc: BuildSpeed. */
  readonly buildSpeed: FxRaw;
  /** Frames of buildup animation gating. ModEnc: BuildupTime (Q16.16). */
  readonly buildupTime: FxRaw;
  /** Ore regrowth rate in minutes (Q16.16). ModEnc: GrowthRate. */
  readonly growthRate: FxRaw;
  /** Whether ore/tiberium regrows. ModEnc: TiberiumGrows. */
  readonly tiberiumGrows: boolean;
  /** Fraction of cost refunded on sell (percent int). ModEnc: RefundPercent. */
  readonly refundPercent: number;
  /** Weapon reload cadence (Q16.16). ModEnc: ReloadRate. */
  readonly reloadRate: FxRaw;
  /** Default MCV/base unit id. ModEnc: BaseUnit (first entry). */
  readonly baseUnit?: string;
  /** Default harvester id. ModEnc: HarvesterUnit (first entry). */
  readonly harvesterUnit?: string;
  /**
   * Prerequisite alias groups: lower-cased alias name (e.g. `power`) -> member
   * building ids. Sourced from PrerequisitePower / PrerequisiteFactory / ...
   * These expand `Prerequisite=POWER` style references in TechnoTypes.
   */
  readonly prerequisiteAliases: ReadonlyMap<string, readonly string[]>;
}

/** A single diagnostic recorded during parsing (dangling refs, etc.). */
export interface RulesDiagnostic {
  /** Machine-readable category. */
  readonly kind:
    | 'unknown-weapon'
    | 'unknown-warhead'
    | 'unknown-projectile'
    | 'unknown-type'
    | 'malformed-verses'
    | 'missing-section';
  /** The referencing object id (e.g. the unit or weapon that pointed here). */
  readonly from: string;
  /** The unresolved / offending reference. */
  readonly ref: string;
  /** Human-readable detail. */
  readonly message: string;
}
