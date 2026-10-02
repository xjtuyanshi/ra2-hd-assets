import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { readYrBeams, type YrRadBeamEffect, type YrWaveEffect, type YrBeamsStats } from './beamsReader';
import { readYrObjectCoords, YR_GET_COORDS, YR_GET_COORDS_SLOT, type YrPoint3 } from './objectCoords';
export {
  readYrObjectCoords,
  YR_GET_COORDS,
  YR_GET_COORDS_SLOT,
  YR_FOUNDATION_SIZES,
  type YrPoint3,
} from './objectCoords';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import { YR_STATE_VTABLES, isPlausiblePointer, readAsciiZ, readPointerVector } from './stateReader';

/**
 * Read-only live visual effects of Yuri's Revenge 1.001 (gamemd.exe, SHA-256 in YR_STARTUP_PAGE_HASH) for an external
 * renderer that replaces the original 2D explosion, fire, smoke and weapon art: animations (AnimClass), projectiles in
 * flight (BulletClass), laser beams (LaserDrawClass), electric bolts (EBolt), particle systems (ParticleSystemClass)
 * plus RadBeam/WaveClass ribbons (beamsReader.ts, with their own instruction evidence) and "just fired" events
 * (TechnoClass::LastFireBulletFrame). Like stateReader.ts it only reads guest memory through a
 * GuestMemoryAccessor, never writes guest state and never calls guest code, so it runs on the main thread and in the VM
 * Worker alike.
 *
 * Sources: global array addresses and class layouts come from the community YRpp headers (Phobos-developers/YRpp:
 * AnimClass.h, AnimTypeClass.h, BulletClass.h, BulletTypeClass.h, ParticleSystemClass.h, ParticleSystemTypeClass.h,
 * LaserDrawClass.h, EBolt.h, TechnoClass.h, StageClass.h), used as facts only. Each fact below was checked against a
 * disassembly of the player's own gamemd.exe 1.001; the notes name the function that confirms it:
 *
 * - AnimClass constructor (0x421EA0) writes the primary vtable 0x7E3354, Type (+0xC8, the first argument), the
 *   StageClass Animation (+0xAC Value, +0xC0 Rate, +0xC4 Step) and appends the object to AnimClass::Array (0xA8E9A8).
 *   On the first construction of a type it resolves AnimTypeClass::End (+0x2C0) from the SHP frame count (halved when
 *   Shadow=yes) and LoopEnd (+0x2BC) from End, so both are final once an instance exists.
 * - AnimClass::DrawIt (0x422CA0, vtable +0x114) draws SHP frame Type.Start (+0x2B4) + Animation.Value and skips
 *   anims flagged Invisible (+0x19D) or above the detail level. AnimClass::AI (0x423AC0, vtable +0x5C) ends an
 *   iteration when Value reaches End (last loop) or LoopEnd - Start, decrements RemainingIterations (+0x195, 0xFF =
 *   forever), restarts at LoopStart - Start, and when no iteration is left switches the same object to Type.Next
 *   (+0x2C8) and plays that: one AnimClass can therefore change `type` during its life (key effects on id + uid).
 * - AnimClass::SetOwnerObject (0x424B50) stores Location (+0x9C) *relative to* the owner's GetCoords() while
 *   OwnerObject (+0xCC) is set, and AnimClass::GetCoords (0x422BE0, vtable +0x48) returns owner.GetCoords() +
 *   Location. GetCoords of units, infantry, aircraft, terrain and bullets is ObjectClass's (0x5F65A0: Location);
 *   BuildingClass::GetCoords (0x447AC0) adds (W * 128 - 128, H * 128 - 128) for the type's foundation (+0xEF0, tables
 *   0x8192B8 / 0x819310); CellClass::GetCoords (0x486840) is the cell centre at the cell's floor height. This reader
 *   dispatches on the same vtable slot, so attached anims (burning buildings, damage smoke on vehicles) get absolute
 *   world positions.
 * - BulletClass constructor (0x466380, vtable 0x7E46E4) appends to BulletClass::Array (0xA8ED40);
 *   BulletClass::Construct (0x4664C0) sets Type +0xAC, Owner (firer) +0xB0, Target +0x10C, Speed +0x110, WH +0x128;
 *   BulletClass::MoveTo (0x468670, vtable +0x1F0) sets Velocity (+0xE8, 3 doubles), SourceCoords (+0x134) = launch
 *   point and TargetCoords (+0x140) = Target.GetTargetCoords(). BulletTypeClass flags Arcing (+0x29B) and Inviso
 *   (+0x29E) are where BulletTypeClass::LoadFromINI (0x46BF00 region) stores those keys.
 * - LaserDrawClass has no vtable; its constructor (0x54FE60) fills Source +0x24, Target +0x30, colours +0x41/+0x44/
 *   +0x47, Duration +0x4C and appends to DynamicVectorClass<LaserDrawClass*> at 0xABC878 (not named in YRpp).
 * - EBolt::Fire (0x4C2A60) stores Point1 +0x0, Point2 +0xC and appends to EBolt::Array (0x8A0E88); the constructor
 *   (0x4C1E10) starts Lifetime (+0x28) at 0x10000, which the draw pass halves until it reaches 0.
 * - ParticleSystemClass constructor (0x62DC50, vtable 0x7EFB9C) appends to ParticleSystemClass::Array (0xA80208) and
 *   lays out Type +0xAC, Particles (DynamicVectorClass at +0xBC), TargetCoords +0xD4, Owner +0xE0, Target +0xE4,
 *   Lifetime +0xEC, OwnerHouse +0xFC. ParticleSystemTypeClass::LoadFromINI stores BehavesLike at +0x2B4 (0 Smoke,
 *   1 Gas, 2 Fire, 3 Spark, 4 Railgun).
 * - VoxelAnimClass constructor (0x7493B0, vtable 0x7F6318) sets Type +0x104, AttachedSystem +0x108, OwnerHouse
 *   +0x10C, Invisible +0x13C, Duration +0x140 and appends to VoxelAnimClass::Array (0x887388); its BounceClass (+0xB0)
 *   holds the tumbling orientation quaternion CurrentAngle at +0xE0 (debris such as flying turrets and wheels).
 * - TechnoClass::Fire writes the current frame to +0x120 (YRpp `LastFireBulletFrame`, store at 0x6FF743) whenever it
 *   launches a bullet; TechnoClass::SetTarget (0x6FCF3E) stores the target at +0x2B4.
 * - Type vtables (from the constructors): AnimTypeClass 0x7E3608 (0x427530), BulletTypeClass 0x7E4948 (0x46BBC0),
 *   ParticleSystemTypeClass 0x7F00A8 (0x6440A0), WeaponTypeClass 0x7F73B8 (0x771C70), WarheadTypeClass 0x7F6B30
 *   (0x75CEC0), ParticleClass 0x7EF954 (0x62B5E0), TerrainClass 0x7F522C (0x71BB90), CellClass 0x7E4EEC (0x47BBF0),
 *   VoxelAnimTypeClass 0x7F6548 (0x74AD80).
 *
 * scripts/remaster/bridge/verifyEffectsReader.mts checks the result against a running skirmish (anims projected onto
 * captured frames, frame progression and removal, bullets travelling from shooter to target, poll cost).
 *
 * Consistency: like the state reader, a poll may observe the game between two logic frames, or an object half way
 * through its constructor or through AnimClass::SetOwnerObject. Every pointer, vtable, count, string, offset and
 * coordinate is validated; anything implausible is skipped and counted in `stats`, never thrown. Objects still in limbo
 * (e.g. an anim whose constructor has not placed it yet) are skipped and counted unless `includeLimbo` is set.
 */

/** YR 1.001 global addresses (see the module notes for the confirming code). */
export const YR_EFFECTS_GLOBALS = Object.freeze({
  /** Unsorted::CurrentFrame, the logic frame counter. */
  frame: 0xa8ed84,
  /** AnimClass::Array (DynamicVectorClass<AnimClass*>). */
  anims: 0xa8e9a8,
  /** BulletClass::Array. */
  bullets: 0xa8ed40,
  /** ParticleSystemClass::Array. */
  particleSystems: 0xa80208,
  /** DynamicVectorClass<LaserDrawClass*> appended by the LaserDrawClass constructor. */
  lasers: 0xabc878,
  /** EBolt::Array. */
  electricBolts: 0x8a0e88,
  /** VoxelAnimClass::Array (debris). */
  voxelAnims: 0x887388,
  /** DynamicVectorClass<TechnoClass*> (buildings, vehicles, infantry, aircraft). */
  technos: 0xa8ec78,
  /** HouseClass::Array. */
  houses: 0xa80228,
});

/** DynamicVectorClass: Count at +0x10 (Items at +4 is read through readPointerVector). */
const VECTOR_COUNT = 0x10;

/** Field offsets (YRpp facts; every one is read or written by the code named in the module notes). */
export const YR_EFFECTS_OFFSETS = Object.freeze({
  /** AbstractClass::UniqueID. */
  uniqueId: 0x10,
  /** ObjectClass::InLimbo (bool). */
  inLimbo: 0x81,
  /** ObjectClass::Location (CoordStruct, leptons); relative to the owner for an attached anim. */
  location: 0x9c,
  /** AbstractTypeClass::ID (char[0x18]). */
  typeId: 0x24,
  /** HouseClass::ArrayIndex. */
  houseArrayIndex: 0x30,

  /** AnimClass::Animation (StageClass): Value (current stage), Rate (logic frames per step), Step (+1 / -1). */
  animStage: 0xac,
  animRate: 0xc0,
  animStep: 0xc4,
  /** AnimClass::Type (AnimTypeClass*). */
  animType: 0xc8,
  /** AnimClass::OwnerObject (ObjectClass* the anim is attached to). */
  animOwnerObject: 0xcc,
  /** AnimClass::IsBuildingAnim (bool: a building's own active/idle/damage anim). */
  animBuilding: 0x118,
  /** AnimClass::Paused (bool). */
  animPaused: 0x11a,
  /** AnimClass::Owner (HouseClass*, remap owner; null for most explosions). */
  animOwner: 0x180,
  /** AnimClass::RemainingIterations (byte, 0xFF = loops forever). */
  animLoopsLeft: 0x195,
  /** AnimClass::Invisible (bool: updated but not drawn). */
  animInvisible: 0x19d,
  /** AnimTypeClass::Start / LoopStart / LoopEnd / End (resolved frame count of one iteration). */
  animTypeStart: 0x2b4,
  animTypeLoopStart: 0x2b8,
  animTypeLoopEnd: 0x2bc,
  animTypeEnd: 0x2c0,
  /** AnimTypeClass::Translucency (int: 0, 25, 50 or 75 percent). */
  animTypeTranslucency: 0x2ec,
  /** AnimTypeClass::Layer (Layer enum, -1..4). */
  animTypeLayer: 0x364,
  /** AnimTypeClass::Flat / Translucent (bools). */
  animTypeFlat: 0x369,
  animTypeTranslucent: 0x36a,

  /** BulletClass::Type (BulletTypeClass*). */
  bulletType: 0xac,
  /** BulletClass::Owner (TechnoClass* that fired it). */
  bulletFirer: 0xb0,
  /** BulletClass::Velocity (3 doubles, leptons per frame). */
  bulletVelocity: 0xe8,
  /** BulletClass::Target (AbstractClass*). */
  bulletTarget: 0x10c,
  /** BulletClass::WH (WarheadTypeClass*). */
  bulletWarhead: 0x128,
  /** BulletClass::AnimFrame (byte, current image frame of animated projectiles). */
  bulletFrame: 0x12c,
  /** BulletClass::WeaponType (WeaponTypeClass*). */
  bulletWeapon: 0x130,
  /** BulletClass::SourceCoords / TargetCoords (CoordStruct). */
  bulletSource: 0x134,
  bulletTargetCoords: 0x140,
  /** BulletTypeClass::Arcing / Inviso (bools). */
  bulletTypeArcing: 0x29b,
  bulletTypeInviso: 0x29e,

  /** ParticleSystemClass::Type (ParticleSystemTypeClass*). */
  particleSystemType: 0xac,
  /** ParticleSystemClass::Particles (DynamicVectorClass<ParticleClass*>). */
  particleSystemParticles: 0xbc,
  /** ParticleSystemClass::TargetCoords (CoordStruct). */
  particleSystemTargetCoords: 0xd4,
  /** ParticleSystemClass::Owner (ObjectClass*). */
  particleSystemOwnerObject: 0xe0,
  /** ParticleSystemClass::Lifetime (int, frames left; negative = unlimited, see YrParticleSystemEffect). */
  particleSystemLifetime: 0xec,
  /** ParticleSystemClass::OwnerHouse (HouseClass*). */
  particleSystemHouse: 0xfc,
  /** ParticleSystemTypeClass::BehavesLike (int). */
  particleSystemTypeBehavesLike: 0x2b4,

  /** LaserDrawClass::Progress (StageClass; Value counts up while the beam fades). */
  laserProgress: 0x0,
  /** LaserDrawClass::Thickness (int), IsHouseColor (bool). */
  laserThickness: 0x1c,
  laserHouseColor: 0x20,
  /** LaserDrawClass::Source / Target (CoordStruct). */
  laserSource: 0x24,
  laserTarget: 0x30,
  /** LaserDrawClass::InnerColor / OuterColor / OuterSpread (ColorStruct RGB bytes). */
  laserInnerColor: 0x41,
  laserOuterColor: 0x44,
  laserOuterSpread: 0x47,
  /** LaserDrawClass::Duration (int, frames). */
  laserDuration: 0x4c,
  /** LaserDrawClass::Blinks / Fades (bools). */
  laserBlinks: 0x50,
  laserFades: 0x52,

  /** EBolt::Point1 / Point2 (CoordStruct). */
  boltSource: 0x0,
  boltTarget: 0xc,
  /** EBolt::Owner (TechnoClass* or null), WeaponSlot (int). */
  boltFirer: 0x20,
  boltWeaponSlot: 0x24,
  /** EBolt::Lifetime (0x10000 when fired, halved by every draw pass; 0 = gone). */
  boltLifetime: 0x28,
  /** EBolt::AlternateColor (bool). */
  boltAlternateColor: 0x2c,

  /** VoxelAnimClass::Type (VoxelAnimTypeClass*). */
  voxelAnimType: 0x104,
  /** VoxelAnimClass::Bounce.Velocity (3 floats) and Bounce.CurrentAngle (Quaternion X, Y, Z, W floats). */
  voxelAnimVelocity: 0xd4,
  voxelAnimRotation: 0xe0,
  /** VoxelAnimClass::OwnerHouse (HouseClass*), Invisible (bool), Duration (int, frames left). */
  voxelAnimHouse: 0x10c,
  voxelAnimInvisible: 0x13c,
  voxelAnimDuration: 0x140,

  /** TechnoClass::LastFireBulletFrame (int, logic frame of the last bullet launched). */
  technoLastFireFrame: 0x120,
  /** TechnoClass::Owner (HouseClass*). */
  technoOwner: 0x21c,
  /** TechnoClass::Target (AbstractClass*). */
  technoTarget: 0x2b4,
  /** BuildingClass::Type (BuildingTypeClass*) and BuildingTypeClass::Foundation (Foundation enum). */
  buildingType: 0x520,
  buildingTypeFoundation: 0xef0,
  /** CellClass::MapCoords (CellStruct {short X, short Y}) and Level (signed char). */
  cellMapCoords: 0x24,
  cellLevel: 0x11b,
});

/** Primary vtables of the effect classes and their types (confirming constructors in the module notes). */
export const YR_EFFECTS_VTABLES = Object.freeze({
  anim: 0x7e3354,
  animType: 0x7e3608,
  bullet: 0x7e46e4,
  bulletType: 0x7e4948,
  weaponType: 0x7f73b8,
  warheadType: 0x7f6b30,
  particleSystem: 0x7efb9c,
  particleSystemType: 0x7f00a8,
  particle: 0x7ef954,
  voxelAnim: 0x7f6318,
  voxelAnimType: 0x7f6548,
  terrain: 0x7f522c,
  cell: 0x7e4eec,
});

/** Sanity limits: anything larger is treated as a stale or torn read. */
export const YR_EFFECTS_LIMITS = Object.freeze({
  anims: 8192,
  bullets: 4096,
  particleSystems: 2048,
  lasers: 1024,
  electricBolts: 1024,
  voxelAnims: 4096,
  particlesPerSystem: 1024,
  technos: 16384,
  houses: 32,
  /** |X|, |Y| in leptons (512 cells, beyond any map). */
  maxCoordinate: 512 * 256,
  /** |Z| in leptons: 64 height levels, far above the flight level. */
  maxHeight: 64 * 104,
  /** Attachment chains (anim on anim on object) followed at most this deep. */
  attachDepth: 4,
  /**
   * Largest plausible |X|, |Y| of an attached anim's stored offset from its owner (6 cells; building fire offsets stay
   * within 3). AnimClass::SetOwnerObject (0x424B50) sets OwnerObject a few instructions before it rewrites Location
   * from absolute to relative, and a poll between two emulator slices can land in that window: a live run read one
   * such anim at twice its owner's coordinates. Larger offsets are skipped and counted in `stats.unresolved`.
   */
  maxAttachOffset: 6 * 256,
  /** Longest plausible laser duration (frames). */
  maxLaserDuration: 10_000,
});

/** Guest .rdata range of the pinned image: every vtable lies inside it. */
const RDATA_START = 0x7e1000;
const RDATA_END = 0x812000;
const CODE_START = 0x401000;

export type YrEffectObjectKind =
  | 'building'
  | 'vehicle'
  | 'infantry'
  | 'aircraft'
  | 'terrain'
  | 'anim'
  | 'bullet'
  | 'particleSystem'
  | 'voxelAnim'
  | 'cell'
  | 'other';

/** An object an effect is attached to, fired by or aimed at. */
export interface YrEffectObjectRef {
  /** Native pointer (matches YrObjectState.id for technos). */
  id: number;
  /** AbstractClass::UniqueID (0 for cells). */
  uid: number;
  kind: YrEffectObjectKind;
}

/** Layer enum (YRpp): drawing order bucket of an anim. Attached anims are always drawn in `ground`. */
export type YrEffectLayer = 'underground' | 'surface' | 'ground' | 'air' | 'top';
const LAYERS: readonly YrEffectLayer[] = ['underground', 'surface', 'ground', 'air', 'top'];

export interface YrAnimEffect {
  /** AnimClass pointer; pointers are reused after deletion, so key on (id, uid). */
  id: number;
  /** AbstractClass::UniqueID, unique for the whole game. */
  uid: number;
  /** AnimTypeClass ID, e.g. "EXPLOLRG", "TWLT070", "FIRE01". Can change when the anim chains to Type.Next. */
  type: string;
  /** Absolute world position in leptons (AnimClass::GetCoords: resolved through the attachment). */
  x: number;
  y: number;
  z: number;
  /** SHP frame the engine draws now: Type.Start + stage. */
  frame: number;
  /** StageClass Value: progress inside the current type, 0 .. frameCount - 1 (counts down for reversed anims). */
  stage: number;
  /** AnimTypeClass::End: frames in one iteration (0 while the type has never been resolved). */
  frameCount: number;
  /** Loop range as absolute SHP frames (AnimTypeClass::LoopStart / LoopEnd). */
  loopStart: number;
  loopEnd: number;
  /** Iterations left including the current one; 255 = loops until removed. */
  loopsLeft: number;
  /** Logic frames per stage step (StageClass::Rate); 0 = not advancing. */
  rate: number;
  /** Object the anim follows (burning building, smoking vehicle, parachute ...), or null. */
  attachedTo: YrEffectObjectRef | null;
  /** House index (AnimClass::Owner) or -1. */
  owner: number;
  /** Draw layer; attached anims report `ground` like AnimClass::InWhichLayer. */
  layer: YrEffectLayer | null;
  /** AnimTypeClass::Flat: drawn flat on the ground (scorch marks, craters, ...). */
  flat: boolean;
  /** AnimTypeClass::Translucent / Translucency (0, 25, 50, 75 %). */
  translucent: boolean;
  translucency: number;
  /** AnimClass::IsBuildingAnim: a building's own animation (active/idle/damage) rather than a combat effect. */
  buildingAnim: boolean;
  /** AnimClass::Invisible (updated but not drawn) or Paused. */
  invisible: boolean;
  paused: boolean;
}

export interface YrBulletEffect {
  id: number;
  uid: number;
  /** BulletTypeClass ID (the weapon's Projectile=, e.g. "Cannon", "InvisibleLow", "AAHeatSeeker"). */
  type: string;
  /** WeaponTypeClass ID of the weapon that fired it, or null (shrapnel, airburst, ...). */
  weapon: string | null;
  /** WarheadTypeClass ID, or null. */
  warhead: string | null;
  /** Current position (leptons). */
  x: number;
  y: number;
  z: number;
  /** Launch point (BulletClass::SourceCoords) and aim point (TargetCoords). */
  source: YrPoint3;
  target: YrPoint3;
  /** Leptons per logic frame. */
  velocity: YrPoint3;
  /** The techno that fired it, or null. */
  firer: YrEffectObjectRef | null;
  /** House index of the firer, or -1. */
  owner: number;
  /** BulletTypeClass::Inviso: never drawn by the original (instant-hit weapons); Arcing: ballistic. */
  inviso: boolean;
  arcing: boolean;
  /** BulletClass::AnimFrame (image frame of animated or rotating projectiles). */
  frame: number;
}

export interface YrLaserEffect {
  /** LaserDrawClass pointer (no UniqueID: lasers are not AbstractClass objects). */
  id: number;
  source: YrPoint3;
  target: YrPoint3;
  /** RGB 0..255. */
  innerColor: [number, number, number];
  outerColor: [number, number, number];
  outerSpread: [number, number, number];
  thickness: number;
  /** IsHouseColor: drawn in the firer's house colour (Prism-style). */
  houseColor: boolean;
  /** Lifetime in frames and the StageClass progress towards it. */
  duration: number;
  progress: number;
  fades: boolean;
  blinks: boolean;
}

export interface YrElectricBoltEffect {
  /** EBolt pointer (no UniqueID). */
  id: number;
  /** Point1 / Point2 at fire time (the engine re-anchors the source to the firer's barrel while it draws). */
  source: YrPoint3;
  target: YrPoint3;
  firer: YrEffectObjectRef | null;
  weaponSlot: number;
  /** Raw lifetime: 0x10000 when fired, halved by every draw pass. */
  lifetime: number;
  alternateColor: boolean;
}

export interface YrVoxelAnimEffect {
  id: number;
  uid: number;
  /** VoxelAnimTypeClass ID (debris voxels, e.g. flying turrets, wheels, rocks). */
  type: string;
  x: number;
  y: number;
  z: number;
  /** Leptons per frame (BounceClass::Velocity). */
  velocity: YrPoint3;
  /** Tumbling orientation (BounceClass::CurrentAngle quaternion X, Y, Z, W). */
  rotation: [number, number, number, number];
  /** House index (OwnerHouse) or -1. */
  owner: number;
  /** Frames left (VoxelAnimClass::Duration). */
  duration: number;
  invisible: boolean;
}

export type YrParticleBehaviour = 'smoke' | 'gas' | 'fire' | 'spark' | 'railgun';
const BEHAVIOURS: readonly YrParticleBehaviour[] = ['smoke', 'gas', 'fire', 'spark', 'railgun'];

export interface YrParticleSystemEffect {
  id: number;
  uid: number;
  /** ParticleSystemTypeClass ID, e.g. "SmokeSys", "FireStreamSys". */
  type: string;
  behavesLike: YrParticleBehaviour | null;
  /** System origin (leptons). */
  x: number;
  y: number;
  z: number;
  /** TargetCoords (direction/end point of streams and railguns). */
  target: YrPoint3;
  attachedTo: YrEffectObjectRef | null;
  /** House index (OwnerHouse) or -1. */
  owner: number;
  /** Live particles in the system. */
  particleCount: number;
  /**
   * Frames left. Negative for a system without a lifetime: the engine starts it at -1 and keeps decrementing (an
   * ambient map GasCloudSys read -(frame + 1) in a live game), so treat any negative value as unlimited.
   */
  lifetime: number;
  /** Particle positions (only with `particles: true`; at most YR_EFFECTS_LIMITS.particlesPerSystem). */
  particles?: YrPoint3[];
}

export interface YrFireEvent {
  /** The techno (matches YrObjectState.id / uid). */
  id: number;
  uid: number;
  kind: 'building' | 'vehicle' | 'infantry' | 'aircraft';
  /** Logic frame of the shot (TechnoClass::LastFireBulletFrame); de-duplicate on (id, frame). */
  frame: number;
  /** Current target (TechnoClass::Target) and its position when it resolves, else null. */
  target: YrEffectObjectRef | null;
  targetPosition: YrPoint3 | null;
}

export type YrEffectKind = 'anims' | 'voxelAnims' | 'bullets' | 'particleSystems' | 'lasers' | 'electricBolts';

export interface YrEffectsStats {
  beams?: YrBeamsStats;
  /** Raw DynamicVectorClass counts. */
  vectors: Record<YrEffectKind, number>;
  /** Entries skipped because a pointer, vtable, type, value or coordinate failed validation. */
  invalid: Record<YrEffectKind, number>;
  /** Entries skipped because the object is in limbo (0 with `includeLimbo`). */
  limbo: Record<YrEffectKind, number>;
  /**
   * Attached anims skipped because their owner's position could not be resolved or their stored offset is not a
   * plausible relative offset (a read in the middle of AnimClass::SetOwnerObject, see maxAttachOffset).
   */
  unresolved: number;
  /** Technos scanned for fire events. */
  technos: number;
}

export interface YrEffects {
  frame: number;
  anims: YrAnimEffect[];
  voxelAnims: YrVoxelAnimEffect[];
  bullets: YrBulletEffect[];
  lasers: YrLaserEffect[];
  electricBolts: YrElectricBoltEffect[];
  radBeams?: YrRadBeamEffect[];
  waves?: YrWaveEffect[];
  particleSystems: YrParticleSystemEffect[];
  /** Technos whose last shot is at most `fireWindow` frames old. */
  fires: YrFireEvent[];
  stats: YrEffectsStats;
}

export interface ReadYrEffectsOptions {
  /** Also return anims, bullets and particle systems in limbo (default false: skipped and counted). */
  includeLimbo?: boolean;
  /** Report technos that fired within this many logic frames (default 30); 0 skips the techno scan. */
  fireWindow?: number;
  /** Include per-particle positions of particle systems (default false). */
  particles?: boolean;
}

const inRdata = (vtable: number) => vtable >= RDATA_START && vtable < RDATA_END && (vtable & 3) === 0;

const TECHNO_KINDS = new Map<number, YrFireEvent['kind']>([
  [YR_STATE_VTABLES.building, 'building'],
  [YR_STATE_VTABLES.unit, 'vehicle'],
  [YR_STATE_VTABLES.infantry, 'infantry'],
  [YR_STATE_VTABLES.aircraft, 'aircraft'],
]);
const OBJECT_KINDS = new Map<number, YrEffectObjectKind>([
  ...TECHNO_KINDS,
  [YR_EFFECTS_VTABLES.terrain, 'terrain'],
  [YR_EFFECTS_VTABLES.anim, 'anim'],
  [YR_EFFECTS_VTABLES.bullet, 'bullet'],
  [YR_EFFECTS_VTABLES.particleSystem, 'particleSystem'],
  [YR_EFFECTS_VTABLES.voxelAnim, 'voxelAnim'],
  [YR_EFFECTS_VTABLES.cell, 'cell'],
]);

const withinWorld = (x: number, y: number, z: number) =>
  Math.abs(x) <= YR_EFFECTS_LIMITS.maxCoordinate &&
  Math.abs(y) <= YR_EFFECTS_LIMITS.maxCoordinate &&
  Math.abs(z) <= YR_EFFECTS_LIMITS.maxHeight;

function readPoint(memory: GuestMemoryAccessor, address: number): YrPoint3 {
  return { x: memory.i32(address), y: memory.i32(address + 4), z: memory.i32(address + 8) };
}

function readRgb(memory: GuestMemoryAccessor, address: number): [number, number, number] {
  return [memory.u8(address), memory.u8(address + 1), memory.u8(address + 2)];
}

/** `count` little-endian floats, or null when unreadable or not finite. */
function readFloats(memory: GuestMemoryAccessor, address: number, count: number): number[] | null {
  const bytes = memory.bytes(address, count * 4);
  if (bytes.length !== count * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const values = Array.from({ length: count }, (_, i) => view.getFloat32(i * 4, true));
  return values.every(Number.isFinite) ? values : null;
}

/** `count` little-endian doubles, or null when unreadable or not finite. */
function readDoubles(memory: GuestMemoryAccessor, address: number, count: number): number[] | null {
  const bytes = memory.bytes(address, count * 8);
  if (bytes.length !== count * 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const values = Array.from({ length: count }, (_, i) => view.getFloat64(i * 8, true));
  return values.every(Number.isFinite) ? values : null;
}

/** A plausible AbstractClass-derived object: aligned pointer inside memory whose first dword is a .rdata vtable. */
function objectVtable(memory: GuestMemoryAccessor, pointer: number): number {
  if (!isPlausiblePointer(memory, pointer, YR_EFFECTS_OFFSETS.location + 12)) return 0;
  const vtable = memory.u32(pointer);
  return inRdata(vtable) ? vtable : 0;
}

/** Reference to an object the effect points at, or null when the pointer is not a plausible object. */
function objectRef(memory: GuestMemoryAccessor, pointer: number): YrEffectObjectRef | null {
  if (pointer === 0) return null;
  const vtable = objectVtable(memory, pointer);
  if (!vtable) return null;
  const kind = OBJECT_KINDS.get(vtable) ?? 'other';
  return { id: pointer, uid: kind === 'cell' ? 0 : memory.u32(pointer + YR_EFFECTS_OFFSETS.uniqueId), kind };
}

/**
 * Snapshot of the effects the engine is playing now. Never throws for any memory content; outside a battle every list
 * is empty. Cost is O(entries): about 25 guest reads per anim, 30 per bullet, 15 per laser/bolt/particle system, 2 per
 * techno for the fire scan.
 */
export function readYrEffects(memory: GuestMemoryAccessor, options: ReadYrEffectsOptions = {}): YrEffects {
  const o = YR_EFFECTS_OFFSETS;
  const V = YR_EFFECTS_VTABLES;
  const L = YR_EFFECTS_LIMITS;
  const frame = memory.i32(YR_EFFECTS_GLOBALS.frame);
  const perKind = (): Record<YrEffectKind, number> => ({
    anims: 0,
    voxelAnims: 0,
    bullets: 0,
    particleSystems: 0,
    lasers: 0,
    electricBolts: 0,
  });
  const stats: YrEffectsStats = { vectors: perKind(), invalid: perKind(), limbo: perKind(), unresolved: 0, technos: 0 };
  const includeLimbo = options.includeLimbo === true;

  // House pointer -> index (HouseClass::ArrayIndex must agree with the slot, as in the state reader).
  const houseIndex = new Map<number, number>();
  for (const [index, house] of (readPointerVector(memory, YR_EFFECTS_GLOBALS.houses, L.houses) ?? []).entries())
    if (isPlausiblePointer(memory, house, o.houseArrayIndex + 4) && memory.i32(house + o.houseArrayIndex) === index)
      houseIndex.set(house, index);
  const houseOf = (pointer: number) => (pointer === 0 ? -1 : (houseIndex.get(pointer) ?? -1));

  // AbstractTypeClass IDs per (vtable, pointer), cached per poll (types live for the whole game; End and the other
  // type fields are re-read per entry because End is resolved lazily by the first instance).
  const typeCaches = new Map<number, Map<number, string | null>>();
  const readType = (pointer: number, vtable: number, span: number): string | null => {
    let cache = typeCaches.get(vtable);
    if (!cache) typeCaches.set(vtable, (cache = new Map()));
    let id = cache.get(pointer);
    if (id === undefined) {
      id =
        isPlausiblePointer(memory, pointer, span) && memory.u32(pointer) === vtable
          ? readAsciiZ(memory, pointer + o.typeId, 0x18)
          : null;
      cache.set(pointer, id);
    }
    return id;
  };
  const typeName = (pointer: number, vtable: number) =>
    pointer === 0 ? null : readType(pointer, vtable, o.typeId + 0x18);

  /** Validated vector entries; the vector's own count goes to stats.vectors, rejected headers to stats.invalid. */
  const entries = (kind: YrEffectKind, vector: number, limit: number): number[] => {
    const count = memory.u32(vector + VECTOR_COUNT);
    stats.vectors[kind] = count;
    const pointers = readPointerVector(memory, vector, limit);
    if (!pointers) {
      stats.invalid[kind] += count;
      return [];
    }
    return pointers;
  };

  // ---- Anims ----
  const anims: YrAnimEffect[] = [];
  const seen = new Set<number>();
  for (const pointer of entries('anims', YR_EFFECTS_GLOBALS.anims, L.anims)) {
    if (
      !isPlausiblePointer(memory, pointer, o.animInvisible + 1) ||
      memory.u32(pointer) !== V.anim ||
      seen.has(pointer)
    ) {
      stats.invalid.anims++;
      continue;
    }
    seen.add(pointer);
    if (memory.u8(pointer + o.inLimbo) !== 0 && !includeLimbo) {
      stats.limbo.anims++;
      continue;
    }
    const typePointer = memory.u32(pointer + o.animType);
    const type = readType(typePointer, V.animType, o.animTypeTranslucent + 1);
    if (!type) {
      stats.invalid.anims++;
      continue;
    }
    // AnimClass::GetCoords: Location, relative to the owner's GetCoords() while attached.
    const ownerObject = memory.u32(pointer + o.animOwnerObject);
    const attachedTo = objectRef(memory, ownerObject);
    let position = readPoint(memory, pointer + o.location);
    if (ownerObject !== 0) {
      const base =
        Math.abs(position.x) <= L.maxAttachOffset && Math.abs(position.y) <= L.maxAttachOffset && attachedTo
          ? readYrObjectCoords(memory, ownerObject, L.attachDepth - 1)
          : null;
      if (!base) {
        stats.unresolved++;
        continue;
      }
      position = { x: base.x + position.x, y: base.y + position.y, z: base.z + position.z };
    }
    if (!withinWorld(position.x, position.y, position.z)) {
      stats.invalid.anims++;
      continue;
    }
    const stage = memory.i32(pointer + o.animStage);
    const start = memory.i32(typePointer + o.animTypeStart);
    const end = memory.i32(typePointer + o.animTypeEnd);
    const layer = memory.i32(typePointer + o.animTypeLayer);
    anims.push({
      id: pointer,
      uid: memory.u32(pointer + o.uniqueId),
      type,
      x: position.x,
      y: position.y,
      z: position.z,
      frame: start + stage,
      stage,
      frameCount: end > 0 ? end : 0,
      loopStart: memory.i32(typePointer + o.animTypeLoopStart),
      loopEnd: memory.i32(typePointer + o.animTypeLoopEnd),
      loopsLeft: memory.u8(pointer + o.animLoopsLeft),
      rate: memory.i32(pointer + o.animRate),
      attachedTo,
      owner: houseOf(memory.u32(pointer + o.animOwner)),
      layer: ownerObject !== 0 ? 'ground' : (LAYERS[layer] ?? null),
      flat: memory.u8(typePointer + o.animTypeFlat) !== 0,
      translucent: memory.u8(typePointer + o.animTypeTranslucent) !== 0,
      translucency: memory.i32(typePointer + o.animTypeTranslucency),
      buildingAnim: memory.u8(pointer + o.animBuilding) !== 0,
      invisible: memory.u8(pointer + o.animInvisible) !== 0,
      paused: memory.u8(pointer + o.animPaused) !== 0,
    });
  }

  // ---- Voxel anims (debris) ----
  const voxelAnims: YrVoxelAnimEffect[] = [];
  for (const pointer of entries('voxelAnims', YR_EFFECTS_GLOBALS.voxelAnims, L.voxelAnims)) {
    if (
      !isPlausiblePointer(memory, pointer, o.voxelAnimDuration + 4) ||
      memory.u32(pointer) !== V.voxelAnim ||
      seen.has(pointer)
    ) {
      stats.invalid.voxelAnims++;
      continue;
    }
    seen.add(pointer);
    if (memory.u8(pointer + o.inLimbo) !== 0 && !includeLimbo) {
      stats.limbo.voxelAnims++;
      continue;
    }
    const type = readType(memory.u32(pointer + o.voxelAnimType), V.voxelAnimType, o.typeId + 0x18);
    const at = readPoint(memory, pointer + o.location);
    const floats = readFloats(memory, pointer + o.voxelAnimVelocity, 7);
    if (!type || !withinWorld(at.x, at.y, at.z) || !floats) {
      stats.invalid.voxelAnims++;
      continue;
    }
    voxelAnims.push({
      id: pointer,
      uid: memory.u32(pointer + o.uniqueId),
      type,
      ...at,
      velocity: { x: floats[0]!, y: floats[1]!, z: floats[2]! },
      rotation: [floats[3]!, floats[4]!, floats[5]!, floats[6]!],
      owner: houseOf(memory.u32(pointer + o.voxelAnimHouse)),
      duration: memory.i32(pointer + o.voxelAnimDuration),
      invisible: memory.u8(pointer + o.voxelAnimInvisible) !== 0,
    });
  }

  // ---- Bullets ----
  const bullets: YrBulletEffect[] = [];
  for (const pointer of entries('bullets', YR_EFFECTS_GLOBALS.bullets, L.bullets)) {
    if (
      !isPlausiblePointer(memory, pointer, o.bulletTargetCoords + 12) ||
      memory.u32(pointer) !== V.bullet ||
      seen.has(pointer)
    ) {
      stats.invalid.bullets++;
      continue;
    }
    seen.add(pointer);
    if (memory.u8(pointer + o.inLimbo) !== 0 && !includeLimbo) {
      stats.limbo.bullets++;
      continue;
    }
    const typePointer = memory.u32(pointer + o.bulletType);
    const type = readType(typePointer, V.bulletType, o.bulletTypeInviso + 1);
    const at = readPoint(memory, pointer + o.location);
    const source = readPoint(memory, pointer + o.bulletSource);
    const target = readPoint(memory, pointer + o.bulletTargetCoords);
    if (
      !type ||
      !withinWorld(at.x, at.y, at.z) ||
      !withinWorld(source.x, source.y, source.z) ||
      !withinWorld(target.x, target.y, target.z)
    ) {
      stats.invalid.bullets++;
      continue;
    }
    const doubles = readDoubles(memory, pointer + o.bulletVelocity, 3);
    const firerPointer = memory.u32(pointer + o.bulletFirer);
    const firer = objectRef(memory, firerPointer);
    bullets.push({
      id: pointer,
      uid: memory.u32(pointer + o.uniqueId),
      type,
      weapon: typeName(memory.u32(pointer + o.bulletWeapon), V.weaponType),
      warhead: typeName(memory.u32(pointer + o.bulletWarhead), V.warheadType),
      ...at,
      source,
      target,
      velocity: doubles ? { x: doubles[0]!, y: doubles[1]!, z: doubles[2]! } : { x: 0, y: 0, z: 0 },
      firer,
      owner:
        firer && TECHNO_KINDS.has(memory.u32(firerPointer)) ? houseOf(memory.u32(firerPointer + o.technoOwner)) : -1,
      inviso: memory.u8(typePointer + o.bulletTypeInviso) !== 0,
      arcing: memory.u8(typePointer + o.bulletTypeArcing) !== 0,
      frame: memory.u8(pointer + o.bulletFrame),
    });
  }

  // ---- Lasers (plain structs: validated by value) ----
  const lasers: YrLaserEffect[] = [];
  const plain = new Set<number>();
  for (const pointer of entries('lasers', YR_EFFECTS_GLOBALS.lasers, L.lasers)) {
    const source = readPoint(memory, pointer + o.laserSource);
    const target = readPoint(memory, pointer + o.laserTarget);
    const duration = memory.i32(pointer + o.laserDuration);
    if (
      !isPlausiblePointer(memory, pointer, o.laserDuration + 12) ||
      plain.has(pointer) ||
      !withinWorld(source.x, source.y, source.z) ||
      !withinWorld(target.x, target.y, target.z) ||
      !(duration >= 0 && duration <= L.maxLaserDuration)
    ) {
      stats.invalid.lasers++;
      continue;
    }
    plain.add(pointer);
    lasers.push({
      id: pointer,
      source,
      target,
      innerColor: readRgb(memory, pointer + o.laserInnerColor),
      outerColor: readRgb(memory, pointer + o.laserOuterColor),
      outerSpread: readRgb(memory, pointer + o.laserOuterSpread),
      thickness: memory.i32(pointer + o.laserThickness),
      houseColor: memory.u8(pointer + o.laserHouseColor) !== 0,
      duration,
      progress: memory.i32(pointer + o.laserProgress),
      fades: memory.u8(pointer + o.laserFades) !== 0,
      blinks: memory.u8(pointer + o.laserBlinks) !== 0,
    });
  }

  // ---- Electric bolts (plain structs) ----
  const electricBolts: YrElectricBoltEffect[] = [];
  for (const pointer of entries('electricBolts', YR_EFFECTS_GLOBALS.electricBolts, L.electricBolts)) {
    const source = readPoint(memory, pointer + o.boltSource);
    const target = readPoint(memory, pointer + o.boltTarget);
    const lifetime = memory.i32(pointer + o.boltLifetime);
    const firerPointer = memory.u32(pointer + o.boltFirer);
    const firer = objectRef(memory, firerPointer);
    if (
      !isPlausiblePointer(memory, pointer, o.boltAlternateColor + 1) ||
      plain.has(pointer) ||
      !withinWorld(source.x, source.y, source.z) ||
      !withinWorld(target.x, target.y, target.z) ||
      !(lifetime >= 0 && lifetime <= 0x10000) ||
      (firerPointer !== 0 && !firer)
    ) {
      stats.invalid.electricBolts++;
      continue;
    }
    plain.add(pointer);
    electricBolts.push({
      id: pointer,
      source,
      target,
      firer,
      weaponSlot: memory.i32(pointer + o.boltWeaponSlot),
      lifetime,
      alternateColor: memory.u8(pointer + o.boltAlternateColor) !== 0,
    });
  }

  // ---- Particle systems ----
  const particleSystems: YrParticleSystemEffect[] = [];
  for (const pointer of entries('particleSystems', YR_EFFECTS_GLOBALS.particleSystems, L.particleSystems)) {
    if (
      !isPlausiblePointer(memory, pointer, o.particleSystemHouse + 4) ||
      memory.u32(pointer) !== V.particleSystem ||
      seen.has(pointer)
    ) {
      stats.invalid.particleSystems++;
      continue;
    }
    seen.add(pointer);
    if (memory.u8(pointer + o.inLimbo) !== 0 && !includeLimbo) {
      stats.limbo.particleSystems++;
      continue;
    }
    const typePointer = memory.u32(pointer + o.particleSystemType);
    const type = readType(typePointer, V.particleSystemType, o.particleSystemTypeBehavesLike + 4);
    const at = readPoint(memory, pointer + o.location);
    const target = readPoint(memory, pointer + o.particleSystemTargetCoords);
    const particleVector = pointer + o.particleSystemParticles;
    const particleCount = memory.u32(particleVector + VECTOR_COUNT);
    if (
      !type ||
      !withinWorld(at.x, at.y, at.z) ||
      !withinWorld(target.x, target.y, target.z) ||
      particleCount > L.particlesPerSystem
    ) {
      stats.invalid.particleSystems++;
      continue;
    }
    const system: YrParticleSystemEffect = {
      id: pointer,
      uid: memory.u32(pointer + o.uniqueId),
      type,
      behavesLike: BEHAVIOURS[memory.i32(typePointer + o.particleSystemTypeBehavesLike)] ?? null,
      ...at,
      target,
      attachedTo: objectRef(memory, memory.u32(pointer + o.particleSystemOwnerObject)),
      owner: houseOf(memory.u32(pointer + o.particleSystemHouse)),
      particleCount,
      lifetime: memory.i32(pointer + o.particleSystemLifetime),
    };
    if (options.particles) {
      const positions: YrPoint3[] = [];
      for (const particle of readPointerVector(memory, particleVector, L.particlesPerSystem) ?? []) {
        if (!isPlausiblePointer(memory, particle, o.location + 12) || memory.u32(particle) !== V.particle) continue;
        const p = readPoint(memory, particle + o.location);
        if (withinWorld(p.x, p.y, p.z)) positions.push(p);
      }
      system.particles = positions;
    }
    particleSystems.push(system);
  }

  // ---- Fire events ----
  const fires: YrFireEvent[] = [];
  const window = options.fireWindow ?? 30;
  if (window > 0) {
    const technos = readPointerVector(memory, YR_EFFECTS_GLOBALS.technos, L.technos) ?? [];
    stats.technos = technos.length;
    for (const pointer of technos) {
      if (!isPlausiblePointer(memory, pointer, o.technoTarget + 4)) continue;
      const kind = TECHNO_KINDS.get(memory.u32(pointer));
      if (!kind) continue;
      const fired = memory.i32(pointer + o.technoLastFireFrame);
      if (!(fired > 0 && fired <= frame && frame - fired <= window)) continue;
      const targetPointer = memory.u32(pointer + o.technoTarget);
      const target = objectRef(memory, targetPointer);
      fires.push({
        id: pointer,
        uid: memory.u32(pointer + o.uniqueId),
        kind,
        frame: fired,
        target,
        targetPosition: target ? readYrObjectCoords(memory, targetPointer) : null,
      });
    }
  }

  const beams = readYrBeams(memory, { includeLimbo });
  stats.beams = beams.stats;
  return {
    frame,
    anims,
    voxelAnims,
    bullets,
    lasers,
    electricBolts,
    particleSystems,
    fires,
    stats,
    radBeams: beams.radBeams,
    waves: beams.waves,
  };
}

/**
 * Guarded factory: only the pinned YR 1.001 image is supported. Beyond the hash it checks that the GetCoords slots the
 * reader reproduces hold the expected functions and that every effect/type vtable starts with a code pointer, so a
 * different build or a not-yet-loaded image yields null instead of silently wrong data.
 */
export function createYrEffectsReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): ((options?: ReadYrEffectsOptions) => YrEffects | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  const accessor = memory();
  const slot = (vtable: number) => accessor.u32(vtable + YR_GET_COORDS_SLOT);
  const imageValid =
    slot(YR_EFFECTS_VTABLES.anim) === YR_GET_COORDS.anim &&
    slot(YR_STATE_VTABLES.building) === YR_GET_COORDS.building &&
    slot(YR_STATE_VTABLES.unit) === YR_GET_COORDS.object &&
    slot(YR_EFFECTS_VTABLES.cell) === YR_GET_COORDS.cell &&
    Object.values(YR_EFFECTS_VTABLES).every((vtable) => {
      const first = accessor.u32(vtable);
      return first >= CODE_START && first < RDATA_START;
    });
  if (!imageValid) return null;
  return (options) => {
    try {
      return readYrEffects(memory(), options);
    } catch {
      return null;
    }
  };
}
