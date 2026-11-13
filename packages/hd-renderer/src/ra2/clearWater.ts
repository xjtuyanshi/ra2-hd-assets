import {
  abs,
  color,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  pow,
  reflect,
  screenUV,
  sin,
  smoothstep,
  texture,
  time,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { Color } from 'three/webgpu';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, sampleLightField } from '../atmosphere';
import { oceanNormalTexture, waterTextures } from '../proceduralTextures';
import type { ShaderNode } from '../tsl';
import type { BedWaterInputs, BedWaterLook, WaterLook, WaterLookInputs } from './waterLook';

/** Candidate A uses the approved optical palette and the four-sample three.js WaterMesh surface model.
 * Metric targets require same-camera rendered acceptance; they are not guarantees from these coefficients.
 */
export const CLEAR_WATER = {
  /** Shore distance (cells) over which the depth proxy of clearDepth reaches open water. */
  depthCells: 2.4,
  /** Optical absorption per metre of water (prototype A: (0.42, 0.080, 0.058) x its 2.6 path factor). */
  absorption: [1.09, 0.21, 0.15],
  /** Water depth (m) per cell of shore distance on the beach slope, and the extra drop to the open shelf. */
  shelfSlope: 1.1,
  shelfDrop: 5,
  shelfStart: 0.4,
  shelfEnd: 2.2,
  maxMetres: 8,
  refraction: 0.06,
  maxRefraction: 0.08,
  foamPeriod: 7,
  causticGain: 0.4,
  reflection: 0.03,
  reflectionMax: 0.13,
  /** Share of the Fresnel term added to the reflection strength. */
  fresnelGain: 0.45,
  skyTop: 0.06,
  shininess: 700,
  sparkle: 1.2,
  relief: 1.65,
  /** Share of the water's relief shaded by tilt alone (direction-free), its gain, and the mean it adds back. */
  tiltShare: 0.5,
  tiltShade: 11,
  tiltMean: 0.12,
  whitecap: 0,
  cliffContact: 0.55,
  mirrorKeep: 0.55,
  /** Share of the water a mirrored object (bridge deck, pier, ship hull) replaces at full mirror coverage. */
  objectReflection: 0.4,
  /** Brightest a mirrored object may be, relative to the water around it. */
  objectShade: 0.55,
  /** Seabed dapple: rock/weed threshold of the 0..1 field (lower = more patches) and how much they darken. */
  dappleFrom: 0.52,
  dappleDark: 0.26,
  /** Depth (m) by which the seabed dapple has faded out: deep water is an even teal. */
  dappleDeep: 6.5,
  /** Turquoise level over sand, depth (m) at which it has become the deep teal, and how fast the bed fades (1/m). */
  shallowLevel: 0.78,
  deepGain: 1.55,
  aquaEnd: 4.5,
  clarity: 0.9,
  /** How far (1/m) the bed's own light and dark (sand ripples, rocks) stays visible through the water. */
  bedTexture: 0.25,
  motionTarget: 1.5,
  anisotropyTarget: 0.4,
  highlightTarget: 0.04,
  saturationTarget: 0.6,
} as const;

/** One ground world unit is one cell (world.ts); eight metres per cell is the chosen visual scale. */
export const CLEAR_SURFACE = { tileMetres: 26, metresPerCell: 8, timeScale: 0.6, normalGain: 1.7, viewStretch: 1.5 } as const;
/** WaterMesh.getNoise: divisor (x,z), signed scroll rate (tiles per surface-clock second), equal weights. */
export const CLEAR_LAYERS = [
  [103, 103, 1 / 17, 1 / 29],
  [107, 107, 1 / 19, -1 / 31],
  [8907, 9803, 1 / 101, 1 / 97],
  [1091, 1027, -1 / 109, 1 / 113],
] as const;
/**
 * Rotation (degrees) of each layer's sampling frame. WaterMesh samples all four in one orientation; under the 2:1
 * camera the two fine layers then share one crest direction and read as horizontal streaks. Turning the second
 * fine layer across the first gives a crossing sea at the same scales and speeds.
 */
export const CLEAR_LAYER_TURN = [0, 75, 0, -40] as const;
/**
 * Light used for the water's relief and sun glitter: fixed relative to the fixed camera, at prototype A's sun
 * (screen right 0.30, up 0.62, away from the camera 0.72). The scene's sun sits behind the camera, where a mirror-like
 * surface seen from above shows no glitter at all; RA3 and the approved prototype both light the water from ahead.
 */
export const CLEAR_GLINT_LIGHT = (() => {
  const right = 0.3,
    up = 0.62,
    away = 0.72;
  const x = (right - away) * Math.SQRT1_2,
    z = (-right - away) * Math.SQRT1_2;
  const n = Math.hypot(x, up, z);
  return [x / n, up / n, z / n] as const;
})();

/** sRGB palette before scene lighting: deep teal-blue, turquoise shallows, the sand bed seen through the shallows. */
export function clearPalette(theater = '') {
  switch (theater.toLowerCase()) {
    case 'snow':
      return { deep: 0x114558, shallow: 0x3796b2, bed: 0x8a969c };
    case 'desert':
      return { deep: 0x174750, shallow: 0x45aea4, bed: 0xa89470 };
    case 'urban':
    case 'newurban':
      return { deep: 0x17434f, shallow: 0x3a908c, bed: 0x8a8a80 };
    default:
      return { deep: 0x134250, shallow: 0x2a9894, bed: 0x8c7c5e };
  }
}

/**
 * Clear look's shore class from the mean linear colour of the land just inland of the waterline: 1 for natural ground
 * (sand and dirt lean red, grass and weed green, rock and scree either way), 0 for masonry (quays, seawalls, plazas and
 * embankment roads are neutral in hue: red and green about equal, whatever their brightness or saturation). terrain.ts
 * spreads it onto the water with the shore field (shoreField.ts shoreValueSteps), so the class follows the nearest
 * shore and never flips per pixel. Measured in the sandbox: beach sand splits about +0.3, olive coast grass -0.2,
 * dark islet rock +0.25, beige concrete plazas -0.05..+0.06. Near-black ground counts as masonry.
 */
export function clearShoreSandiness(r: number, g: number, b: number): number {
  const hi = Math.max(r, g, b, 0.004);
  const split = Math.abs(r - g) / hi;
  const t = Math.max(0, Math.min(1, (split - 0.04) / 0.06));
  // Near-black ground is the shaded face of a wall, pier or bridge, whose hue is only noise.
  const lit = Math.max(0, Math.min(1, (hi - 0.015) / 0.02));
  return t * t * (3 - 2 * t) * lit * lit * (3 - 2 * lit);
}

/** Range of clearShoreTone: the bed under the shallows is this many times the theatre's sand brightness at 0 and 1. */
export const CLEAR_SHORE_TONE = [0.3, 1.4] as const;
/**
 * Brightness of the land at the shore relative to the theatre's sand (palette.bed), encoded 0..1 over CLEAR_SHORE_TONE;
 * the shallows' bed takes it, so a dark rock island stands in dark-floored water instead of a pale sand ring. A
 * negative colour (no shore) gives the sand itself.
 */
export function clearShoreTone(r: number, g: number, b: number, theater = ''): number {
  const sand = new Color(clearPalette(theater).bed);
  const ratio =
    r < 0 ? 1 : (0.2126 * r + 0.7152 * g + 0.0722 * b) / (0.2126 * sand.r + 0.7152 * sand.g + 0.0722 * sand.b);
  const [lo, hi] = CLEAR_SHORE_TONE;
  return Math.max(0, Math.min(1, (ratio - lo) / (hi - lo)));
}

/** CPU reference of the shader's depth proxy, including steep rocky/cliff shores. */
export function clearDepth(shore: number, hard = 0): number {
  const t = Math.max(0, Math.min(1, shore / CLEAR_WATER.depthCells));
  return Math.max(t * t * (3 - 2 * t), Math.max(0, Math.min(1, hard)) * 0.9);
}
/** Transmission of the water column for the seabed colour, per channel, at a depth in metres. */
export function clearTransmission(metres: number): number[] {
  return CLEAR_WATER.absorption.map((a) => Math.exp(-a * Math.max(0, metres)));
}

/** RGB = world normal; A = coincident compression of the two fine layers. */
export function clearField(ground: ShaderNode): ShaderNode {
  // The 2:1 camera squashes ground-isotropic waves into horizontal streaks on screen (spectral anisotropy about 0.7 in
  // the fine relief). The wave field is laid out stretched along the view's ground direction (x + z) by viewStretch,
  // and its slopes along that direction are flattened by the same factor, so its crests read closer to round on
  // screen; the long-wave scales and speeds across the screen are unchanged.
  const k = (1 - 1 / CLEAR_SURFACE.viewStretch) / 2;
  const along = ground.x.add(ground.y).mul(k);
  const uv = vec2(ground.x.sub(along), ground.y.sub(along)).mul(
    (CLEAR_SURFACE.metresPerCell * 103) / CLEAR_SURFACE.tileMetres,
  );
  const clock = time.mul(CLEAR_SURFACE.timeScale);
  let sum: ShaderNode = vec3(0);
  const alpha: ShaderNode[] = [];
  CLEAR_LAYERS.forEach(([x, z, dx, dz], i) => {
    const turn = (CLEAR_LAYER_TURN[i]! * Math.PI) / 180;
    const c = Math.cos(turn),
      si = Math.sin(turn);
    const turned = turn ? vec2(uv.x.mul(c).sub(uv.y.mul(si)), uv.x.mul(si).add(uv.y.mul(c))) : uv;
    const sample = texture(oceanNormalTexture(), turned.div(vec2(x, z)).add(vec2(clock.mul(dx), clock.mul(dz))));
    alpha.push(sample.a);
    const n = sample.rgb.mul(2).sub(1);
    // A turned layer's tangent normal is turned back into the ground frame.
    sum = sum.add(turn ? vec3(n.x.mul(c).add(n.y.mul(si)), n.y.mul(c).sub(n.x.mul(si)), n.z) : n);
  });
  // The mean of four decoded normals, exactly WaterMesh's sum * 0.5 - 1 when no layer is turned.
  const mean = sum.mul(0.25);
  // The same stretch applied to the slopes: the component along (x + z) is divided by viewStretch.
  const slopeAlong = mean.x.add(mean.y).mul(k);
  const normal = normalize(
    vec3(mean.x.sub(slopeAlong), mean.z, mean.y.sub(slopeAlong)).mul(
      vec3(CLEAR_SURFACE.normalGain, 1, CLEAR_SURFACE.normalGain),
    ),
  );
  const compression = alpha[0]!.add(alpha[1]!).sub(0.9).mul(1.4).clamp(0, 1);
  return vec4(normal, compression);
}
export function clearNormal(p: ShaderNode): ShaderNode {
  return clearField(p).xyz;
}
export function clearSlope(p: ShaderNode): ShaderNode {
  const n = clearNormal(p);
  return n.xz.negate().div(max(n.y, 0.01));
}
export function clearReflectionOffset(p: ShaderNode): ShaderNode {
  return clearSlope(p).mul(0.1);
}

/** CPU reference of the shader's water depth in metres at a shore distance (cells), before the seabed dapple. */
export function clearMetres(shore: number, hard = 0, quay = 0): number {
  const s = Math.max(0, shore);
  const t = Math.max(0, Math.min(1, (s - CLEAR_WATER.shelfStart) / (CLEAR_WATER.shelfEnd - CLEAR_WATER.shelfStart)));
  const shelf = s * CLEAR_WATER.shelfSlope + t * t * (3 - 2 * t) * CLEAR_WATER.shelfDrop;
  return Math.min(CLEAR_WATER.maxMetres, Math.max(shelf, hard * 6, quay * 5));
}

/** Same terrain/mirror/light passes as enhanced, without sheen trains, painted chop or extra targets. */
export function clearWaterLook(
  inputs: WaterLookInputs & { bedAt?: (offset: ShaderNode) => ShaderNode },
  nodes = DEFAULT_ATMOSPHERE_NODES,
): WaterLook {
  const { position: p, shore, waterness, uniforms } = inputs;
  const { night, sceneBrightness } = nodes;
  const palette = clearPalette(inputs.theater);
  const hard: ShaderNode = inputs.calm ?? float(0);
  // Quays, seawalls and pavement: no beach there (no turquoise shallows, no foam), deep water up to the wall.
  const quay: ShaderNode = (inputs.quay ?? float(0)).mul(float(1).sub(hard));
  // Depth and colour beside masonry take the class itself: where a bridge head or pier also counts partly as a hard
  // shore, the product above fell to a few tenths, and the floor of a weak hard shore (hard x 6 m) left a shallow,
  // pale turquoise patch in the gap of a broken bridge.
  // Even a weak masonry class (a bridge head's ramp art reads as partly natural ground) takes deep water: at a few
  // tenths the turquoise of a partial depth drew a pale arc around the head.
  const quayDeep: ShaderNode = smoothstep(0.04, 0.3, max(inputs.quay ?? float(0), quay));
  const edge = max(inputs.maskShore ?? shore, 0);
  const cells = max(shore, 0);
  // The shallows follow the shore's shape: wide in bays and along long coasts, narrow around islets and off headlands,
  // where the bed drops away quickly.
  // Shore mass 0.5 is a straight coast (shoreField.ts SHORE_MASS_FULL).
  const width: ShaderNode = inputs.shoreMass
    ? mix(float(0.16), float(1.3), smoothstep(0.25, 0.62, inputs.shoreMass))
    : float(1);
  const shelfCells = cells.div(width);
  const field = clearField(p.xz);
  const normal = field.xyz;
  const groundTilt = normal.xz.negate().div(max(normal.y, 0.01));
  const light = vec3(...CLEAR_GLINT_LIGHT);
  const noise = waterTextures().noise;
  // One broad noise tap (g) and a mid-scale one wander the shelf edge: the shore distance is warped before the shelf
  // profile, so the shallows widen in some places and narrow in others instead of an even ring.
  const broad = texture(noise, p.xz.mul(0.043).add(vec2(0.57, 0.21)));
  const mid = texture(noise, p.xz.mul(0.16).add(vec2(0.13, 0.71))).g;
  // The factor stays at least 0.5, and the shelf reaches open water by about 2.6 cells whatever the warp: the shore
  // values (mass, tone) spread from the coast end in a round box-blur footprint a few cells out, beyond which they read
  // as a long sandy coast; a wider shelf there drew turquoise discs around islets and pale blobs off cliffs.
  // Along a long coast the shelf also changes over tens of cells: a narrow fringe where the bed drops steeply, wide
  // sand flats elsewhere (one very broad tap), so a straight coast does not carry an even band.
  const reach = smoothstep(0.3, 0.7, texture(noise, p.xz.mul(0.011).add(vec2(0.31, 0.83))).r);
  const longCoast: ShaderNode = inputs.shoreMass ? smoothstep(0.25, 0.55, inputs.shoreMass) : float(1);
  const flats = mix(float(1), mix(float(0.6), float(1.9), reach), longCoast);
  // Islets take most of their wander from the mid-scale tap (features under a cell), so their fringe follows the
  // rock's outline and changes width around it instead of drawing a round, even collar.
  const wander = broad.g
    .sub(0.5)
    .mul(longCoast.mul(2.4).add(0.8))
    .add(mid.sub(0.5).mul(mix(float(3.4), float(2.2), longCoast)))
    .clamp(-0.5, 1.6);
  const warped = max(
    cells.mul(
      float(1)
        .add(wander.mul(smoothstep(0.1, 0.7, shelfCells)))
        .div(width.mul(flats))
        .max(0.5),
    ),
    cells.sub(0.6).mul(1.1),
  );
  const shelf = warped
    .mul(CLEAR_WATER.shelfSlope)
    .add(smoothstep(CLEAR_WATER.shelfStart, CLEAR_WATER.shelfEnd, warped).mul(CLEAR_WATER.shelfDrop));
  // Beside very dark ground (asphalt ramps, shaded bridge heads; clearShoreTone near 0) there is no sand bed: the water
  // is deep up to the edge (a partial depth there let the bed's turquoise float as a greener patch in a bridge gap).
  const darkShore: ShaderNode = inputs.shoreTone ? smoothstep(0.3, 0.05, inputs.shoreTone) : float(0);
  // Partial classes count in full: a bridge head between masonry and dark asphalt gave a few metres, whose turquoise
  // read as a greener patch.
  const masonry = smoothstep(0.08, 0.4, max(quayDeep, darkShore));
  const metres = max(shelf, max(hard.mul(6), masonry.mul(6)))
    .max(0)
    .min(CLEAR_WATER.maxMetres);
  // Refracted bed: the lake bed's own art where the cache has one, else the theatre's sand with a faint ripple-mark
  // texture, both shifted a little by the wave normals. (Sampling the ground inland of the shore traced the distance
  // field's medial lines as rays around rocks and piers.)
  const offset = groundTilt.mul(CLEAR_WATER.refraction).mul(smoothstep(0, 0.3, metres));
  const bounded = offset.mul(float(CLEAR_WATER.maxRefraction).div(max(offset.length(), CLEAR_WATER.maxRefraction)));
  // Sand: a fine grain and a coarser, wavering mottle of ripples and weed. Both are laid out round on screen
  // (ground x - z across, half of x + z down): ripple marks stretched along the ground's x - z axis read as horizontal
  // streaks on screen and made the shallows the most anisotropic texture in view.
  const sandTap = texture(noise, p.xz.add(bounded).mul(vec2(0.42, 0.42)));
  const rippleAt = p.xz.add(bounded).add(vec2(sandTap.g.mul(0.35), 0));
  const ripple = texture(noise, vec2(rippleAt.x.sub(rippleAt.y), rippleAt.x.add(rippleAt.y).mul(0.5)).mul(0.6)).b;
  const sandGrain = sandTap.b.sub(0.5).mul(0.5).add(sandTap.g.sub(0.5).mul(1.4)).add(ripple.sub(0.5).mul(1.1)).add(1);
  // The bed near a shore takes the brightness of that shore's land (dark rock islands sit in dark-floored water).
  // Islets and headlands (short shores) sit on a darker rock bed than a beach of the same land brightness.
  const tone: ShaderNode = inputs.shoreTone
    ? inputs.shoreTone
        .mul(CLEAR_SHORE_TONE[1] - CLEAR_SHORE_TONE[0])
        .add(CLEAR_SHORE_TONE[0])
        .mul(longCoast.mul(0.35).add(0.65))
    : float(1);
  const bed = inputs.bedAt ? inputs.bedAt(bounded) : color(palette.bed).mul(sandGrain).mul(tone);
  // Seabed dapple: low-frequency, static patches of rock and weed and deeper holes, seen through the water as the
  // prototype's and RA3's dark blotches; the refraction offset makes their edges waver with the waves.
  const shifted = p.xz.add(bounded.mul(3));
  const under = vec2(shifted.x.sub(shifted.y), shifted.x.add(shifted.y).mul(0.5));
  // Rock and weed from one tap: the broad field shaped by the medium one (the noise texture's r and g octaves).
  const rockTap = texture(noise, under.mul(0.11));
  const rockField = rockTap.r.mul(0.6).add(rockTap.g.mul(0.4));
  // Rocks start in the shallows, so the bed there is not a bare even colour, and fade out with depth: the bed of deep
  // water is not seen, and patches tens of cells wide there read as dark stains or cloud shadows on the open sea.
  const rock = smoothstep(CLEAR_WATER.dappleFrom, CLEAR_WATER.dappleFrom + 0.1, rockField)
    .mul(max(smoothstep(0.15, 0.8, cells), float(1).sub(longCoast)))
    .mul(smoothstep(CLEAR_WATER.dappleDeep, CLEAR_WATER.dappleDeep * 0.55, metres));
  const dapple = mix(
    float(1).sub(rock.mul(CLEAR_WATER.dappleDark)),
    float(1),
    max(hard.mul(0.5), quay.mul(0.2), night.mul(0.45)),
  );
  // Water colour: the approved turquoise over sand, deepening to the approved teal; the change is read at a depth
  // perturbed by the rock field, so the edge of the shallows is ragged rather than a smooth contour. The bed's own
  // light and dark (sand ripples, art) stays visible through the first few metres, and the sand's own colour through
  // the first half metre or so, so the shallows read as clear water over sand rather than a glowing band.
  const sandColour = new Color(palette.bed);
  const bedLuma = dot(bed, vec3(0.2126, 0.7152, 0.0722)).div(
    0.2126 * sandColour.r + 0.7152 * sandColour.g + 0.0722 * sandColour.b,
  );
  const bedShade = mix(
    float(1),
    bedLuma.clamp(0.4, 1.6).pow(1.4),
    exp(metres.mul(-CLEAR_WATER.bedTexture))
      .mul(float(1).sub(quayDeep))
      .mul(float(1).sub(night.mul(0.8))),
  );
  // Only near the shallows may the perturbation make the water read shallower: further out it raised isolated
  // turquoise blobs in deep water.
  const tintWarp = rockTap.g.sub(0.5).mul(0.7);
  const tintDepth = metres.mul(float(1).add(max(tintWarp, tintWarp.mul(smoothstep(3.2, 1.8, metres)))));
  // At night the shallows keep the deep colour: the night transform below brightens the water body, and a turquoise
  // band brightened with it glowed as a pale ring (a lace of rings where the reef edge wanders).
  // Islets and headlands (short shores) have steep rock sides and no sand flats: their narrow fringe is a darker,
  // clearer turquoise than a beach's, so it does not read as a pale collar around each rock.
  const aqua = mix(
    color(palette.shallow).mul(CLEAR_WATER.shallowLevel).mul(longCoast.mul(0.3).add(0.7)),
    color(palette.deep).mul(CLEAR_WATER.deepGain),
    night.mul(0.85),
  );
  // The deep teal lighter than the palette: with the weaker sky reflection it would otherwise read darker
  // than the approved look (deep L* about 30 instead of 35-41).
  const column = mix(
    aqua,
    color(palette.deep).mul(CLEAR_WATER.deepGain),
    // Even a partial quay class (shaded bridge and pier faces read as mixed ground) takes the deep colour: the
    // turquoise of a partial depth there drew cyan wisps under bridges.
    // Beside very dark ground (asphalt ramps, shaded bridge heads; clearShoreTone near 0) there is no sand bed to
    // light the water: a turquoise patch there floated in the gap of a broken bridge.
    max(smoothstep(CLEAR_WATER.aquaEnd * 0.3, CLEAR_WATER.aquaEnd, tintDepth), masonry),
  )
    .mul(dapple)
    .mul(bedShade);
  const seen = exp(metres.mul(-CLEAR_WATER.clarity));
  // Caustics: drifting light on the bed between about a third of a cell and a cell and a half from the beach.
  const caustic = texture(
    waterTextures().caustics,
    p.xz
      .div(1.3)
      .add(bounded.mul(4))
      .add(vec2(time.mul(0.045), time.mul(-0.033))),
  )
    .r.sub(0.45)
    .mul(CLEAR_WATER.causticGain)
    .mul(smoothstep(0.1, 0.4, edge).mul(smoothstep(1.6, 0.8, edge)))
    .mul(float(1).sub(hard).mul(float(1).sub(quayDeep)))
    // Caustics need sunlight: under the moon they drew a regular honeycomb over the night shallows.
    .mul(float(1).sub(night));
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(metres.negate()));
  // The bed seen through the first metre keeps its own light and dark but takes the water's turquoise hue within about
  // half a metre (sand colour mixed straight into turquoise read as a grey, milky rim).
  const aquaLuma =
    new Color(palette.shallow).r * 0.2126 +
    new Color(palette.shallow).g * 0.7152 +
    new Color(palette.shallow).b * 0.0722;
  // Wet sand and rock under the water are darker than the dry beach beside it.
  const bedSeen = bed.mul(dapple).mul(smoothstep(0.0, 0.6, metres).mul(0.18).add(0.5));
  const cyanBed = color(palette.shallow)
    .div(aquaLuma)
    .mul(dot(bedSeen, vec3(0.2126, 0.7152, 0.0722)).mul(1.05));
  const throughWater = mix(bedSeen.mul(transmission), cyanBed, smoothstep(0.0, 0.2, metres).mul(0.92));
  // At night the bed is not lit enough to show: the night transform below would turn a lit bed into pale lace.
  // The last few centimetres over a beach are wet sand under a film of water, darker than both the dry sand and the
  // shallows: mixing the sand's orange with the turquoise there otherwise drew a pale grey line along the coast.
  const wetEdge = mix(float(0.86), float(1), smoothstep(0.02, 0.3, metres).max(quayDeep).max(hard));
  let body: ShaderNode = mix(column, throughWater, seen.mul(float(1).sub(night.mul(0.85))))
    .mul(float(1).add(caustic))
    .mul(wetEdge);
  // A's relief is illumination by the same normal used for glints, not a separate crest/height pattern.
  // Over the shallows the bed, not the surface relief, carries the texture.
  // At night the moon stands higher than the day's glint light: lit from low ahead, the relief alone (no bed,
  // glints or seabed patches to break it up) read as diagonal streaks.
  const reliefLight = normalize(mix(light, vec3(0, 1, 0), night.mul(0.3)));
  // Shading by a slope along one light direction weights the waves' spectrum by cos^2 of the angle to the light, so
  // even a round sea reads as streaks across the light (spectral anisotropy about 0.5 wherever nothing else breaks it
  // up: open deep water, night, snow). Half of the relief is shaded by tilt alone, which has no direction.
  const lit = max(dot(normal, reliefLight), 0).div(reliefLight.y);
  const tilted = float(1).sub(float(1).sub(normal.y).mul(CLEAR_WATER.tiltShade)).add(CLEAR_WATER.tiltMean);
  const relief = mix(
    float(1),
    mix(lit, tilted, CLEAR_WATER.tiltShare),
    smoothstep(0.5, 3.5, metres).mul(0.92).add(0.2).mul(CLEAR_WATER.relief),
  );
  body = body.mul(relief);
  // Cliff feet: the wall drops into deep, shaded water, darkest within half a cell of real rock walls (a snowy or
  // rocky shore without a cliff keeps its colour: a dark ring there read as a black halo).
  const cliffNear: ShaderNode = inputs.cliffNear ?? hard;
  const cliffFoot = hard.mul(cliffNear).mul(smoothstep(0.6, 0.15, edge));
  body = body.mul(float(1).sub(hard.mul(0.08)).sub(cliffFoot.mul(CLEAR_WATER.cliffContact)));
  // Quays: the deep colour, a touch lighter, up to the wall, then a dark wet line at its foot.
  body = body.mul(
    float(1)
      .add(quay.mul(0.03))
      .sub(quay.mul(smoothstep(0.07, 0.0, edge)).mul(0.3)),
  );
  // Night: the moonlight is blue; a greener, brighter body keeps the water a dark teal, never black navy.
  const nightBody = body.mul(vec3(5.0, 3.4, 1.9));
  body = mix(
    body,
    mix(nightBody, vec3(dot(nightBody, vec3(0.2126, 0.7152, 0.0722))), 0.1),
    night,
  );

  // The RTS camera is orthographic: one view direction for the whole screen (IsoCamera, 30 degree pitch), so the
  // glitter is spread by the waves alone instead of gathering on one side of the screen.
  const view = vec3(Math.cos(Math.PI / 6) * Math.SQRT1_2, 0.5, Math.cos(Math.PI / 6) * Math.SQRT1_2);
  const reflectedDirection = reflect(view.negate(), normal);
  const fresnel = float(0.02).add(pow(float(1).sub(max(dot(normal, view), 0)), 5).mul(0.98));
  // Fresnel toward the far edge: the RTS camera hardly changes the view angle across the screen, so the top of the
  // screen stands in for grazing view.
  const far = smoothstep(0.75, 0.0, screenUV.y);
  const strength = float(CLEAR_WATER.reflection)
    .add(fresnel.mul(CLEAR_WATER.fresnelGain))
    .add(far.mul(CLEAR_WATER.skyTop).mul(float(1).sub(night)))
    .min(CLEAR_WATER.reflectionMax)
    .mul(float(1).sub(cliffFoot.mul(0.6)));
  const open = smoothstep(0, 0.45, edge);
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0, 0.8, reflectedDirection.y)).mul(
    mix(float(0.24), sceneBrightness.min(1).mul(0.12), night),
  );
  // The mirrored scene: at a cliff only the foot of the rock is mirrored (fading within about 0.4 cells) and in the
  // water's own colour, so tall walls do not smear brown far out over the deep water.
  let mirror: ShaderNode = sky;
  let objectMirror: ShaderNode = float(0);
  let objectColour: ShaderNode = vec3(0);
  if (inputs.reflection) {
    const mirrored = moonlit(inputs.reflection.colour, nodes);
    const toned = mix(
      mirrored,
      color(palette.deep).mul(dot(mirrored, vec3(0.2126, 0.7152, 0.0722)).mul(3)),
      hard.mul(0.7),
    );
    const coverage = inputs.reflection.coverage
      .mul(CLEAR_WATER.mirrorKeep)
      .mul(mix(float(1), smoothstep(0.45, 0.05, edge), hard));
    mirror = mix(sky, toned, coverage);
    // Bridges, piers and ships: at the clear look's low Fresnel strength their mirror image vanished into the bright
    // water body and the bridge seemed to float. Where the mirror holds an object, it replaces up to objectReflection
    // of the water, as in the enhanced look's OBJECT_REFLECT; cliffs keep their short, water-toned foot image.
    objectMirror = inputs.reflection.coverage
      .mul(CLEAR_WATER.objectReflection)
      .mul(float(1).sub(hard))
      .mul(float(1).sub(night.mul(0.5)));
    // The mirror shows the art's lit face, but water mirrors an object's shaded underside: pale rails and road
    // markings mirrored at full brightness read as glass slabs. The image is held below the water's own brightness,
    // so a bridge or hull mirrors as a darker shape, as in the original and enhanced looks.
    const waterLuma = dot(body, vec3(0.2126, 0.7152, 0.0722));
    const imageLuma = max(dot(toned, vec3(0.2126, 0.7152, 0.0722)), 0.001);
    objectColour = toned.mul(waterLuma.mul(CLEAR_WATER.objectShade).div(imageLuma).min(1));
  }
  // A's sharp Phong glints, lit from ahead (CLEAR_GLINT_LIGHT) in the sun's colour.
  const sunDot = max(dot(reflectedDirection, light), 0);
  const glint = pow(sunDot, CLEAR_WATER.shininess).mul(CLEAR_WATER.sparkle).add(pow(sunDot, 60).mul(0.03));
  // Break the glints up with a fine mask that is isotropic on screen (ground x - z across, x + z down undoes the 2:1
  // squash): one crest otherwise lit a whole horizontal dash, and patches of them streaked across a still.
  const twinkle = texture(
    noise,
    vec2(p.x.sub(p.z), p.x.add(p.z).mul(0.5))
      .mul(1.1)
      .add(vec2(time.mul(0.011), time.mul(-0.008))),
  ).b;
  const sparkle = uniforms.sunColor
    .mul(glint)
    .mul(smoothstep(0.6, 0.74, twinkle).mul(1.5))
    .mul(smoothstep(0.4, 2, metres))
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night));
  const lights = sampleLightField(p.xz.sub(vec2(Math.SQRT1_2, Math.SQRT1_2).mul(0.9)).add(groundTilt.mul(2)), nodes)
    .mul(0.12)
    .min(vec3(0.18));
  const breakup = texture(noise, p.xz.mul(0.24)).g;
  const lace = texture(noise, p.xz.mul(0.9).add(vec2(time.mul(0.007), 0))).b;
  const cycle = time.mul((2 * Math.PI) / CLEAR_WATER.foamPeriod).add(breakup.mul(3));
  const breath = sin(cycle).mul(0.5).add(0.5);
  // Beaches: no white outline at the waterline (the owner read the continuous white rim as a sticker edge). The sand
  // runs into wet sand and clear shallows; white water appears only as a sparse, broken wash line while a wave runs
  // up (the rising half of each local cycle) and is gone as it draws back.
  const swash = breath.mul(0.14).add(0.02);
  const rising = smoothstep(-0.2, 0.6, sin(cycle.add(Math.PI / 2)));
  // Holes in the foam from the moving wave field itself (a separate fine noise tap cost about 0.2 ms at 1080p).
  const holes = float(1).sub(field.w).mul(0.7).add(breakup.mul(0.3));
  const swashLine = smoothstep(0.035, 0.0, abs(edge.sub(swash)))
    .mul(smoothstep(0.45, 0.7, lace))
    .mul(smoothstep(0.45, 0.62, holes))
    .mul(rising)
    .mul(0.5);
  // Only a few stretches of coast take a set of waves at a time: a broad mask drifting along the coast.
  const set = smoothstep(0.6, 0.72, texture(noise, p.xz.mul(0.07).add(vec2(time.mul(0.006), time.mul(-0.004)))).g);
  const beachFoam = swashLine
    .mul(set)
    .mul(smoothstep(0.05, 0.09, swash))
    .mul(smoothstep(0.4, 0.65, breakup))
    .mul(float(1).sub(hard))
    .mul(float(1).sub(quay));
  // Rocky shores: a little broken white water at the base where waves hit, breathing slowly.
  const rockFoam = smoothstep(0.04, 0.012, edge)
    .mul(smoothstep(0.5, 0.7, lace))
    .mul(breath.mul(0.6).add(0.4))
    .mul(hard)
    .mul(0.3);
  // Small streaky white crests only where the two moving long-wave compression masks overlap.
  const clock = time.mul(CLEAR_SURFACE.timeScale);
  const surfaceMetres = p.xz.mul(CLEAR_SURFACE.metresPerCell).add(vec2(clock.mul(0.4), 0));
  const wind = (200 * Math.PI) / 180;
  const alongWind = vec2(
    surfaceMetres.x.mul(Math.cos(wind)).add(surfaceMetres.y.mul(Math.sin(wind))),
    surfaceMetres.y.mul(Math.cos(wind)).sub(surfaceMetres.x.mul(Math.sin(wind))),
  );
  // The cached noise has 24 fine / 4 broad lattice cycles per tile; convert prototype metres to its UVs.
  const fleck = texture(noise, alongWind.mul(vec2(4.5 / 24, 1.6 / 24))).b;
  const gust = texture(noise, surfaceMetres.mul(0.05 / 4).add(clock.mul(0.03 / 4))).r;
  const whitecaps = smoothstep(0.6, 0.82, field.w.mul(0.8).add(fleck.mul(0.55)))
    .mul(smoothstep(0.35, 0.7, gust))
    .mul(CLEAR_WATER.whitecap)
    .mul(smoothstep(1, 3, metres))
    .mul(float(1).sub(hard))
    .mul(float(1).sub(quay));
  const foam = beachFoam
    .add(rockFoam)
    .add(whitecaps)
    .min(1)
    .mul(waterness)
    .mul(float(1).sub(night.mul(0.5)));
  const objectShare = objectMirror.mul(open);
  body = mix(body.mul(float(1).sub(strength.mul(open)).sub(objectShare)), color(0xe8eeec), foam);
  const emission = mirror
    .mul(strength)
    .add(sparkle)
    .add(lights)
    .mul(open)
    .add(objectColour.mul(objectShare))
    .mul(waterness)
    .mul(float(1).sub(foam));
  return { normal, body, emission, foam };
}

/** Adapt the clear surface to the bed path's existing coverage contract; leave dry terrain artwork untouched. */
export function clearBedWaterLook(inputs: BedWaterInputs, nodes = DEFAULT_ATMOSPHERE_NODES): BedWaterLook {
  const look = clearWaterLook(inputs, nodes);
  return {
    ...look,
    // Foam is already blended into clear's body, unlike the enhanced bed contract.
    foam: float(0),
    foamColour: color(0xc4ceca),
    land: inputs.bedAt(vec2(0)),
    coverage: inputs.waterness,
    openWater: inputs.waterness,
    wetness: float(0),
    roughness: float(1),
    gloss: float(0),
  };
}
