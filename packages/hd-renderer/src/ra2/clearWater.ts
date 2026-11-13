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
  shelfSlope: 1.3,
  shelfDrop: 5,
  shelfStart: 0.4,
  shelfEnd: 2.2,
  maxMetres: 8,
  refraction: 0.04,
  maxRefraction: 0.05,
  foamPeriod: 7,
  causticGain: 0.4,
  reflection: 0.03,
  reflectionMax: 0.13,
  /** Share of the Fresnel term added to the reflection strength. */
  fresnelGain: 0.45,
  skyTop: 0.06,
  shininess: 700,
  sparkle: 4,
  relief: 1.2,
  whitecap: 0.32,
  cliffContact: 0.55,
  mirrorKeep: 0.55,
  /** Seabed dapple: rock/weed threshold of the 0..1 field (lower = more patches) and how much they darken. */
  dappleFrom: 0.52,
  dappleDark: 0.5,
  /** Turquoise level over sand, depth (m) at which it has become the deep teal, and how fast the bed fades (1/m). */
  shallowLevel: 0.78,
  deepGain: 1.4,
  aquaEnd: 4.5,
  clarity: 1.4,
  /** How far (1/m) the bed's own light and dark (sand ripples, rocks) stays visible through the water. */
  bedTexture: 0.32,
  motionTarget: 1.5,
  anisotropyTarget: 0.4,
  highlightTarget: 0.04,
  saturationTarget: 0.6,
} as const;

/** One ground world unit is one cell (world.ts); eight metres per cell is the chosen visual scale. */
export const CLEAR_SURFACE = { tileMetres: 26, metresPerCell: 8, timeScale: 0.5, normalGain: 1.5 } as const;
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
  const uv = ground.mul((CLEAR_SURFACE.metresPerCell * 103) / CLEAR_SURFACE.tileMetres);
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
  const normal = normalize(mean.xzy.mul(vec3(CLEAR_SURFACE.normalGain, 1, CLEAR_SURFACE.normalGain)));
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
  const edge = max(inputs.maskShore ?? shore, 0);
  const cells = max(shore, 0);
  // The shallows follow the shore's shape: wide in bays and along long coasts, narrow around islets and off headlands,
  // where the bed drops away quickly.
  // Shore mass 0.5 is a straight coast (shoreField.ts SHORE_MASS_FULL).
  const width: ShaderNode = inputs.shoreMass
    ? mix(float(0.45), float(1.3), smoothstep(0.15, 0.62, inputs.shoreMass))
    : float(1);
  const shelfCells = cells.div(width);
  const field = clearField(p.xz);
  const normal = field.xyz;
  const groundTilt = normal.xz.negate().div(max(normal.y, 0.01));
  const light = vec3(...CLEAR_GLINT_LIGHT);
  const noise = waterTextures().noise;
  // One broad noise tap serves the seabed holes (r) and the wandering shelf edge (g, plus a second, smaller wander
  // from a mid-scale tap): the shore distance is warped before the shelf profile, so the shallows widen in some places
  // and narrow in others instead of an even ring, without raising shoals out in open water.
  const broad = texture(noise, p.xz.mul(0.043).add(vec2(0.57, 0.21)));
  const mid = texture(noise, p.xz.mul(0.16).add(vec2(0.13, 0.71))).g;
  const wander = broad.g.sub(0.5).mul(2.4).add(mid.sub(0.5).mul(1.8)).clamp(-0.45, 0.75);
  // Bays and wander together widen the shallows at most 1.6 times: more raised shoals far out beside seawalls.
  const warped = cells.mul(
    float(1)
      .add(wander.mul(smoothstep(0.25, 1.0, shelfCells)))
      .div(width)
      .max(0.62),
  );
  const shelf = warped
    .mul(CLEAR_WATER.shelfSlope)
    .add(smoothstep(CLEAR_WATER.shelfStart, CLEAR_WATER.shelfEnd, warped).mul(CLEAR_WATER.shelfDrop));
  const metres = max(shelf, max(hard.mul(6), quay.mul(5)))
    .max(0)
    .min(CLEAR_WATER.maxMetres);
  // 0..1 depth for the rules that need one (glints, night, whitecaps).
  const depth = smoothstep(0, 4.5, metres);
  // Refracted bed: the lake bed's own art where the cache has one, else the theatre's sand with a faint ripple-mark
  // texture, both shifted a little by the wave normals. (Sampling the ground inland of the shore traced the distance
  // field's medial lines as rays around rocks and piers.)
  const offset = groundTilt.mul(CLEAR_WATER.refraction).mul(smoothstep(0, 0.3, metres));
  const bounded = offset.mul(float(CLEAR_WATER.maxRefraction).div(max(offset.length(), CLEAR_WATER.maxRefraction)));
  // Sand: a fine grain and long, wavy ripple marks across the shore (the noise stretched along one axis).
  const sandTap = texture(noise, p.xz.add(bounded).mul(vec2(0.42, 0.42)));
  const rippleAt = p.xz.add(bounded).add(vec2(sandTap.g.mul(0.35), 0));
  const ripple = texture(noise, vec2(rippleAt.x.add(rippleAt.y).mul(0.95), rippleAt.x.sub(rippleAt.y).mul(0.16))).b;
  const sandGrain = sandTap.b.sub(0.5).mul(0.35).add(ripple.sub(0.5).mul(0.8)).add(1);
  // The bed near a shore takes the brightness of that shore's land (dark rock islands sit in dark-floored water).
  const tone: ShaderNode = inputs.shoreTone
    ? inputs.shoreTone.mul(CLEAR_SHORE_TONE[1] - CLEAR_SHORE_TONE[0]).add(CLEAR_SHORE_TONE[0])
    : float(1);
  const bed = inputs.bedAt ? inputs.bedAt(bounded) : color(palette.bed).mul(sandGrain).mul(tone);
  // Seabed dapple: low-frequency, static patches of rock and weed and deeper holes, seen through the water as the
  // prototype's and RA3's dark blotches; the refraction offset makes their edges waver with the waves.
  const under = p.xz.add(bounded.mul(3));
  // Rock and weed from one tap: the broad field shaped by the medium one (the noise texture's r and g octaves).
  const rockTap = texture(noise, under.mul(0.075));
  const rockField = rockTap.r.mul(0.6).add(rockTap.g.mul(0.4));
  const holeField = broad.r;
  // Rocks start in the shallows, so the bed there is not a bare even colour.
  const rock = smoothstep(CLEAR_WATER.dappleFrom, CLEAR_WATER.dappleFrom + 0.07, rockField).mul(
    smoothstep(0.15, 0.8, cells),
  );
  const hole = smoothstep(0.54, 0.66, holeField).mul(smoothstep(1.2, 2.5, cells));
  const dapple = mix(
    float(1)
      .sub(rock.mul(CLEAR_WATER.dappleDark))
      .mul(float(1).sub(hole.mul(CLEAR_WATER.dappleDark * 0.6))),
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
  const bedShade = mix(float(1), bedLuma.clamp(0.4, 1.6), exp(metres.mul(-CLEAR_WATER.bedTexture)));
  // Only near the shallows may the perturbation make the water read shallower: further out it raised isolated
  // turquoise blobs in deep water.
  const tintWarp = rockTap.g.sub(0.5).mul(0.7);
  const tintDepth = metres.mul(float(1).add(max(tintWarp, tintWarp.mul(smoothstep(3.2, 1.8, metres)))));
  // At night the shallows keep the deep colour: the night transform below brightens the water body, and a turquoise
  // band brightened with it glowed as a pale ring (a lace of rings where the reef edge wanders).
  const aqua = mix(
    color(palette.shallow).mul(CLEAR_WATER.shallowLevel),
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
    max(smoothstep(CLEAR_WATER.aquaEnd * 0.3, CLEAR_WATER.aquaEnd, tintDepth), smoothstep(0.08, 0.45, quay)),
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
      .add(vec2(time.mul(0.014), time.mul(-0.01))),
  )
    .r.sub(0.45)
    .mul(CLEAR_WATER.causticGain)
    .mul(smoothstep(0.1, 0.4, edge).mul(smoothstep(1.6, 0.8, edge)))
    .mul(float(1).sub(hard).mul(float(1).sub(quay)));
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(metres.negate()));
  // The bed seen through the first metre keeps its own light and dark but takes the water's turquoise hue within about
  // half a metre (sand colour mixed straight into turquoise read as a grey, milky rim).
  const aquaLuma =
    new Color(palette.shallow).r * 0.2126 +
    new Color(palette.shallow).g * 0.7152 +
    new Color(palette.shallow).b * 0.0722;
  // Wet sand and rock under the water are darker than the dry beach beside it.
  const bedSeen = bed.mul(dapple).mul(0.82);
  const cyanBed = color(palette.shallow)
    .div(aquaLuma)
    .mul(dot(bedSeen, vec3(0.2126, 0.7152, 0.0722)).mul(1.05));
  const throughWater = mix(bedSeen.mul(transmission), cyanBed, smoothstep(0.05, 0.7, metres));
  let body: ShaderNode = mix(column, throughWater, seen).mul(float(1).add(caustic));
  // A's relief is illumination by the same normal used for glints, not a separate crest/height pattern.
  // Over the shallows the bed, not the surface relief, carries the texture.
  const relief = mix(
    float(1),
    max(dot(normal, light), 0).div(light.y),
    smoothstep(0, 3, metres).mul(0.55).add(0.45).mul(CLEAR_WATER.relief),
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
    night.mul(smoothstep(0.15, 0.85, depth)),
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
    mix(float(0.28), sceneBrightness.min(1).mul(0.12), night),
  );
  // The mirrored scene: at a cliff only the foot of the rock is mirrored (fading within about 0.4 cells) and in the
  // water's own colour, so tall walls do not smear brown far out over the deep water.
  let mirror: ShaderNode = sky;
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
  }
  // A's sharp Phong glints, lit from ahead (CLEAR_GLINT_LIGHT) in the sun's colour.
  const sunDot = max(dot(reflectedDirection, light), 0);
  const glint = pow(sunDot, CLEAR_WATER.shininess).mul(CLEAR_WATER.sparkle).add(pow(sunDot, 60).mul(0.03));
  // Break the glints up with a fine mask that is isotropic on screen (ground x - z across, x + z down undoes the 2:1
  // squash): one crest otherwise lit a whole horizontal dash, and patches of them streaked across a still.
  const twinkle = texture(
    noise,
    vec2(p.x.sub(p.z), p.x.add(p.z))
      .mul(0.9)
      .add(vec2(time.mul(0.011), time.mul(-0.008))),
  ).b;
  const sparkle = uniforms.sunColor
    .mul(glint)
    .mul(smoothstep(0.42, 0.62, twinkle).mul(1.5))
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
  const beachFoam = swashLine
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
  body = mix(body.mul(float(1).sub(strength.mul(open))), color(0xe8eeec), foam);
  const emission = mirror.mul(strength).add(sparkle).add(lights).mul(open).mul(waterness).mul(float(1).sub(foam));
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
