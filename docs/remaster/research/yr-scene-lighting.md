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
| Cell lighting | 0x484180 | See the formula below. |
| Tint normalisation | 0x5558E0 | Divides the summed tint by its largest channel. |

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

## Stock scenarios

`gameres/hd-cache/_research/night-lights/all-scenarios-lighting.tsv` (derived from the player's install, not in Git)
lists the `[Lighting]` of every stock scenario and multiplayer map found in the install's MIX archives. Ambient,
rounded to 0.1, over the 220 entries with a `[Lighting]` section:

| Ambient | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scenarios | 5 | 28 | 66 | 40 | 77 | 2 | 2 |

The 0.6-0.72 group are the maps built as night maps: blue or neutral tints, lamp-post light sources (`INYELWLAMP`,
`INGALITE`, `INBLULMP`, `SNONITLAMP`) and `NEGLAMP` darkening. Examples:

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

- `mapAtmosphere`: the class comes from the authored base ambient `base = Ambient - Ground` and the tint, with lamp
  posts (positive `InvisibleInGame` light sources) as evidence: night when `base <= 0.70`, or `base <= 0.76` with a
  blue tint or with two or more lamp posts (unless the tint is warm); dusk when `base <= 0.76` with a warm tint; day
  otherwise. `Level * medianZ` is deliberately left out of the class: an earlier version classified on
  `Ambient - Ground + Level * medianZ` and staged XMP06T2 (0.60 + 0.039 x 4 = 0.756), multimd a6506e58 = XMP13S4
  (0.68 + 0.028 x 5) and amazon.mmx (0.68 + 0.029 x 6) as day. The height term still sets the night level (what unlit
  ground at the typical height shows). `packages/ra2-assets/tests/lights.test.ts` checks the real (Ambient, RGB,
  Ground, Level, medianZ, lamp posts) of XMP06T2, XMP13S4, amazon.mmx, sov07tmd, Transylv, NOWIMPS and XTN01T2 (all
  night) and of XMP29U2, RiverRam and invasion.mmx (day). Renderers recompute the profile from the sidecar's raw data
  (`sidecarAtmosphere`), so sidecars written by an older classifier stage maps the current way.
- Linear light from engine brightness: `engineToLinear(e) = 0.30 * (e / 0.62)^2.2` (the palette scales display
  values, so linear light scales by v^2.2); a typical stock night (0.62) shows unlit ground at 30 % of noon. Night maps
  are clamped to 26-40 % of noon so every night stays readable.
- Light sources: the engine grid's difference to the unlit grid is added as irradiance, staged by the map's class
  (`mapLightStaging` in `packages/hd-renderer/src/ra2/mapLights.ts`). Night maps get the engine exactly (full
  `LightVisibility`, linear falloff, full strength, at the night ambient `nightBaseAmbient`): their mappers tuned
  lamps and `NEGLAMP` darkening for that formula. Dusk maps get the same at their own ambient, always on, as the
  engine applies light sources at every hour. A day map forced to night is an HD presentation choice, not the engine:
  with the full 15.6-cell radius the seven `INGALITE` washes on XMP29U2 lit the park lawn to 0.77 of noon, a floodlit
  field, while the moon alone gives 0.26; there each source is a pool (0.45 x `LightVisibility`, the engine falloff
  squared via `engineLightDelta`'s `falloffPower`, 0.8 of the engine's strength): about 3.1x the moonlit ground at the
  post, 1.5x three cells out, nothing past seven. By day the light sources are part of the map's day grade instead
  (next item). No night-map cache has been rendered yet, so the night-map staging is unverified on screen.
- The night keys aim 1.15x above the night level (`NIGHT_TONE_COMPENSATION` in `packages/hd-renderer/src/lighting.ts`)
  to offset the Neutral tone mapper's toe, so the displayed ground keeps the intended fraction of noon. Moonlight is
  cool (`MOON_TINT`); only maps built as night maps tint it with their own `[Lighting]`, a day map's grade stays a
  daylight choice.
- Objects take the light at half saturation (`OBJECT_TINT`), a compromise with the engine's untinted object lighting.
- By day the renderer applies the engine's cell light itself (`packages/hd-renderer/src/ra2/mapLighting.ts`): per
  cell `engineCellLight` with the map's `[Lighting]` and light sources, multiplied into the palette colours in their
  own sRGB scale, level x tint for terrain-class art and the level only for objects, as the engine draws them at all
  times. Checked on XMP29U2 against same-moment captures: terrain 1.00/0.81/0.66 of the palette per channel, 1.345x
  next to the `INGALITE` posts (1.340 predicted). Its weight fades with the night weight on day maps and is 0 on maps
  staged as night or dusk, whose light the night presentation above derives from the same data (one owner at a
  time). `mapLightMultipliers` in `packages/ra2-assets/src/iso.ts` (offline previews) uses the same formula.

## Scene lighting events

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

Limits retained from static RE: full cell recomputation's Dominator terrain branch reads NukeLevel at
`0x4844DB`, unlike incremental relight and bridges. New converters at `0x555E50` test storm before nuke and include
Dominator state 5, unlike bulk palette updates. Dominator's `5 -> 0` transition at `0x53B054` has no adjacent
relight, so cached cells can briefly retain older coefficients. The global snapshot follows the documented bulk
palette/incremental-relight policy; those cached per-cell exceptions and TimeWarp's full lifecycle remain
**UNVERIFIED** against runtime captures. Asset-free reader tests do not establish rendered-pixel acceptance.

## Open questions

- Land types 13 and 14 hold both ground and pavement; the surface classes use tile colours (`classifyTileSurface`),
  checked on XMP29U2 and RiverRam only.
- Exact cached converter behaviour during overlapping events and Dominator recovery remains unverified at runtime.
- Spotlights (`[Structures]` field 11) are recorded by the research probe but not drawn.
