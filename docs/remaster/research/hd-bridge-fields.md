# HD bridge fields H1-H3

The HD live view (`packages/hd-renderer/src/live`) accepts optional snapshot fields and uses each one whenever it is
present; without them it falls back to the estimates listed in `docs/remaster/HD_BRIDGE.md` ("Bridge fields"). The
types to fill are `LiveSnapshot`, `LiveHouse`, `LiveObject`, `LiveCells` (`live/liveView.ts`) and `LiveAnim`,
`LiveBullet`, `LiveParticleSystem`, `LiveVoxelAnim`, `LiveFireEvent`, `LiveBeam`, `LiveEffects` (`live/effects.ts`).
`LiveRadBeam` and `LiveWave` (`live/beams.ts`) extend `LiveEffects` with optional `radBeams`/`waves` arrays.
H2 building and infantry state and H3 runtime cells (overlays and smudges, published as independent live
grids) are implemented end to end. H1 is partially implemented; remaining fields below are proposals.

## H1: pass through what the readers already read

Everything below already exists in `YrEffects` (`src/games/yr/effectsReader.ts`) or `YrHouseState`
(`src/games/yr/stateReader.ts`); H1 only stops `toSnapshot` in `src/ui/pages/game/hdBridge.ts` (and, for houses, the
game-neutral `GameRenderHouse`) from dropping it. Implemented: anim frame/stage/frameCount, flat/layer/alpha,
owner/attachment/buildingAnim and projectile type/frame/velocity. The YR observer also reads RadBeam and WaveClass
through `src/games/yr/beamsReader.ts`; their validated endpoints, type,
period/amplitude/color and life/progress pass through `GameRenderEffects` and `toSnapshot` unchanged. The independent
HD beam layer consumes these optional arrays, clears them on removal/unavailable effects, and shares the engine
coordinate transform and depth-tested additive presentation with the other effect layers. Instruction evidence and
cycle/reset limits are in [Tactical passthrough](tactical-passthrough.md).

Zero-lifetime electric bolts are filtered by the
YR projection, and the view accepts changed effects without requiring a new logic frame. The following is the full
target projection, not the current game-neutral contract (debris, fire events, detailed beams and particles remain):

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

| Field                               | Offset                             | Pinned executable evidence                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current `BState`                    | Building `+0x534`                  | Constructor `0x43B777` initializes -1; `BeginMode` (`0x447780`) stores `mov [esi+0x534], edi` at `0x4477C1`; AI promotes the queue at `0x43FFD5`.                                                                                                                                                                                                                       |
| `QueueBState`                       | Building `+0x538`                  | Initialized -1 at `0x43B77D`; requested mode stored at `0x447794`; cleared at `0x4477B6` / `0x44003C`. It is validated but never substituted for the drawn mode.                                                                                                                                                                                                        |
| Current / queued mission            | Building `+0xAC` / `+0xB4`         | `ForceMission` stores current at `0x5B2FE9`; getter `0x5B3040` falls back to queued at `0x5B304B` only if current is -1. Mission name table `0x816CAC`: Construction=18, Selling=19; AI bounds missions to 0..31 at `0x5B30B8`.                                                                                                                                         |
| `Animation.Value`                   | Building `+0xF8`                   | `GetCurrentFrame` (`0x43EF90`) reads at `0x43EF9A`; animation AI (`0x4509D0`) adds Step `+0x110` at `0x450A05`, stores Value at `0x450A0E`.                                                                                                                                                                                                                             |
| Make Start / Count                  | BuildingType `+0xF04` / `+0xF08`   | `LoadBuildup` (`0x45F230`) stores Start=0 at `0x45F2FE`, foreground Count at `0x45F304`, halving SHP foreground/shadow frames at `0x45F2B4..0x45F2C8`. For Gate=yes, `0x45F2D2..0x45F2D9` replaces Count with `GateStages + 1` (type `+0x16F8`, key `0x81A6F4`, INI store `0x4612E8`, default 9 at `0x45E1F0`). `BeginMode` initializes Value from Start at `0x447AA7`. |
| `HasBuildUp`                        | Building `+0x6E9`                  | Cleared at `0x43B990`; set at `0x442CCF` after successful make loading. Mode 0 with no loaded make is unavailable, not proof of completion: `GetImageData` (`0x4513D0`) still asks for make art; `DrawIt` exits at `0x43D2BB` if it is absent.                                                                                                                          |
| Type `Gate`                         | BuildingType `+0x16B7`             | INI store `0x460A13`, key `0x81AA8C`; `GetCurrentFrame` checks at `0x43EFD0` and reverses at `0x43EFDA..0x43EFEB`.                                                                                                                                                                                                                                                      |
| Type `LaserFence` / `FirestormWall` | BuildingType `+0x16BF` / `+0x16C0` | INI stores `0x460ABA` / `0x460ADA`, keys `0x81AA30` / `0x81AA20`; frame overrides at `0x43EFAA` / `0x43EFBD` precede make calculation. H2 make state is omitted for these special types.                                                                                                                                                                                |

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
from `shadows`, so ordinary make indices address the foreground half. Gate counts instead follow GateStages and
need not equal the available art count. The reader's `0x7FFF` count bound is a sanity limit, not an SHP-derived bound.
The pinned construction loader uses Start=0; other starts, invalid counts/stages, partial initialization and missing
make art leave H2 unavailable.

### ActiveAnim and native dynamic detail

Baseline: player-supplied `gamemd.exe`, YR 1.001, the pinned SHA-256 above. The user verified the
following through read-only reverse engineering and live measurement; the implementation does not patch
the native draw gate or run its mutating threshold function.

NAPOWR has no `Light*` keys. Its blue sphere and lit walls come from artmd's `NAPOWR_A` ActiveAnim
(`DetailLevel=2`, `ActiveAnimPoweredSpecial=true`), whose frames redraw the whole building. The body art
without that anim has a pale glass sphere. This is not a delayed native light source.

| Fact | YR 1.001 evidence |
| --- | --- |
| ActiveAnim instance | `BuildingClass::Anims[21]` begins at `+0x55C`; slot 3 is `+0x568` |
| Slot removal | `0x451E40` nulls the slot and deletes its anim through vtable `+0x20` |
| PoweredSpecial lifecycle | `0x4549B0` tests online through vtable `+0x350`, creates slots through `0x451890`; offline sibling `0x454930` kills them through `0x451E40` |
| Per-slot powered flags | BuildingType records stride `0x44` from `+0xF8C`: Powered `+0xF8C`, PoweredLight `+0xF8D`, PoweredEffect `+0xF8E`, PoweredSpecial `+0xF8F`; slot 3 is `+0x1058..+0x105B`, INI stores `0x461A03` / `0x461A20` / `0x461A5A` |
| Type PoweredSpecial | `+0x1574`, INI store `0x46000F` |
| Anim fields | Type `+0xC8`, Invisible `+0x19D`, Stage `+0xAC` (also documented in `src/games/yr/effectsReader.ts`); AnimType.DetailLevel `+0x2D4` |
| Draw gate | `0x422FCC..0x42300E`: skip if FPS below DetailThreshold and DetailLevel > 1, or Invisible, or DetailLevel above options dword `[0xA8EB78]` |
| Measured FPS | Dword `[0xABCD44]`, writer `0x55E3B5` |
| Threshold hysteresis | `0x55AF60`, flag byte `[0xABCD50]`, min dword `[0x829FF4]`, buffer dword `[0x829FF8]` |
| AudioVisual INI keys | Loader `0x669216` / `0x66922F` / `0x669248` stores the three detail keys to `[esi]` / `[esi+4]` / `[esi+8]`; stock DetailMinFrameRateNormal=15, DetailBufferZoneWidth=5 |

When the flag is set, DetailThreshold clears it at FPS >= min + buffer and returns min; otherwise it
returns min + buffer. When clear, FPS < min sets it and returns min + buffer; otherwise it returns min.
The equivalent read-only skip predicate is `(flag ? fps < min + buffer : fps < min) && DetailLevel > 1`.

User live proof: a normal-speed skirmish supplied **519 samples at 250 ms**. Flag `[0xABCD50] == 1`
was equivalent to the original sphere being unlit, with **zero exceptions**. Measured FPS was 1..19 in
these windows on a loaded host; layer order and building/anim object bytes were identical between lit
and unlit windows. The off window is the engine's dynamic-detail fallback below 15 FPS, held until 20,
and depends on host load in the VM. It is not a change in game state.

`src/games/yr/buildingActiveAnim.ts`, called by the hash/image-gated YR render projection for completed
buildings, publishes optional `activeAnim`: null slot -> `none`; a present anim skipped by any of the
three gates -> `detail`; otherwise -> `shown`. It validates building/anim/type pointer spans and
vtables, DetailLevel/options 0..3, boolean flags, and FPS/min/buffer integers (FPS 0..1000, min 1..1000,
buffer 0..1000, sum <= 1000). Failed/truncated reads remain unknown; a validated null slot needs no
detail globals. Globals are sampled once per poll and reused across buildings, with optional snapshot
`nativeDetail { fps, lowFrameRate, level }`. Same-frame caching includes globals, slot, anim and type
detail fields, even when the slot is not yet in the effects vector. No YR address reaches the renderer.

NAPOWR alone marks its HD light as `BuildingLightSpec.activeAnim`. `none` removes its pool, orb and
arcs immediately and return restarts their existing half-second fade. Default `'ignore'` preserves
lighting for `detail`, presenting game state independently of native renderer load; `'mirror'` or
`?hd-native-detail=mirror` also suppresses `detail` for original/HD reviews. Undefined retains the
existing policy, including sandbox/older snapshots. Other building sources are unchanged. Synthetic
reader, same-frame projection, bridge and light-gate regressions cover these contracts; the user's
native live proof does not establish new HD rendered-pixel parity in this worktree.

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

The optional `infantryDrawFacingRaw` overrides only sequence-frame facing. At `0x518E27..0x518F2E` the image chooser
uses Target (`+0x2B4`) instead of PrimaryFacing when InfantryType.JumpJet (`+0xD94`, INI store `0x715200`) is true,
JumpJetTurn (`+0xECB`, key `0x8258FC`, store `0x524668`, default false at `0x5237E2`) is false, and locomotor
`+0x674` resolves to the Jumpjet CLSID `{92612C46-F71F-11D1-AC9F-006008055BB5}` at `0x7E9AC0`.
The read-only observer validates the concrete ILocomotion vtable `0x7ECD68` and adjacent IPersist vtable `0x7ECE34`
(constructor stores `0x54ACC3..0x54ACD0`, ILocomotion is base+4), whose GetClassID slot is `0x54B710`.
It never calls guest COM. Other locomotors, invalid pointers/types/coordinates and absent targets omit the override.
The sequence and stage remain usable when only this optional read fails.

`0x5F3DB0` obtains both positions through GetCoords (`vtable +0x48`). Shared `src/games/yr/objectCoords.ts` keeps
infantry and effects on the same read-only dispatch, including building foundation centres and cell centres;
unknown implementations are omitted. Only bounded integer coordinates are accepted for direction calculation.
The atan helper `0x4CAE30` truncates the absolute slope/step index into the float table `0x8610B4`, with step at
`0x8650B8`, handles axes/zero displacement and applies quadrant signs. The reader samples that same guest table.
`0x5F3DFF..0x5F3E13` subtracts pi/2 (`0x7E2820`), multiplies by **-65534/(2\*pi)** (`0x7E2818`), truncates via
`0x7C5F00` and stores the low word. Continuous host atan2 and rounding at a 65536 scale are not equivalent near
frame boundaries. PrimaryFacing remains the travel heading; older snapshots without the override retain pose interpolation.

`hd:library` already extracts every artmd Sequence entry in `packages/ra2-assets/src/node/library.ts`; no cache
schema change or regeneration is required for libraries that already carry `LibraryInfantry.sequences`.
The view prefers a named engine sequence to inferred movement/fire/death. An old library missing a named sequence
keeps those estimates; one with no sequence metadata at all draws its first body frame.

Publication freshness, zero-health death art and the completed-building body fields `buildingFrame` and
`buildingDamaged` are detailed in [native presentation evidence](native-presentation.md). Body-frame selection is
independent of the make-frame path above and of yellow-condition damage animation layers.

Limits: native Spy/disguise type substitution (`0x518DDF..0x518DF0`) is not projected. These fields do not provide locomotor bobbing or additional SHP vehicle
walk/firing state. Real-game same-moment HD build/sell/infantry acceptance remains separate from disassembly and
synthetic guest-memory tests.

### Fallback and remaining H2 scope

Without H2, LiveView records each building UID's first logic frame and last seen frame in `push()`, independently of
rendering or art readiness. Other object kinds do not allocate appearance records.
After the initial 60-frame grace period it estimates make progress from that pushed frame. A newly seen building
following a pushed-snapshot gap **greater than 54 logic frames** is treated as complete because its placement time
is unknown. Missing building records are evicted when the current logic frame exceeds their last seen frame by more
than 54; shorter omissions preserve the first-seen clock. Objects still present retain it even across a snapshot gap.
History uses match-unique UIDs rather than reusable pointers and resets on a logic-frame rewind. Engine state, when available, takes precedence over this conservative fallback.

SHP vehicles (terror drone, squid, dolphin) still need `UnitClass::WalkedFramesSoFar` and the facing used for their
body art. Those fields are not implemented or assigned offsets here. The view uses primary facing and estimates
walk progress from logic frame / `WalkRate`.

## H3: runtime cells (implemented)

The page forwards `snapshot.overlays` and `snapshot.smudges` from `GameRenderState`. Both contain bounds, row-major
`Int16Array index`, `Uint8Array data`, a rules-ID `types` table and a lifetime-monotonic `revision`. They replace the
proposed tuple-diff `snapshot.cells` path, which remains only as a legacy renderer input; the page does not populate it.

`src/games/yr/overlayReader.ts` reads `Cell+0x44` / `+0x11E` and `OverlayTypes` at `0xA83D80`.
`src/games/yr/smudgeReader.ts` reads `Cell+0x48` / `+0x11F` and `SmudgeTypes` at `0xA8EC18`. The reader comments
record the pinned SHA-256, validation rules, header leads and independent instruction evidence. Placement writes the
smudge index/data at `0x6B60EA` / `0x6B60F5`; clearing is at `0x543573` / `0x54357D`.

The engine's smudge byte is `dy * Width + dx`, not an SHP animation frame: `DrawIt` decodes it at `0x6B562C` /
`0x6B5637` and draws body frame 0 at `0x6B56B1`. The per-theater library's `smudges` section includes Width/Height
and all rules types, allowing the renderer to reconstruct and deduplicate multi-cell burn marks. Its draw rectangle
is the native tactical redraw rectangle, not per-cell clipping, so remaining footprint cells retain the same sprite.

Both readers scan on the existing 250 ms cell cadence, reuse scratch arrays and compare exact contents. Only changed
layers are copied into immutable publications; ordered Worker replies omit independently unchanged grids. New
scenarios, map changes and logic rewinds reset scratch state. A valid empty grid removes all map-start objects in
that layer; null restores its map-cache fallback. This includes same-frame updates while paused.

H3 now carries harvesting, wall placement/destruction, craters and burn marks. Old libraries without `smudges` warn
once and use interpretable map-cache art, but cannot draw every new type until upgraded. `overlaysFromEngine` and
`smudgesFromEngine` diagnostics distinguish each layer; the legacy `cellsFromEngine` reports any active live cell path.
See [Live overlays and smudges](../LIVE_OVERLAYS.md) for exact cache commands, polling measurements and acceptance.
Real-match comparison remains unverified by reader/mapping/library/view unit tests.

Native interface publication is documented in [YR sidebar UI state](sidebar-ui.md).
