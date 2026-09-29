# HD bridge fields H1-H3 (proposal for the page bridge and the YR readers)

The HD live view (`packages/hd-renderer/src/live`) accepts optional snapshot fields and uses each one whenever it is
present; without them it falls back to the estimates listed in `docs/remaster/HD_BRIDGE.md` ("Bridge fields"). The
types to fill are `LiveSnapshot`, `LiveHouse`, `LiveObject`, `LiveCells` (`live/liveView.ts`) and `LiveAnim`,
`LiveBullet`, `LiveParticleSystem`, `LiveVoxelAnim`, `LiveFireEvent`, `LiveBeam`, `LiveEffects` (`live/effects.ts`).
Nothing here is applied to `src/` yet.

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

## H2: new state reader fields

Field names from the community YRpp headers; their offsets must be taken from YRpp and confirmed against the pinned
gamemd.exe 1.001 like every other reader field (none of them is read today, so no offset is asserted here).

- BuildingClass `BState` / `QueueBState` (BStateType: construction, idle, active, full, aux1, aux2) and the progress
  of its make anim (the building's own StageClass of the Buildup SHP) -> `LiveObject.buildState` ('building' while
  the make anim plays, 'selling' when it plays backwards, else 'done') and `buildupFrame`.
- InfantryClass `SequenceAnim` (DoType: Ready, Guard, Walk, FireUp, Prone, Crawl, Die1..5, ...) and the frame of its
  sequence -> `LiveObject.infantrySequence` (the artmd sequence key, e.g. "Prone", "Die1") and `sequenceFrame`. Live
  captures show infantry lying prone under fire in the original while the view, without this, draws them standing.
- SHP vehicles (terror drone, squid, dolphin): UnitClass `WalkedFramesSoFar` (walk step counter) and the facing the
  engine draws the body with. The view takes `facingRaw` (the primary facing) and steps walk frames on logic frame /
  `WalkRate`; only a few live terror drones have been checked against the original.

## H3: runtime cells (new reader)

`snapshot.cells = { full, cells: [x, y, overlay, overlayData, smudge, smudgeData][], overlayTypes?, smudgeTypes? }`:
read the MapClass cells (CellClass OverlayTypeIndex, OverlayData, SmudgeTypeIndex, SmudgeData), keep the previous
poll's copy in the reader and report only changed cells (`full: true` on the first poll); `overlayTypes` and
`smudgeTypes` are the rules ids by index (OverlayTypeClass / SmudgeTypeClass arrays), sent once.

H3 unlocks ore growth and harvesting, walls built and destroyed, and the engine's own craters and burn marks. Until
then the view draws the map's initial overlays and smudges and no HD scorch marks (HD scorch invented craters the
original does not have). Live captures show why H3 blocks a release of the HD view: harvested ore fields stay full
and walls built around a base are missing entirely. Without it the view warns once in the console and reports
`cellsFromEngine: false` in `LiveView.diagnostics()`.
