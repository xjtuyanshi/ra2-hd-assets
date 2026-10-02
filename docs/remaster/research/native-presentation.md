# Native presentation rules and HD publication boundaries

Baseline: YR 1.001 `gamemd.exe`, SHA-256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`, checked directly against the
player-supplied executable. All addresses below are image virtual addresses. HD baseline: `14b91f8`.
The private verify2/run1 captures and the installed urban library were read in place; neither images, JSON
captures nor original/derived art are fixtures in this repository.

## Infantry death and publication freshness

`InfantryClass::PlayAnim` stores SequenceAnim at `0x51D9D2` (`+0x6C4`) and clears Animation.Value at
`0x51DA8C` (`+0xF8`). The image chooser reads Value at `0x518E18`, applies remainder by the sequence count
at `0x518E1F`, and adds the sequence's start and facing stride at `0x518F70..0x518F82`. The enum name table
at `0x8255C8` identifies sequence 11 as Die1; these are sequence-local stages, not elapsed host time.
AI compares Value with CountFrames at `0x520B09`. The enclosing logic pass only stores CurrentFrame at
`0x55DE81`; an emulator slice can finish between an object update and that store.

The installed E2/CONS library contains Die1 at start 134, count 15, facing multiplier 0, in the same body
sprite as Ready/Walk. It has 301 body frames. There is no missing sequence key or separate death sheet here.
Health zero does not remove an infantry from the state reader: its native vector membership and InLimbo
govern removal. Stage 0 can still look upright; stage 2 must select frame 136, regardless of render-clock age.

Two independent caches could retain stale data: the reader's key omitted animation state, and LiveView
discarded same-frame publications unless painter registration changed (then copied only registration).
The key now samples bounded techno render fields and effect instances. LiveView replaces the full current
publication on a same-frame update, invalidates object/effect batches, and preserves the interpolation
timestamp and previous endpoint. The page keeps its existing 15 ms active / 1000 ms idle polling and single
in-flight request. Named sequence steps never advance from renderer time; movement interpolation remains.

Evidence boundary: exported pair 19's HD and native state both say frame 60676, Die1/0. Pair 20's HD still
says 60676/Die1/0 while its native JSON says 60677/Die1/2. Pairs 21/22 also have native JSON one logic frame
later; pair 09 differs by 12. The pictures show the reported mismatch, but those exports do not establish
an atomic framebuffer/state sample. The cache defects are confirmed by code, disassembly and synthetic
same-frame regressions; fresh frozen-match parity remains UNVERIFIED.

## Shroud edges are pixel masks, not techno anchor rejection

TacticalClass::Render (`0x6D8DB0`) walks the registered object layers at `0x6D8F19..0x6D8F43` and invokes
Render (`vtable +0x104`, e.g. `0x6D916C`). Its conditional location test at `0x6D8FDA` is IsLocationFogged
(`0x5865E0`), not IsLocationShrouded (`0x586360`). In this vanilla image IsLocationFogged returns false.
Building Render (`0x43CEA0`, vtable `0x7E3EBC+0x104`) checks redraw/alive/limbo flags and clips the drawing
rectangle; `0x43D005` dispatches DrawIt. Object Render (`0x5F4B10`, infantry/aircraft) checks redraw/limbo
and screen projection. Unit Render (`0x73B0B0`, vtable `0x7F5C70+0x104`) calls that path at `0x73B132`.
These paths do not make a whole-techno shroud decision from its anchor or from all foundation cells.

The cell draw at `0x4801F0` writes SHROUD.SHP into the alpha buffer. The tactical cell loops at
`0x6D3660` / `0x6D72F2` project with Z forced to zero. Terrain and object blitters consume that per-pixel
lighting: a roof, crane or fence can cross the edge even when its anchor is unmapped. The HD object path
therefore leaves the art for the existing common shroud post pass. InvisibleInGame objects remain excluded.
The point query `ShroudLayer.isLocationShrouded` still serves effect/light policies, not techno eligibility.
This fixes the erroneous whole-object rejection in pairs 06/09/27; it does not replace the fitted smooth
mask with the engine's irregular SHROUD.SHP edge pieces or implement additional fog/cloak policies.

## Completed-building body frames

DrawIt calls GetCurrentFrame at `0x43D26D`. The chooser (`0x43EF90`) starts with Animation.Value and
handles special walls/construction before the completed-body branches below:

| Rule                                                                                                      | Address evidence                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Health ratio is integer Health / integer Strength, without integer division or rounding a threshold to HP | `0x5F5C63..0x5F5C78`: load Health `+0x6C`, obtain type, divide by Strength `+0xA0`                                                               |
| Loaded global ConditionYellow / ConditionRed                                                              | Rules instance `0x8871E0`, doubles `+0x1700` / `+0x1708`; INI stores `0x66B37F` / `0x66B358`, section pointer `0x7F0C7C` resolves to AudioVisual |
| CanBeOccupied switches to the civilian/occupancy rule                                                     | `0x43F02C..0x43F034`; type `+0x157B`, INI store `0x4600DF`, key `0x81ADBC`                                                                       |
| Occupants add 2 to the base frame                                                                         | `0x43F040..0x43F04A`; virtual `+0x408` resolves to `0x4581F0`, which reads count `+0x694`                                                        |
| Damage adds 1 at/below red, or at/below yellow when TechLevel > 0                                         | `0x43F051..0x43F096`; type TechLevel `+0x634`, INI store `0x714584`, key `0x824E40`                                                              |
| TechLevel -1 remaps occupied damaged frame 3 to 1                                                         | `0x43F097..0x43F0B3`                                                                                                                             |
| Gates use 0 above yellow, GateStages + 1 at/below yellow                                                  | `0x43F0BD..0x43F0F5`                                                                                                                             |
| Ordinary idle bodies add 1 at/below yellow                                                                | `0x43F0F6..0x43F11C`                                                                                                                             |
| Other completed modes add the maximum end of modes 1, 2, 4 and 5 when damaged                             | `0x43F11D..0x43F16D`, type records `+0xF04`, stride 12                                                                                           |

There is no per-type ConditionYellow/Red override or General-section lookup in this chooser. CanBeOccupied
and TechLevel are the relevant type policies. Reading the loaded Rules doubles preserves map/session INI
overrides instead of trusting the extracted library's default thresholds. CAMIAM01 at 0.496 and CASTL02
at 0.475 are above the stock red condition 0.25, so their civilian bodies remain intact. Ordinary buildings
still switch at/below 0.5. Bibs and damage-animation variants continue to use the separate yellow condition
(e.g. BeginMode at `0x4477E8`); body damage must not suppress engine-owned fire/damage anims.

`buildingRenderState.ts` publishes optional `buildingFrame` and `buildingDamaged`. They flow through
GameRenderObject and the page to body/shadow/window selection and layer/bib damage selection. Invalid
rules/type/count reads retain the existing fallback. LaserFence/FirestormWall special body overrides are
outside this reader's supported body branch. No asset schema change or library regeneration is required.

## Native effect lifetime

EBolt::Draw (`0x4C2790`) tests Lifetime `+0x28` at `0x4C2797..0x4C279C`, skips drawing at zero, and halves
it at `0x4C2821..0x4C2823`. This is a draw-pass lifetime, not simply CurrentFrame. The raw reader can
legitimately report a zero-lifetime object before removal; the render projection now omits it. The reader
cache samples instance state and list membership; LiveEffectsDriver accepts beam removal/replacement in
the same logic frame. Stable repeated publications do not regenerate beams.

AnimClass::DrawIt (`0x422CA0`) uses stage `+0xAC` and Type.Start `+0x2B4` at `0x423045..0x423055`.
The projection previously dropped native frame/stage/alpha, causing an already-progressed impact anim to
restart visually at its first observed host snapshot. These fields now reach the renderer, along with
layer/owner/attachment and buildingAnim. Invisible/art-less anims remain filtered. Projectiles also retain
type/frame/velocity; an unavailable effects publication clears previous native cards, beams and voxel
projectiles instead of keeping an old list.

Pair 26's HD list still contains TSTIMPCT and a bolt, and its native JSON is one logic frame later. This
does not independently prove an extra orphan object inside Projectiles (its per-publication sweep already
removes missing meshes). The verified defects are stale publication acceptance, zero-life bolts and lost
anim stage. General procedural garnish still has its bounded host-time lifetime; this change does not claim
that every HD light/particle is pixel-identical to native effects.

## Cell-reader initialization and verification

The cell readers publish at 250 ms intervals and can return null during initialization. Overlay index/data
come from Cell `+0x44` / `+0x11E`; smudge index/data from `+0x48` / `+0x11F` (native placement stores at
`0x6B60EA` / `0x6B60F5`). The warning is a host diagnostic, not an engine rule: it now waits five seconds
without any cell publication. An empty but valid grid counts as publication and prevents this warning for
the match. A frame rewind resets the grace period.

Asset-free regressions cover reader offsets/validation, zero-health death steps, same-frame cache invalidation,
body condition/occupancy/gate/active frames, bridge forwarding, renderer publication acceptance, shrouded-anchor
art versus InvisibleInGame, expired/replaced beams, effect clearing and delayed/absent cell publication.
They use synthetic memory and cards only. Real-match frozen-frame comparison, WebGPU pixel clipping,
host/VM frame synchronization and full-match polling cost remain UNVERIFIED in this worktree.
