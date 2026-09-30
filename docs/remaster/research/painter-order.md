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
push = max(groundPush, facadePush) + 0.03
depth = geometryDepth - (push - placementPush + traversalBias) / (far - near)
```

Each screen column intersects the two front faces of the foundation extrusion. Owner-relative offsets keep
shifted building animation cards on the same profile. Ordinary trees, infantry and effects use `sFront = 0`:
vertical above their draw point and ground-following below it. This removes frame-padding-dependent tree/explosion
ordering and prevents surrounding ground from cutting the lower rows of a unit card.

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

## Update ownership and regressions

`LiveView` refreshes traversal metadata for a new snapshot, changed registration, art/cell rebuild or visibility
change. An interpolation-only presentation updates poses/anchors without assigning biases or sorting cards.
Static trees, cells and overlay pages retain depth profiles and never join unit/effect uploads. Scratch arrays
and sprite records are retained; the ordering refresh creates no temporary sort arrays or Sets. Particle cards
own a separate pool reset by `applyEffects`, so an asynchronously loaded turret cannot overwrite their anchors.

A same-frame registration-only push replaces metadata on the existing timed snapshot and UID map, retaining
`previous`, `current.at`, object poses and camera endpoints. It invalidates object ordering, not the effects clock.

Asset-free coverage is in `packages/hd-renderer/tests/painterOrder.test.ts`, `liveOcclusion.test.ts`,
`liveScheduling.test.ts`, `effectBuffers.test.ts`, `projectiles.test.ts`, and `tests/basic/liveSmudges.test.ts`.
The LiveView regression executes the real push/render/object/effect/order methods with GPU/resource boundaries
replaced, and checks interpolation, unchanged static layers, shroud visibility and particle anchor ownership.
The root `test:unit` entry includes the whole HD renderer test directory. None of these tests claims a live match,
GPU shader execution, exact original-art pixel parity or measured full-match FPS.
