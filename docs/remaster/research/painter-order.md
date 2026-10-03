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
The body formula was also checked against a supplied native Soviet-refinery Z-buffer dump: 9,316 of 9,370 opaque
pixels matched exactly, with the remaining pixels overwritten by nearer later draws. That validates the native
body formula for that capture, not the HD shader or complete live rendered-pixel parity.

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
candidate = int32(rowBaseline - int8(zShapePixel))
if candidate < existingZ:
    write colour
    existingZ = uint16(candidate)
```

Comparison zero-extends the old ushort, without truncating the new signed candidate before testing it.
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
the width-at-least-eight branch at `0x43D787` suppresses the shape and takes the gradient fallback (height alone does not).
Object height also contributes to the draw's Z offset (`0x43D836`–`0x43D84D`, using height projection
`0x6D20E0`), as does `NormalZAdjust` at type `+0x1520`. Art `Height` is not a body-depth input.
The clipped SHP frame bottom sets the constant baseline; the template supplies its per-pixel correction.

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
| Infantry | Body call `0x5195E2` through `0x41C090`/`0x705E00`: gradient 2 and write=false (`0x5195B5`–`0x5195B8`), normal grounded adjustment `-p(z)-13`. `0x519585` is the conditional INFSHDW shadow call, not the body. |
| SHP vehicles            | Shape call at `0x73C7A7`, flags `0x2E01`: read/test existing Z.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Voxel units | `0x706640` reaches cached `0x707480` or uncached `0x706ED0` compositing. The rasterizer supplies a one-byte color bitmap, not its physical depth map; `0x754510` supplies its bounds. Ordinary flags `0x2800` select test-only gradient 2. Normal ground adjustment is `-p(z)-1`, or `-p(z)-14` for a Harvester on a Refinery cell (`0x7043E1`–`0x704420`). |

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

## Native Z model

`ra2/nativeDepth.ts` implements RA2/YR policy in the same camera-space nearness units as `ra2/cardDepth.ts`.
Smaller native Z is nearer. If ground under the draw anchor has native depth `Zg`, a pixel at native depth `Z`
has `push = (Zg - Z) * G`, where `G = GROUND_DEPTH = sqrt(3) / P`, `P = 60 / sqrt(2)` native pixels per world
unit, and `VERTICAL_DEPTH = G / 3`. Original-screen offsets `px, py` are relative to the draw anchor, with py down.
Geometry still uses its existing placement push for lighting; reconstructed fragment depth cancels that placement
before applying native nearness, `CARD_CLEARANCE`, and the additive traversal/component bias.

A library may provide `depthTemplate: { file, width, height }`: raw bytes already transformed by the extractor
and reinterpreted as signed int8. The engine transform is zero -> zero, otherwise `(raw - 65) & 255` followed by
signed reinterpretation; wrapped values must not be saturated, and zero is a valid depth correction. `LiveLibrary`
validates exact width-times-height byte length and loads one nearest, unmipmapped R8 data texture before sprite
materials are constructed. All atlas pages share it, use integer `textureLoad`, and its library owner releases it.
An absent descriptor keeps the legacy analytic building path; a declared invalid/unreadable payload is an error.

For body, buildup, selling and deploying-body frames, let foundation dimensions be W,H and `pointMove` be mx,my:

```text
A = (198 + mx - 30*(W-H), 446 + my - 15*(W+H-2))
h' = min(frameHeight, templateHeight - (A.y + frame.offset.y))
beta = frame.offset.y + h' - 1
push_body(px, py) = (beta + 1 - Nadj + int8(template[A + floor(px,py)])) * G
```

`building.zShape.pointMove` defaults to zero and is forced to zero while building/selling (native missions 18/19).
`normalZAdjust` defaults to zero; DeployingAnim replaces it with -20 and RoofDeployingAnim with -40.
Only foundation width W>=8 disables the template; those bodies use the gradient-2 card below with `c = 1 - Nadj`.
There is no additional per-row body term. HD samples beyond the template clamp to its edge; native color is clipped
there. Frame opacity still gates depth writes: BUILDNGZ does not fill transparent SHP holes. Neither art `Height`
nor an invented roof/foundation volume enters this formula.

Ground-like parts use `push_ground = (py + k) * G`: BibShape k=2; UnderDoorAnim, UnderRoofDoorAnim and the HD door
interior k=1; DoorAnim k=6. DoorAnim is native test-only and its HD card must not hide passing units.
This requires color order as well as disabled depth writes: a DoorAnim drawn after a unit could still overwrite
that unit's color while its depth test passes against the older body buffer. The HD passes therefore draw bodies
at render order 4, test-only DoorAnim at 4.001, then native ground units at 4.002. Unit cards retain depth writes
for HD internal/overlap ordering. Their sprite child pass and cloned voxel materials use the transparent queue,
so opaque-queue precedence cannot put units before the door; airborne and shadow materials retain their physical
paths. The native ground-unit sprite child shares the main instance buffers and fireball capture codes/registration.
Attached Active/Idle/Special/Production/Super parts, lights and conveyor cards inherit their owner's body template
origin and clipped frame baseline, with the existing small component bias. Draw offsets, including `yDrawOffset`,
are measured back from the owner draw anchor so a shifted animation cannot invent a nearer depth surface.

Ground units use the native upright-card rule:

```text
push_card(py) = (e + c + floor((e - py) / 3)) * G
```

For SHP vehicles and infantry, e is `frame.offset.y + frameHeight - 1`; c=0 for vehicles and c=12 for infantry.
A Harvester's c becomes 13 exactly when its current cell `(floor(x/256), floor(y/256))` belongs to a Refinery
foundation. The library flags `harvester` and `refinery` identify those types. Radio contact, mission, stationary
state, distance from the pad and the traversal order are not predicates for this bonus.

Voxel vehicles and landed aircraft use c=0 or the same harvester bonus. `ra2/voxelNativeDepth.ts` approximates the
native bitmap bottom with the eight projected corners of the posed world-space model AABB, recomputed as pose or
facing changes and including articulated turret/barrel parts, excluding shadow/reflection twins. Building voxel
turrets use their own bottom and `c = -1 - turretVoxel.zAdjust`. With ground draw anchor a, fragment p, view-forward
unit vector F and `py_frag` projected in the same native pixel scale:

```text
Delta = (1 - KAPPA) * (dot(p - a, F) + push_card(py_frag))
depth = physicalDepth - (Delta + additiveBias) / (far - near)
KAPPA = 0.06
```

Keeping six percent of physical distance preserves model-face ordering. Error from the ideal card is bounded by
`KAPPA * max(abs(dot(p-a,F) + push_card(py_frag)))` over the posed model. This is a documented HD approximation to
the native bitmap, not physical voxel tactical depth. Only grounded layer-2 units, including bridge-deck units,
use cards; flight and shadow passes keep their existing depth. Absolute native 16-bit wrap/modulo-three phase and
all special locomotor/effect branches are outside this relative model.

Trees, cell overlays, bridges, effects, decals, shadows, wet reflections and the fireball capture/code policy
retain their prior paths. With no template, buildings retain the analytic foundation facade and voxel turrets retain
their physical depth with the existing facade placement; generic cards still
use the existing ground/vertical profile. The former dock pull/propagation, measured door/roof recess constants and
contained-infantry suppression are removed: the refinery cell bonus, ground planes and opaque native body depth
now decide those overlaps. Synthetic refinery, factory and barracks fixtures check the depth relationships;
shader construction does not establish live WebGPU pixel parity with the player's art.

Sprite instance flags retain their existing interleaved buffer. The stride is 16 floats without capture and 17
with capture; the capture code keeps offset 8. A new vec4 starts at offset 8/9: mode (0 legacy, 1 body template,
2 ground, 3 card), body origin x/y or card bottom/bonus, then body baseline or ground k. The following vec4 holds
owner pixel offsets x/y, the anchor's existing nearness relative to its owner, and draw pass (0 main, 1 test-only,
2 native ground unit). These attributes share the original buffer, so extending the depth profile does not consume
another vertex buffer.
DoorAnim uses a depth-tested, non-writing child pass over the shared geometry and is excluded from fireball capture.

The clearance must exceed the lifted decal plane **at the same screen pixel**. At this camera pitch,
a horizontal plane raised by `h` advances depth by `h / sin(30 degrees)`, not `h * sin(30 degrees)`.
SHP shadows/decals retain their `0.02` lift, and effect decals retain `0.025`; `CARD_CLEARANCE` is
the latter's camera-depth displacement plus `0.01` (currently `0.06`). A `0.03` clearance allowed
ground-following wall pixels to fail against their own or neighboring shadows, leaving dark holes.
Frame selection, wall connection data, placement and shadow opacity are unchanged.

Ground and Air effect cards test reconstructed depth and do not write depth. Native `Layer=air` anims draw
after the whole ground layer. The final P-L5H-3b design replaces round one's terrain pull and round two's global
COVER/FRONT targets with **one surface/code capture followed by a 3x3 reduction**. A whole-object decision belongs
to each **(fire, object) pair**. Rhino 5009 at (63.0, 63.6) is 1.83848 horizontal cells ahead of EXPLOLRG at
(60.8, 63.2), but 0.84853 behind TWLT050 at (64.0, 63.8): it must remain completely in front of the first and be
completely covered by the second in the same frame. A global winner cannot express this.

The RA2 policy in `src/ra2/fireEngulf.ts` now decides capture membership only, immediately before capture, after
interpolated poses, effect records and camera are final (`HdRenderer.beforeDepthCapture`). Active non-flat Air
explosion/collapse cards use the current/same-page-next crop union (`effectDisplayBounds`), including HD display
scale/merge growth without the fallback sphere cap. Proximity retains the union's half-diagonal plus 0.75 cells
and a conservative object circle plus 0.75. SHP bounds include all owner parts across pages; voxel bounds include
part bounding spheres/centres and articulated offsets. Foundations and building turrets contribute their extents.
`EffectsLayer.appendExplosionFootprints` also contributes at most seven reusable pool circles over alive explosion
garnish, including shader motion; delayed/unborn, expired and muzzle/electric/continuous-fire particles do not
activate capture. This keeps membership alive after a native card ends. Over-inclusion only adds capture work.

Units/infantry/parked aircraft anchor at the current voxel root or SHP ground draw point, with height/bridge
placement. Buildings use the foundation centre (NW plus half dimensions) and body's ground height; missing
foundations use 1x1. Flying aircraft retain their original independent layer and are excluded (native flight
layer or height > ground + 0.01). Every component of an owner receives its anchor code. No global class is stored.

The frame reference is `IsoCamera.target`, near the view centre. Normalize the horizontal camera direction
independently of elevation, then `code = dot(anchor.xz - reference.xz, horizontalToCamera)`. Fire cards use their
instance anchor; core/blast/halo/billow/column/spark/ember garnish uses its own **current** x/z, including drift,
ballistics and ember wobble. Terrain-class meshes use `ALWAYS_COVER_CODE = -1024`; excluded sprite instances use
`NOT_CAPTURED_CODE = -65504`, discarded only during capture. Rebase before membership/uploads on every pipeline
render, including benchmarks. For normal half-float products, with unit roundoff `u=2^-11`, the absolute bound after
RG16F encoding, R/G decoding and the reduction's further half-float code store is
`abs(code) * ((1+u)^2/(1-u) - 1) + 2^-20`: <0.011728 cells for |code|<=8, <0.046907 for |code|<=32. Large absolute map
coordinates do not enter this bound. Wider views/large footprints increase |code| and the bound; there is no
claim of <0.05 precision at arbitrary zoom. Codes near the 1.5-cell boundary have this quantization uncertainty.

`HdRenderer.terrainDepth` (`src/terrainDepth.ts`, original public name retained) owns one layer-31, drawing-buffer-size,
single-sample capture: blendable **RG16F (`rg16float`) + depth32float**, colour cleared to (0,0), depth to far. It
captures tree mains, fallback cell mains, library overlay mains, and every near unit/infantry/building. Original
materials, alpha tests/discards, position/depth nodes and painter bias preserve true surface depth, without an
override material. Voxel registration touches only explicit body/turret/barrel `partMeshes`; layers and prior mesh
userData are restored on removal/disposal, with shadow/reflection/foam/glow twins excluded. Shared voxel materials
read the code via an object-group uniform from the **rendered mesh's userData**, never a shared material constant.
Sprite mains retain the capture scalar at flags offset 8; native depth extends the stride to 17 floats (16 without
capture). Code/kind varyings are flat. The `objectDepthCaptureEnabled` object gate discards excluded/non-upright
instances only in the actual capture target/camera. Native unit children share capture registration and instance
codes; under/over and test-only children never join capture. Sprite paths retain six vertex buffers: main/unit
capture uses 11 attributes (10 without capture), ground passes at most 10.
Native/HD Air effect cards retain six buffers/eight attributes.

Capture colour alone is replaced through a capture MRT: source `R=code*a`, `G=a`, with original source alpha `a`.
NormalBlending's RGB source multiplier is `b=a`, hence over clear `R'=code*a*b`, `G'=a*b` and `R'/G'=code` in exact
arithmetic. Same-anchor overlapping parts preserve this ratio; different anchors already blended at one pixel
produce a weighted code mixture (not an exact owner ID). Half-float error is bounded above for normal products.
r186 normally truncates an RG MRT shader output to vec2 and loses source alpha. The capture-only `CaptureMRT`
keeps a **vec4 shader output** for the RG16F attachment, retaining alpha for blending while storing only R/G.
It reads `diffuseColor.a` before that truncation. Materials and ordinary main/mirror MRTs are never modified.
Implementation evidence: three.js 0.186.1 `MRTNode.setup`, `NodeMaterial.setup`, `WebGPUTextureUtils.getFormat`, and
GPUWeb CTS `src/webgpu/api/validation/render_pipeline/fragment_state.spec.ts` (vec4 output is compatible with RG
and alpha-dependent blending requires four output components).

One fullscreen reduction writes **two RGBA16F (`rgba16float`) MRT attachments, no depth attachment**. Clamp all
nine neighbour coordinates at the drawing-buffer borders; ignore depth>=1 or G<=0. Record A selects the centre
texel's decoded code when captured, otherwise the nearest captured texel's code. Record B selects the nearest
captured texel whose code differs from A by more than **OBJECT_CODE_TOLERANCE=0.1 horizontal cells**, or is invalid.
Each attachment stores R=sMin, G=sMax over only texels within that tolerance of its own selected code, B=code,
A=valid; an invalid record is all zero. Equal nearest depths keep the first texel in row-major order. This keeps
the centre bush and the adjacent in-front tank as separate records instead of letting one erase the other's
decision. A COVER tank in front of a centre bush similarly retains its own conservative pull. Codes are anchor
groups, not unique IDs: always-cover terrain shares -1024, and a third distinct group is not retained.
Distances are `near + depth*(far-near) - depthReference`, where depthReference is the camera-space distance
to the view-centre reference (150 cells in IsoCamera). Relative depths over the 0.1..400 camera range lie in
[-149.9,250), giving at most 0.0625-cell half-float rounding. Reconstructed normalized depth is `(s+reference-near)/(far-near)`.
Use camera-space **CAP=2 cells, eps=0.2 cells**:

```text
For each valid record i:
  spread_i = min(sMax_i - sMin_i, CAP)
  cover_i = code_i - fireCode < FRONT_DISTANCE (1.5 horizontal cells)
P = min over cover records of (sMin_i - spread_i - eps), or +infinity
Q = max over front records of (sMax_i + spread_i + eps), or -infinity
depth = min(max(base, normalized(Q)), normalized(P))
No valid records: base exactly
```

Each eligible main-pass fire fragment makes **two textureLoads**, one per reduction record. Terrain's sentinel
always contributes a pull. If Q>P, a covered surface lies in front of an in-front object: the covered surface is
the visible front, so applying P last makes cover win. Absent sides are unbounded (GPU flags skip their clamp).
With a centre bush behind a FRONT tank, the fire's own card depth can be behind the bush; combining its pull
with the tank's push places the fire between them. A single tank push cannot bring that base forward and leaves
a one-pixel bush ring. Using the centre alone would instead leave COVER tank edge samples visible.
The base sphere/ground rim/legacy merge max-combination remains unchanged where there is no captured surface.
With MSAA, different samples of an edge pixel can retain different triangles' pixel-centre frag_depth values,
including extrapolation outside a triangle. The 3x3 window finds adjacent triangle centres, and one extra local
spread bounds their extrapolation when it is <=min(spread,2). eps covers depth-format rounding plus the worst
`2*sMin-sMax` / `2*sMax-sMin` half-float error (3*0.0625=0.1875 cells) and D24 rounding (~0.000024 cells).
CAP limits excessive pull/push across depth discontinuities within each code group; different groups do not
widen each other's spreads. This is a conservative local bound, not a
mathematical guarantee for triangles absent from all nine single-sample texels, or extrapolation beyond CAP.
Synthetic shallow/steep edge tests exercise the bound; real 4x GPU silhouettes and internal part edges remain
separate acceptance. Nearby different-owner depth/code discontinuities and transparent code mixtures also need
pixel review.

The same round-one non-flat Air cards (including translucent/other Air art) and explosion garnish use this main-only
combination. Existing spark mode 4, negative ember temperatures, and halo/core tags keep shared pools gated.
Ground/Top/flat/shadow cards, ground garnish, beams/projectiles, muzzle/electric/continuous-fire garnish and
`volumetricBlasts.ts` retain their original policies. Both object-group gates check the actual target/camera after
r186 nested reflector `updateBefore`; capture, mirror and other renders get no main pull, and resumed main draws
recompute the gate. WebGL2 omits capture/reduction samplers. If no qualifying Air card and no explosion garnish
is alive, **skip capture, clears and reduction entirely**, invalidate readiness and leave the pull off.

HdRenderer owns resize/disposal independently of pipeline rebuilds. Target/cube face/mipmap/MRT/clear colour/alpha/
depth/auto-clear/background are restored after either capture or reduction, including failure. Storage is
4 (depth32float) + 4 (RG16F) + 2*8 (RGBA16F) = **24 bytes/pixel**, **86,400,000 bytes (86.4 MB, 82.40 MiB)** at
2400x1500, excluding existing scene attachments and driver allocation overhead. The second record adds
**28,800,000 bytes (28.8 MB, 27.47 MiB)** to the prior 57.6 MB format estimate (+50%); the approximate 60 MB goal
grows by 26.4 MB. Both records retain the documented half-float depth/code precision without packing.
Cost on active frames: one scene
capture over terrain and near object parts/batches, one fullscreen reduction with nine depth and nine code loads,
and two reduction loads per eligible fire fragment. One extra sprite scalar, no extra vertex buffer. CPU work is
footprint collection (active garnish pools scan their allocated slots) plus objects times active card/pool circles;
scratch records are reused, and unchanged no-fire frames skip owner uploads. This is not measured GPU timing.
`objectDepth.ts` exports pure reduction/combination/encode/decode/precision twins. CPU tests cover the measured
per-pair case, hull/turret/barrel volume, SHP drone, terrain corners, MSAA extrapolation, the bush ring with base
behind the bush, COVER tank over a centre bush, conflicting COVER tree/FRONT unit, two FRONT units, ownership
tolerance, blending, formats/memory,
gates/lifecycle and actual r186 WGSL/buffer layouts. GPU execution, five-blast XMP29U2 pixel review and same-scene
performance remain UNVERIFIED by those tests.

High-bridge cards use a horizontal plane at `4 * LEVEL_HEIGHT`; neighboring pieces have identical depth at the
same screen pixel. Their draw offsets remain unchanged. Grounded unit cards anchor on the deck while their shadow
twins and flat decals retain their physical ground-depth paths.

Traversal bias remains independent of scene population: registered index i contributes `0.01 * i / (i + 32)`
with small layer/component increments bounded by `0.04`, additive to the native depth above. Foundations do not
take a registration bias. Ground fallback effects keep their small positive tie break. There is no global NDC
slot band; finite GPU precision can still collapse long equal-depth registration lists, and arbitrary native
translucency ordering across atlas pages is not reconstructed. Fog/shroud use the separate geometry-depth
attachment; their post-processing contract is unchanged.

## Delivery images and native state evidence

The renderer retains the existing delivery-image selection and reader publication contracts. Contact/dock fields
remain available to consumers, but they no longer determine a unit's nearness adjustment.

YR 1.001 policy stays in `src/games/yr`:

- RadioLinks is `VectorClass<TechnoClass*>` at `+0xE0` (observed vtable `0x7E180C`), with Items `+0xE4` and Capacity
  `+0xE8`. GetNthLink `0x65AD40` indexes Items; ContainsLink `0x65AD50` scans Capacity entries. Contact ID publication
  requires capacity `1..64`, plausible pointers/spans, and link 0 belonging to the validated objects of this snapshot.
- BuildingType flags are UnitRepair `+0x16A9` (INI store `0x460929`), Refinery `+0x16BB` (`0x460A6C`), and Helipad
  `+0x16CB` (`0x4604E0`). Their validated OR defines `dock`. WeaponsFactory `+0x16BD` (`0x460A8C`) alone is not a dock:
  GAWEAP/NAWEAP/YAWEAP have radio links to newly produced units but must keep them behind the factory facade.
  These fields describe native docking/delivery state; the renderer depth bonus uses library Refinery/Harvester flags.
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

| Frame       | Current / queued mission | Link 0 | SHAD Z (leptons) | Original drawing                                                                                       |
| ----------- | ------------------------ | ------ | ---------------- | ------------------------------------------------------------------------------------------------------ |
| 9171        | 5 / 16                   | SHAD   | 208              | Closed roof.                                                                                           |
| 9184 / 9208 | 16                       | SHAD   | 208              | RoofDeployingAnim; heli parts visible inside the opening.                                              |
| 9235        | 16                       | NULL   | 368              | Roof still open; heli rising out. The previous HD reader selected door and hid it under a closed roof. |
| 9278        | 5                        | NULL   | 798              | Roof still open for an unexplained reason; intentionally outside this Unload latch.                    |
| 9342        | —                        | —      | —                | Closed in original and HD.                                                                             |

These are supplied native observations, not new HD rendered-pixel acceptance. The mission-5 discrepancy at 9278
remains `UNVERIFIED`; the latch deliberately ends there.

The factory's delivery art is a body image substitution, not an attached AnimClass. Art loaders store DeployingAnim
`+0x14E4` at `0x45F3A7`, UnderDoorAnim `+0x14EC` at `0x45F5DF`, RoofDeployingAnim `+0x14FC` at `0x45F47F`, and
UnderRoofDoorAnim `+0x1504` at `0x45F78B`. DrawIt `0x43D692..0x43D6D3` / `0x43D7D2` substitutes the deploying shape
(native Z adjust -20, roof -40); `0x43D7A7..0x43D7EE` selects
`min(GetCurrentFrame(B), trunc(i16[SHP+6] / 2))`, without subtracting one from that cap.
`0x43D8EE..0x43D9C9` and roof `0x43D9D8..0x43DA67` then draw the under-door section at yellow-damage frame 1, else 0.

This replacement lasts for the entire effective Unload mission, including after link 0 becomes NULL and while
the logical door closes. Ground delivery remains `unloading='door'` without a contact. DoorClass moving/target-open
bytes `+0x368/+0x369` and its timer (`+0x358/+0x360/+0x364`) do not drive the deploying SHP frame. The ordinary
factory body getter keeps stage `+0xF8` and mode `+0x534`, applying the existing damage-bank offset; Unload does
not reset the stage. State 3 holds while `+0x418` is nonzero, starts closing at `0x44E202..0x44E22B`, and state 4
requests Guard only after closure (`0x44E233..0x44E25A`). A separate DoorAnim is absent from the supplied ordinary
factory definitions; any configured legacy DoorAnim follows its own progress rule. The persisted roof latch above
is a separate observed compatibility policy, not proved by the null-contact branch of DrawIt, which defaults to
ground delivery.

`LiveView.libraryBuildingSprites` uses those library key pairs while a completed building reports `unloading`.
It uses `SpriteEntry.frameCount` for the native inclusive half-count cap; legacy entries without that metadata
fall back to foreground plus shadow array lengths. The source frame exactly at the half boundary addresses the
first shadow-half frame, rather than clamping to the last foreground frame. It substitutes the replacement
shadow and queues the healthy/damaged under-door frame at the same draw anchor with the existing palette/remap
routing. Missing/empty pairs retain the normal body.
The replacement body receives the BUILDNGZ baseline with Nadj -20/-40; both under-door interiors use gradient 0,
k=1. Body posts remain depth writers while the floor plane admits a nearer unit card.

The earlier measured `DOOR_RECESS = 2.75` / `ROOF_RECESS = 4` and `foundationRecess` encoding are removed.
Those fits used the former analytic box; native UnderDoor depth has no such recess or art `UnderDoorAnimZAdjust`
consumer in the traced path. Similarly, infantry are no longer hidden by a rectangular containment index. Their
c=12 cards test the opaque body depth, allowing front stairs to differ from the foundation centre without hiding
an entire visual, its shadow and every attached part. Transparent art alone writes no building Z.

An accompanying native NAWEAP/Rhino trace observed CurrentMission `5` with QueuedMission `16` when the tank appeared
(door still closed), then CurrentMission `16` thirteen logic frames later with link 0 pointing at the tank inside
the foundation. Mission `16` persisted for about five seconds during drive-out; link 0 was released after the unit
left the foundation, then mission returned to `5` and the door closed. This supports effective-mission gating and
keeping the door image through link release. It is native-state evidence supplied with this task, not live HD
rendered-pixel acceptance of the implementation.

## Native draw eligibility and body translucency

These predicates are from the pinned YR 1.001 executable. The reader evaluates validated pointers and fields;
the bridge forwards generic optional `nativeHidden` and `translucent` fields, and LiveView never calls guest code.

Unit wrapper `0x73B0B4..0x73B121` skips the complete render when tether byte `U+0x418` is nonzero, link 0 is a
validated building, and either its effective mission or queued mission is Unload 16, with canonical door booleans
`B+0x368/B+0x369` (each 0 or 1). The four door predicates exhaust opening, closing, open and closed; this is not an
openness threshold. Building validation checks its object/type spans, vtables and type ID independently of
whether InLimbo or snapshot filtering omits the linked building from publication; `contactUid` remains limited to
published contacts. Effective mission uses `B+0xAC`, falling back to `B+0xB4` only when current is -1. Queued
Unload can therefore hide a tethered unit before it selects the factory's replacement body. `nativeHidden=true`
suppresses the whole HD visual, including shadows and owner extras, through the same visibility gate as
InvisibleInGame art. Selection brackets and health bars remain native overlay pixels; LiveView does not generate
selection geometry, and the bridge preserves `isSelected` as state rather than altering native input/selection.
Owner-attached anims, particle systems and fire events are suppressed only when both UID and pointer match the
hidden owner, including same-frame hide/unhide changes. Independent explosions and projectiles retain their
native publication lifetime.

Chrono bytes BeingWarpedOut `U+0x270` and WarpingOut `U+0x271` are a different rule. If either is nonzero,
`0x73B259..0x73B275` ORs flag `0x4` into the body draw. The ordinary uncloaked combination selects
`BlitTransLucent50AlphaZRead`, whose pixel loop at `0x495165..0x495178` halves and adds source/destination colors.
The reader publishes `translucent=0.5`; HD applies that opacity to SHP/voxel body parts without changing their
shadow opacity. The translucent body does not write depth. Clearing the flags restores ordinary body rendering.
These bytes alone are not invisibility flags, and this does not establish every cloak/blend combination.

No CMIN-specific hard-hide interval is proved: normal teleport's harvester exception clears `+0x271` and its timer
at `0x719580..0x7195B6`. Refinery docking sends Unload to the miner, not necessarily the building, so neither rule
is a verified explanation for a reported missing miner. Live original/HD comparison remains `UNVERIFIED`.

## Last destroyed-building visual

The reader has no Health > 0 filter; zero-HP buildings can still be reported while eligible. Native removal first
clears marked byte `+0x74` and tactical membership (`0x5F4D6D..0x5F4D79`), then sets InLimbo `+0x81` at
`0x5F4E9E`, which excludes the building from the default reader. The native building render wrapper itself requires
marked and !InLimbo (`0x43CED1..0x43CEE4`); this is not a proved state where an InLimbo object keeps drawing.

Normal rendering at `0x55D8F2` precedes Logic AI at `0x55DC9E` and the logic-frame increment at
`0x55DE73..0x55DE81`. A previously painted body can therefore remain in the native framebuffer after the reader
observes its removal. However, the wait path can render again after the increment (`0x55E271 -> 0x4F4480`), so a
fixed one-frame picture lag is not established.

LiveView uses a bounded presentation heuristic: a drawable building not selling or explicitly hidden keeps
its last visual only for the first missing snapshot's logic frame, provided that frame is no more than one tick
after its last observation. It expires as soon as that missing frame advances; same-frame polls do not extend
the lifetime, and larger frame gaps or a rollback do not resurrect it. Pointer/UID replacement cancels the old
visual. The cached descriptor and body frame stay frozen; no freed native pointer is read. Positive last-sampled
health is eligible because lethal damage and removal can both occur between polls, without publishing HP=0.
Explicit selling/hidden states remove the cached visual immediately. This one-tick cache has synthetic regression
coverage, including actual LiveView body/shadow queuing and disposal, but exact last-picture parity is
`UNCERTAIN`, and live acceptance is `UNVERIFIED`. Exact parity would need coherent render descriptors tied to the
native image's presentation boundary, not arbitrary post-logic polling or an invented multi-tick death timer.

## Update ownership and regressions

`LiveView` refreshes traversal metadata for a new snapshot, changed registration, art/cell rebuild or visibility
change. An interpolation-only presentation updates poses/anchors without assigning biases or sorting cards.
Static trees, cells and overlay pages retain depth profiles and never join unit/effect uploads. Sprite records
are retained; refinery foundation cells are indexed from current type/position data, independently of radio
links. Particle cards own a separate pool reset by `applyEffects`, so an asynchronously loaded turret cannot overwrite their anchors.

A same-frame registration-only push replaces metadata on the existing timed snapshot and UID map, retaining
`previous`, `current.at`, object poses and camera endpoints. It invalidates object ordering, not the effects clock.

Asset-free coverage is in `packages/hd-renderer/tests/painterOrder.test.ts`, `nativeDepth.test.ts`, `voxelNativeDepth.test.ts`,
`depthTemplateLibrary.test.ts`,
`liveBuildingDelivery.test.ts`, `liveOcclusion.test.ts`,
`liveScheduling.test.ts`, `effectBuffers.test.ts`, `effectOcclusion.test.ts`, `projectiles.test.ts`,
`vertexBuffers.test.ts`, and `tests/basic/liveSmudges.test.ts`.
The LiveView regression executes the real push/render/object/effect/order methods with GPU/resource boundaries
replaced, and checks interpolation, unchanged static layers, shroud visibility and particle anchor ownership.
The root `test:unit` entry includes the whole HD renderer test directory. None of these tests claims a live match,
GPU shader execution, exact original-art pixel parity or measured full-match FPS.
