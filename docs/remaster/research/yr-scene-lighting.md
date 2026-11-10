# Yuri's Revenge scene lighting and light sources

Reverse-engineering notes behind `packages/ra2-assets/src/lights.ts` (the `lights.json` sidecar) and the HD night
presentation in `packages/hd-renderer` (`src/lightField.ts`, `src/ra2/mapLights.ts`, `src/ra2/nightDressing.ts`).
Baseline: the player's own `gamemd.exe`, Yuri's Revenge 1.001 (sha256 `7b8a0685…`), read with the repository's MIX/INI
loaders; no third-party data. Addresses are virtual addresses in that executable.

## Where the numbers come from

| What | Address | Behaviour |
| --- | --- | --- |
| `ScenarioClass::ReadLighting` | 0x68A7F8..0x68AC9A | Reads `[Lighting]` with the CRT `atof` on the leading numeric prefix (`0,01` reads 0, `.5` reads 0.5). Stores Ambient/Red/Green/Blue (and the Ion and Dominator variants) as `int(v * 100 + 0.01)` percent, Ground/Level as `int(v * 1000 + 0.01)` per-mille; x87 `_ftol` truncates. |
| `ScenarioClass` constructor | 0x6838D3..0x6839B7 | Defaults for missing keys: Ambient 1, Red/Green/Blue 1, Ground 0.05, Level 0.008; IonAmbient 0.87, Ion RGB 0.30/0.40/0.75, IonGround/IonLevel 0; DominatorAmbient 1.5, Dominator RGB 0.85/0.20/0.30, DominatorAmbientChangeRate 0.001. DominatorGround/Level are explicitly zeroed at 0x6839B1/0x6839B7. |
| `BuildingTypeClass` light keys | 0x460C8C..0x460DC4 | `LightVisibility` (int, leptons), `LightIntensity`, `LightRedTint`/`LightGreenTint`/`LightBlueTint` stored as `int(v * 1000 + 0.1)`. |
| `BuildingTypeClass` constructor | 0x45DE12 | `LightVisibility` 5000; the tints stay at 1000.0 (per-mille 1000000) when a type sets `LightIntensity` without tints. Kept as is. |
| Light source creation | 0x440D6C, 0x4466D5 | A building creates a `LightSourceClass` only when `LightIntensity != 0`, centred on its foundation: (256x + 128w, 256y + 128h, 104z) leptons. TerrainTypes (TIBTRE ore trees) carry the keys but get no light source. |
| Cell lighting | 0x484180 (full), 0x484680 (incremental) | See the formula below. Both keep three fields per cell: `+0x10A` = I (clamped 0..2000), `+0x10C` = I x M / 1000 (terrain), `+0x10E` = the same for the bridge level (z + 4). `+0x108` holds the summed light-source intensity, `+0x104` M x 65.536. |
| Tint normalisation | 0x5558E0 | Divides the summed tint by its largest channel. |
| Object brightness | units 0x73D06C/0x73D0B4, infantry 0x51940F/0x519444, aircraft 0x41491E, buildings 0x43D163..0x456E38 | Read the cell's `+0x10A`: I alone, without the tint and without its largest channel M. Units and infantry under a bridge cell (flag 0x10000) take -500; on a bridge + 4 x Level; aircraft and airborne infantry + Level x height. |
| Terrain brightness | cell draw 0x47F9F6..0x47FB41 and the overlay/smudge/terrain-object draws | Read `+0x10C` and draw through the tinted converter. |
| Extra object light | rules reader 0x66B69E..0x66B74E; uses 0x73D0C9, 0x519457, 0x41492A | `[AudioVisual]` ExtraUnitLight / ExtraInfantryLight / ExtraAircraftLight as `int(v * 1000)` at RulesClass `+0x17D4/+0x17D8/+0x17DC`, ADDED to the cell value. Buildings add nothing. |
| Light source list | vector items 0xABCA14, count 0xABCA20; constructor 0x554760; switch 0x554A60/0x554A80 | `LightSourceClass` (vtable 0x7ED028, 0x4C bytes): `+0x24` intensity, `+0x28/+0x2C/+0x30` RGB tint, `+0x34` DetailLevel (2), `+0x38` position, `+0x44` LightVisibility, `+0x48` Activated. The cell relight skips a light that is switched off or whose DetailLevel exceeds the game's detail setting (0xA8EB78; 0x484294..0x4842AA). A building keeps its light at BuildingClass `+0x614`. |
| Shade rows | converter creation 0x544F1E, table builder 0x556090, blitter lookup 0x420140 | A lighting converter has 53 shade rows when the normalised tint's channels sum to 2000 per mille or more, else 27. Row s multiplies the palette by 2 s C / (rows - 1) per tint channel C, so one row is 1/26 of the palette at 53 rows. The blitters pick the row as `lo x hi x (rows - 1) / 32258`, truncated (127 is the neutral byte). |

The map's own sections override `rulesmd.ini` for every key above (scenario INIs are merged over rules).

## Per-cell formula (engine units, per-mille integers)

For a cell (x, y) at height level z, with centre (256x + 128, 256y + 128) in leptons, and every light source l with
radius r (LightVisibility), intensity I_l and tint t_l:

```
d  = trunc(hypot(dx, dy))                      light height ignored
f  = floor(1000 * (r - d) / r)                 when d <= r, else the light does not contribute
I  = 1000 * Ambient + sum(I_l * f / 1000) + Level * z - Ground         clamped to [0, 2000]
R,G,B = 1000 * (Red, Green, Blue) + sum(t_l * f / 1000)                each clamped to [0, 2000]
M  = max(R, G, B);  M * 65.536 < 66 gives a black cell
intensity = min(2000, I * M / 1000);  tint = (R, G, B) / M
```

Integer divisions truncate towards zero (negative lights such as `NEGLAMP` darken). `engineCellLight` in
`packages/ra2-assets/src/lights.ts` is an exact port, covered by `packages/ra2-assets/tests/lights.test.ts`.

`intensity` and `tint` above are what terrain is drawn with: palette x I x M x tint, in other words the palette times
I times the absolute Red/Green/Blue. Objects are drawn with I itself (`CellLight.level`) plus their extra light, no
tint and no M. The two differ on every map whose largest tint channel is not 1: with Red/Green/Blue 0.8/0.8/0.75
(HillBtwn) terrain shows at 0.8 I while a building shows at I; with 1/1/1.5 (XMP30S6) terrain shows at 1.5 I on the
blue channel; and under a light type that sets `LightIntensity` without tint keys (the constructor's 1000.0, which
saturates all three channels at 2) the terrain field doubles while objects only gain the light's intensity.

Neither is applied continuously: the draw picks a shade row (table above). `engineShade` models that for terrain as
`trunc(trunc(I x 127) x 127 x 52 / 32258) / 26`. The table builder and the lookup are from the executable; the step
from the 0..2000 intensity to its light byte was not located and is taken as `trunc(I x 127)`. Frozen native frames
support the truncation: an exact-intensity render of the same instant measured 1.03-1.04 of the native ground at
terrain intensity 0.98 and 0.77 (Fight, DeepFrze), 1.06-1.09 at 0.68-0.76 (XMP06T2, HillBtwn, XXmas) and 1.13 at 0.57
(Transylv); truncation plus the loss of the 16-bit surface on dark colours predicts 1.04, 1.03, 1.065-1.075 and
1.095, exact intensities predict 1.03-1.05 throughout, and rounding predicts the darkest map below the brightest.
Objects keep the continuous level (they add their extra light before the row is picked and their level is sampled
between cells).

## Stock scenarios

`gameres/hd-cache/_research/night-lights/all-scenarios-lighting.tsv` (derived from the player's install, not in Git)
lists the `[Lighting]` of every stock scenario and multiplayer map found in the install's MIX archives. Ambient,
rounded to 0.1, over the 220 entries with a `[Lighting]` section:

| Ambient | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scenarios | 5 | 28 | 66 | 40 | 77 | 2 | 2 |

The non-lunar 0.6-0.72 group are the maps built as night maps: blue or neutral tints, lamp-post light sources
(`INYELWLAMP`, `INGALITE`, `INBLULMP`, `SNONITLAMP`) and `NEGLAMP` darkening. Lunar maps share this low ambient range
but use dim airless daylight rather than the night presentation. Examples:

| Map (source) | Theater | Ambient | R/G/B | Ground | Level | Light sources |
| --- | --- | --- | --- | --- | --- | --- |
| sov07tmd.map (mapsmd03.mix) | temperate | 0.55 | 0.40/0.40/0.70 | 0 | 0.003 | INORANLAMP x2, NEGLAMP x4, INYELWLAMP x10 |
| XMP06T2 "Urban Rush" (multimd.mix) | temperate | 0.60 | 1/1/1 | 0 | 0.039 | INYELWLAMP x8 |
| Transylv.yro | newurban | 0.60 | 0.9/0.9/1.0 | 0.05 | 0.008 | INBLULMP x4 |
| multimd.mix a6506e58 | snow | 0.68 | 0.75/0.75/1.2 | 0 | 0.028 | INGALITE x8 |
| amazon.mmx | temperate | 0.68 | 0.68/0.80/1.0 | 0 | 0.029 | NEGLAMP x4, INYELWLAMP x5 |
| sov06lmd.map (mapsmd03.mix) | lunar | 0.70 | 1/1/1 | 0.05 | 0.008 | INBLULMP x5, TEMNITLAMP x3 |
| multimd.mix 629413d | snow | 0.75 | 1/1/1.5 | 0 | 0.008 | INGALITE x10 |

Warm mid-ambient maps (for example multimd.mix ac956741, Ambient 0.73 with 1/0.92/0.8) read as dusk. The two cached
maps are day maps: XMP29U2 "The Alamo" (1, 1/0.8/0.68, Ground 0, Level 0) with seven `INGALITE` lamp posts at cells
(59,68) (72,68) (70,51) (58,51) (29,47) (64,13) (58,110), and RiverRam (0.9, 1/0.9/0.9, 0.05, 0.008) with eight inert
`TIBTRE02` ore trees and no light sources.

`INGALITE` (`InvisibleInGame=yes`, LightVisibility 4000, LightIntensity 0.5, tint 0.05/0.05/0.01) is a strong light:
at its centre it adds 0.5 to a night map's ~0.6-0.7 ambient. The engine never draws it; the visible `GALITE` post uses
the same art (`gglite.shp`).

## HD mapping

- `mapAtmosphere`: outside theater `lunar`, the night class comes from the object level the game shows at the map's
  median height, `eff = Ambient - Ground + Level * medianZ`, and the tint, with lamp posts (positive
  `InvisibleInGame` light sources) as evidence: night when `eff <= 0.72`, or `eff <= 0.76` with a blue tint or with
  two or more lamp posts (unless the tint is warm); dusk when the authored base `Ambient - Ground <= 0.76` with a warm
  tint; day otherwise. An earlier classifier left `Level * medianZ` out so that maps "built as night maps" with raised
  ground stayed night (XMP06T2, 0.60 + 0.039 x 4 = 0.756; XMP13S4, 0.68 + 0.028 x 5; amazon.mmx, 0.68 + 0.029 x 6).
  Frozen native frames show that the game does not draw those dark where players stand (next section), so the height
  term is back in the class. `packages/ra2-assets/tests/lights.test.ts` checks the real values of sov07tmd, Transylv,
  NOWIMPS, XTN01T2, XXmas and XMP06T2 with its lamp posts (night) and of XMP13S4, amazon.mmx, XDeadman, XMP15S4,
  XMP29U2, RiverRam and invasion.mmx (day). Renderers recompute the profile from the sidecar's raw data
  (`sidecarAtmosphere`), including the theater, so sidecars written by an older classifier stage maps the current way.
  Theater `lunar` takes the airless day profile described below; an omitted theater retains the terrestrial classifier.
- The class does not decide brightness. The engine's cell light (`MapLightGrade`) is the map on every class at its
  authored staging; a night map is a day map (same keys, exposure, display transform and look, at noon or at the look
  preset's hour) whose keys carry a night dressing weight of 1: lit windows, lamp heads and HD street lamp pools. The
  moonlit presentation of the next two items is what an hour forced to night shows on any map.
- Linear light from engine brightness: `engineToLinear(e) = 0.30 * (e / 0.62)^2.2` (the palette scales display
  values, so linear light scales by v^2.2); a typical stock night (0.62) shows unlit ground at 30 % of noon. The
  profile's `nightLevel` is clamped to 26-40 % of noon; it sets the moonlit keys of a forced night.
- Light sources at the authored staging are part of the grade (the engine's formula, per cell). In a live match the
  grade takes the game's own active list (`readYrLightSources`, the LightSourceClass vector above), so it also holds
  on maps without a light sidecar and follows lights the engine switches off; the sidecar's type table on the standing
  buildings is the fallback.
- Light sources under a forced night: the engine grid's difference to the unlit grid is added as irradiance, staged
  by the map's class (`mapLightStaging` in `packages/hd-renderer/src/ra2/mapLights.ts`), with the gain of the moonlit
  night weight. Night maps get the engine exactly (full
  `LightVisibility`, linear falloff, full strength, at the night ambient `nightBaseAmbient`): their mappers tuned
  lamps and `NEGLAMP` darkening for that formula. Dusk maps keep sources in the full engine grade at their authored
  hour; their separate field follows night gain only when the hour is forced towards night and the grade fades out.
  A day map forced to night is an HD presentation choice, not the engine:
  with the full 15.6-cell radius the seven `INGALITE` washes on XMP29U2 lit the park lawn to 0.77 of noon, a floodlit
  field, while the moon alone gives 0.26; there each source is a pool (0.45 x `LightVisibility`, the engine falloff
  squared via `engineLightDelta`'s `falloffPower`, 0.8 of the engine's strength): about 3.1x the moonlit ground at the
  post, 1.5x three cells out, nothing past seven.
- The night keys aim 1.15x above the night level (`NIGHT_TONE_COMPENSATION` in `packages/hd-renderer/src/lighting.ts`)
  to offset the Neutral tone mapper's toe, so the displayed ground keeps the intended fraction of noon. Moonlight is
  cool (`MOON_TINT`) on every map; a map's `[Lighting]` tint stays in its grade.
- Objects take the light field's local lights (a forced night's sources, HD lamps, fires) at half saturation
  (`OBJECT_TINT`), a compromise with the engine's untinted object lighting.
- The renderer applies the engine's cell light itself (`packages/hd-renderer/src/ra2/mapLighting.ts`): per
  cell `engineCellLight` with the map's `[Lighting]` and light sources, multiplied into the palette colours in their
  own sRGB scale: the shade row of I x M times the normalised tint for terrain-class art, the object level I (the
  texture's alpha) plus the extra light for objects, as the engine draws them at all times. Checked on XMP29U2
  against same-moment captures: terrain 1.00/0.81/0.66 of the palette per channel, 1.345x next to the `INGALITE`
  posts (1.340 predicted; one shade row is 0.038). Its weight is 1 below a night weight of 0.1 (`gradeNight`; a look
  preset's afternoon hour carries 0.067) and fades to 0 at a full forced night, on day and night maps alike.
  Authored dusk keeps weight `1 - night` and source share 1 at its map hour whatever a look's day-map source share
  (1 in every preset; a reduced share darkens everything near a lamp post, next section). On airless lunar maps this
  grade owns the ambient, tint and map light sources, while their sun/sky keys stay neutral and do not multiply in the
  ambient again.
  `mapLightMultipliers` in `packages/ra2-assets/src/iso.ts` (offline previews) uses the same formula.

## Same-frame evidence against the game

Frozen pairs of the owner's game in the play configuration (cinematic look, `hd-vlook=remaster`,
`hd-vproj=vehicles-hd`, window 1728x1080 at device scale factor 2, normal game speed): the VM is held on one logic
frame, the HD picture is captured at device pixels and the native frame is read from the game's own 16-bit
framebuffer. Regions come from the frozen snapshot's object list and from the native frame only: ground = unshrouded
pixels away from every object, vehicles = the pixels of tight boxes on vehicles that differ from the ground around
them, yard = the pixels the deployed Soviet construction yard changed. Numbers are HD / native of the mean Rec.709
luma on display code values, and the ground's hue and CIELAB a* / b* shift. They are observations of one base per
map, not asset-free test results.

"Before" is the play build as handed over (`s2-play2`), "after" this change; each side is its own frozen pair, so the
two sides of a row may show different start positions of the map.

| Map | Ambient, R/G/B, Ground, Level; base height | Before: ground | vehicles | yard | ground hue / a* / b* | After: ground | vehicles | yard | ground hue / a* / b* |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| XDeadman (temperate) | 0.68, 0.68/0.68/1, 0, 0.028; 8.0 | 1.04 | 0.57 | 0.71 | +28 / -6 / -3 | 1.11 | 0.93 | 1.26 | +4 / -1 / -2 |
| XMP29U2 (urban), away from lamps | 1, 1/0.8/0.68, 0, 0; 2.0 | 1.05 | 0.90 | 1.23 | +2 / -1 / -4 | 1.09 | 0.88 | 1.23 | -0 / -0 / -3 |
| XMP29U2, 7.6 cells from a lamp | 1, 1/0.8/0.68, 0, 0; 2.0 | 0.92 | 0.83 | 1.03 | +2 / -3 / -5 | 1.00 | 0.94 | 1.17 | +1 / -2 / -2 |
| XHailMary (urban) | 1, 1/1/1, 0, 0.039; 0.0 | 0.97 | 0.86 | 1.18 | +1 / +0 / -3 | 1.04 | 0.89 | 1.23 | +2 / -1 / +1 |
| Fight (newurban) | 1, 1/1/1, 0.05, 0.008; 4.0 | 1.08 | 0.88 | 1.25 | -7 / +1 / -4 | 1.08 | 0.93 | 1.26 | -6 / +1 / -3 |
| DeepFrze (snow) | 0.8, 0.9/0.9/1, 0.05, 0.006; 4.0 | 1.10 | 0.94 | 1.27 | +2 / +0 / +1 | 1.06 | 0.93 | 1.22 | +2 / +1 / -1 |
| XMP13S4 (snow) | 0.68, 0.75/0.75/1.2, 0, 0.028; 5.0 | 1.08 | 0.62 | 0.78 | -11 / -12 / +12 | 1.12 | 0.94 | 1.22 | -1 / -0 / -1 |
| MoonPatr (lunar) | 0.65, 1/1/1.1, 0.05, 0.008; 0.0 | 1.15 | 1.60 | 2.02 | +1 / +1 / -1 | 1.05 | 0.98 | 1.35 | +2 / +0 / -0 |
| XMP14T2 (dusk; DuskPen lighting) | 0.73, 1/0.92/0.8, 0, 0.035; 5.0 | 1.10 | 0.83 | 1.32 | +5 / -4 / +6 | 1.09 | 0.84 | 1.29 | +5 / -5 / +6 |
| Transylv (newurban, night) | 0.6, 0.9/0.9/1, 0.05, 0.008; 2.0 | 0.97 | 0.61 | 0.93 | +24 / -4 / -6 | 1.10 | 0.89 | 1.35 | +9 / -3 / -1 |
| XXmas (snow, night) | 0.68, 0.62/0.62/1, 0, 0.027; 0.0 | 1.52 | 0.68 | 0.93 | -7 / -5 / -0 | 1.09 | 0.96 | 1.28 | +1 / +4 / -8 |
| XMP06T2 (temperate) | 0.6, 1/1/1, 0, 0.039; 4.0 | 0.80 | 0.68 | 0.86 | +74 / -0 / -16 | 1.06 | 0.90 | 1.29 | +7 / -2 / -0 |
| HillBtwn (urban) | 1, 0.8/0.8/0.75, 0.05, 0.008; 0.0 | 1.16 | 0.74 | 1.08 | -5 / +0 / -4 | 1.08 | 0.95 | 1.26 | -4 / -0 / -4 |

The lamp row's "after" pair was taken before the last two renderer changes of this work (lamp pools of night maps,
added sprite light); neither acts on a day map at an object level of 1 or more.

Read with these in mind:

- Three offsets are the same on every map and are not map lighting. The remaster vehicle art is darker than the
  original's (0.72-0.83 of the native luminance under the faithful look on every map measured, 0.84-0.98 under the
  cinematic look), the redrawn construction yard is brighter (1.2-1.35; original civilian buildings sit at 1.0-1.13),
  and the cinematic look lifts mid-tones by about 9 % in display values and cools the ground by b* 3-4 (the approved
  cooling; on XXmas's saturated blue snow the same grade reads b* -8).
- Before, the night class staged a map by its Ambient alone and drew it under a dim blue moon at 22:00 without the
  engine grade: on XDeadman, XMP13S4, XMP06T2, Transylv and XXmas vehicles and infantry showed at 0.57-0.85 of the
  native luminance with a blue cast, the ground's hue was off by up to 74 degrees and XXmas's snow was 1.52x too
  bright. The game draws all of them with the ordinary cell formula; XDeadman's base at height 8 has object level 0.90.
- Objects read I, not I x M: HillBtwn (Red/Green/Blue 0.8/0.8/0.75) drew vehicles at 0.74 and the yard at 1.08 while
  its ground sat at 1.16, and MoonPatr, whose lamp types set no tint keys (M saturates at 2), drew objects at 1.6-2.0.
  The native yard itself confirms the level: its luma per unit of I is 91.5 (XHailMary, I 1.0), 90.1 (XMP29U2, 1.0),
  87.1 (Fight, 0.98), 84.2 (HillBtwn, 0.95; I x M would give 105), 87.3 (XMP14T2, 0.91), 84.3 (XDeadman, 0.90), 85.5
  (XMP06T2, 0.76) and 80.6 (Transylv, 0.57), and its colour stays neutral under XDeadman's 0.68/0.68/1 tint.
- A reduced lamp share darkens what stands near a lamp post (XMP29U2 row), and maps without a light sidecar had no
  lamp light at all until the grade took the game's own light list (XHailMary's ground rose from 0.97 to the other
  day maps' level).
- The look's added sprite light (sun highlight, glass glint, mirrored sky) is scaled by the map's object light: at
  full strength the yard read 1.46 on the two darkest maps (MoonPatr, Transylv) against 1.17-1.29 elsewhere.
- HD street lamps (a night dressing the game does not have) keep their plain irradiance. Scaled up to their former
  share of a moonlit ground they clipped under the day display: a Transylv base beside a lamp-lined road measured
  ground 1.25 and a burnt-out tank.
- Remaining outside 0.9-1.1 after the change: every yard (its art), vehicles on the dusk map and some day maps
  (0.84-0.89, their art), and the ground of XDeadman and XMP13S4 by one or two hundredths. Authored dusk (XMP14T2)
  was not changed and keeps its own warm low sun: ground b* +6, vehicles 0.84. The shade rows are modelled for
  terrain only; objects on the darkest maps are drawn about one row (4 %) brighter than the game's.

## Dusk staging and unlit resource overlays

The supplied same-frame DuskPen measurements use Ambient 0.73, RGB `(1, 0.92, 0.8)`, Level 0.035, median height 6,
and the authored dusk hour 18.2. A flat-ground sample measured original mean `(139, 124, 60)`, hue 48.5 and saturation
0.40, versus HD `(161, 152, 87)`, hue 52 and saturation 0.30 (both L5H and the pre-fix S2 baseline). Day-map XMP29U2
was already close: original `(91, 82, 55)`, HD `(93, 87, 65)`. These are supplied replay observations, not results of
the asset-free tests in this checkout.

The dusk profile now anchors the warm sunset key at its own hour and uses a 10-degree sun floor; other profiles keep
28 degrees. The anchor has night weight zero. Clear flat RGB is normalized to noon before weather, with the same
per-channel scale on sun and sky, preserving warm directional light and cooler shade. The original `MapLightGrade`
then supplies the full engine brightness, warm tint and light sources. Enhanced exposure lift, white adaptation and
map-tint neutralization are disabled for dusk profiles. The separate source field follows night gain, which is zero
at the anchor, so those light sources are not applied twice. If time is forced towards night, map grade and the clear
calibration fade into the night presentation. Day/night profile settings and light uniforms are regression-tested
for exact equality with the pre-fix baseline. DuskPen's target of mean RGB within ±8% of the original and saturation
at least 0.33 remains **UNVERIFIED** until the owner renders and measures replays.

The same-pixel DuskPen evidence establishes a separate overlay policy: bright yellow ore was `(200.7, 180.3, 40.8)`
before the storm and `(200.8, 180.4, 40.8)` during it, while adjacent grass changed by `(0.30, 0.44, 0.98)`. On night
map Transylv, ore remained bright yellow at mean `(222, 200, 45)` over dark grass. Ore and gems (tiberium overlays,
all theatres) therefore bypass scene-event lighting, map grade and night/dusk darkening. Live classification uses
the overlay type's `tiberium` flag; static map caches use the extractor's existing unlit overlay classification.
The HD material retains clear-noon crystal shading and optional decorative wetness. Ordinary overlays keep their
terrain lighting. This is an overlay-only policy; unlit metadata on other object classes does not reclassify them
as resource overlays. The display capture preserves depth/foreground occlusion and shroud; filtered-edge night-toe
composition and rendered-pixel equivalence still require GPU acceptance. The isolated highlights no longer feed
scene bloom; their material sparkle remains, but equivalence to the former clear-noon bloom halo is unverified.

## Scene lighting events

The engine decoder preserves native scene state for snapshots and replays. The presentation adapter
`packages/hd-renderer/src/ra2/sceneLighting.ts` owns palette normalization, event transitions, storm shadow/overcast
selection and bounded strike flash. `packages/hd-renderer/src/sceneLighting.ts` exposes only neutral terrain/object
gains, sun-shadow share, overcast and sky flash to `HdRenderer`; the generic renderer does not interpret native
weapon/event names or `[Lighting]` coefficients. Adjacent same-event interpolation remains in the RA2 adapter.

`src/games/yr/sceneLighting.ts` reads the live scene inputs for the generic `GameRenderLighting` contract. The
address evidence below comes from the YR 1.001 static disassembly recorded in the supplied `re_report.md` and
`re_offsets.json` (same `7b8a0685…` executable baseline). It is separate from the user's subsequent XMP29U2 live
measurement; neither source establishes exact pixel equivalence for every event overlap or cached converter.

`S = *(ScenarioClass**)0xA8B230` (dereference evidence: `0x539842`). All table fields are signed 32-bit words.
Ambient and RGB divide by 100; Ground and Level divide by 1000 to recover fractional `[Lighting]` units.

| Scenario offset | Meaning | Instruction evidence |
| --- | --- | --- |
| `+0x3528` | Mutable base/restoration Ambient | Constructor `0x6838D3`, INI store `0x68A856`, restoration read `0x53C39A` |
| `+0x352C` | **Current** Ambient | Cell reads `0x4841BA`/`0x484688`; transition writes `0x55B470`/`0x55B490`/`0x55B4AE` |
| `+0x3530` | Target Ambient, not current light | Compare `0x55B33D..0x55B349`; event stores `0x53C2B3`/`0x53C32E`/`0x53C3A0`/`0x53C3BE` |
| `+0x3534/38/3C` | Normal Red/Green/Blue | Cell reads `0x4841E6`/`0x484215`/`0x484244` |
| `+0x3540/44` | Normal Ground/Level | Constructor `0x6838F7`/`0x683901`; cell reads `0x48456B`/`0x484574` |
| `+0x3548`, `+0x354C/50/54` | Ion Ambient and RGB | Constructor `0x68390B`/`0x68392B`/`0x683931`/`0x68394D`; selector `0x53C2AD..0x53C30E` |
| `+0x3558/5C` | Ion Ground/Level | Constructor `0x683961`/`0x683967`; cell reads `0x48448A`/`0x484493` |
| `+0x3560`, `+0x3564/68/6C` | Nuke Ambient and RGB | Constructor `0x68396D..0x683987`; target/palette setup `0x53ABB7..0x53AC39` |
| `+0x3570/74` | Nuke Ground/Level | Constructor `0x68391A`/`0x683920`; cell reads `0x484526`/`0x48452F` |
| `+0x357C`, `+0x3580/84/88` | Dominator Ambient and RGB | Constructor `0x683991..0x6839AB`; selector `0x53C328..0x53C389` |
| `+0x358C/90` | Dominator Ground/Level | Explicit zero defaults `0x6839B1`/`0x6839B7`; INI reads `0x68AC2A`/`0x68AC64` |

| Static address | Type and meaning | Instruction evidence |
| --- | --- | --- |
| `0xA9FAB4` | uint8 storm active | Set `0x539FA9`; getter `0x53A100`; clear `0x53A8DD` |
| `0xA9FAD0` | uint8 storm ending, waiting for existing clouds | Set `0x53A099`/`0x53A935`; checked `0x53A8C6` |
| `0xA9FAB8` | int32 storm deferment remaining; positive means pending | Store `0x539F70`; decrement `0x53AAAD`; active-or-pending predicate `0x53A0E0` |
| `0xA9F9CC/0xA9F9CE` | int16 storm target cell X/Y | Packed store `0x539F46`; signed reads `0x53AA10`/`0x53AA21` |
| `0xA9FABC` | int32 nuke state: 0 inactive, 1 flash, 2 recovery | Start `0x53AB81`; predicates `0x53A110`/`0x53A120`; update `0x53A6C0` |
| `0xA9FAC0` | int32 Dominator state: 0 inactive, 1..4 palette event, 5 ambient recovery | Start `0x53AF0C`; dispatch `0x53AF40`; recovery exit `0x53B054` |
| `0xA9FAB0` | int32 extra effect; nonzero selects Nuke palette | Predicate `0x53BAD0`; selection `0x53C290`; TimeWarp identity inferred from `LetsDoTheTimeWarpOutAgain` sound lookup at `0x53B52B` |

Two priority orders must remain separate:

- Bulk palette selector `0x53C280`: `nuke == 1 || timewarp != 0` selects raw Nuke RGB; otherwise active storm
  selects raw Ion RGB; otherwise Dominator states 1..4 select raw Dominator RGB; otherwise no override. The reader
  labels simultaneous nuke/timewarp as `nuke`, following the first tested condition; both use identical RGB.
- Incremental cell relight `0x4846C0..0x4847D3`: active storm selects Ion Ground/Level; otherwise any nonzero
  Dominator state selects Dominator Ground/Level; otherwise nuke state 1 selects Nuke Ground/Level; otherwise normal.
  TimeWarp alone does not select Nuke Ground/Level. Dominator state 5 therefore has no Dominator palette override
  but retains its height coefficients while ambient recovers.

The renderer receives current Ambient, normal RGB, selected Ground/Level, and raw event RGB as independent values.
`0x53AD00` updates converter palettes; `0x556145..0x556157` stores alternate RGB and enables it immediately. Do not
replace the normal cell tint with Ion RGB before cell-light calculation, or normalize the event RGB. The reader
checks aligned scenario pointers, exact byte spans, enum/boolean ranges and plausible lighting values, returning
null on unavailable/implausible reads. A real zero remains zero. Its fields participate in the render snapshot's
change key, including validity, so a second poll in the same logic frame can publish event changes.

The supplied XMP29U2 measurement has normal Ambient/RGB/Ground/Level `1 / (1,0.8,0.68) / 0 / 0`. Current Ambient
changes `100 -> 87` within 1–2 logic frames of storm activation, and `87 -> 100` within two frames of ending. This
overrides any assumption of a slow presentation fade for those running rules. The HD view reads current Ambient;
it neither predicts it from event timing nor applies another event fade. The executable's general transition code
at `0x55B33D..0x55B4D2` still permits other rates under other rules.

At unlit cells, terrain uses palette × intensity × normal normalized tint, while ordinary objects omit that tint.
During an event the raw event palette colour replaces that tint for both classes. With Ion RGB `(0.3,0.4,0.75)`,
the expected storm/clear ratios are terrain `0.87 * (0.3/1,0.4/0.8,0.75/0.68) = (0.261,0.435,0.95956…)` and objects
`0.87 * (0.3,0.4,0.75) = (0.261,0.348,0.6525)`. Same-frame original captures measured terrain `(0.25,0.425,1.00)`
and buildings/units `(0.23,0.34,0.64)`, consistent within palette quantization. `WCCLOUD1..3` in the supplied live
sample occupy native layer `top`, at about 1493 leptons Z, and the original captures show their bright grey art
above black shroud without event darkening.

When the live normal RGB differs from the cache's authored `[Lighting]` (a map edited after its cache was built, a
trigger-changed light, a stale cache), `computeSceneMultipliers` scales each terrain channel by live / authored RGB on
top of the intensity ratio, and an event palette keeps the live normal RGB's largest channel M; objects still take the
intensity alone. A day-built cache (1/1/1) under an edited night of Ambient 0.55, Level 0.003 and RGB 0.4/0.4/0.7
therefore gives terrain `0.562 x (0.4, 0.4, 0.7)` at median height 4 instead of a neutral 0.562 (round 9e #3). Equal
live and authored RGB keep the exact identity path. Only light level and tint follow the live values: the day/dusk/night
staging, sun and shadows still come from the cached map.

Two display effects follow such a run-time scale (`ra2DisplayPolicy`, `SceneLighting.gradeShare` / `darkLoss`). The
engine draws into a 16-bit RGB565 surface: truncating to 5/6/5 bits and showing the result with bit replication loses
about `a - v / 32` (red, blue) and `a - v / 64` (green) levels of 255 at value v, with a = 3.98 / 1.99. HD shows the
palette colours themselves, so by day its dark tones sit a few levels above the original's (round 9e same-moment
harbour pair, HD with the grade removed minus original in luma bins 24-36: +2.4..3.3 / +1.1..2.3 / +2.5..3.3, against
2.9 / 1.5 / 2.9 predicted). The level-dependent part scales with the palette and is already in the art's calibration;
the constant part does not, so under a terrain multiplier s the original loses `a x (1 - s)` more than HD, which the
display now takes off the lit, visible battlefield (about 3.1 / 1.5 / 2.4 levels on the XMP27T8 night edit; zero in
the authored light and above it). Objects receive the terrain value too (their own loss is smaller, about 1.3 levels
less on that edit). Second, the look's cinematic grade (shadow split-tone, mid-tone lift, cool balance) was tuned on
the authored picture; on a picture the engine has darkened to a fifth it moved everything into graded shadow. Its share
is now the luminance of the terrain multiplier (1 in the authored light; 0.237 on the night edit, about 0.44 in an Ion
Storm on a stock day map), as the night presentation already fades it. Offline estimate on the round 9e night A/B
still (HD grade inverted, then re-applied with both changes): battlefield HD / original luma 1.31 -> 1.16, B/G +17 %
-> +6 %; it needs a live A/B.

The supplied HD cinematic replay at hour 16.5 measured storm/clear terrain ratios `(0.229, 0.450, 1.117)` and
building ratios `(0.22, 0.36–0.39, 0.75–0.80)` despite correct scene multipliers. The storm presentation was selecting
the ordinary grey-blue overcast key after adaptation, adding a second colour transform. It now transfers removed
sun RGB irradiance into hemisphere RGB irradiance without changing flat-ground colour or luminance. Existing
decorative weather is retained, while sky colours, exposure, white adaptation, map-tint adaptation and bloom
threshold remain event-free. Unit tests exercise that conservation and renderer uniform ordering; the corrected
replay ratios remain **UNVERIFIED** until measured.

Limits retained from static RE: full cell recomputation's Dominator terrain branch reads NukeLevel at
`0x4844DB`, unlike incremental relight and bridges. New converters at `0x555E50` test storm before nuke and include
Dominator state 5, unlike bulk palette updates. Dominator's `5 -> 0` transition at `0x53B054` has no adjacent
relight, so cached cells can briefly retain older coefficients. The global snapshot follows the documented bulk
palette/incremental-relight policy; those cached per-cell exceptions and TimeWarp's full lifecycle remain
**UNVERIFIED** against runtime captures. Asset-free reader tests do not establish rendered-pixel acceptance.

## Lunar daylight and ore/gem brightness

The C1 baseline is the user's original-versus-HD measurement on the same frozen MoonPatr frame at 2x. A 480 x 320
box of flat regolith, restricted to low-saturation pixels, gave the following readings. These are baseline evidence,
not measurements of the implementation after C1.

| Presentation | Regolith L* median / standard deviation | Regolith a* / b* | Gem HSV V median / p95 |
| --- | --- | --- | --- |
| Original YR | 47 / 14 (speckled grain) | -3 / -3 | 0.53 / 0.97 |
| HD classified as night | not recorded | not recorded / about -17 | 0.35 / 0.50 |
| HD forced to noon (`hd-time=12`) | 75 / not recorded | not recorded / -9 | 0.71 / 0.85 |

MoonPatr's `[Lighting]` is Ambient `0.65`, Red `1`, Green `1`, Blue `1.1`, Ground `0.05`, Level `0.008`. Its base
intensity is `0.60`; the height term gives roughly `0.62` on the measured ground. The original engine scales palette
sRGB code values by cell intensity, so a factor near `0.62` corresponds to about `0.33-0.36` in linear light. This
explains the original L* 47 versus forced-noon L* 75 without inventing moonlight or a blue sky. Gem highlights instead
reach V p95 `0.97`, essentially the unlit art's p95 `0.96`: on this map, ore/gem overlays retain art brightness while
the ground is dimmed.

The later C4 same-moment captures supplied with the task show why a uniform scene exposure is insufficient. Away
from lamps, the original regolith has L* `47` and the exposure-staged HD has L* `46`; gem V p95 already matches
at `0.97`. Around the player's base, however, the original draws strong blue-violet pools from MoonPatr's nine map
light sources (`SNONITLAMP` x5, `INBLULMP` x4), while HD is uniformly grey. Disabling `MapLightGrade` discarded
these engine-exact local contributions. These are pre-C4 observations, not a rendered result from the new code.

The lunar rule is therefore **engine grade including light sources + neutral airless sun/sky + ore exempt**.
The map policy in `packages/ra2-assets/src/lights.ts` handles theater `lunar` before the terrestrial ambient
classifier and returns `kind: 'day'`, `hour: 12`, `tint: [1, 1, 1]`, `airless: true`, with no `exposure` multiplier.
`MapLightGrade` stays at weight `1 - night`, with `setSources` and `sourceWeight` following other day maps. The
engine cell formula applies ambient, height and the local sources once, in palette sRGB: terrain-class art takes
intensity x tint, objects take intensity. This retains the original lamp pools as well as the dim ground between
them. Height affects the per-cell grade, not the lunar day classification. Non-lunar maps retain their existing
results: Transylv (`newurban`, Ambient `0.60`, RGB `0.9/0.9/1.0`) remains night, and XMP29U2 remains day.

In `packages/hd-renderer/src/lighting.ts`, airless sun, fill, ground and sky swatches remain luminance-matched
neutral greys at the unscaled noon reference. Sky/haze and cinematic colour controls add no terrestrial blue;
white adaptation and map-tint adaptation stay off. Exposure adaptation also remains off based on `airless`, even
though the profile has no `exposure` field, so the dim palette-graded scene is not lifted back toward noon.
Default staging stays at noon with HD night dressing off; the original map lamps remain in the day grade.

Ore/gem brightness is a game-layer sprite-class policy: `spriteClassGradeExempt` returns true only for class `ore`
on an airless profile. Library overlays whose extracted type has `tiberium: true` belong to that class. The generic
sprite renderer receives a per-instance exemption flag and samples multiplier 1 (`vec3(1)` for the terrain grade)
instead of `terrainGradeAt`/`objectLevelAt`, without knowing any RA2 overlay names or theater. This replaces the
former `1 / exposure` received-light gain; all other classes and ordinary day/night profiles retain their grade.

Visual acceptance remains **UNVERIFIED** for C4: the task prohibits starting a server or browser. To verify on an
existing owner-run scene, freeze MoonPatr at the same frame and compare original with default HD staging, then
repeat the regolith crop and gem samples above. Check blue-violet pools around the base, near-neutral dim regolith
away from lamps, bright gem highlights, no HD night dressing, and no blue haze under the cinematic look. Repeat
on Transylv and XMP29U2 to check that night and terrestrial day staging are unchanged. No new disassembly inspection
was performed for C4; the ore/gem palette or `LightConvert` selection path and its addresses remain unverified,
so the overlay exception is supported by the supplied same-frame measurements rather than an inferred executable address.

## Open questions

- Land types 13 and 14 hold both ground and pavement; the surface classes use tile colours (`classifyTileSurface`),
  checked on XMP29U2 and RiverRam only.
- Exact cached converter behaviour during overlapping events and Dominator recovery remains unverified at runtime.
- Spotlights (`[Structures]` field 11) are recorded by the research probe but not drawn.
