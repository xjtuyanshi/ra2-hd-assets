import { describe, expect, it } from 'vitest';
import { parseIni } from '../ini/iniFile.js';
import { RulesDb } from './rulesDb.js';
import { ARMOR_CLASSES } from './types.js';

/** Build a RulesDb from synthetic rules (+ optional art) INI text. */
function build(rulesText: string, artText?: string): RulesDb {
  const rules = parseIni(rulesText);
  const art = artText === undefined ? undefined : parseIni(artText);
  return RulesDb.build(rules, art);
}

const RULES = `
[General]
BuildSpeed=0.65
BuildupTime=0.06
GrowthRate=2.0
TiberiumGrows=yes
RefundPercent=.25
ReloadRate=0.05
BaseUnit=MCV,SMCV
HarvesterUnit=HARV,SLAV
PrerequisitePower=NAPOWR,GAPOWR
PrerequisiteFactory=NAWEAP,GAWEAP
Prerequisite=SHOULD_NOT_BECOME_ALIAS

[InfantryTypes]
0=E1
1=E2
2=E1

[VehicleTypes]
0=HTNK
1=HARV
2=MCV

[BuildingTypes]
0=GAPOWR
1=GAWEAP

[AircraftTypes]
0=ORCA

[SuperWeaponTypes]
0=NukeSpecial

[Countries]
0=Americans
1=Russians
0=Americans

[Sides]
0=GDI
1=Nod

[E1]
Cost=130
Strength=110
Armor=none
TechLevel=1
Primary=M60
Owner=Americans,Russians
Points=5
Trainable=yes

[E2]
Cost=160
Strength=90
Armor=flak
Primary=Grenade
Prerequisite=POWER,FACTORY

[HTNK]
Cost=1250
Strength=450
Armor=heavy
TechLevel=5
Primary=120mm
Speed=5
Sight=8
Locomotor={4A582744-9839-11d1-B709-00A024DDAFD1}
MovementZone=Normal
Points=20
Soylent=500

[HARV]
Cost=1600
Strength=1100
Armor=medium
Harvester=yes
Weeder=no

[MCV]
Cost=3400
Strength=1200
Armor=light
DeploysInto=GACNST
Deployer=yes

[GAPOWR]
Cost=950
Strength=750
Armor=concrete
Power=200
Radar=no
Capturable=yes
BaseNormal=yes
Adjacent=2

[GAWEAP]
Cost=2200
Strength=1150
Armor=steel
Power=-35
WeaponsFactory=yes
Factory=UnitType
BuildCat=Combat
Storage=0

[ORCA]
Cost=1100
Strength=210
Armor=light
Primary=OrcaMissile

[M60]
Damage=18
ROF=22
Range=4.25
Projectile=Bullet
Warhead=SA
Report=GIAttack
Burst=2

[Grenade]
Damage=35
ROF=55
Range=3.25
Projectile=Arcing
Warhead=HE

[120mm]
Damage=75
ROF=55
Range=5.5
Projectile=Cannon
Warhead=AP

[OrcaMissile]
Damage=60
ROF=50
Range=6
Projectile=Missile
Warhead=DANGLING_WH

[SA]
Verses=100%,100%,100%,50%,25%,25%,100%,25%,25%
InfDeath=1

[HE]
Verses=90%,80%,70%,60%,50%,40%,100%,30%,20%,10%,5%
Spread=1.5
CellSpread=2.0
Wall=yes
Wood=yes

[AP]
Verses=20%,30%,50%
InfDeath=0

[Bullet]
Inviso=no
AA=no
AG=yes

[Arcing]
Arcing=yes
AG=yes
ROT=1

[Cannon]
Arcing=no
AG=yes
AA=no

[Missile]
AA=yes
AG=yes
Vertical=yes
ROT=5
`;

const ART = `
[GAPOWR]
Foundation=3x3

[GAWEAP]
Foundation=4x3
`;

describe('RulesDb TypeLists', () => {
  it('parses ordered, deduped type lists', () => {
    const db = build(RULES);
    // E1 registered twice -> deduped to one.
    expect(db.typeLists.infantry).toEqual(['E1', 'E2']);
    expect(db.typeLists.vehicles).toEqual(['HTNK', 'HARV', 'MCV']);
    expect(db.typeLists.buildings).toEqual(['GAPOWR', 'GAWEAP']);
    expect(db.typeLists.aircraft).toEqual(['ORCA']);
    expect(db.typeLists.superWeapons).toEqual(['NukeSpecial']);
    // Americans registered twice -> deduped.
    expect(db.typeLists.countries).toEqual(['Americans', 'Russians']);
    expect(db.typeLists.sides).toEqual(['GDI', 'Nod']);
  });
});

describe('RulesDb TechnoType shared fields', () => {
  it('parses infantry base fields', () => {
    const db = build(RULES);
    const e1 = db.getTechno('E1')!;
    expect(e1.kind).toBe('infantry');
    expect(e1.cost).toBe(130);
    expect(e1.strength).toBe(110);
    expect(e1.armor).toBe('none');
    expect(e1.techLevel).toBe(1);
    expect(e1.primary).toBe('M60');
    expect(e1.owner).toEqual(['Americans', 'Russians']);
    expect(e1.points).toBe(5);
    expect(e1.trainable).toBe(true);
  });

  it('parses each armor class enum value', () => {
    const db = build(RULES);
    expect(db.getTechno('E1')!.armor).toBe('none');
    expect(db.getTechno('E2')!.armor).toBe('flak');
    expect(db.getTechno('HTNK')!.armor).toBe('heavy');
    expect(db.getTechno('HARV')!.armor).toBe('medium');
    expect(db.getTechno('MCV')!.armor).toBe('light');
    expect(db.getTechno('GAPOWR')!.armor).toBe('concrete');
    expect(db.getTechno('GAWEAP')!.armor).toBe('steel');
  });

  it('defaults TechLevel to -1 and Trainable to true when absent', () => {
    const db = build(RULES);
    const harv = db.getTechno('HARV')!;
    expect(harv.techLevel).toBe(-1);
    expect(harv.trainable).toBe(true);
  });

  it('lookup is case-insensitive', () => {
    const db = build(RULES);
    expect(db.getTechno('htnk')).toBe(db.getTechno('HTNK'));
  });
});

describe('RulesDb Prerequisite alias expansion', () => {
  it('expands [General] PrerequisiteX alias groups', () => {
    const db = build(RULES);
    const e2 = db.getTechno('E2')!;
    // POWER -> NAPOWR,GAPOWR ; FACTORY -> NAWEAP,GAWEAP
    expect(e2.prerequisite).toEqual(['NAPOWR', 'GAPOWR', 'NAWEAP', 'GAWEAP']);
    // The bare [General] Prerequisite= key must NOT be registered as an alias.
    expect(db.general.prerequisiteAliases.has('')).toBe(false);
  });

  it('leaves non-alias prerequisites as-is', () => {
    const db = build('[BuildingTypes]\n0=X\n[X]\nPrerequisite=SOMEBLD\n[General]\n');
    expect(db.getTechno('X')!.prerequisite).toEqual(['SOMEBLD']);
  });
});

describe('RulesDb BuildingType extras', () => {
  it('parses power, factory, radar and reads Foundation from artmd', () => {
    const db = build(RULES, ART);
    const powr = db.getTechno('GAPOWR')! as import('./types.js').BuildingType;
    expect(powr.kind).toBe('building');
    expect(powr.power).toBe(200);
    expect(powr.radar).toBe(false);
    expect(powr.capturable).toBe(true);
    expect(powr.baseNormal).toBe(true);
    expect(powr.adjacent).toBe(2);
    expect(powr.foundationWidth).toBe(3);
    expect(powr.foundationHeight).toBe(3);

    const weap = db.getTechno('GAWEAP')! as import('./types.js').BuildingType;
    expect(weap.power).toBe(-35);
    expect(weap.weaponsFactory).toBe(true);
    expect(weap.factory).toBe('UnitType');
    expect(weap.buildCat).toBe('Combat');
    expect(weap.foundationWidth).toBe(4);
    expect(weap.foundationHeight).toBe(3);
  });

  it('leaves foundation at 0 when art is absent', () => {
    const db = build(RULES);
    const powr = db.getTechno('GAPOWR')! as import('./types.js').BuildingType;
    expect(powr.foundationWidth).toBe(0);
    expect(powr.foundationHeight).toBe(0);
  });
});

describe('RulesDb UnitType extras', () => {
  it('parses locomotor, movement zone, harvester, deployer', () => {
    const db = build(RULES);
    const htnk = db.getTechno('HTNK')! as import('./types.js').UnitType;
    expect(htnk.locomotor).toBe('{4A582744-9839-11d1-B709-00A024DDAFD1}');
    expect(htnk.movementZone).toBe('Normal');
    expect(htnk.speed).toBe(5);
    expect(htnk.sight).toBe(8);

    const harv = db.getTechno('HARV')! as import('./types.js').UnitType;
    expect(harv.harvester).toBe(true);
    expect(harv.weeder).toBe(false);

    const mcv = db.getTechno('MCV')! as import('./types.js').UnitType;
    expect(mcv.deployer).toBe(true);
    expect(mcv.deploysInto).toBe('GACNST');
  });
});

describe('RulesDb WeaponType', () => {
  it('parses damage/rof/burst and converts Range cells -> leptons', () => {
    const db = build(RULES);
    const m60 = db.getWeapon('M60')!;
    expect(m60.damage).toBe(18);
    expect(m60.rof).toBe(22);
    expect(m60.burst).toBe(2);
    expect(m60.report).toBe('GIAttack');
    expect(m60.projectile).toBe('Bullet');
    expect(m60.warhead).toBe('SA');
    // Range=4.25 cells -> 4.25*256 = 1088 leptons.
    expect(m60.range).toBe(1088);
  });

  it('converts fractional cell ranges to leptons', () => {
    const db = build(RULES);
    // Range=3.25 cells -> 3.25*256 = 832 leptons.
    expect(db.getWeapon('Grenade')!.range).toBe(832);
  });
});

describe('RulesDb WarheadType Verses', () => {
  it('parses a full 11-entry Verses table aligned to the armor enum', () => {
    const db = build(RULES);
    const he = db.getWarhead('HE')!;
    expect(he.verses).toHaveLength(ARMOR_CLASSES.length);
    expect(he.verses).toEqual([90, 80, 70, 60, 50, 40, 100, 30, 20, 10, 5]);
    expect(he.wall).toBe(true);
    expect(he.wood).toBe(true);
    // Spread=1.5 -> Q16.16.
    expect(he.spread).toBe(1.5 * 65536);
    expect(he.cellSpread).toBe(2 * 65536);
  });

  it('pads short Verses tables with the 100% default', () => {
    const db = build(RULES);
    // AP has only 3 entries; remaining 8 default to 100.
    const ap = db.getWarhead('AP')!;
    expect(ap.verses).toEqual([20, 30, 50, 100, 100, 100, 100, 100, 100, 100, 100]);
  });

  it('accepts mixed %/no-% entries', () => {
    const db = build('[WarheadX]\n');
    // Directly exercise via a warhead referenced by a weapon.
    const db2 = build(
      '[VehicleTypes]\n0=T\n[T]\nPrimary=W\n[W]\nWarhead=WH\n[WH]\nVerses=100%,50,25%,10\n',
    );
    expect(db2.getWarhead('WH')!.verses.slice(0, 4)).toEqual([100, 50, 25, 10]);
    expect(db.warheadCount).toBe(0);
  });
});

describe('RulesDb ProjectileType', () => {
  it('parses projectile flags', () => {
    const db = build(RULES);
    const missile = db.getProjectile('Missile')!;
    expect(missile.aa).toBe(true);
    expect(missile.ag).toBe(true);
    expect(missile.vertical).toBe(true);
    expect(missile.rot).toBe(5);

    const bullet = db.getProjectile('Bullet')!;
    expect(bullet.inviso).toBe(false);
    expect(bullet.aa).toBe(false);
    expect(bullet.ag).toBe(true);
  });
});

describe('RulesDb GeneralRules', () => {
  it('parses [General] constants as fixed-point / typed values', () => {
    const db = build(RULES);
    const g = db.general;
    expect(g.buildSpeed).toBe(42598); // 0.65 floored
    expect(g.growthRate).toBe(2 * 65536);
    expect(g.tiberiumGrows).toBe(true);
    // RefundPercent=.25 -> 25%.
    expect(g.refundPercent).toBe(25);
    expect(g.baseUnit).toBe('MCV');
    expect(g.harvesterUnit).toBe('HARV');
  });
});

describe('RulesDb none-weapon handling', () => {
  it('treats Primary=none as no weapon and records no diagnostic', () => {
    const db = build('[VehicleTypes]\n0=T\n[T]\nPrimary=none\nSecondary=<none>\n');
    const t = db.getTechno('T')!;
    expect(t.primary).toBeUndefined();
    expect(t.secondary).toBeUndefined();
    expect(db.diagnostics.filter((d) => d.ref.toLowerCase().includes('none'))).toHaveLength(0);
  });
});

describe('RulesDb RefundPercent forms', () => {
  it('parses the vanilla percent form 50% -> 50', () => {
    const db = build('[General]\nRefundPercent=50%\n');
    expect(db.general.refundPercent).toBe(50);
  });
  it('parses a bare fraction 0.5 -> 50', () => {
    const db = build('[General]\nRefundPercent=0.5\n');
    expect(db.general.refundPercent).toBe(50);
  });
});

describe('RulesDb resolution & diagnostics', () => {
  it('resolveTechno links weapon -> warhead -> projectile', () => {
    const db = build(RULES);
    const chain = db.resolveTechno('HTNK')!;
    expect(chain.techno.id).toBe('HTNK');
    expect(chain.weapon!.id).toBe('120mm');
    expect(chain.warhead!.id).toBe('AP');
    expect(chain.projectile!.id).toBe('Cannon');
  });

  it('resolves the secondary slot when requested', () => {
    const db = build('[VehicleTypes]\n0=T\n[T]\nSecondary=W\n[W]\nWarhead=WH\n[WH]\nVerses=100%\n');
    const chain = db.resolveTechno('T', 'secondary')!;
    expect(chain.weapon!.id).toBe('W');
    expect(chain.warhead!.id).toBe('WH');
  });

  it('records dangling warhead references without throwing', () => {
    const db = build(RULES);
    // OrcaMissile references DANGLING_WH which has no section.
    const dangling = db.diagnostics.find((d) => d.ref === 'DANGLING_WH');
    expect(dangling).toBeDefined();
    expect(dangling!.kind).toBe('unknown-warhead');
    expect(dangling!.from).toBe('OrcaMissile');
    // The weapon still parsed; only the warhead link is missing.
    expect(db.resolveTechno('ORCA')!.weapon!.id).toBe('OrcaMissile');
    expect(db.resolveTechno('ORCA')!.warhead).toBeUndefined();
  });

  it('records a type registered without a section', () => {
    const db = build('[VehicleTypes]\n0=GHOST\n');
    const diag = db.diagnostics.find((d) => d.ref === 'GHOST');
    expect(diag!.kind).toBe('unknown-type');
  });

  it('resolveTechno returns undefined for unknown ids', () => {
    const db = build(RULES);
    expect(db.resolveTechno('NOPE')).toBeUndefined();
  });
});
