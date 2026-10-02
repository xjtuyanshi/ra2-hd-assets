# YR 1.001 tactical traversal and pixel occlusion

## Scope and evidence

This note describes the player's YR 1.001 `gamemd.exe`, SHA-256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`.
Addresses below are image virtual addresses, not file offsets, and do not apply to RA2.
The executable hash, instructions, vtable targets, constants and string references were checked directly.
No executable, disassembly dump, extracted Z-shape or screenshot belongs in this repository.

Names such as `ZGradient`, `ZReadWrite`, `GetYSort` and the layer names use the YRpp vocabulary
([Ares YRpp, GeneralDefinitions.h](https://github.com/Ares-Developers/YRpp/blob/master/GeneralDefinitions.h)).
Instruction behavior, rather than symbolic flag names alone, is the evidence for the conclusions below.
This is static analysis; it does not establish pixel-identical live rendering.

## Traversal is only one part of the renderer

The five native layer vectors start at `0x8A0360`, with a `0x18` stride:
Underground (0), Surface (1), Ground (2), Air (3), Top (4).
`TacticalClass`'s object traversal starts at `0x6D8DB0`; its vector walk is visible at `0x6D8F19`.
It invokes `DrawBehind` through vtable `+0x10C` at `0x6D9085`, then `DrawIfVisible`
through `+0x104` at `0x6D909E` (ultimately the object's `DrawIt`, `+0x114`).
Additional object drawing follows in a separate extras walk. Consequently a list index is a traversal position,
not a constant depth for every pixel of that object.

The Ground vector is sorted with the virtual `GetYSort` at `+0xB8`.
The adjacent-update routine `0x551A30` only swaps strictly reversed keys (`0x551A63`–`0x551A73`);
equal-key registrations retain their relative order. Insertion at `0x551A90` uses comparator `0x5F6220`.
Do not sort a reader snapshot afresh and assume it equals the native list: an observed list can be partially sorted.

| Object kind                                        | Verified key and addresses                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, infantry, aircraft, terrain object, particle | `Location.X + Location.Y`. `GetYSort` at `0x5F6BD0` calls position virtual `+0xAC`; these classes use `0x41BE00`, which forwards to coordinates. Height is not in this key.                                                                                                                                   |
| Building                                           | `Location.X + Location.Y - 256`. Position override `0x459EF0` subtracts 128 on both axes, giving the northwest foundation corner. Key override `0x449410` adds 32 for a voxel turret (type byte `+0x16C5`) and subtracts 16 for a gate (`+0x16B7`). Foundation size and building height do not enter the key. |
| Animation                                          | `0x422BC0` calls `0x5F6BD0` and adds the animation's adjustment at `+0x104`. Registration layer still matters; an animation is not universally a Ground object.                                                                                                                                               |
| Cell overlays, including bridges                   | Drawn through cell/cache sweeps, not independently inserted into the Ground object vector. A synthetic cell-centre Ground key is not their native occlusion rule.                                                                                                                                             |

Vtable cross-checks: Unit `0x7F5C70`, Infantry `0x7EB058`, Aircraft `0x7E22A4`,
Terrain `0x7F522C`, Particle `0x7EF954`, Building `0x7E3EBC`, Anim `0x7E3354`.

Ground sorting is called at `0x55DBC8`, before Logic AI (`0x55DC9E`) and the frame counter store
at `0x55DE81` (`0xA8ED84`). Thus two polls can have the same simulation frame and different registration metadata.
Such a metadata refresh must not advance an interpolation clock or replace its previous pose endpoint.

## The software Z-buffer

`ZBuffer` is reached through global `0x887644`. It stores 16-bit depths; smaller values are nearer.
`0x7BD130` addresses a pixel using the backing surface (`+0x14`), circular offset (`+0x10`),
end (`+0x1C`) and wrap size (`+0x20`). The clear path writes `0xFFFF`
(`0x7BD109` / `0x7BD11C`). It is a scrolling screen-space buffer, not the native Ground list.

`CC_Draw_Shape` (`0x4AED70`) chooses its converter blitter through `0x490E50`.
The SHP row renderer `0x437A10` obtains Z at `0x437B3D` and builds a row baseline at `0x437C39`
from the destination, buffer origin and Z adjustment. A supplied Z-shape provides signed per-pixel corrections.
The ordinary RLE read/write path has this effective operation for a nontransparent pixel:

```text
candidate = uint16(rowBaseline - int8(zShapePixel))
if candidate < existingZ:
    write colour
    existingZ = candidate
```

The signed subtraction and comparison are at `0x4991DC`–`0x4991EC`; colour and Z writes are at
`0x499222` and `0x499230`. A read-only sibling at `0x4980CB`–`0x4980E4` performs the comparison
but does not store Z. Other blitter variants implement blending/remapping; these are concrete ordinary paths,
not a claim that every special effect has identical writes.

**`0x4E00` tests and writes Z in this path.** It is incorrect to treat `0x4000` as a write-only bit
that needs a separate `0x2000` bit to test. The selector tests `0x4000` first at `0x490F3D`–`0x490F51`;
with the `0x0800` variant it selects converter `+0x158`, installed by `0x4902A3` / `0x4902B7`.
Its vtable `0x7E53A0` points at `0x4990E0` / `0x499280`, including the comparison above.
The read-only branch at `0x490F5B` instead tests mask `0x3000` (constant at `0x81DC28`),
selecting `+0x138`; vtable `0x7E5420` points at `0x497FD0` / `0x498150`.
This also corrects the review's speculative claim that an ordinary tree cannot test building Z.

## Buildings: foundation key, per-pixel Z shape

The building body calls `TechnoClass::DrawObject` (`0x705E00`) at `0x43D85F`, passing
Z-write enabled (`0x43D830`) and `ZGradient = 2` (`0x43D832`). `DrawObject` enables the gradient
flag at `0x706130` and read/write mode at `0x70613E`.

The shared `BUILDNGZ.SHA` name is referenced at `0x8193F4`. Loader `0x45E8F0` stores the shape
at `0x89DDBC`, decodes frame 0 (`0x45E917` / `0x45E924`), and subtracts `0x41` from each nonzero
sample at `0x45E94D`. The draw path takes that pointer at `0x43D767`. It aligns the template using
foundation dimensions (`0x43D730`, call `0x45EC90`) and projected offsets (`0x6D1FE0`);
the dimension-at-least-eight branch at `0x43D787` suppresses the shape and takes the gradient fallback.
Object height also contributes to the draw's Z offset (`0x43D836`–`0x43D84D`, using height projection
`0x6D20E0`). The SHP frame's rectangular bounds are not the building's occlusion surface.

The row renderer indexes a six-int gradient record, 24 bytes each, at `0x817710`
(`0x437A91`–`0x437A9C`). Records 0–3 are:

| Gradient                 | Record                  |
| ------------------------ | ----------------------- |
| Ground                   | `(1, 1, 1, 1, -1, 1)`   |
| Deg45                    | `(2, 3, 2, 3, -1, 1)`   |
| Deg90, used by buildings | `(1, 3, 1, 3, 1, 0)`    |
| Deg135                   | `(1, 1, -1, -1, -1, 1)` |

The fallback row accumulator advances at `0x437E82`–`0x437EA7`; Deg90's unit increment is
distributed over three rows. With an explicit Z-shape, the shape row pointer advances instead
(`0x437E72`–`0x437E7C`). These integer gradients, template corrections and object Z adjustments
explain why a later-visited trooper can still be behind a building's facade.

For example, a 4×4 building at northwest cell `(50,50)` sorts at `25600`, while a unit at
`(52.5,49.5)` sorts at `26112`. Traversal draws the unit later, but its pixels behind the building
fail the Z comparison. Turning those list positions into unconditional NDC slots reverses this result.

## Terrain, overlays and units

Terrain/cache painting precedes ordinary object traversal. The dirty rectangle pipeline at
`0x6D4471`–`0x6D44F7` clears/rebuilds tiles, cell extras, overlays and static objects; the tile surface
is copied to the composite at `0x6D45C7`. See [tactical passthrough](tactical-passthrough.md)
for the individual cache passes and why retaining only the final object walk is insufficient.

| Producer or consumer    | Concrete Z evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terrain tiles (TMP)     | Tile sweep `0x6D71E0` calls cell renderer `0x4801F0` at `0x6D751A`, then tile rasterizer `0x547CF0` at `0x480499`. It obtains the Z row through `0x7BD130` at `0x548194`. At `0x548228` it checks TMP header flag `+0x24 & 2`, resolving Z data via header `+0x0C` at `0x54822E`. One ordinary pixel path adds the unsigned Z byte to the baseline (`0x5487AB`–`0x5487AF`), compares existing Z at `0x5487B1`, writes passing Z at `0x5487B6`, then colour at `0x5487EB`. Unlike the SHP path above, this branch permits equal Z. |
| Terrain objects (trees) | `DrawIt` at `0x71C1B0`: height conversion at `0x71C251`, ordinary flags `0x4E00` at `0x71C2D7`, gradient 2 at `0x71C2ED`, draw at `0x71C304`. Z adjustment includes negative height and `-12` (`0x71C2EA`). A special state/type branch selects read-only `0x2E00` at `0x71C2D0`. Ordinary trees therefore test/write Z and can cover an explosion drawn later behind them.                                                                                                                                                       |
| Cell overlays           | Cell sweep `0x6D6D10` calls overlay renderer `0x47F6A0` at `0x6D7001`. Its SHP branches include `0x4E00`, ground/vertical gradients and tile-height adjustments. DrawFlat and elevated art cannot be reduced to one Ground cell key.                                                                                                                                                                                                                                                                                              |
| Infantry                | Shape call at `0x519585`, flags `0x2601` at `0x51956F`: read/test existing Z. Height is projected at `0x519552`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SHP vehicles            | Shape call at `0x73C7A7`, flags `0x2E01`: read/test existing Z.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Voxel units             | Rasterizer takes `ZBuffer` at `0x7600DB`, gets a pixel via `0x7BD130` at `0x7600E3`, compares the stored ushort with candidate `cx` at `0x7600ED`, and skips on `jbe` at `0x7600F0`. A passing pixel is drawn at `0x760100`. The native list does not bypass building or terrain Z.                                                                                                                                                                                                                                               |

The repository TMP decoder independently records the file's Z and extra-Z offsets in
`packages/ra2-formats/src/tmp/tmpFile.ts`. The HD terrain mesh remains the existing physical approximation;
this change does not port every TMP/software rasterizer branch.

Stock high bridges in the asset policy (`packages/ra2-assets/src/node/artSource.ts`) are
`BRIDGE1/2`, `BRIDGEB1/2`, `RAILBRDG1/2`, with `drawOffset [0,-60]` and non-flat art.
Their deck is four height levels above the cell. This stock-art inference supplies the HD horizontal
depth plane; it is not newly read native per-pixel bridge Z. Bridge sides, slopes, damaged/custom art and
unusual bridge rules still require real-scene verification.

The engine also has later special drawing, including lasers (`0x550240`), electric bolts (`0x4C2830`),
line trails (`0x556D40`) and radiation beams (`0x6591B0`). HD physical beams/weather are not a literal port
of all these passes. They must nevertheless share a comparable depth space with the objects they cross.

## HD approximation and its boundaries

`ra2/cardDepth.ts` reconstructs depth per fragment in the fixed orthographic view. It cancels the
old frame-size-dependent `cardPush` from fragment depth while retaining its geometry placement for lighting.
Let `px, py` be original screen pixels relative to the draw point, `P = 60 / sqrt(2)` pixels per world unit,
and `w, h` the rectangular foundation dimensions. For a foundation-aligned card:

```text
d = px / 30
sFront = max(0, min(2*w - d, 2*h + d))
groundPush = py * sqrt(3) / P
facadePush = sFront / (sqrt(2) * cos(30°)) - py * tan(30°) / P
push = max(groundPush, facadePush) + CARD_CLEARANCE
depth = geometryDepth - (push - placementPush + traversalBias) / (far - near)
```

Each screen column intersects the two front faces of the foundation extrusion. Owner-relative offsets keep
shifted building animation cards on the same profile. Ordinary trees, infantry and effects use `sFront = 0`:
vertical above their draw point and ground-following below it. This removes frame-padding-dependent tree/explosion
ordering and prevents surrounding ground from cutting the lower rows of a unit card.

The clearance must exceed the lifted decal plane **at the same screen pixel**. At this camera pitch,
a horizontal plane raised by `h` advances depth by `h / sin(30 degrees)`, not `h * sin(30 degrees)`.
SHP shadows/decals retain their `0.02` lift, and effect decals retain `0.025`; `CARD_CLEARANCE` is
the latter's camera-depth displacement plus `0.01` (currently `0.06`). A `0.03` clearance allowed
ground-following wall pixels to fail against their own or neighboring shadows, leaving dark holes.
Frame selection, wall connection data, placement and shadow opacity are unchanged.

Ground and Air effect cards both test this reconstructed depth and do not write depth. Air still
composites after Ground and uses a bounded traversal bias over coincident unit pixels. Native `Layer=air`
explosions (EXPLOLRG/MED/SML, TWLT070/100, S_BANG48 and the effect table's other explosion ids) draw after
the ground layer, so overlapping bushes do not pierce their cores. HD display enlargement needs a bounded volume
approximation: unconditional Air covers units 1.5 horizontal cells ahead, while anchor-only Z exposes those bushes.
`ra2/fireballDepth.ts` gives upright Air explosion/collapse cards a spherical front with
`bias(r) = sqrt(max(0, R^2 - r^2))` and `R = min(1.16, max(displayed width, displayed height)/2)` (factor 1).
Displayed dimensions and union-centre distances are native pixels times current HD display size divided by
`60/sqrt(2)`; native SHP cards use size 1. The sphere uses the existing incandescent-garnish support of 0.5 world
units plus Air's 0.04 tie break. The same-ray unit separation is `1.5/cos(30) = 1.73205`; the maximum advance
1.70 retains 0.03205 margin (the largest two-decimal cap reserving 0.03 is 1.16). The front at `r <= 0.6R` is at
least `0.8R` nearer, engulfing tree cards 0.5-1.0 horizontal cells ahead in the tested peak-stage crops.
Take the maximum of the upright sphere, ground-following rim and legacy merged-building engulf; summing them
would double-count ground/merge reach. Explosion fire puffs/halos use their current diameter and the same cap;
smoke, muzzle/spark/debris art, flat/shadow/Ground and Top cards retain their policies. Radius is packed into the
draw mode's fractional part (`mode + R/4`), preserving six native/eight HD vertex buffers. Farther foreground
facades still occlude the bounded sphere. Animation, SHP projectile and particle producers share this material
policy, including the translucent variant. Top remains the explicit untested pass. This preserves
physical occlusion rather than reconstructing every native read-only unit/translucency interaction.

High-bridge cards instead use a horizontal plane at `4 * LEVEL_HEIGHT`; neighboring pieces have identical
depth at the same screen pixel. Their draw offsets remain unchanged. Voxel geometry retains its complete depth,
with `0.035` camera-space contact clearance so its feet pass the deck's `0.03` clearance. Shadow twins and flat
decals retain their ground-depth path. Building voxel turrets and visible lamp heads place themselves just in
front of their own foundation profile rather than the old whole-frame card plane.

Traversal bias is independent of scene population: registered index `i` contributes
`0.01 * i / (i + 32)` in camera-space world units, with small layer/component increments bounded by `0.04`.
Foundations do not take a registration bias. Ground fallback effects get a small positive tie break.
Physical depth wins beyond this narrow tolerance; beams, rain, emitters and garnish can pass in front of an object
or fail behind it. There is no global `0.1..0.2` NDC band or compressed voxel depth range.
Finite GPU precision can collapse extremely long equal-depth registration lists. Fallback/native atlas blending
uses separate stable groups to avoid a non-transitive comparison during a partial native sort; arbitrary native
translucency ordering across atlas pages is not reconstructed.

This is a foundation-derived approximation, **not** decoded `BUILDNGZ.SHA`, a roof model, or a complete emulator
of art `ZAdjust`, terrain overhangs, nonrectangular foundations and special transparency. A recess in a roof can
therefore still differ from the original. In particular, shader construction and CPU depth assertions do not
prove that the reported CAMIAM01/trooper and tree/explosion captures now match in a live WebGPU frame.
Fog/shroud continue to use the separate geometry-depth attachment; static map previews enable it too now that
their cards use the same analytic depth. The post-processing depth contract is unchanged.

## Contacted dock pull and delivery images

The analytic foundation profile does not decode low dock/pad recesses in `BUILDNGZ.SHA`. The measured refinery case
has northwest cell `(51,101)`, foundation `4x3`, and unit anchor `(13952/256,26240/256)`. Sampling
`foundationPointPush` at that exact anchor and its four one-cell axial neighbours, then adding `0.5`, yields about
`3.00949` camera-space world units; the maximum is capped at `3.5`.

`ra2/dockPull.ts` now requires the unit's `contactUid` to match the host building's `uid`, the host's `dock` to be
true, and its `unloading` field to be absent. The unit must be in layer 2 without a foundation, drawn after its
host in native painter order, with its exact anchor inside the foundation or its one-cell outer border. There is
no stationary-frame gate: backing-in frames must clear the low pad too. Hosts are resolved by UID rather than by
searching every foundation. Missing policy/contact data in older snapshots disables dock pull.

YR 1.001 policy stays in `src/games/yr`:

- RadioLinks is `VectorClass<TechnoClass*>` at `+0xE0` (observed vtable `0x7E180C`), with Items `+0xE4` and Capacity
  `+0xE8`. GetNthLink `0x65AD40` indexes Items; ContainsLink `0x65AD50` scans Capacity entries. Contact ID publication
  requires capacity `1..64`, plausible pointers/spans, and link 0 belonging to the validated objects of this snapshot.
- BuildingType flags are UnitRepair `+0x16A9` (INI store `0x460929`), Refinery `+0x16BB` (`0x460A6C`), and Helipad
  `+0x16CB` (`0x4604E0`). Their validated OR defines `dock`. WeaponsFactory `+0x16BD` (`0x460A8C`) alone is not a dock:
  GAWEAP/NAWEAP/YAWEAP have radio links to newly produced units but must keep them behind the factory facade.
  Repair shipyards also have WeaponsFactory, so their delivery phase independently disables pull.
- Mission getter `0x5B3040` reads CurrentMission `+0xAC`, using QueuedMission `+0xB4` only when CurrentMission is `-1`.
  DrawIt `0x43D33A..0x43D381` reads link 0's type flags JumpJet `+0xD94` (store `0x715200`) or BalloonHover `+0xD6A`
  (`0x714DA9`) to select the roof; `0x43D692..` uses that decision only at effective mission `16`. The reader validates
  each object's class vtable and existing class-specific type offset before reading these flags, instead of calling
  GetTechnoType (virtual `+0x84`). Art availability does not determine the published delivery state.

`createYrStateReader` retains a roof decision only after publishing `unloading='roof'` in the current continuous
effective Unload. When link 0 becomes NULL it continues publishing roof until the effective mission leaves `16`.
Unreadable roof state still omits `unloading`; it does not substitute the latch. History belongs to each reader,
checks the building pointer, UID and type pointer, and retains only validated buildings seen in the latest read
and still in Unload. Disappearance, type/UID reuse and invalid mission reads reset it. `readYrState` remains a
stateless single-snapshot helper.

Supplied frozen native GAWEAP `5x3`, northwest `(58,98)`, Night Hawk SHAD roof-delivery evidence:

| Frame | Current / queued mission | Link 0 | SHAD Z (leptons) | Original drawing |
| --- | --- | --- | --- | --- |
| 9171 | 5 / 16 | SHAD | 208 | Closed roof. |
| 9184 / 9208 | 16 | SHAD | 208 | RoofDeployingAnim; heli parts visible inside the opening. |
| 9235 | 16 | NULL | 368 | Roof still open; heli rising out. The previous HD reader selected door and hid it under a closed roof. |
| 9278 | 5 | NULL | 798 | Roof still open for an unexplained reason; intentionally outside this Unload latch. |
| 9342 | — | — | — | Closed in original and HD. |

These are supplied native observations, not new HD rendered-pixel acceptance. The mission-5 discrepancy at 9278
remains `UNVERIFIED`; the latch deliberately ends there.

After direct dock pulls are computed, a different ground vehicle/infantry U within three cells (Chebyshev distance)
of docked unit D's exact anchor inherits pull only if it follows D in painter order:

```text
pull_U = max(pull_U, 0, pull_D - ((U.x + U.z) - (D.x + D.z)) * sqrt(3/8) + 0.05)
```

Coordinates in this expression are cell anchors. This preserves overlap ordering for passing units; units before
D are never pulled. Only directly docked units are sources, so propagation does not cascade through a crowd or
alter another directly docked unit. `PainterObject.pull` enters `spritePainterBias`, which both SHP cards and voxel
parts consume. Buildings, their turrets, effects and projectiles do not participate in this propagation.

The factory's delivery art is a body image substitution, not an attached AnimClass. Art loaders store DeployingAnim
`+0x14E4` at `0x45F3A7`, UnderDoorAnim `+0x14EC` at `0x45F5DF`, RoofDeployingAnim `+0x14FC` at `0x45F47F`, and
UnderRoofDoorAnim `+0x1504` at `0x45F78B`. DrawIt `0x43D692..0x43D6D3` / `0x43D7D2` substitutes the deploying shape
(native Z adjust -20, roof -40); `0x43D7A7..0x43D7EE` clamps GetCurrentFrame (`0x43EF90`) to its foreground half.
`0x43D8EE..0x43D9C9` and roof `0x43D9D8..0x43DA67` then draw the under-door section at yellow-damage frame 1, else 0.

`LiveView.libraryBuildingSprites` uses these library key pairs while a completed building reports `unloading`.
It clamps the replacement body frame to `frames.length - 1`, substitutes its shadow, and queues the under-door
frame immediately after the body with the same anchor, placement push and foundation dimensions/offsets. Each
sprite retains the existing palette/remap handling. The under-door card alone has `SpriteInstance.foundationRecess`
set to `DOOR_RECESS = 2.75` for a door or `ROOF_RECESS = 4` for a roof;
the deploying body retains the front facade. There is no factory-exit dock pull. Missing/empty pairs retain the
normal body. Bibs, active layers, construction
and selling frames, and voxel turrets are unchanged.

Frozen native frames fit a recessed door plane rather than the foundation's back surface. NAWEAP has a `5x3`
foundation at northwest `(58,98)`, with its door on the +x face. At frame `9454`, `unloading='door'`, the open dark
interior completely covers the new tank at local `(2.5,1.5)`: its centre has `x+z=4.0`, versus native facade
`x+z=7.5` at that column, so it is `3.5` sum units behind; its front end at local `x≈3.0` is about `3.0` behind.
About `86` frames later, the whole tank at local `(4.13,1.06)` is visible over the dark interior and ramp while
the door posts remain in front. Its centre is about `1.74` sum units behind the facade. These supplied native
observations bound the interior recess by `1.74 < R < about 3.0` (refined below); they are not a new HD runtime acceptance run.

`live/liveView.ts` exports `DOOR_RECESS = 2.75`, a generic measured approximation of the engine's door-interior
Z-shape/ZAdjust (`2.75 * sqrt(3/8) ≈ 1.684` world units in depth). A first fit of `R = 2` hid the rear half of a
tank that the original shows whole: in frozen live frames (same factory) the original shows the entire tank in the
doorway at local `(3.85,1.43)`, its centre `2.3` and its rear end about `2.8` sum units behind the facade, while the
waiting tank at `(2.5,1.5)` (voxel front end about `3.0` behind) stays hidden. `2.75` keeps a `0.25` margin to
that hidden case. The rectangular profile gives front sums `7.0` and `6.93` at the two centre columns above; it
does not reconstruct the native first column's `7.5`. With the recess these become `4.25` and `4.18`, keeping the
first centre (`4.0`) behind and the second (`5.19`) in front. A back-surface profile would expose the early tank and is therefore unsuitable.

Roof delivery instead looks down to a deeper interior floor: `ROOF_RECESS = 4`, exported beside `DOOR_RECESS`,
applies only to the UnderRoofDoorAnim card. In the supplied native roof frames the heli at local `(2.5,1.5)`,
sum `4.0`, must appear in front of the interior plane `7.5 - 4 = 3.5`. The rectangular approximation's facade sum
at this column is `7`, so its recessed sum is `3`. Both a unit on the floor and one raised `1.5` levels remain in
front of that card; the deploying body's opaque roof edges still occlude them. Outside units behind the building
on the same column stay hidden: their sums are below the back surface (at most `3` on the `5x3` centre columns).
Door delivery retains the shallower measured recess and all of its previous depth relationships.

The optional generic `SpriteInstance.foundationRecess` defaults to zero. Instance encoding changes only the
existing sum-offset component, foundation flags component 7: `ds = -dx - dz - foundationRecess`. Both
`cardDepthPush` and `cardDepthNode` retain their original expression and interface:

```text
d = px / 30 + dx
front = max(0, min(2w - d, 2h + d))
ds = -dx - dz - recess
s = front + ds
push = max(py * GROUND_DEPTH, s * FOUNDATION_DEPTH - py * VERTICAL_DEPTH) + CARD_CLEARANCE
```

The deploying body and all other layers retain recess zero. The body's facade still hides the emerging tank at
opaque posts/walls, and an outside unit behind the building on the same screen column remains hidden by the
interior. Lower ramp rows retain `max(ground, facade)`, so a unit standing outside the facade stays in front with
the existing unit bias. Reused pool records reset their recess to zero. There is no depth-mode bit or new shader
branch: the anchor/light-sample buffer returns to five components and the original vec2 light-sample attribute.
Foundation widths/heights, difference offset, placement, lighting and deck/shadow paths retain their behavior;
other consumers of the existing sum offset receive the same recessed profile for the interior card.

## Infantry inside foundations

The supplied barracks replay has a `2x2` foundation at northwest `(67,14)` and an infantry spawn at local
`(0.5,1.5)`. The original hides it until it walks out, about ten logic frames later. Its HD pixels appear mostly
in transparent art beside the tapered tower and above the plinth: changing only opaque-card depth cannot hide
those pixels. The engine's building Z-shape box covers the foundation independently of those art holes.

Known limit (live frozen frames, YABRCK `2x3`, NW `(54,90)`): the original hides a fresh initiate at local
`(1.25,1.75)` on its spawn frame but shows it 9 and 21 frames later at `(1.47,1.96)` and `(1.8,2.29)` walking down
its exit stairs, still inside the foundation (the Yuri barracks' Z-shape is low there). HD hides those poses: both
the containment rule below and the rectangular front facade (about 1.06 and 0.4 sum units in front of the unit)
cover them. Limiting the rule to the spawn moment was tried and did not reveal the initiate (the facade still covers
the stairs) while it would re-expose the NAHAND conscript in transparent art, so the rule stays unconditional until
per-art Z-shapes are reconstructed.

`LiveView` therefore suppresses ground-layer, non-airborne infantry at exact snapshot anchors strictly inside
`NW + (0.05, w - 0.05) x (0.05, h - 0.05)`. It hides the visual root and queues no body, shadow or overlay art for
that frame. Vehicle/aircraft delivery and docking remain independent. Anchors on the inset boundary or outside,
airborne infantry, non-ground registration and scenes without a known visible foundation are unaffected.
The existing front-facade depth approximation still governs opaque-art overlap.

The cell-aligned rectangular foundation index is refreshed for new publications (including same-frame changes)
and art/visibility rebuilds, not interpolation-only poses. Each cell stores a nine-bit union of allowed low-edge,
middle and high-edge regions on its two axes. Overlaps merge by OR, so an infantry lookup remains one cell lookup
and one bit test rather than a scan of building candidates. Inset checks compare world-coordinate bounds directly
to keep exact edge equality outside despite floating-point subtraction. This is a rectangular foundation
approximation, not a claim to reconstruct custom/nonrectangular native Z-shapes.

An accompanying native NAWEAP/Rhino trace observed CurrentMission `5` with QueuedMission `16` when the tank appeared
(door still closed), then CurrentMission `16` thirteen logic frames later with link 0 pointing at the tank inside
the foundation. Mission `16` persisted for about five seconds during drive-out; link 0 was released after the unit
left the foundation, then mission returned to `5` and the door closed. This supports effective-mission gating and
keeping the door image through link release. It is native-state evidence supplied with this task, not live HD
rendered-pixel acceptance of the implementation.

## Update ownership and regressions

`LiveView` refreshes traversal metadata for a new snapshot, changed registration, art/cell rebuild or visibility
change. An interpolation-only presentation updates poses/anchors without assigning biases or sorting cards.
Static trees, cells and overlay pages retain depth profiles and never join unit/effect uploads. Sprite records
are retained; the ordering refresh creates a UID host map and direct-dock/passing anchor lists, without sorting
them. Particle cards
own a separate pool reset by `applyEffects`, so an asynchronously loaded turret cannot overwrite their anchors.

A same-frame registration-only push replaces metadata on the existing timed snapshot and UID map, retaining
`previous`, `current.at`, object poses and camera endpoints. It invalidates object ordering, not the effects clock.

Asset-free coverage is in `packages/hd-renderer/tests/painterOrder.test.ts`, `dockPull.test.ts`,
`liveBuildingDelivery.test.ts`, `liveOcclusion.test.ts`,
`liveScheduling.test.ts`, `effectBuffers.test.ts`, `effectOcclusion.test.ts`, `projectiles.test.ts`,
`vertexBuffers.test.ts`, and `tests/basic/liveSmudges.test.ts`.
The LiveView regression executes the real push/render/object/effect/order methods with GPU/resource boundaries
replaced, and checks interpolation, unchanged static layers, shroud visibility and particle anchor ownership.
The root `test:unit` entry includes the whole HD renderer test directory. None of these tests claims a live match,
GPU shader execution, exact original-art pixel parity or measured full-match FPS.
