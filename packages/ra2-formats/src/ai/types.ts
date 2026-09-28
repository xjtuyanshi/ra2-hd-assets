// Typed shapes for the Vanguard AI database (parsed from aimd.ini).
//
// aimd.ini is the retail RA2/YR skirmish-AI data file. It defines the reusable
// building blocks a computer player composes into behaviour:
//
//   * [TaskForces]  — named unit compositions ("3 Rhino, 2 Flak").
//   * [ScriptTypes] — ordered action lists a team runs ("move to waypoint,
//     attack the nearest enemy building").
//   * [TeamTypes]   — bind a TaskForce to a Script plus recruitment/priority
//     metadata ("Soviet Armor Hard": build 5 Rhinos, run the general-attack
//     script, priority 5).
//   * [AITriggerTypes] — weight-driven rules that pick which TeamType to build
//     given game conditions. DELIBERATELY NOT MODELLED in v1 (see aiDb.ts).
//
// This is the *only* AI layer the bot consumes; it never reads raw INI. All ids
// in vanilla aimd.ini are GUID-suffixed strings like `0ACDC72C-G`; we keep them
// verbatim and resolve refs case-insensitively, mirroring the rules layer.

/**
 * A single member line of a TaskForce: build `count` of TechnoType `typeId`.
 * In aimd.ini these appear as indexed `0=count,TYPE` lines.
 */
export interface TaskForceEntry {
  /** How many of the unit to include (aimd: the number before the comma). */
  readonly count: number;
  /** TechnoType id, e.g. `HTNK`. Original case as written in aimd.ini. */
  readonly typeId: string;
}

/**
 * A named unit composition. ModEnc: TaskForce. The engine uses `Group` to gate
 * which teams may recruit from it (-1 = any); we retain it verbatim for
 * fidelity though the v1 bot does not act on it.
 */
export interface TaskForce {
  /** GUID-style section id, e.g. `0ACDC72C-G`. */
  readonly id: string;
  /** Human-readable `Name=` (e.g. "5 Rhino, 2 Flak"). '' if absent. */
  readonly name: string;
  /** Ordered member entries, in the `0=`,`1=`,... index order of the section. */
  readonly units: readonly TaskForceEntry[];
  /** Recruitment group gate. ModEnc: Group. -1 (the vanilla default) = any. */
  readonly group: number;
}

/**
 * One step of a Script: a raw `(action, arg)` pair. aimd.ini stores these as
 * indexed `0=action,arg` lines where both are integers. The engine dispatches
 * `action` through a large opcode table; we keep the raw ints and expose the
 * handful the v1 bot understands via {@link ScriptAction}.
 */
export interface ScriptStep {
  /** Raw script action opcode. See {@link ScriptAction}. */
  readonly action: number;
  /** Raw action argument (waypoint index, quarry enum, count, ...). */
  readonly arg: number;
}

/** An ordered AI script. ModEnc: ScriptType. */
export interface Script {
  /** GUID-style section id. */
  readonly id: string;
  /** Human-readable `Name=`. '' if absent. */
  readonly name: string;
  /** Ordered `(action, arg)` steps in section index order. */
  readonly actions: readonly ScriptStep[];
}

/**
 * A team template: a TaskForce + Script + recruitment metadata. ModEnc:
 * TeamType. Only the fields the v1 bot needs are surfaced; the rest of the (very
 * large) vanilla TeamType flag set is intentionally not modelled.
 */
export interface TeamType {
  /** GUID-style section id. */
  readonly id: string;
  /** Human-readable `Name=`. '' if absent. */
  readonly name: string;
  /** Referenced TaskForce id (`TaskForce=`). '' if absent. */
  readonly taskForce: string;
  /** Referenced Script id (`Script=`). '' if absent. */
  readonly script: string;
  /** Selection weight. ModEnc: Priority. Higher = preferred. */
  readonly priority: number;
  /** Max simultaneous instances the AI keeps. ModEnc: Max. */
  readonly max: number;
  /** Minimum tech level gate. ModEnc: TechLevel. */
  readonly techLevel: number;
  /**
   * House restriction. ModEnc: House. Vanilla aimd.ini leaves this `<none>`
   * (any house); we normalise the `<none>`/`` sentinels to `undefined`.
   */
  readonly house?: string;
  /** Is a base-defence team (stationary). ModEnc: IsBaseDefense. */
  readonly isBaseDefense: boolean;
}

/**
 * A single non-fatal problem found while parsing/resolving aimd.ini. Mirrors the
 * rules layer's {@link RulesDiagnostic} philosophy: collect, never throw.
 */
export interface AiDiagnostic {
  /** Machine-readable category. */
  readonly kind:
    | 'unknown-taskforce' // a TeamType (or resolve query) referenced a missing TaskForce
    | 'unknown-script' // a TeamType referenced a missing Script
    | 'missing-section' // a registry id had no matching section
    | 'malformed-entry' // a TaskForce/Script line did not parse as count,type / action,arg
    | 'dropped-taskforce'; // a TaskForce was filtered out (a unit is outside the slice)
  /** The referencing object id. */
  readonly from: string;
  /** The unresolved / offending reference. */
  readonly ref: string;
  /** Human-readable detail. */
  readonly message: string;
}

/**
 * The documented subset of RA2 script-action opcodes the v1 bot understands.
 * The full opcode table has ~60 entries (see ModEnc "ScriptTypes"); we enumerate
 * only the ones the bot dispatches on. All other opcodes are preserved as raw
 * ints in {@link ScriptStep.action} and ignored by the bot.
 *
 * Values are the stable engine opcode numbers (verified against retail aimd.ini
 * scripts, e.g. the "General Attack Buildings" script uses 0 = attack-quarry
 * with arg 2 = buildings).
 */
export const ScriptAction = {
  /** 0: Attack the nearest target of the quarry category in `arg`. AttackQuarry. */
  AttackQuarry: 0,
  /** 3: Move to the waypoint whose index is `arg`. MoveToWaypoint. */
  MoveToWaypoint: 3,
  /** 5: Guard the area for `arg` ~1/15s ticks (delay/guard). GuardArea. */
  GuardArea: 5,
  /** 6: Jump back to script line `arg` (loop). JumpToLine. */
  JumpToLine: 6,
  /** 53: Move to the enemy's nearest structure. MoveToEnemyStructure. */
  MoveToEnemyStructure: 53,
  /** 54: Guard the current location. GuardCurrent. */
  GuardCurrent: 54,
  /** 58: Attack-move / set target zone (arg = quarry-encoded). AttackMove. */
  AttackMove: 58,
} as const;

/**
 * The RA2 "quarry" target categories used as the `arg` of an AttackQuarry (0)
 * action — the documented subset the bot reasons about. Raw ints; other values
 * are preserved and ignored.
 */
export const ScriptQuarry = {
  /** 0: Anything. */
  Anything: 0,
  /** 1: Buildings — the whole enemy base. */
  Buildings: 1,
  /** 2: Buildings that are factories/production. */
  Factories: 2,
} as const;
