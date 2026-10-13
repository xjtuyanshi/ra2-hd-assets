# YR 1.001 read-only sidebar UI state

The development HD bridge combines `src/games/yr/sidebarReader.ts` through
`src/games/yr/renderState.ts`. It accepts only `YR_STARTUP_PAGE_HASH` (the supplied
YR 1.001 executable). All addresses below are guest virtual addresses. There are
no guest calls, memory writes, resource downloads or production imports. The
page's HD UI covers the native pixels; the engine continues drawing and receiving
input. See [HD bridge fields](hd-bridge-fields.md) for the game-neutral publication.

## Drawing and covering

`GScreen::Render` calls inherited Tab Draw at `0x4F4502`. Tab Draw `0x6D0A20`
draws credits and the bottom command bar; Sidebar Draw `0x6A6C30` temporarily
selects Sidebar (`*0x887300`) for background, gadgets and the active strip.
Power Draw `0x63FB20` and Radar Draw `0x653100` use that surface. Tooltip Draw
at `0x6A708D` precedes `BlitSidebar` (`0x6A70E0`), which draws the sidebar mouse
and copies directly to Primary (`0x6A71C7`, `0x6A722C`, `0x6A739D`). The final
Composite presentation does not merge the sidebar. Gadget Draw may also select
Sidebar (`0x69DF12`). Dirty surfaces can persist between draws.

A Composite key fill cannot remove these pixels; a late Primary fill can erase
tooltips and cursor save-under. The page therefore covers the existing native
interface rather than changing native surface composition. This reader does not
implement keying, cursor suppression or input interception. It publishes the final
software cursor and native tooltip for the development page layer to restore only
pixels erased by its transparent rectangles.

## Sidebar archive and tab-art policy

YR 1.001 `gamemd` loads sidebar archives at `0x534FA0` with ECX equal to the side index.
The `cmp esi,2 / jne / mov esi,1` sequence maps Yuri (side 2) to Soviet (side 1),
then `lea esi,[ebx+1]` supplies the archive number. `SIDEC%02dMD.MIX` is stored at
`0x827E0C` and pushed at `0x5350DB`; `SIDEC%02d.MIX` is stored at `0x827DE4` and
pushed at `0x53517E`. The resulting policy is Allied 0 → 01, Soviet 1 → 02, Yuri 2 → 02.
It belongs in `packages/ra2-assets/src/games/yrUi.ts`, independently of generic rasterization.

For each requested tab SHP and `SIDEBAR.PAL`, extraction reads the MD archive first,
then the base archive, within that side's archive set. A missing MD member can fall
back; a present malformed member is an error. Explicit nested archive lookup does
not mount new files into the shared install namespace or alter its precedence.

In the supplied installation, `sidec01.mix` and `sidec02.mix` inside `ra2.mix` contain
`tab00.shp` through `tab03.shp` and `sidebar.pal`. Allied canvases are 28×27, Soviet
32×28; each has five frames. `sidec02md.mix` exists but contains no tab art. Frame 0
is normal, 1 active/selected/lit, 2 disabled/blank, 3 pressed, and 4 matches normal.
Every frame is exported side by side with original SHP crop offsets and index-zero
transparency. The C5 local extraction compared all four Allied strips against the
supervisor's s1 references and all four Soviet/Yuri strips against s2: every RGBA
pixel matched. This verifies asset extraction separately from live-match rendering.

## Layout recipe

`S = 0x87F7E8`, `SC = *0xA8B230`, `H = *0xA83D4C`.
`Strip[i] = S + 0x1544 + i * 0xF94`; its inline records start at `+0x58`,
capacity 75, stride `0x34`. All published rectangles are half-open frame pixels.

The normal layout's frame width is `ViewBounds.x + ViewBounds.width + sidebarWidth`;
height is `SidebarBounds.y + SidebarBounds.height`. SidebarBounds describes the
lower layout, so the whole column uses its x with y=0 and the full derived height.
The command bar is the optional rectangle pointed to by `*0xB0FC58`. Gadget
rectangles are read live, including art-sized widths/heights. Missing or
unconstructed optional gadgets produce null, not invented positions.

The strip covers `(Location.x, Location.y, pitchX + 60, stripHeight)`;
`cameoOrigin = Location + (0,1)`. `cameoPitch` comes from `0xB0B4FC/0xB0B500`.
Draw visits rows first, then columns. Ordinal is `2*(TopRowIndex+row)+column`.
Scrolling adds one row and shifts y by `Slid-pitchY`; only images intersecting the
strip are published. Hover uses the **visible slot**, not the list ordinal.
Native pictures are 60x48 (`0x6A82C9..0x6A8304`). The power slot count is
`trunc((stripHeight+3)/3)`, pitch 3, first y=`SidebarBounds.y+0x45`, with x+5
for side0. Its live SHP header width takes precedence over the base art fallback.

## Field evidence

**V** means verified against instructions in the supplied executable/disassembly;
**D** means derived from those operands; **A** means supplied installation art-header
measurement; **P** means a deliberately partial reconstruction. These are static
evidence, not a live memory capture. Community YRpp headers supplied leads only.

| Published field or input | Address / offset | Evidence | Confidence |
| --- | --- | --- | --- |
| Battle roots, frame | SC `0xA8B230`, H `0xA83D4C`, frame `0xA8ED84` | `0x6A95EE`, `0x6A95A3`, `0x6A9B5E` | V |
| Side family | SC `+0x34B8`, 0/1/2; invalid becomes -1 | `0x6A5095`, `0x63FB5D` | V |
| Frame, whole column | View `0x886FA0`, lower sidebar `0x886F90`, width `0x7F5BF8` | `0x6A514A..0x6A51C6`, `0x6A742E` | D |
| Command bar | Rectangle pointer `0xB0FC58` | `0x72FEB8..0x72FED4`, `0x6D0C09` | V |
| Radar aperture | S `+0x11F0/+0x11F4/+0x11F8/+0x11FC`, x relative to sidebar | `0x652CF0`, `0x652F13`, `0x654725` | V/D |
| Credits band / anchor | sidebar x, width; y0,height16; centered x,y2 | `0x6D0B6D..0x6D0BAC`, `0x4A2370..0x4A25D5` | D |
| Active tab, counts | S `+0x539C`; each strip `+0x54` | `0x6A6FC5..0x6A6FDF`, `0x6A95BE` | V |
| Strip location/bounds | strip `+0x20/+0x24`, height `0xB0B504` | `0x6A5502..0x6A5529` | V/D |
| Cameo pitch/origin/size | `0xB0B4FC/0xB0B500`, Location y+1, 60x48 | `0x6A96A7..0x6A96C2`, `0x6A82C9..0x6A8304` | V |
| Visible ordinal / scroll | strip `+0x44` TopRowIndex, `+0x3F` scrolling, `+0x4C` Slid | `0x6A963C..0x6A970E` | V |
| Tab rectangles | inline gadgets `0xB07C48+i*0x60`, rect `+0x0C` | `0x6A541C..0x6A5484`, `0x69DF33..0x69DF68` | V |
| Tab flashing | gadget `+0x38` FlashDelay !=0 (active, not blink phase `+0x34`) | `0x69DFC0..0x69DFDB`, `0x69E050..0x69E05A`; phase `0x69E060` | V |
| Optional buttons | repair `0xB0B3A0`, sell `0xB07DF8`, down `0xB0B328`, up `0xB0B408`, options `0xB04978`, diplomacy `0xB04910` | `0x6A5382`, `0x6A53C5`, `0x6ABEB8`, `0x6ABEED`, `0x653038`, `0x6530A3` | V |
| Gadget construction/rect | vtable `+0`, X/Y/W/H `+0x0C/+0x10/+0x14/+0x18` | `0x69DE32..0x69DE3D`, `0x69DF33..0x69DF68`; vtable is a host sanity guard | V |
| Record type/index/category | entry `+0/+4/+8` (category is DWORD, defense=5) | `0x6A879B..0x6A87AA`, `0x6ABCA5` | V |
| Type arrays | building `0xA83C68`, infantry `0xA8E348`, unit `0xA83CE0`, aircraft `0xA8B218`; Items+4, Count+0x10 | resolver `0x48DCD0..0x48DD4B`: byte table `0x48DD24[type-1]` selects jump `0x48DD10`; Unit/UnitType -> `0x48DCE7` (`[0xA83CE4]`), Infantry/InfantryType -> `0x48DCFA` (`[0xA8E34C]`); live YR 1.001 match: `0xA8E348` items start E1, E2, SHK and `0xA83CE0` AMCV, HARV, APOC (an earlier draft of this row had the two swapped, which put vehicle cameos on the infantry tab); super Items `0xA8E334`, Count `0xA8E340` at `0x6A9939..0x6A9948` | V |
| Type ID / localized name | type `+0x24` bounded ASCII[24]; UIName pointer `+0x60` for both techno and SW | existing state reader ID; `0x6A9779`, `0x6A9941` | V |
| Techno picture filename | type `+0x6D6`, ASCII[25]; AltCameoFile `+0x6F5` | `Cameo` string `0x843350`, load `0x71599F..0x715A05`; alternate `0x715A9C..0x715AA9` | V |
| Alternate picture choice | H `+0x2BF/+0x2C0`; type AltCameo pointer `+0x710`, flag `+0xC8E`, building `+0x408` | `0x712040..0x7120C5` | V |
| Super picture filename | type `+0xCC`, 25-byte terminated storage (24-character payload) | `SidebarImage` string `0x842624`; `0x6CED9C..0x6CEE26` | V |
| Cost | techno type `+0x610`; supers null | Cost key `0x825470`, INI `0x71469F..0x7146B3`; getter `0x711EB0..0x711EB6` | V |
| Naval / defense kind | unit type `+0xCCE`; building entry category5 | `0x50B389`, `0x5F7A15..0x5F7A47`, `0x6ABCA5` | V |
| Production state / animation / flash | entry `+0x10/+0x14/+0x30`; factory link `+0x0C` | `0x6A9812..0x6A991D`, `0x6A9B5E`, association `0x6ABA9E` | V |
| Factory clock / ready / hold | Factory Value `+0x24`, Rate `+0x38`, Object `+0x58`, SpecialItem `+0x68`, suspended `+0x70` | `0x4CA120`, `0x4CA130`, `0x6A9E9C..0x6A9EDD` | V |
| Queue vectors / totals | Factory `+0x40`, Items `+0x44`, Count `+0x50`; current Object `+0x58` | `0x4CA670`; display `0x6A9C6C..0x6A9CC3` | V |
| Object-to-type read dispatch | building `+0x520`, infantry `+0x6C0`, unit/aircraft `+0x6C4`; recognized object vtables | existing state-reader dispatch; factory CountTotal's GetType `0x4CA670` | V |
| Queue primary factory | H aircraft `+0x53AC`, infantry `+0x53B0`, land `+0x53B4`, naval `+0x53B8`, building `+0x53BC` | `0x500510..0x500588`; cameo passes category0 at `0x6A9C52` | V |
| Build limit / counter index | type `+0x3B8`; ArrayIndex `+0xDF8` | `0x50B3F3`, getters `0x748180`, `0x465DB0`, `0x524D60`, `0x41CFD0` | V |
| Owned counters (building/unit/infantry/aircraft) | H `+0x5500/+0x5514/+0x5528/+0x553C`; data+4,length+8 | `0x50B433`, `0x50B565`, `0x50B4B5`, `0x50B63D`; counter `0x49FAE0..0x49FB26` | V |
| Ever-produced counters (same order) | H `+0x55A0/+0x55B4/+0x55C8/+0x55DC` | `0x50B537`, `0x50B405`, `0x50B48B`, `0x50B60B` | V |
| Available factory subset | H Buildings vector `+0x68` (Items+0x6C,Count+0x78); object limbo `+0x81`, type `+0x520`, usable `+0x660`, mission `+0xAC/+0xB4`; building type Factory `+0xEB8`, Naval `+0xCCE` | `0x5F791A..0x5F7A57`; mission getter `0x5B3040` | V/P |
| Darkening overrides | strip contains state1/2; factory clears; states1/3 clear, state2 darkens without factory | `0x6A95D3..0x6A95E9`, `0x6A9780..0x6A98F9` | V/P |
| Hover | Select `0xB07E80+(tab*60+visibleSlot)*0x38`, byte+0x34; inhibit `0xA8ED9C` | `0x6A972D..0x6A9742`, `0x6A8284..0x6A8299` | V |
| Super instance | H vector `+0x254`, Items+0x258; SW type+0x28 | `0x6A9966..0x6A99AC` | V |
| Super clock | SW custom duration `+0x24`, timer StartFrame+0x30,TimeLeft+0x38, present+0x6D, ready+0x6F, suspended+0x70, charge state+0x7C; type RechargeTime+0xB0, ChargeDrain+0xE5 | `0x6CBEE0..0x6CC066`, `0x6CDE90`, `0x6CC2B0..0x6CC33C` | V |
| Charge-drain multiplier | Rules pointer `0x8871E0`, double+0x760 | `0x6CBF5F..0x6CBF78` | V |
| Displayed credits | S `+0x5520`, signed (observer may display elapsed time) | `0x4A25A7`, `0x4A261D..0x4A2678` | V |
| Power output/drain | H `+0x53A4/+0x53A8`; low=output<drain && drain!=0 | `0x4F6A00`, `0x4F6A10`, `0x4FCE33..0x4FCE4D` | V |
| Animated power bands | S `+0x152C/+0x1530/+0x1534`: surplus/reserve/used in that order | `0x63FB20..0x63FDAC`, `0x640004..0x640018` | V |
| Power geometry/art | `0xAC4E74` SHP pointer, header width+2; slot3; N=(stripHeight+3)/3 | `0x63F7CA` loads `POWERP.SHP` string `0x836D9C`; `0x69DE32`; `0x63FB5D..0x63FBB5` | V/D |
| Base power-width fallback | SIDEC01/02 `POWERP.SHP` headers: 12x2 / 16x2, five frames; side2 maps to family1 | supplied base archives art headers; family remap `0x534FB1..0x534FB6` | A/V |
| Radar displayed state | S stage+0x14AC, activation+0x14B0; availability+0x14D8 drives transitions, not a power test | `0x6531DB..0x653297`, `0x653379..0x653450`, `0x656EEF..0x656F0B` | V |
| Armed repair/sell | S bytes `+0x11B0/+0x11B1` | setters `0x4AC8C8`, `0x4AC668` | V |
| Localized Ready/Hold | Labels ptr `0xB1CF74`, Count `0xB1CF6C`; Values ptr `0xB1CF78`, Count `0xB1CF70`; label stride0x28,name[32],num+0x20,valueIndex+0x24 | `0x734E70..0x734EBC`, case-insensitive comparator `0x7C8D20`; `0x6A983B`, `0x6A9ED8` | V |

## Native control states and command slots

`ShapeButton::Draw` at `0x69DED3..0x69DF12` selects the actual source frame. Disabled byte `+0x1E`
selects frame 2 first. With toggle byte `+0x40`, flashing/press-phase byte `+0x34` selects frame
`3 + bool(+0x2D)`; otherwise it selects `bool(+0x2D)`. Without that toggle byte it selects
`bool(+0x2C)`. The source SHP pointer is `+0x58` (`0x69DEC8`, `0x69DF86`), not `+0x40`.
The reader publishes these numbers in `tabFrames` and each `controls` entry without calling a guest getter.

The executable constructs 25 inline command gadgets at `0xB0C1C0`, stride `0x60`
(`0x6CFBA2..0x6CFBB7`). `Tab::Draw` visits the 25-element order table at `0xB0CB78`, accepting
indices 0..24 (`0x6D0D4F..0x6D0D8A`); it does not draw all allocated objects. The reader keeps this
order, ignores out-of-range/duplicate gadget indices and absent/unconstructed shapes, and reads each live rectangle.
The order-table position is the source command, while its value selects the positioned gadget: setup reads the
gadget index at `0x6D1012`, then binds the source shape from `0xB0C148 + slot*4` at `0x6D108E..0x6D109C`.
The reader therefore publishes `command<slot>`, not `command<gadget index>`. When a command is hidden or moved,
using the gadget index as the image key puts another command's icon on the live action's rectangle.
The expanded byte is `S+0x5544`; `0x6D0DCD..0x6D0DE3` draws `0xB0CCB0` when expanded and
`0xB0CC40` otherwise. Those are published as `commandCollapse`/`commandExpand`. Command image keys
remain numeric (`command0`..`command24`), avoiding invented semantic command names.

`Tab::Draw` loads the left-cap shape pointer at `0x6D0C35` from `0xB0FA3C` and passes the zeroed EBP as its source
frame at `0x6D0C5B`; `0x6D0C2D..0x6D0C5F` does not select a hover or expansion frame. The loader at
`0x72FB71..0x72FB7C` resolves `0x844D30` to `LENDCAP.SHP` and stores that pointer. The reader therefore publishes
`commandBarLeftFrame: 0`; the additional stock art frames are not an inferred state mapping. Responsive chrome
keeps the live command gadget rectangles and source frames independent of the background.

The loader at `0x6D0F24..0x6D0F5A` formats `Button%02d.SHP` from string `0x842828` and retains
source pointers in `0xB0C148`. Original-art extraction uses the existing side-archive/palette priority;
both toolbar toggles receive the `BTTNBKGD.SHP` pointer from `0xB0FA90`
(`0x6D0404..0x6D042F`, `0x6D0481..0x6D0487`; loader/table `0x72FB91`, `0x844D34`).
This shape is a blank background; the toolbar decoration drawn separately at
`0x6D0D8C..0x6D0DC8` must not be mistaken for an icon contained in it.
missing stock shapes are reported and do not become fabricated images. UI-state fixtures are synthetic;
these instruction checks do not certify live press/disabled timing or button labels.

## Software cursor and native tooltip (C3)

These operands were checked in the supplied YR 1.001 executable and disassembly.
The reader remains hash-guarded and never calls a guest method or changes memory.

| Input | Address / offset | Instruction evidence |
| --- | --- | --- |
| WWMouse singleton / vtable | pointer `0x887640`, vtable `0x7F7B2C` | constructor `0x7B8730`, final vtable store `0x7B8850`; published at `0x560D67` |
| Final cursor SHP / sheet frame | WWMouse `+4/+8` | SetCursor `0x7B8B1C: mov [esi+4],ebx`, `0x7B8B1F: mov [esi+8],edx` |
| Current hotspot position | WWMouse `+0x14/+0x18` (client/guest-frame pixels) | mouse update `0x7B9F62/0x7B9F69`; drawing `0x7B9849/0x7B9857` |
| Resolved hotspot inside SHP bounding box | WWMouse `+0x3C/+0x40` | SetCursor `0x7B8B24/0x7B8B2E`; drawing subtracts them at `0x7B984C/0x7B985A` |
| Software visibility | signed WWMouse `+0x0C`, hidden if negative | getter `0x7B89F0`; tooltip tests getter at `0x478BAF/0x478BB2`; mouse draws gate at `0x7B9904` |
| MouseClass current type / animation frame / small flag | S `+0x5560/+0x5568/+0x555C` | type/flag stores `0x5BDD9F/0x5BDDA5`; animation increment/modulo `0x5BDE1B..0x5BDE3D` |
| MouseClass requested default type | S `+0x5564` | setter `0x5BDA8D`; differs from current presentation type |
| MouseStruct table | `0x82D028`, stride `0x1C` | `0x5BDC8C..0x5BDC95` computes `28*type+table` |
| Table fields | StartFrame `+0`, FrameCount `+4`, FrameRate `+8`, SmallFrame `+0xC`, SmallFrameCount `+0x10`, HotspotX/Y `+0x14/+0x18` | frame selection `0x5BDD14..0x5BDD22`; rate `0x5BDCEB`, `0x5BDE43`; modulo `0x5BDE35/0x5BDE3A`; hotspots `0x5BDD22..0x5BDD78` |
| Hotspot sentinels | `0x3039` centre, `0xD431` full width/height, otherwise zero | `0x5BDD27..0x5BDD78`: compare sentinels, read signed SHP header dimensions `+2/+4`, halve for centre; resolved values passed at `0x5BDD86..0x5BDD93` |
| Live cursor SHP | pointer `0xABF294` | `0x5BDF3A` loads filename string `0x82604C`, `0x5BDF44` stores result |
| Cursor files | **`MOUSE.SHA` (SHP/TS format)**, **`MOUSEPAL.PAL`** | null-terminated executable strings `0x82604C/0x826084`; palette read at `0x52C13D..0x52C155`, 6-bit channels shifted at `0x52C182..0x52C18B`. The supplied installation has these files; `MOUSE.SHP` is not this build's filename. No INI cursor filename lookup is used by this loader. |
| Native tooltip singleton / vtable | pointer `0x887368`, vtable `0x7F74C4` | allocation/constructor/publication `0x77778D..0x7777B8` |
| Tooltip enabled / shown data | byte `+0xC`, pointer `+4` | enabled gate `0x724206`; Draw `0x724B90..0x724B9F` passes rect only while shown pointer exists |
| Tooltip measured frame rectangle | `+0x18/+0x1C/+0x20/+0x24` | update `0x724B2E..0x724B3E`; CCToolTip layout `0x478BA0`; native draw `0x478E30`; clear/hide zeros all fields and shown pointer at `0x724AB2..0x724ABE` |
| Tooltip copied wide text | inline UTF-16[256] `+0x28` | `0x724B19..0x724B23` copies the native text, including cost lines supplied by `0x6D1800` through `0x479064..0x47906E`; draw uses rect `+0x10` at `0x478EDB` (tooltip `+0x28`) |
| Final tooltip dimensions / edge clamp | measured again, padding width+8 / height+4 | `0x478EF5..0x478F30`; layout uses width+4 / height+3 at `0x478C46/0x478C49`; draw clamps x at `0x478F40..0x478F56` |
| Tooltip target surface | right-sidebar byte `0xA8EB7C`; `*0x887300` Sidebar / `*0x88731C` Composite | `0x478E45..0x478ECB` selects surface and converts frame x to local x; width/height getters vtable+0x7C/+0x80 resolve to `0x411540/0x411550`, reading surface+4/+8 |
| Native tooltip font metrics | font `*0x89C4D0`; glyph set+4, fallback+8, line height+0x1C, tab width+0x28, spacing+0x2C | `0x478EE1/0x478F04`; measure `0x433CF0..0x433E85`, including CR/LF, tabs, word/character wrap |
| Native glyph widths | glyph set: record stride+0x14, UTF-16 index map+0x18, records+0x1C; first record byte is advance | `0x433DAF..0x433DEA`; zero map index uses the font fallback glyph |

The sheet export preserves each frame's complete SHP bounding box and its cropped
pixel offsets. It exports all frames, including placeholders, without treating the
second half as shadows. Runtime hotspots come from WWMouse, including the native
resolved sentinel values. The reader checks its shape against `*0xABF294`, frame
against the live SHP frame count, vtable, visibility, bounds and hotspot range. It
does not advance the animation from host time. Unknown/hidden cursor data publishes
null; valid cursor data with unavailable art uses a clipped vector arrow.

Tooltip decoding preserves CR/LF, blank lines and cost text; malformed, unterminated,
disabled, unshown or out-of-frame tooltip state publishes null. The HD layer never
constructs a tooltip from hover/name/cost fields. It fills the supplied rectangle
and adds precisely that rectangle to the covered union until the tooltip disappears.
The cached measurement is only the placement input. The reader mirrors the native
font-width lookup and wrapping, adds the draw routine's 8/4-pixel padding, clamps x
to the selected surface edge, and clips its publication to that surface/frame.
This also handles cached measurement dimensions that differ from the current text.
Unavailable font/surface data publishes null. Synthetic fixtures verify the operand
reconstruction; real-match screenshots remain necessary to establish final pixel alignment.

The input controller's read-only accessor copies the latest locally tracked guest
coordinates (absolute pointer events, accumulated lock motion, resolution rescale).
HD drawing prefers those coordinates without adding listeners, consuming events,
changing the snapshot or replacing the guest's shape/frame. The cursor clips to
the covered union even when only its picture, not its hotspot, crosses a hole.

## Predicates, validation and approximations

Factory IsDone is exactly Value54 and (Object exists or SpecialItem!=-1). An
unfinished clock uses Value/54, averaging with a greater entry animation value
only in state1, using integer truncation. State2 without a factory draws frame0
and Hold; state3 without a factory suppresses the clock and **does not** set Ready.
Hold checks Rate0/suspended, not Factory.OnHold. Queue totals use the appropriate
primary factory, independently of CurrentFactory, and count matching type pointers
plus the current object's type. A lone current item has no caption; one queued
item displays only with no current object or a non-null different current type.

Super normal progress is `min(53,trunc(54*(T-R)/T))/54` while the clock is shown;
ready normal weapons have no clock. Charge-drain state2 uses
`min(53,trunc(54*R/(T*Rules.multiplier)))/54`. A not-present instance yields frame0.
Zero/negative durations and nonfinite multipliers are host corruption guards.
Suspension selects Hold; charge-drain state1 selects Ready; ordinary Ready follows
IsReady. Ordinary supers do not read or validate charge-drain state: the pinned
branches at `0x6CBEFC` and `0x6CC2C6` skip `SW+0x7C` when `type+0xE5` is zero;
that unused field can remain `-1`, including a ready American paradrop.
The fixed contract cannot express `TXT_CHARGING` or `TXT_FIRESTORM_ON`;
those captions are **not represented** by Ready/Hold. The reader never labels
firestorm-on as Ready. Flashing reports an active FlashEndFrame window; the native
blink phase itself is frame remainder16>8. Tab flashing similarly reports an
active FlashDelay, independently of its current blink phase.

Availability reconstruction is **partial**: it reproduces the strip's busy-building
rule, production overrides, usable/not-limbo/not-selling factory matching (including
naval), and ordinary positive-owned / negative-ever-produced build limits with queued
totals. It cannot fully reproduce `FindFactory(true,true,true,H)` / `CanBuild` country,
prerequisite, tech-level and ownership masks, docking availability, unit deployment
counts (`0x50B4C4..0x50B506`) or shared airport-bound aircraft limits
(`0x50B570..0x50B5EB`). Factory matching omits the type owner's mask test
(`0x5F79B0..0x5F79C1`). Darkening can consequently be too light in these cases.
There is no invented affordability test. Nonzero malformed producer/type/queue
pointers reject the poll; null native Object.GetType preserves its queue predicate.

The reader validates roots, all tab counts (0..75), active tab (0..3), type indices,
bounded vectors, required rectangles, progress/states and strings. Optional image
or CSF failures return null; an absent or empty UIName falls back to its ID, while malformed nonempty UIName rejects the poll.
UTF-16 pointers allow two-byte alignment. Root/frame/active-tab/counts are rechecked
at the end; this rejects some torn polls but is **not an atomic snapshot guarantee**.
No guest getter is called, especially Factory.IsDifferent's consuming getter.

Each render-state poll reads the sidebar independently of the battlefield key.
An exact bounded serialized-content key retains the previous sidebar reference when
unchanged. Sidebar-only changes create a new top-level snapshot while preserving
objects/effects/shroud/overlays/smudges (and other battlefield references), including
the due-cell-poll early-return path. Outside a battle it publishes null.

## Runtime acceptance

Synthetic guest-memory tests cover geometry at two frame sizes, scrolling/clipping,
production and queue branches, build limits, superweapon clocks, CSF lookup, corruption,
read-only memory and same-frame publication identity. They also cover final software
cursor frames/hotspots and native tooltip UTF-16, font widths, padding, wrapping,
surface edge clamps and hidden/corrupt data. They require no game assets.
The supplied original executable and art were read only for static evidence; none
are added to Git.

Live acceptance (YR 1.001, 1152x744 frame, right sidebar, skirmish on XMP29U2 with all three sides): the
page layer was compared against the native sidebar in frozen pairs (VM Worker busy-waiting while the HD and
the native screenshot are taken) during scripted build orders. Matched: chrome/tab/cameo rectangles, cameo
identity and order on all four tabs, build progress sector, hold (`等待`) and ready (`就绪`) labels, queue
counts, darkened unavailable cameos, tab flashing, the active-tab plate, radar aperture after the radar comes
online, and the power bar. Findings fixed from these pairs:

- the infantry and vehicle type vectors were swapped (`0xA8E348` is InfantryTypes, `0xA83CE0` UnitTypes;
  the type-vector table at `0x48DD10` lists them), which put vehicle cameos on the infantry tab;
- the native radar strokes the map outline one row outside its aperture (yellow rows at aperture y-1 and
  y+height), so the radar hole is padded by one frame pixel;
- the progress clock washes the unbuilt sector 50% toward a colour of the side's sidebar palette, not black:
  mean-colour regression of the covered sector (original cameo vs native frame) gives Allied about
  (64,173,238) and Soviet about (244,225,112); Yuri, which uses the Soviet sidebar art, measures
  (241,222,113). After the change the covered-sector mean of an Allied power plant at 24% progress reads
  native (87,139,168) against HD (87,140,171).

Known live differences: the credits counter can trail the native frame by one or two polls while the native
counter is ticking (both show the same value once it settles); the first frames of the radar power-on
transition can differ (a transient viewport outline), steady radar pixels match (mean absolute difference
0.04 over the aperture).

**UNVERIFIED runtime:** left-sidebar/hidden-sidebar layouts, observer cameo behavior (the observer draws a
separate slot treatment), superweapon cameos in a live match, modded power art when no live header exists,
availability approximations beyond the scripted build orders, native tooltip pixel alignment (no tooltip was
shown natively in the scripted runs), cursor save-under, and frame sizes other than 1152x744 in a real match.
The normal frame recipe is not certified for left-sidebar or hidden-sidebar modes.
These limits do not turn synthetic tests or a successful build into UI acceptance.
