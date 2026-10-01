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
implement keying, cursor suppression, tooltips or input interception. Tooltip and
cursor appearance under the page layer require separate C2/runtime acceptance.

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
| Type arrays | building `0xA83C68`, infantry `0xA83CE0`, unit `0xA8E348`, aircraft `0xA8B218`; Items+4, Count+0x10 | resolver `0x48DCD0..0x48DD4B` (dispatch bytes); super Items `0xA8E334`, Count `0xA8E340` at `0x6A9939..0x6A9948` | V |
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
IsReady. The fixed contract cannot express `TXT_CHARGING` or `TXT_FIRESTORM_ON`;
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
read-only memory and same-frame publication identity. They require no game assets.
The supplied original executable and art were read only for static evidence; none
are added to Git.

**UNVERIFIED runtime:** real-match memory sampling, left-sidebar/hidden-sidebar
layouts, observer cameo behavior (the observer draws a separate slot treatment),
modded power art when no live header exists, all availability approximations,
actual localized text placement, native clock/art alignment and timing, radar
transitions, tooltips/cursor save-under, page-layer toggling and real user interaction.
The normal frame recipe is not certified for left-sidebar or hidden-sidebar modes.
These limits do not turn synthetic tests or a successful build into UI acceptance.
