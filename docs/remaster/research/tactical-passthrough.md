# YR 1.001 tactical draw pipeline and native overlay passthrough

Research notes behind `src/games/yr/tacticalPassthrough.ts` (the patch), `src/games/shared/guestGates.ts` (the
generic gate engine) and the HD bridge's key-colour compositing. Baseline: YR 1.001 `gamemd.exe`, SHA-256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`, as installed by the player.

Sources: class layouts, vtable addresses, a few function addresses and the Surface/ObjectClass virtual order come from
the community YRpp headers (Phobos-developers/YRpp: `TacticalClass.h`, `Surface.h`, `ObjectClass.h`,
`TechnoClass.h`, `AnimClass.h`, `EBolt.h`, `LineTrail.h`, `RadBeam.h`, `IonBlastClass.h`, `SpotlightClass.h`,
`MessageListClass.h`, `CCToolTip.h`). Everything else is from disassembling the player's executable (`objdump`) and
from live experiments in the VM (switching one gate at a time and capturing the primary surface). No code from YRpp,
Ares or Phobos is used, and nothing from Chrono Divide.

## Frame structure

`GScreenClass::Render` (0x4F4480) runs once per frame on the map singleton (0x87F7E8):

1. reads and clears the redraw request at `this+0xC` (0x4F44A5); non-zero means a full tactical redraw;
2. `TacticalClass::Render(DSurface::Composite, fullRedraw, mode)` (0x6D3D10) three times: mode 0 (scroll the cached
   surfaces, clear Z/alpha buffers on a full redraw), mode 1 (terrain), then `this->vt[0x40]` (sidebar, radar, tabs),
   then mode 2 (objects);
3. `MessageListClass::Draw` (0x5D49A0 on 0xA8BC60, on-screen/chat/EVA text) and `CCToolTip` (vt+0xC on
   `*0x887368`), both into the composite surface;
4. mouse show and `vt[0x44]` (blit to the primary surface).

Surfaces are 16-bit (RGB565). `DSurface::ViewBounds` (0x886FA0) is the tactical rectangle, (0, 0, 984, 712) at
1152x744, i.e. the frame minus the 168 px sidebar and 32 px command bar. `DSurface::Tile` (0x8872FC) caches terrain;
`DSurface::Composite` (0x88731C) is the frame being built; `DSurface::Temp` (0x887314) is the current draw target.
The DSurface vtable is 0x7E85D4 (CopyFromPart +0x8 = 0x4BB080, FillRectEx +0x10 = 0x4BB620, FillRect +0x14 =
0x4BB5F0, DrawRectEx +0x54, Lock +0x5C, Unlock +0x60).

### Mode 1: terrain

Runs only when something is dirty, but in practice every frame (units, animated tiles and scrolling keep dirty areas
queued; the gate counters show one call per frame). Inside a Lock of `DSurface::Tile`:

| Call site | Callee    | ret   | Draws                                                                   |
| --------- | --------- | ----- | ----------------------------------------------------------------------- |
| 0x6D4471  | 0x6D2B60  | 0x10  | dirty-rectangle clipping, Z-buffer clear, tiles of newly visible cells  |
| 0x6D448B  | 0x6D3660  | 0x10  | tiles (per-rectangle worker 0x6D71E0)                                   |
| 0x6D449D  | 0x6D2DE0  | 0xC   | cell pass (worker 0x6D7560)                                             |
| 0x6D44AF  | 0x6D3470  | 0xC   | cell overlays (0x4D1890 → CC_Draw_Shape)                                |
| 0x6D44C1  | 0x6D3290  | 0xC   | cell pass (worker 0x6D6D10)                                             |
| 0x6D44D3  | 0x6D3AC0  | 0xC   | non-moving objects into the cache (0x6D97D0 → vt+0x104 DrawIfVisible)   |
| 0x6D44E5  | 0x6D3040  | 0xC   | cell pass (worker 0x6D7C00)                                             |
| 0x6D44F7  | 0x6D3870  | 0xC   | non-moving objects into the cache (0x6D9920 → vt+0x104 DrawIfVisible)   |

Then 0x6D45C7 copies Tile into the composite: `Composite->CopyFromPart(&ViewBounds, Tile, &ViewBounds, 0, 1)`.

Buildings and trees are therefore part of the terrain cache: they reappear only when their area is redrawn. Any
switch that changes what goes into the cache must be followed by a full redraw.

### Mode 2: objects and overlays

After registering buildings as selectable (0x6D9CE0) and locking the composite:

| Order | Call                                      | Category | Draws                                                                    |
| ----- | ----------------------------------------- | -------- | ------------------------------------------------------------------------ |
| 1     | 0x6DAD60(0), 0x6DA9D0(0), 0x6D5030(0)     | overlay  | waypoint markers and paths, building placement grid (pending building)   |
| 2     | 0x53D850 IonBlastClass::DrawAll           | effect   |                                                                          |
| 3     | 0x6D8DB0(1) layer render                  | world    | see below                                                                |
| 4     | 0x5FFFA0 SpotlightClass::DrawAll          | effect   |                                                                          |
| 5     | 0x550240, 0x4C2830, 0x556D40, 0x6591B0    | effect   | laser draws (vector at 0xABC878, not named in YRpp), EBolt, LineTrail, RadBeam (see below) |
| 6     | 0x6DBE20                                  | overlay  | walks the selected objects (0xA8ECB8) and the pending building; not gated |
| 7     | 0x430AC0 BeaconManagerClass::Draw         | overlay  | beacons                                                                  |
| 8     | 0x6DA180                                  | overlay  | drag-select band box (DrawRectEx)                                        |
| 9     | 0x6DAD60(1), 0x6DA9D0(1), 0x6D5030(1)     | overlay  | second pass of 1                                                         |
| 10    | planning mode 0x63B0A0/0x63B150/0x63B2F0  | overlay  | planning tokens                                                          |
| 11    | per techno: vt+0x438 DrawActionLines, mind-control links 0x472160 | overlay | target lines while the action-line timer (flag 0x843108, 0x70D150) runs, links |
| 12    | 0x6D7840                                  | terrain  | ore/gem glints written straight into the locked surface (0x6D7BB4); also keeps per-cell glint objects and calls CRT `rand()` (see Known limits) |
| 13    | unlock; 0x6D4B50 timers                   | overlay  | mission and super weapon timers                                          |

The effect lists of steps 2, 4 and 5 differ in what else they do:

| List (call site)            | Per item                    | Besides drawing                                                                                   |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| IonBlast 0x53D850 (0x6D4656) | 0x53D580                   | no game state: builds a pitch lookup table and writes pixels straight into the locked surface     |
| Spotlight 0x5FFFA0 (0x6D4664) | 0x5FF850                  | no game state: writes pixels straight into the locked surface; updates the detail flag 0xABCD50 through 0x55AF60 (0x5FF86E) |
| Laser 0x550240 (0x6D4669)   | 0x550260                    | no game state: colour jitter from the non-critical generator 0x886B88 (0x55049F..0x5504D1); updates the detail flag through 0x55AF60 (0x550BCA, in 0x5509F0) |
| EBolt 0x4C2830 (0x6D466E)   | draw 0x4C1F20 (ret 0x1C) at 0x4C2938 | the only code that ages bolts (`sar` Lifetime at 0x4C2940, 0x10000 at construction, so about 17 frames) and removes them from `EBolt::Array` (count 0x8A0E98), clears the owner's link (+0x6DC) and frees them (0x4C2951..0x4C29BA) |
| LineTrail 0x556D40 (0x6D4673) | draw 0x556C00 (plain `ret`) at 0x556DD2 | the only caller of `LineTrail::Update` 0x556B70 and the only runtime remover/deleter (count 0xABCB88; 0x556D7C..0x556DC6) |
| RadBeam 0x6591B0 (0x6D4678) | 0x659650 / 0x659CA0         | both return the "done" flag that decides deletion; the only remover/freer (count 0xB04A70; 0x659383..0x6593CD) |

The EBolt and RadBeam draws (random jitter from the non-critical generator 0x886B88) reach the frame only through
DSurface vtable +0x34 (DrawLineColor, a gated blitter); the LineTrail draw uses a direct call to 0x4BEAC0 instead.
`tests/real-game/yr/tacticalPassthrough.test.ts` checks these instructions in the pinned executable.

The layer render 0x6D8DB0 walks the five layers (0x8A0360): per object `DrawBehind` (vt+0x10C) and `DrawIfVisible`
(vt+0x104, which calls `DrawIt` vt+0x114); buildings also get `DrawExtras` (vt+0x110) there; then a second walk calls
`DrawExtras` for every techno drawn this frame, which draws health bars (vt+0x44C = 0x6F64A0), pips (0x450),
veterancy (0x454), brackets and group numbers on top of all objects. `DrawIt` also registers selectable objects
(`TacticalClass::AddSelectable` 0x6D9EF0, used by band selection), so it must still run.

Object draw virtuals (vtable slot contents; DrawIt is +0x114):

| Class          | vtable   | DrawIfVisible | DrawBehind | Category |
| -------------- | -------- | ------------- | ---------- | -------- |
| UnitClass      | 0x7F5C70 | 0x73B0B0      | 0x6F60D0   | objects  |
| InfantryClass  | 0x7EB058 | 0x5F4B10      | 0x6F60D0   | objects  |
| BuildingClass  | 0x7E3EBC | 0x43CEA0      | 0x6F60D0   | objects  |
| AircraftClass  | 0x7E22A4 | 0x5F4B10      | 0x6F60D0   | objects  |
| TerrainClass   | 0x7F522C | 0x71CC50      |            | objects  |
| VeinholeMonster| 0x7F66A8 | 0x5F4B10      |            | objects  |
| AnimClass      | 0x7E3354 | 0x422C70      |            | effects, or objects when `IsBuildingAnim` (+0x118) |
| ParticleClass  | 0x7EF954 | 0x5F4B10      |            | effects  |
| ParticleSystem | 0x7EFB9C | 0x5F4B10      |            | effects  |
| BulletClass    | 0x7E46E4 | 0x5F4B10      |            | effects  |
| VoxelAnimClass | 0x7F6318 | 0x749B20      |            | effects  |
| WaveClass      | 0x7F6BF4 | 0x5F4B10      |            | effects  |
| BuildingLight  | 0x7E3AD0 | 0x5F4B10      |            | effects  |

Low-level blitters used by world drawing: `CC_Draw_Shape` 0x4AED70 (SHP; `__fastcall`, ret 0x38; also pips, cursors
and placement grids), `TechnoClass::DrawVoxel` 0x706640 (ret 0x28, called by `FootClass::Draw_A_VXL` 0x4DAF10 and
building voxel turrets), `TechnoClass::DrawVoxelShadow` 0x706BD0 (ret 0x2C), and the DSurface primitives world code
calls directly: `ParticleClass::DrawIt` 0x62CEC0 draws spark particles with `SetPixel` (vt+0x24), effects draw lines.

## The patch

All sites are verified against their original bytes before anything is written (all-or-nothing); the full list with
bytes is `yrPassthroughOriginalBytes()`, checked against the real executable by
`tests/real-game/yr/tacticalPassthrough.test.ts`.

- **Terrain fill** (`terrain:fill`): 0x6D45C7..0x6D45DA (`6A 01 6A 00 8B 11 68 A0 6F 88 00 50 68 A0 6F 88 00 FF 52 08`)
  becomes `call stub; jmp 0x6D45DB`. The stub repeats the copy, or while the switch is on calls
  `Composite->FillRect(&ViewBounds, key)` (vt+0x14).
- **Terrain passes** (`terrain:pass1..8`): the eight `call rel32` sites above return at once while terrain passthrough
  is on (the frame never shows the cache then), and so does the ore-glint call at 0x6D492B (`terrain:ore-glints`),
  which writes pixels directly into the locked surface where no blitter gate sees them.
- **Objects/effects**: vtable slots +0x104 (and +0x10C for technos) point to *suppress* stubs: the original runs with
  a suppression depth raised; the return address is kept on a private return stack so arguments and calling
  convention do not matter.
- **Blitters**: entries of 0x4AED70 (`81 EC 94 00 00 00`), 0x706640 (`83 EC 40 53 55`) and 0x706BD0
  (`83 EC 3C 53 55`) jump to *blit* stubs that return at once only while the depth is non-zero, then run the
  relocated prologue. The same *blit* stubs sit in 22 slots of the DSurface vtable 0x7E85D4 (copies, fills, ellipse,
  pixel, line, rectangle and gradient primitives; argument bytes from each implementation's `ret`), returning success
  (eax = 1). Everything drawn outside a suppressed call (placement grid, pips, health bars, band box, cursor) is
  unaffected.
- **Effect lists** (effects category): only lists that keep no game state are skipped (the side effects they do have
  are listed under Known limits). The `call rel32` sites of
  IonBlast (0x6D4656, `E8 F5 91 E6 FF`), Spotlight (0x6D4664, `E8 37 B9 F2 FF`) and lasers (0x6D4669,
  `E8 D2 BB E7 FF`) return at once. EBolt (0x6D466E, `E8 BD E1 DE FF`) and RadBeam (0x6D4678, `E8 33 4B F8 FF`) run
  their whole lists under a *suppress* stub on the call site, so bolts and beams still age, leave their arrays and are
  freed while only their line pixels disappear. For LineTrail the list runs unchanged and only the per-trail draw call
  at 0x556DD2 (`E8 29 FE FF FF`, `call 0x556C00`) returns at once, because its direct call to 0x4BEAC0 is not gated.
- **Redraw request** (`redraw:request`): 0x4F44A5 (`8B 46 0C C7 46 0C 00 00 00 00`) becomes `call stub` + NOPs. When
  the host changed the categories, the stub copies the pending switch bitmap into the live one, then calls the game's
  own `GScreenClass::MarkNeedsRedraw(1)` (0x4F42F0, ret 4), then performs the original read and clear.

Switch changes are latched there, at the start of `GScreenClass::Render`, because the host can run between any two
guest instructions: a Worker message is handled whenever the VM yields to the host, for example during the DirectDraw
Unlock at 0x6D455E just before the terrain copy. Written directly, turning terrain off after the passes were skipped
would copy the unmaintained Tile into that frame. Latched, every gate of a frame sees one set of switches, and a change
takes effect exactly in a frame that also repaints everything.

Every gate acts only on the game's main thread (VM thread id 0, read from the VM's current-thread word): the
suppression depth and return stack are shared by all guest threads, and the VM preempts threads at any instruction.
YR's WWMouse thread (CreateThread proc 0x7B8610 → 0x7BA090, started at 0x7B84F0) restores and saves the software
cursor background through `DSurface::Primary->CopyFromPart` (vtable +0x08, e.g. 0x7B90AB) while the mouse moves in
battle; without the thread check, a switch landing while the main thread was inside a suppressed draw dropped those
copies and left one-frame cursor ghosts.

Stubs and a 4 KiB data page live in RAM the host reserves at the top of guest memory (above the heap arena and the
fast-file mirror), on separate pages: v86 treats guest writes to a page with compiled code as self-modifying code.
Data page: magic `GATE`, suppression depth, return-stack pointer, 256 live and 256 pending switch bits, user words
(requested category flags, key colour, fill count, redraw request/count, latched category flags) and one hit counter
per gate. The code page is 8 KiB (the stubs take a little over 4 KiB). The static-stub tail below 0xA0000 is not
used: it is almost full, and 0xA0000..0xBFFFF is v86's VGA window, where host-written bytes are not what the guest
reads.

Categories (bit flags written by `RenderPassthroughControl.set`): terrain 1, objects 2, effects 4. The blitter gates
are enabled whenever any category is on; anims with `IsBuildingAnim` follow objects.

## Key colour and compositing

The tactical rectangle starts every frame as RGB565 0xF81F (magenta). In-game frames reach the page as packed RGB565
(`VmFrame.rgb565`; RGBA only when USER32 controls are composited), and `vmFrameRenderer.setTransparentKey` compares
the packed value exactly (RGBA/indexed paths compare its bit-replicated RGB888 expansion), only inside the rectangle.
No native frame of the tested scenes contained 0xF81F before the patch.

## Measurements

`scripts/remaster/bridge/verifyPassthrough.mts`, worker mode, GPU Chromium, 1152x744, speed 0, the same scene measured
in interleaved 6 s windows (5 rounds unless noted), host otherwise shared with other development sessions:

| Run (build)                      | Off: logic FPS / guest instr per frame | Terrain+objects | All categories  |
| -------------------------------- | -------------------------------------- | --------------- | --------------- |
| before effects default and gates | 145.6 / 3.33 M                         | 179.0 / 1.82 M  | 175.8 / 1.79 M  |
| effects default, surface gates   | 117.3 / 3.33 M                         | 140.7 / 2.02 M  | 151.6 / 1.79 M  |
| ore glints gated                 | 108.1 / 3.38 M                         | 133.4 / 1.88 M  | 138.0 / 1.81 M  |
| effect lists kept, latch, thread | 92.8 / 3.82 M                          | 122.9 / 1.70 M  | 126.5 / 1.72 M  |

The last row is the current build (EBolt/RadBeam lists suppressed instead of skipped, LineTrail per-trail draw
skipped, switches latched per frame, main-thread check in every stub), measured with the default 4 rounds and a
Soviet player whose scene includes a barracks and Tesla troopers, so its "off" column is not comparable with the rows
above. Guest instructions per logic frame drop by 40–56 %; logic FPS rises by 20–36 %, less than the instruction
count because host-side work per frame (DirectDraw emulation, frame transfer, audio) is unchanged. Absolute FPS
differs between runs with host load; only the columns of one run are comparable.

The same run passed every check of the script (15/15), including the effect-list check: three Tesla troopers
force-firing with every category on created and removed bolts 13 times in 12.7 s (never more than one alive, none
alive longer than 0.1 s), frames taken while a bolt was alive had no non-key pixel in the tactical view (about 210
bolt pixels with effects native), and the EBolt, LineTrail and RadBeam counts were 0 afterwards. No LineTrail or
RadBeam weapon fired in that scene, so for those two lists the run shows only that nothing was left behind.

## Known limits

RadBeam and WaveClass pixel suppression now has an HD replacement: `src/games/yr/beamsReader.ts` reads their native
arrays, endpoints and draw-cycle state; the optional `radBeams`/`waves` fields pass through the game render snapshot
and HD bridge to `packages/hd-renderer/src/live/beams.ts`. It draws additive world-space ribbons and magnetic/sonic
ripples, retaining native list membership and removal, including publications within the same logic frame. No gate or
guest update behavior changes. Faithful/enhanced styles share geometry; enhanced brightens the halo. RadBeam now uses
its native RGB; type 1 uses the native single world-Z sine, including chrono weapons. Halo/core widths and magnetic/sonic
ripples remain HD interpretations, not a pixel-identical port. CaptureManager links are also projected separately;
their endpoint, color, selection and timer evidence is in [HD bridge fields](hd-bridge-fields.md#chrono-weapon-ribbon-and-mind-control-links).

Verified YR 1.001 layout evidence (instruction addresses in the player's disassembly; also recorded in the reader):

| Fact | Layout | Confirming instructions |
| --- | --- | --- |
| RadBeam pointer vector | base `0xB04A60`, items `+4`, capacity `+8`, count `+0x10` | `0x659134`, `0x659139`, `0x65917A`, `0x659180`, `0x659186`, `0x6591B9` |
| RadBeam shape | type `+0x10`; RGB `+0x20`; source/target `+0x24`/`+0x30`; period `+0x3C`; double amplitude `+0x40` | `0x65940F`, `0x659474..0x659480`, `0x6594A4..0x6594D4`, `0x6594E4`, `0x6594F8..0x6594FB` |
| RadBeam draw cycle | age `+0x7C`, sustained `+0x58`, drawing `+9` | `0x6599A8..0x6599B3`, `0x65996F..0x659998`, `0x65978C`, `0x659CB7` |
| WaveClass vector/vtable | base `0xA8EC38`, items `+4`, capacity `+8`, count `+0x10`; vtable `0x7F6BF4` | `0x75EAA9`, `0x75EAAE`, `0x75EAF3..0x75EAF9`, `0x75EA3F` |
| Wave type/world endpoints | type `+0xB0`; source `+0xC0`, target `+0xB4`; `+0xCC` is screen-space | `0x75E97B`, `0x761B1E..0x761B83`, `0x7625B2..0x762617` |
| Wave cache ownership | ctor initializes endpoints; sonic/magnetic AI refreshes them through direct calls, independently of the suppressed DrawIfVisible slot | `0x75EB1A`, `0x75EB29`, `0x760F6E`, `0x760FA0`, `0x762CBF`, `0x762D0E`, `0x762D52` |
| Wave life | sonic/magnetron intensity `+0x130`, 100 to -1; laser/biglaser intensity `+0x1D0`, 160 to below 32 | `0x75E98E`, `0x760F73..0x760F86`, `0x760FD7..0x760FEB`, `0x75EB87`, `0x760FF6..0x761010` |

RadBeam period is a draw-cycle duration, not a spatial wavelength. Sustained beams oscillate their age and remain
until the native engine removes them. Magnetron can reset its intensity to 64 (`0x762B51`), so wave progress is a
current intensity/cycle value, not monotonic total age. RadBeam enum value 0 is named Temporal by YRpp but is not
drawn by DrawAll and is filtered out. The CLEG firing path is independently confirmed as type **1**, with
`ChronoBeamColor` selected through the temporal warhead branch (`0x6FF594..0x6FF5B7`, `0x6FD620`);
it was already read but incorrectly drawn green by the old fixed type palette. Frozen live comparison remains separate.

The deterministic sandbox `fx.html?fx=beams` shows rad, chrono, eruption, magnetron, sonic and a mind-control link
around `cx`/`cy`, frozen at progress 0.5. `bprogress=0..1` selects a different lifetime sample;
`btypes=chrono,mindcontrol` isolates the new review rows; `effects=enhanced` selects brighter halos.

- Translucent native drawing over the key blends with it: with effects left native, smoke and translucent explosion
  edges appear magenta-tinted over the HD world. Switching effects to passthrough removes them; exact un-blending
  would need the tactical view rendered twice with two keys (difference matting).
- Map-placed tile animations are AnimClass objects and follow the effects category.
- Object and layer draws, and the EBolt and RadBeam lists, still run with only their pixel output removed (selection
  registration, visibility flags, effect ageing and removal). Skipped outright are the terrain passes (they maintain
  the Tile cache, which the frame never shows while terrain is on; switching off repaints it), the ore glints, the
  IonBlast, Spotlight and laser lists and the per-trail LineTrail draw. None of these keeps simulation state, but not
  all of them only draw, so with passthrough on the process differs from a native run in these ways (each of them
  also varies natively with what is on screen or with the frame rate):
  - The non-critical random generator 0x886B88 is called less often: the laser draw uses it for colour jitter.
    Native drawing that keeps running uses it as well (e.g. 0x705860, called from TacticalClass::Render at 0x6D48F1,
    reads it at 0x705900), so how often it is called already follows what is on screen.
  - The ore-glint pass 0x6D7840 keeps state of its own. For ore cells in view it allocates a 0x3C-byte glint object
    (operator new 0x7C8E17 at 0x6D7AAF) and keeps it at CellClass+0xFC (0x6D7AC5), and it (re)starts glints through
    0x631E30/0x631D40, which call the CRT `rand()` at 0x7CB4AA (the per-thread 0x343FD/0x269EC3 generator) at
    0x631D53, 0x631D8F, 0x631DEB and 0x631DFA. It also stores `timeGetTime` in 0xB0E640, which only it reads. With
    terrain passthrough on, the main thread's CRT `rand()` sequence and its heap allocations therefore differ from
    native. The other `rand()` callers found (0x5592B0, 0x559608, 0x621DA0/0x621DFA, 0x632692, 0x7A458D) look like
    UI, string or buffer code, and 0x5B8AF3 and 0x5DEC55 seed the generator with `srand()` first; no simulation
    consumer of this stream was found, but that is a survey of call sites, not a proof.
  - The glint pass (0x6D7847), the spotlight draw 0x5FF850 (0x5FF86E) and the laser draw (0x550BCA) update the detail
    hysteresis flag 0xABCD50 through 0x55AF60, which compares the measured frame rate 0xABCD44 (frames per timing
    period) with two thresholds. Animation and particle drawing, which keep running, call it too (0x422FCC,
    0x48A634, 0x62CEC9), and for an unchanged 0xABCD44 a second call leaves the flag as it is, so skipping those
    three callers can change the flag only when no remaining caller runs between two measurements. The measured frame
    rate itself differs between machines, and passthrough changes it.

  With passthrough on, force-fire, MCV deploy, building placement and band selection behave normally; quick defeats
  on XMP29U2 were reproduced without the patch (the AI rushes the idle player). The patches are still installed only
  for the development HD bridge, and multiplayer determinism with passthrough on has not been tested.
- Before the effect-list correction the EBolt, LineTrail and RadBeam lists were skipped whole: their objects never
  aged or left their arrays while effects passthrough was on (a leak per shot, bolts reported as live forever), and
  the backlog was drawn at once when passthrough switched off. `verifyPassthrough.mts` now checks that the three
  counts fall back to 0 with effects passthrough on.
