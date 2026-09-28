// The Vanguard typed AI database.
//
// Turns a parsed aimd.ini into the typed, bot-consumable building blocks a
// computer player composes into behaviour. The bot reads ONLY this layer, never
// raw INI — exactly as the sim reads only {@link RulesDb} and never rulesmd.ini.
//
// WHAT WE MODEL (v1)
// ------------------
//   [TaskForces]  -> TaskForce  (named unit compositions)
//   [ScriptTypes] -> Script     (ordered (action,arg) opcode lists)
//   [TeamTypes]   -> TeamType   (TaskForce + Script + priority/max/house)
//
// WHAT WE DELIBERATELY SKIP (v1): [AITriggerTypes]
// -----------------------------------------------
// AITriggerTypes are weight-driven rules that select which TeamType to build
// given game conditions (owner-house count, enemy-house, a comparator on a
// TechnoType count, easy/medium/hard weights, ...). Modelling them faithfully
// means porting the engine's per-frame weighted-trigger evaluator, which the v1
// bot does not need: it drives TeamTypes directly (pick a team, resolve its
// TaskForce against the buildable slice, produce it). Deferring the trigger
// layer keeps this database a pure, deterministic data projection with no
// game-state dependency. The section is left entirely unparsed; when the bot
// grows condition-driven macro play it can be added here without disturbing the
// existing typed shapes.
//
// DANGLING REFERENCES
// -------------------
// Like rulesmd.ini, aimd.ini contains refs that do not resolve within the file
// (or, after slice-filtering, TaskForces whose units are outside the buildable
// set). We tolerate these: unknown/dropped refs are collected into
// {@link AiDb.diagnostics} rather than thrown, so a full retail aimd.ini loads
// cleanly and the bot simply skips what it cannot use.

import type { IniFile, IniSection } from '../ini/iniFile.js';
import type {
  AiDiagnostic,
  Script,
  ScriptStep,
  TaskForce,
  TaskForceEntry,
  TeamType,
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

/** Whether a House= value is the RA2 "no restriction" sentinel. */
function isNoneRef(id: string): boolean {
  const v = id.trim().toLowerCase();
  return v === '' || v === 'none' || v === '<none>';
}

/**
 * The typed, resolved AI database. Construct via {@link AiDb.build}.
 */
export class AiDb {
  private constructor(
    private readonly taskForces: CiMap<TaskForce>,
    private readonly scripts: CiMap<Script>,
    private readonly teamTypes: CiMap<TeamType>,
    /** Non-fatal parse problems (dangling refs, malformed lines, ...). */
    readonly diagnostics: readonly AiDiagnostic[],
  ) {}

  /** Look up a TaskForce by id (case-insensitive). */
  getTaskForce(id: string): TaskForce | undefined {
    return this.taskForces.get(id);
  }
  /** Look up a Script by id (case-insensitive). */
  getScript(id: string): Script | undefined {
    return this.scripts.get(id);
  }
  /** Look up a TeamType by id (case-insensitive). */
  getTeamType(id: string): TeamType | undefined {
    return this.teamTypes.get(id);
  }

  /** All TaskForces, in registration order. */
  allTaskForces(): TaskForce[] {
    return [...this.taskForces.values()];
  }
  /** All Scripts, in registration order. */
  allScripts(): Script[] {
    return [...this.scripts.values()];
  }
  /** All TeamTypes, in registration order. */
  allTeamTypes(): TeamType[] {
    return [...this.teamTypes.values()];
  }

  /** Count of parsed TaskForces. */
  get taskForceCount(): number {
    return this.taskForces.size;
  }
  /** Count of parsed Scripts. */
  get scriptCount(): number {
    return this.scripts.size;
  }
  /** Count of parsed TeamTypes. */
  get teamTypeCount(): number {
    return this.teamTypes.size;
  }

  /**
   * Resolve a TeamType's TaskForce and Script objects. Any dangling ref yields
   * `undefined` for that field (the dangling ref is already recorded in
   * {@link diagnostics} at build time). Returns `undefined` if the team id
   * itself is unknown.
   */
  resolveTeam(
    id: string,
  ): { team: TeamType; taskForce?: TaskForce; script?: Script } | undefined {
    const team = this.teamTypes.get(id);
    if (!team) return undefined;
    const taskForce = team.taskForce ? this.taskForces.get(team.taskForce) : undefined;
    const script = team.script ? this.scripts.get(team.script) : undefined;
    const out: { team: TeamType; taskForce?: TaskForce; script?: Script } = { team };
    if (taskForce) out.taskForce = taskForce;
    if (script) out.script = script;
    return out;
  }

  /**
   * Build the typed AI database from a parsed aimd.ini.
   *
   * Sections are parsed from the three registry lists ([TaskForces],
   * [ScriptTypes], [TeamTypes]); each registry entry names a section id. A
   * registry id with no matching section is recorded as a `missing-section`
   * diagnostic and skipped. TeamType refs that point at an absent TaskForce /
   * Script are recorded as `unknown-taskforce` / `unknown-script`.
   */
  static build(ini: IniFile): AiDb {
    const diagnostics: AiDiagnostic[] = [];

    const taskForces = new CiMap<TaskForce>();
    for (const id of ini.readRegistry('TaskForces')) {
      const sec = ini.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'missing-section',
          from: 'TaskForces',
          ref: id,
          message: `[TaskForces] registers '${id}' but no [${id}] section exists.`,
        });
        continue;
      }
      taskForces.set(id, parseTaskForce(id, sec, diagnostics));
    }

    const scripts = new CiMap<Script>();
    for (const id of ini.readRegistry('ScriptTypes')) {
      const sec = ini.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'missing-section',
          from: 'ScriptTypes',
          ref: id,
          message: `[ScriptTypes] registers '${id}' but no [${id}] section exists.`,
        });
        continue;
      }
      scripts.set(id, parseScript(id, sec, diagnostics));
    }

    const teamTypes = new CiMap<TeamType>();
    for (const id of ini.readRegistry('TeamTypes')) {
      const sec = ini.getSection(id);
      if (!sec) {
        diagnostics.push({
          kind: 'missing-section',
          from: 'TeamTypes',
          ref: id,
          message: `[TeamTypes] registers '${id}' but no [${id}] section exists.`,
        });
        continue;
      }
      const team = parseTeamType(id, sec);
      teamTypes.set(id, team);
      if (team.taskForce && !taskForces.has(team.taskForce)) {
        diagnostics.push({
          kind: 'unknown-taskforce',
          from: id,
          ref: team.taskForce,
          message: `TeamType '${id}' references undefined TaskForce '${team.taskForce}'.`,
        });
      }
      if (team.script && !scripts.has(team.script)) {
        diagnostics.push({
          kind: 'unknown-script',
          from: id,
          ref: team.script,
          message: `TeamType '${id}' references undefined Script '${team.script}'.`,
        });
      }
    }

    return new AiDb(taskForces, scripts, teamTypes, diagnostics);
  }
}

// ---------------------------------------------------------------------------
// Resolution + filtering for a buildable unit slice
// ---------------------------------------------------------------------------

/** The result of filtering the AI database against a buildable unit set. */
export interface ResolvedTaskForces {
  /** TaskForces whose every member unit exists in the given type set. */
  readonly usable: readonly TaskForce[];
  /** Why each dropped TaskForce was excluded (unit-outside-slice, etc.). */
  readonly dropped: readonly AiDiagnostic[];
}

/**
 * Filter the database's TaskForces down to those the bot can actually build in a
 * given slice: a TaskForce is *usable* iff EVERY member unit's typeId is present
 * in `availableTypes`. Matching is case-insensitive (typeIds are uppercased on
 * both sides), so a slice listed as `HTNK` matches an aimd entry written `HTNK`
 * regardless of casing.
 *
 * A TaskForce with no members is dropped (an empty force is not usable). The
 * returned `usable` list preserves registration order, so the caller sees a
 * deterministic sequence of real vanilla compositions (e.g. Rhino groups) with
 * no dangling unit refs. Every drop is explained in `dropped` for diagnostics.
 *
 * This function is pure and consumes no randomness; the caller (the bot) owns
 * any selection/weighting over the returned list.
 */
export function resolveTaskForcesFor(
  aiDb: AiDb,
  availableTypes: ReadonlySet<string>,
): ResolvedTaskForces {
  // Normalise the slice to uppercase once for case-insensitive membership.
  const available = new Set<string>();
  for (const t of availableTypes) available.add(t.toUpperCase());

  const usable: TaskForce[] = [];
  const dropped: AiDiagnostic[] = [];
  for (const tf of aiDb.allTaskForces()) {
    if (tf.units.length === 0) {
      dropped.push({
        kind: 'dropped-taskforce',
        from: tf.id,
        ref: '',
        message: `TaskForce '${tf.id}' (${tf.name}) has no members; dropped.`,
      });
      continue;
    }
    const missing = tf.units.find((u) => !available.has(u.typeId.toUpperCase()));
    if (missing) {
      dropped.push({
        kind: 'dropped-taskforce',
        from: tf.id,
        ref: missing.typeId,
        message: `TaskForce '${tf.id}' (${tf.name}) needs '${missing.typeId}', outside the slice; dropped.`,
      });
      continue;
    }
    usable.push(tf);
  }
  return { usable, dropped };
}

// ---------------------------------------------------------------------------
// Section parsers (module-private)
// ---------------------------------------------------------------------------

/**
 * Parse an indexed member section (TaskForce or Script body). Both use the same
 * shape: contiguous `0=a,b` / `1=a,b` lines whose key is a positional index.
 * We read them from the section's ordered `entries`, taking only numeric-keyed
 * lines and splitting the value on the first comma into two integer fields.
 * Non-numeric keys (Name=, Group=, ...) are skipped. Malformed value lines are
 * recorded and skipped.
 */
function parseIndexedPairs(
  id: string,
  sec: IniSection,
  diagnostics: AiDiagnostic[],
): Array<{ a: string; b: string }> {
  const out: Array<{ a: string; b: string }> = [];
  for (const entry of sec.entries) {
    // Only positional (all-digit) keys are member lines.
    if (!/^\d+$/.test(entry.key)) continue;
    const comma = entry.value.indexOf(',');
    if (comma < 0) {
      diagnostics.push({
        kind: 'malformed-entry',
        from: id,
        ref: entry.value,
        message: `Section '${id}' line '${entry.key}=${entry.value}' is not a 'a,b' pair; skipped.`,
      });
      continue;
    }
    out.push({
      a: entry.value.slice(0, comma).trim(),
      b: entry.value.slice(comma + 1).trim(),
    });
  }
  return out;
}

/** Parse a leading signed base-10 integer, or `fallback` if none. */
function parseIntOr(raw: string, fallback: number): number {
  const m = /^[+-]?\d+/.exec(raw.trim());
  if (!m) return fallback;
  const n = Number.parseInt(m[0], 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseTaskForce(id: string, sec: IniSection, diagnostics: AiDiagnostic[]): TaskForce {
  const units: TaskForceEntry[] = [];
  for (const { a, b } of parseIndexedPairs(id, sec, diagnostics)) {
    // `count,TYPE`: a is the count (int), b is the TechnoType id (kept verbatim).
    const count = parseIntOr(a, 0);
    const typeId = b.trim();
    if (typeId === '') {
      diagnostics.push({
        kind: 'malformed-entry',
        from: id,
        ref: `${a},${b}`,
        message: `TaskForce '${id}' member '${a},${b}' has no TechnoType; skipped.`,
      });
      continue;
    }
    units.push({ count, typeId });
  }
  return {
    id,
    name: sec.getString('Name').trim(),
    units,
    group: sec.getInt('Group', -1),
  };
}

function parseScript(id: string, sec: IniSection, diagnostics: AiDiagnostic[]): Script {
  const actions: ScriptStep[] = [];
  for (const { a, b } of parseIndexedPairs(id, sec, diagnostics)) {
    // `action,arg`: both raw ints.
    actions.push({ action: parseIntOr(a, 0), arg: parseIntOr(b, 0) });
  }
  return {
    id,
    name: sec.getString('Name').trim(),
    actions,
  };
}

function parseTeamType(id: string, sec: IniSection): TeamType {
  const taskForce = sec.getString('TaskForce').trim();
  const script = sec.getString('Script').trim();
  const house = sec.getString('House').trim();
  return {
    id,
    name: sec.getString('Name').trim(),
    // `<none>`/empty TaskForce/Script refs collapse to '' (no ref).
    taskForce: isNoneRef(taskForce) ? '' : taskForce,
    script: isNoneRef(script) ? '' : script,
    priority: sec.getInt('Priority', 0),
    max: sec.getInt('Max', 0),
    techLevel: sec.getInt('TechLevel', 0),
    isBaseDefense: sec.getBool('IsBaseDefense', false),
    // exactOptionalPropertyTypes: only attach a house when it is a real
    // restriction (vanilla leaves this `<none>`).
    ...(isNoneRef(house) ? {} : { house }),
  };
}
