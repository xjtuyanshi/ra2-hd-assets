# HD bridge fields H1-H3

The HD live view (`packages/hd-renderer/src/live`) accepts optional snapshot fields and uses each one whenever it is
present; without them it falls back to the estimates listed in `docs/remaster/HD_BRIDGE.md` ("Bridge fields"). The
types to fill are `LiveSnapshot`, `LiveHouse`, `LiveObject`, `LiveCells` (`live/liveView.ts`) and `LiveAnim`,
`LiveBullet`, `LiveParticleSystem`, `LiveVoxelAnim`, `LiveFireEvent`, `LiveBeam`, `LiveEffects` (`live/effects.ts`).
H2 building and infantry state is implemented end to end. H1 and the remaining SHP-vehicle H2 fields below are
proposals; live cell overlays already use the separate `GameRenderOverlays` contract.

## H1: pass through what the readers already read

Everything below already exists in `YrEffects` (`src/games/yr/effectsReader.ts`) or `YrHouseState`
(`src/games/yr/stateReader.ts`); H1 only stops `toSnapshot` in `src/ui/pages/game/hdBridge.ts` (and, for houses, the
game-neutral `GameRenderHouse`) from dropping it. Proposed `effects` member of `toSnapshot`:

```ts
effects: state.effects && {
  // Invisible and art-less anims are never drawn; building anims ARE kept (flag buildingAnim): the live view then
  // draws exactly the layers the engine plays, at the engine's frame.
  anims: state.effects.anims
    .filter((anim) => !anim.invisible && anim.frameCount > 0)
    .map((a) => ({
      id: a.id, uid: a.uid, type: a.type, x: a.x, y: a.y, z: a.z,
      frame: a.frame, stage: a.stage, frameCount: a.frameCount, loopStart: a.loopStart, loopEnd: a.loopEnd,
      loopsLeft: a.loopsLeft, rate: a.rate, flat: a.flat, translucent: a.translucent, translucency: a.translucency,
      layer: a.layer, owner: a.owner, attachedTo: a.attachedTo, buildingAnim: a.buildingAnim,
    })),
  bullets: state.effects.bullets
    .filter((bullet) => !bullet.inviso)
    .map((b) => ({
      id: b.id, uid: b.uid, x: b.x, y: b.y, z: b.z, type: b.type, weapon: b.weapon, warhead: b.warhead,
      frame: b.frame, velocity: b.velocity, source: b.source, target: b.target, arcing: b.arcing,
    })),
  voxelAnims: state.effects.voxelAnims
    .filter((v) => !v.invisible)
    .map(({ id, uid, type, x, y, z, rotation, owner }) => ({ id, uid, type, x, y, z, rotation, owner })),
  fireEvents: state.effects.fires.map(({ id, uid, frame }) => ({ id, uid, frame })),
  beams: [
    ...state.effects.lasers.map((l) => ({
      source: l.source, target: l.target, kind: 'laser' as const, colour: l.innerColor,
      outerColor: l.outerColor, thickness: l.thickness, duration: l.duration, progress: l.progress, fades: l.fades,
    })),
    ...state.effects.electricBolts.map(({ source, target, alternateColor }) => ({
      source, target, kind: 'bolt' as const,
      colour: (alternateColor ? [190, 90, 255] : [150, 200, 255]) as [number, number, number],
    })),
  ],
  particleSystems: state.effects.particleSystems.map((s) => ({
    id: s.id, uid: s.uid, behaviour: s.behavesLike, x: s.x, y: s.y, z: s.z,
    type: s.type, particleCount: s.particleCount, lifetime: s.lifetime, target: s.target,
    attachedTo: s.attachedTo,
    ...(s.particles ? { particles: s.particles } : {}),
  })),
},
```

Houses: `civilian: plainName === 'Neutral' || plainName === 'Special'` on each `LiveHouse` (the state reader reads
`HouseClass::PlainName`; `GameRenderHouse` does not carry it yet).

Notes:

- Building anims are reported with `attachedTo: null` (seen for CAUSFGL_A, CAOILD_A, ...). The live view matches them
  to the building whose foundation holds the anim's cell; the owning building (AnimClass::OwnerObject, or the building
  whose anim slots hold the anim) would make the match exact.
- `fires` uses the reader's default fire window (30 frames); the view de-duplicates on (uid, frame).
- Particle positions (reader option `particles: true`) let the view draw the engine's own particles instead of its
  simulated smoke; the per-particle ParticleType id and frame (ParticleClass::Type and its StageClass) are not read
  yet and would be an H2-style addition.
- Poll cost: all of these are read on every poll already.

## H2: implemented building and infantry state

The read-only observers `src/games/yr/buildingRenderState.ts` and `infantryRenderState.ts` are called by
`stateReader.ts` after its normal object/type validation. The factory accepts only YR 1.001,
SHA-256 `7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`, and validates loaded image vtables.
Community YRpp headers (BuildingClass.h, BuildingTypeClass.h, MissionClass.h, TechnoClass.h, InfantryClass.h,
InfantryTypeClass.h, GeneralDefinitions.h) supplied leads only. The following evidence comes from disassembling
the player's pinned executable; no executable bytes or game art are included in the repository.

The fields pass through `YrObjectState`, the game-neutral `GameRenderObject`, the YR projection, the page bridge's
`toSnapshot`, and `LiveObject`. Addresses and enum translation stay in `src/games/yr`; the renderer consumes only
animation state and library art metadata. The observers validate extra object/type spans, vtables, enum ranges and
animation values. An unavailable H2 read leaves the otherwise valid object in the snapshot with optional fields absent.

### Buildings

| Field                               | Offset                             | Pinned executable evidence                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current `BState`                    | Building `+0x534`                  | Constructor `0x43B777` initializes -1; `BeginMode` (`0x447780`) stores `mov [esi+0x534], edi` at `0x4477C1`; AI promotes the queue at `0x43FFD5`.                                                                                              |
| `QueueBState`                       | Building `+0x538`                  | Initialized -1 at `0x43B77D`; requested mode stored at `0x447794`; cleared at `0x4477B6` / `0x44003C`. It is validated but never substituted for the drawn mode.                                                                               |
| Current / queued mission            | Building `+0xAC` / `+0xB4`         | `ForceMission` stores current at `0x5B2FE9`; getter `0x5B3040` falls back to queued at `0x5B304B` only if current is -1. Mission name table `0x816CAC`: Construction=18, Selling=19; AI bounds missions to 0..31 at `0x5B30B8`.                |
| `Animation.Value`                   | Building `+0xF8`                   | `GetCurrentFrame` (`0x43EF90`) reads at `0x43EF9A`; animation AI (`0x4509D0`) adds Step `+0x110` at `0x450A05`, stores Value at `0x450A0E`.                                                                                                    |
| Make Start / Count                  | BuildingType `+0xF04` / `+0xF08`   | `LoadBuildup` (`0x45F230`) stores Start=0 at `0x45F2FE`, foreground Count at `0x45F304`, halving SHP foreground/shadow frames at `0x45F2B4..0x45F2C8`. `BeginMode` initializes Value from Start at `0x447AA7`.                                 |
| `HasBuildUp`                        | Building `+0x6E9`                  | Cleared at `0x43B990`; set at `0x442CCF` after successful make loading. Mode 0 with no loaded make is unavailable, not proof of completion: `GetImageData` (`0x4513D0`) still asks for make art; `DrawIt` exits at `0x43D2BB` if it is absent. |
| Type `Gate`                         | BuildingType `+0x16B7`             | INI store `0x460A13`, key `0x81AA8C`; `GetCurrentFrame` checks at `0x43EFD0` and reverses at `0x43EFDA..0x43EFEB`.                                                                                                                             |
| Type `LaserFence` / `FirestormWall` | BuildingType `+0x16BF` / `+0x16C0` | INI stores `0x460ABA` / `0x460ADA`, keys `0x81AA30` / `0x81AA20`; frame overrides at `0x43EFAA` / `0x43EFBD` precede make calculation. H2 make state is omitted for these special types.                                                       |

Construction mode 0 is requested at `0x44D6BD` and in `Mission_Construction` (`0x449A50`, call
`0x449B32/0x449B36`). Completed construction requests idle mode 1 at `0x449AC5/0x449AC9`; repair requests active
mode 2 at `0x44B802/0x44B806`; missile code requests modes 4 and 5 at `0x44CA84/0x44CA88` and
`0x44CCBE/0x44CCC2`. YRpp names mode 3 Full, but this executable has no direct `BeginMode(3)` caller, and both
type initialization (`0x45E362..0x45E3B6`) and art loading (`0x461612..0x4617B5`) skip that slot. Its name is not
independently established. H2's zero/nonzero distinction follows `GetCurrentFrame` at `0x43EFCC` and does not
depend on that name. Mode -1 is unknown/initialization and is omitted; valid modes 1..5 map to `done`.

Current mode 0 with valid loaded make art maps to `building`, or `selling` when the effective mission is 19.
`Mission_Selling` (`0x449C30`) requests mode 0 at `0x44A89E/0x44A8AC`. Raw Value **increases** during selling;
`0x43EFF7` checks mission 19, then `0x43F00F..0x43F025` computes `Start + Count - Value - 1`.
`buildupFrame` is this actual foreground SHP index, not elapsed sale time. Gates apply the same reversal first,
followed independently by sale reversal. LiveView clamps to available make art and never reverses this frame again.
The library's `SpriteCollector.addShp` (`packages/ra2-assets/src/node/artSource.ts`) separates foreground `frames`
from `shadows`, so the make index addresses the foreground half, matching the native count.
The pinned construction loader uses Start=0; other starts, invalid counts/stages, partial initialization and missing
make art leave H2 unavailable.

### Infantry

| Field                      | Offset                          | Pinned executable evidence                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SequenceAnim`             | Infantry `+0x6C4`               | Constructor `0x517A64` initializes -1; `PlayAnim` (`0x51D6F0`) writes `mov [esi+0x6c4], edi` at `0x51D9D2`.                                                                                                                                                                                         |
| Relative `Animation.Value` | Infantry `+0xF8`                | `PlayAnim` stores a random starting step at `0x51DA84` or clears it at `0x51DA8C`. Image chooser `0x518D80` reads at `0x518E18`, takes remainder by sequence frame count at `0x518E1F`, then adds art StartFrame and facing stride at `0x518F70..0x518F82`. DrawIt calls the chooser at `0x5195D5`. |
| All DoType values          | String-pointer table `0x8255C8` | Art Sequence loader `0x523D00` loads the table at `0x523D3F`, advances records by `0x24` at `0x524077`, table entries by 4 at `0x52407A`, and stops at `0x825670` at `0x52407D`: exactly 42 indexed art keys.                                                                                       |

The executable table independently confirms every `infantrySequence` translation:

| Values | Art keys in increasing index order                                                     |
| ------ | -------------------------------------------------------------------------------------- |
| 0..8   | Ready, Guard, Prone, Walk, FireUp, Down, Crawl, Up, FireProne                          |
| 9..16  | Idle1, Idle2, Die1, Die2, Die3, Die4, Die5, Tread                                      |
| 17..26 | Swim, WetIdle1, WetIdle2, WetDie1, WetDie2, WetAttack, Hover, Fly, Tumble, FireFly     |
| 27..34 | Deploy, Deployed, DeployedFire, DeployedIdle, Undeploy, Cheer, Paradrop, AirDeathStart |
| 35..41 | AirDeathFalling, AirDeathFinish, Panic, Shovel, Carry, SecondaryFire, SecondaryProne   |

`sequenceFrame` is the engine's sequence-local step, before start/facing offsets. It can accumulate beyond 65535:
AI compares Value with CountFrames at `0x520B09` and can request the current sequence again. `PlayAnim`'s same-sequence branch
`0x51D90B..0x51D913` returns before clearing Value. All nonnegative signed-i32 steps are accepted; the art helper
applies the sequence count modulo. Unknown/initial (-1) sequences omit both fields; a valid sequence with an
implausible step retains its name and omits only progress.

Infantry facing uses the native image chooser's 32-direction quantization (`0x518F52..0x518F65`) and reverse
eight-facing lookup table at `0x7EAEFC`, equivalent to `(7 - floor((raw16 + 5120) / 8192)) & 7` after wrapping raw16.
`sequenceFrame()` accepts optional raw16 facing so live interpolated poses retain the low bits at direction boundaries;
the general-purpose `facingFrame()` for other art is unchanged. Fixed Sequence.Facing metadata describes an engine
turn (`0x520CFA..0x520D16` updates primary facing), not a replacement for the image's current direction.

`hd:library` already extracts every artmd Sequence entry in `packages/ra2-assets/src/node/library.ts`; no cache
schema change or regeneration is required for libraries that already carry `LibraryInfantry.sequences`.
The view prefers a named engine sequence to inferred movement/fire/death. An old library missing a named sequence
keeps those estimates; one with no sequence metadata at all draws its first body frame.

Limits: native Spy/disguise type substitution (`0x518DDF..0x518DF0`) and some jumpjet target-based facing
(`0x518E39..0x518F29`) are not projected. These fields do not provide locomotor bobbing or additional SHP vehicle
walk/firing state. Real-game same-moment HD build/sell/infantry acceptance remains separate from disassembly and
synthetic guest-memory tests.

### Fallback and remaining H2 scope

Without H2, LiveView records each UID's first logic frame in `push()`, independently of rendering or art readiness.
After the initial 60-frame grace period it estimates make progress from that pushed frame. A newly seen building
following a pushed-snapshot gap **greater than 54 logic frames** is treated as complete because its placement time
is unknown. History survives temporary object omissions, uses match-unique UIDs rather than reusable pointers, and
resets on a logic-frame rewind. Engine state, when available, takes precedence over this conservative fallback.

SHP vehicles (terror drone, squid, dolphin) still need `UnitClass::WalkedFramesSoFar` and the facing used for their
body art. Those fields are not implemented or assigned offsets here. The view uses primary facing and estimates
walk progress from logic frame / `WalkRate`.

## H3: remaining runtime smudges and tuple proposal

`snapshot.cells = { full, cells: [x, y, overlay, overlayData, smudge, smudgeData][], overlayTypes?, smudgeTypes? }`:
read the MapClass cells (CellClass OverlayTypeIndex, OverlayData, SmudgeTypeIndex, SmudgeData), keep the previous
poll's copy in the reader and report only changed cells (`full: true` on the first poll); `overlayTypes` and
`smudgeTypes` are the rules ids by index (OverlayTypeClass / SmudgeTypeClass arrays), sent once.

The overlay portion is already implemented through `src/games/yr/overlayReader.ts`, `GameRenderOverlays` and the
page bridge: ore growth/depletion and wall connections use the engine's full frame byte. See
`docs/remaster/LIVE_OVERLAYS.md`. The tuple contract above remains a proposal for an alternative publication format
and runtime smudges; this H2 change does not add engine craters/burn marks. Without either live overlay contract,
the view still uses the map's initial overlays, warns once and reports `cellsFromEngine: false`.
