import { describe, expect, it } from 'vitest';
import { parseIni } from '../ini/iniFile.js';
import { AiDb, resolveTaskForcesFor } from './aiDb.js';
import { ScriptAction } from './types.js';

/**
 * A compact synthetic aimd.ini exercising the three modelled registries plus the
 * dangling-ref and malformed-line edge cases. The format mirrors retail aimd.ini
 * exactly: an index registry section, then GUID-style member sections with
 * `Name=`, indexed `0=`/`1=` lines, and metadata keys.
 */
const SYNTHETIC = `
[TaskForces]
0=TF-RHINO
1=TF-MIXED
2=TF-EMPTY
3=TF-DANGLING-SECTION

[TF-RHINO]
Name=3 Rhino Tanks
0=3,HTNK
Group=-1

[TF-MIXED]
Name=2 Conscripts, 1 Rhino
0=2,E2
1=1,HTNK
Group=-1

[TF-EMPTY]
Name=Empty
Group=-1

[ScriptTypes]
0=SC-ATTACK
1=SC-MALFORMED

[SC-ATTACK]
Name=Attack Buildings
0=3,4
1=0,1
2=6,0

[SC-MALFORMED]
Name=Bad Lines
0=54,0
1=notapair
2=58,131075

[TeamTypes]
0=TT-ARMOR
1=TT-INFANTRY
2=TT-BADREFS

[TT-ARMOR]
Name=Soviet Armor Hard
Priority=5
Max=2
TechLevel=1
House=<none>
IsBaseDefense=no
Script=SC-ATTACK
TaskForce=TF-RHINO

[TT-INFANTRY]
Name=Soviet Base Defense
Priority=7
Max=1
TechLevel=0
House=Russians
IsBaseDefense=yes
Script=SC-ATTACK
TaskForce=TF-MIXED

[TT-BADREFS]
Name=Broken Team
Priority=1
Max=1
Script=SC-DOES-NOT-EXIST
TaskForce=TF-DOES-NOT-EXIST
`;

function buildSynthetic(): AiDb {
  return AiDb.build(parseIni(SYNTHETIC));
}

describe('AiDb.build — synthetic aimd.ini', () => {
  it('parses the TaskForces registry into typed compositions', () => {
    const db = buildSynthetic();
    // TF-DANGLING-SECTION is registered but has no section -> not counted.
    expect(db.taskForceCount).toBe(3);
    const rhino = db.getTaskForce('TF-RHINO')!;
    expect(rhino.name).toBe('3 Rhino Tanks');
    expect(rhino.group).toBe(-1);
    expect(rhino.units).toEqual([{ count: 3, typeId: 'HTNK' }]);

    const mixed = db.getTaskForce('TF-MIXED')!;
    expect(mixed.units).toEqual([
      { count: 2, typeId: 'E2' },
      { count: 1, typeId: 'HTNK' },
    ]);
  });

  it('parses ScriptTypes into raw (action,arg) steps and skips malformed lines', () => {
    const db = buildSynthetic();
    const script = db.getScript('SC-ATTACK')!;
    expect(script.name).toBe('Attack Buildings');
    expect(script.actions).toEqual([
      { action: 3, arg: 4 }, // MoveToWaypoint 4
      { action: 0, arg: 1 }, // AttackQuarry buildings
      { action: 6, arg: 0 }, // JumpToLine 0
    ]);
    // The documented enum aligns with the raw ints.
    expect(script.actions[0]!.action).toBe(ScriptAction.MoveToWaypoint);
    expect(script.actions[2]!.action).toBe(ScriptAction.JumpToLine);

    // Malformed 'notapair' line is dropped; the valid ones survive in order.
    const bad = db.getScript('SC-MALFORMED')!;
    expect(bad.actions).toEqual([
      { action: 54, arg: 0 },
      { action: 58, arg: 131075 },
    ]);
    expect(db.diagnostics.some((d) => d.kind === 'malformed-entry' && d.from === 'SC-MALFORMED')).toBe(
      true,
    );
  });

  it('parses TeamTypes with priority/max/house/taskforce/script refs', () => {
    const db = buildSynthetic();
    const armor = db.getTeamType('TT-ARMOR')!;
    expect(armor.name).toBe('Soviet Armor Hard');
    expect(armor.priority).toBe(5);
    expect(armor.max).toBe(2);
    expect(armor.techLevel).toBe(1);
    expect(armor.taskForce).toBe('TF-RHINO');
    expect(armor.script).toBe('SC-ATTACK');
    expect(armor.isBaseDefense).toBe(false);
    // <none> House collapses to undefined (no restriction).
    expect(armor.house).toBeUndefined();

    const inf = db.getTeamType('TT-INFANTRY')!;
    expect(inf.isBaseDefense).toBe(true);
    expect(inf.house).toBe('Russians');
  });

  it('resolveTeam wires a team to its TaskForce and Script objects', () => {
    const db = buildSynthetic();
    const r = db.resolveTeam('TT-ARMOR')!;
    expect(r.team.id).toBe('TT-ARMOR');
    expect(r.taskForce!.id).toBe('TF-RHINO');
    expect(r.script!.id).toBe('SC-ATTACK');
  });

  it('records dangling TaskForce/Script/section refs as diagnostics, never throws', () => {
    const db = buildSynthetic();
    // Registered-but-sectionless TaskForce.
    expect(
      db.diagnostics.some(
        (d) => d.kind === 'missing-section' && d.ref === 'TF-DANGLING-SECTION',
      ),
    ).toBe(true);
    // TT-BADREFS points at non-existent TaskForce + Script.
    expect(
      db.diagnostics.some((d) => d.kind === 'unknown-taskforce' && d.from === 'TT-BADREFS'),
    ).toBe(true);
    expect(
      db.diagnostics.some((d) => d.kind === 'unknown-script' && d.from === 'TT-BADREFS'),
    ).toBe(true);
    // resolveTeam on the broken team yields undefined sub-objects, not a throw.
    const r = db.resolveTeam('TT-BADREFS')!;
    expect(r.taskForce).toBeUndefined();
    expect(r.script).toBeUndefined();
  });

  it('resolveTeam returns undefined for an unknown team id', () => {
    const db = buildSynthetic();
    expect(db.resolveTeam('NOPE')).toBeUndefined();
  });
});

describe('resolveTaskForcesFor — slice filtering', () => {
  it('keeps only TaskForces whose every unit is in the slice', () => {
    const db = buildSynthetic();
    // Slice with HTNK + E2 (both mixed units) -> both non-empty TFs usable.
    const both = resolveTaskForcesFor(db, new Set(['HTNK', 'E2', 'HARV']));
    expect(both.usable.map((t) => t.id)).toEqual(['TF-RHINO', 'TF-MIXED']);
    // Empty TF is dropped with a reason.
    expect(both.dropped.some((d) => d.from === 'TF-EMPTY')).toBe(true);
  });

  it('drops a TaskForce when any member is outside the slice', () => {
    const db = buildSynthetic();
    // Only HTNK available -> TF-MIXED (needs E2) is dropped, TF-RHINO kept.
    const rhinoOnly = resolveTaskForcesFor(db, new Set(['HTNK']));
    expect(rhinoOnly.usable.map((t) => t.id)).toEqual(['TF-RHINO']);
    const drop = rhinoOnly.dropped.find((d) => d.from === 'TF-MIXED');
    expect(drop).toBeDefined();
    expect(drop!.ref).toBe('E2');
  });

  it('matches case-insensitively against the slice', () => {
    const db = buildSynthetic();
    // Lowercase slice must still match uppercase aimd typeIds.
    const lower = resolveTaskForcesFor(db, new Set(['htnk', 'e2']));
    expect(lower.usable.map((t) => t.id)).toEqual(['TF-RHINO', 'TF-MIXED']);
  });

  it('returns an empty usable list when nothing fits', () => {
    const db = buildSynthetic();
    const none = resolveTaskForcesFor(db, new Set(['APOC']));
    expect(none.usable).toEqual([]);
    // Every non-empty TF is explained as dropped.
    expect(none.dropped.length).toBeGreaterThan(0);
  });

  it('is deterministic: identical inputs -> identical usable order', () => {
    const db = buildSynthetic();
    const a = resolveTaskForcesFor(db, new Set(['HTNK', 'E2']));
    const b = resolveTaskForcesFor(db, new Set(['HTNK', 'E2']));
    expect(a.usable.map((t) => t.id)).toEqual(b.usable.map((t) => t.id));
  });
});
