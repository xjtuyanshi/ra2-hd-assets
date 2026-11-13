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
  reflection: 0.07,
  reflectionMax: 0.22,
  skyTop: 0.12,
  shininess: 700,
  sparkle: 6,
  relief: 0.72,
  whitecap: 0.32,
  cliffContact: 0.55,
  mirrorKeep: 0.55,
  /** Seabed dapple: rock/weed threshold of the 0..1 field (lower = more patches) and how much they darken. */
  dappleFrom: 0.52,
  dappleDark: 0.5,
  /** Turquoise level over sand, depth (m) at which it has become the deep teal, and how fast the bed fades (1/m). */
  shallowLevel: 0.78,
  aquaEnd: 4.5,
  clarity: 3,
  motionTarget: 1.5,
  anisotropyTarget: 0.4,
  highlightTarget: 0.04,
  saturationTarget: 0.6,
} as const;

/** One ground world unit is one cell (world.ts); eight metres per cell is the chosen visual scale. */
export const CLEAR_SURFACE = { tileMetres: 26, metresPerCell: 8, timeScale: 0.8, normalGain: 1.5 } as const;
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
  const field = clearField(p.xz);
  const normal = field.xyz;
  const groundTilt = normal.xz.negate().div(max(normal.y, 0.01));
  const light = vec3(...CLEAR_GLINT_LIGHT);
  const noise = waterTextures().noise;
  const shelf = cells
    .mul(CLEAR_WATER.shelfSlope)
    .add(smoothstep(CLEAR_WATER.shelfStart, CLEAR_WATER.shelfEnd, cells).mul(CLEAR_WATER.shelfDrop));
  // One broad noise tap serves the seabed holes (r) and the wandering shelf edge (g), so the turquoise band is not an
  // even ring around every island.
  const broad = texture(noise, p.xz.mul(0.043).add(vec2(0.57, 0.21)));
  const wander = broad.g.sub(0.5).mul(2.4).clamp(-0.45, 0.45);
  const metres = max(shelf.mul(float(1).add(wander.mul(smoothstep(0.3, 1.2, cells)))), max(hard.mul(6), quay.mul(5)))
    .max(0)
    .min(CLEAR_WATER.maxMetres);
  // 0..1 depth for the rules that need one (glints, night, whitecaps).
  const depth = smoothstep(0, 4.5, metres);
  // Refracted bed: the lake bed's own art where the cache has one, else the theatre's sand with a faint ripple-mark
  // texture, both shifted a little by the wave normals. (Sampling the ground inland of the shore traced the distance
  // field's medial lines as rays around rocks and piers.)
  const offset = groundTilt.mul(CLEAR_WATER.refraction).mul(smoothstep(0, 0.3, metres));
  const bounded = offset.mul(float(CLEAR_WATER.maxRefraction).div(max(offset.length(), CLEAR_WATER.maxRefraction)));
  const sandGrain = texture(noise, p.xz.add(bounded).mul(0.42)).b.sub(0.5).mul(0.5).add(1);
  const bed = inputs.bedAt ? inputs.bedAt(bounded) : color(palette.bed).mul(sandGrain);
  // Seabed dapple: low-frequency, static patches of rock and weed and deeper holes, seen through the water as the
  // prototype's and RA3's dark blotches; the refraction offset makes their edges waver with the waves.
  const under = p.xz.add(bounded.mul(3));
  // Rock and weed from one tap: the broad field shaped by the medium one (the noise texture's r and g octaves).
  const rockTap = texture(noise, under.mul(0.075));
  const rockField = rockTap.r.mul(0.6).add(rockTap.g.mul(0.4));
  const holeField = broad.r;
  const rock = smoothstep(CLEAR_WATER.dappleFrom, CLEAR_WATER.dappleFrom + 0.07, rockField).mul(
    smoothstep(0.5, 1.4, cells),
  );
  const hole = smoothstep(0.54, 0.66, holeField).mul(smoothstep(1.2, 2.5, cells));
  const dapple = mix(
    float(1)
      .sub(rock.mul(CLEAR_WATER.dappleDark))
      .mul(float(1).sub(hole.mul(CLEAR_WATER.dappleDark * 0.6))),
    float(1),
    max(max(quay, hard).mul(0.5), night.mul(0.45)),
  );
  // Water colour: the approved turquoise over sand, modulated by the bed's own light and dark (ripple marks, art),
  // deepening to the approved teal over about a cell and a half; the bed itself shows only in the first fraction of
  // a metre, so the shallows read as clear water over sand rather than a glowing band.
  const sandColour = new Color(palette.bed);
  const bedLuma = dot(bed, vec3(0.2126, 0.7152, 0.0722)).div(
    0.2126 * sandColour.r + 0.7152 * sandColour.g + 0.0722 * sandColour.b,
  );
  const aqua = color(palette.shallow).mul(CLEAR_WATER.shallowLevel).mul(mix(float(1), bedLuma.min(1.6), 0.55));
  const column = mix(aqua, color(palette.deep), smoothstep(CLEAR_WATER.aquaEnd * 0.3, CLEAR_WATER.aquaEnd, metres)).mul(
    dapple,
  );
  const seen = exp(metres.mul(-CLEAR_WATER.clarity));
  // Caustics: drifting light on the bed between about a third of a cell and a cell and a half from the beach.
  const caustic = texture(
    waterTextures().caustics,
    p.xz
      .div(1.3)
      .add(bounded.mul(4))
      .add(vec2(time.mul(0.02), time.mul(-0.014))),
  )
    .r.sub(0.45)
    .mul(CLEAR_WATER.causticGain)
    .mul(smoothstep(0.1, 0.4, edge).mul(smoothstep(1.6, 0.8, edge)))
    .mul(float(1).sub(hard).mul(float(1).sub(quay)));
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(metres.negate()));
  let body: ShaderNode = mix(column, bed.mul(transmission), seen).mul(float(1).add(caustic));
  // A's relief is illumination by the same normal used for glints, not a separate crest/height pattern.
  const relief = mix(float(1), max(dot(normal, light), 0).div(light.y), CLEAR_WATER.relief);
  body = body.mul(relief);
  // Cliff feet: the wall drops into deep, shaded water, darkest within half a cell of real rock walls (a snowy or
  // rocky shore without a cliff keeps its colour: a dark ring there read as a black halo).
  const cliffNear: ShaderNode = inputs.cliffNear ?? hard;
  const cliffFoot = hard.mul(cliffNear).mul(smoothstep(0.6, 0.15, edge));
  body = body.mul(float(1).sub(hard.mul(0.08)).sub(cliffFoot.mul(CLEAR_WATER.cliffContact)));
  // Quays: a slightly lighter deep colour up to the wall, then a dark wet line at its foot.
  body = body.mul(
    float(1)
      .add(quay.mul(0.08))
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
    .add(fresnel.mul(0.9))
    .add(far.mul(CLEAR_WATER.skyTop).mul(float(1).sub(night)))
    .min(CLEAR_WATER.reflectionMax)
    .mul(float(1).sub(cliffFoot.mul(0.6)));
  const open = smoothstep(0, 0.45, edge);
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0, 0.8, reflectedDirection.y)).mul(
    mix(float(0.4), sceneBrightness.min(1).mul(0.12), night),
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
  const glint = pow(sunDot, CLEAR_WATER.shininess).mul(CLEAR_WATER.sparkle).add(pow(sunDot, 60).mul(0.1));
  const sparkle = uniforms.sunColor
    .mul(glint)
    .mul(smoothstep(0.4, 2, metres))
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night));
  const lights = sampleLightField(p.xz.sub(vec2(Math.SQRT1_2, Math.SQRT1_2).mul(0.9)).add(groundTilt.mul(2)), nodes)
    .mul(0.12)
    .min(vec3(0.18));
  const breakup = texture(noise, p.xz.mul(0.24)).g;
  const lace = texture(noise, p.xz.mul(0.9).add(vec2(time.mul(0.01), 0))).b;
  const cycle = time.mul((2 * Math.PI) / CLEAR_WATER.foamPeriod).add(breakup.mul(3));
  const breath = sin(cycle).mul(0.5).add(0.5);
  // Beaches: wet white water at the very edge that thins into broken lace, and a soft swash line that slowly runs up
  // and back; both broken by noise so islands are not outlined like stickers.
  const swash = breath.mul(0.16).add(0.03);
  // Holes in the foam from the moving wave field itself (a separate fine noise tap cost about 0.2 ms at 1080p).
  const holes = float(1).sub(field.w).mul(0.7).add(breakup.mul(0.3));
  const swashLine = smoothstep(0.045, 0.0, abs(edge.sub(swash)))
    .mul(smoothstep(0.35, 0.6, lace))
    .mul(smoothstep(0.38, 0.55, holes))
    .mul(0.6);
  // White water at the edge: densest at the waterline, thinning into lace with holes over about a tenth of a cell.
  const wash = smoothstep(0.11, 0.0, edge)
    .mul(smoothstep(0.32, 0.62, lace.mul(0.5).add(holes.mul(0.5)).add(smoothstep(0.05, 0, edge).mul(0.12))))
    .mul(0.7);
  const beachFoam = max(wash, swashLine)
    .mul(smoothstep(0.32, 0.62, breakup).mul(0.5).add(0.5))
    .mul(float(1).sub(hard))
    .mul(float(1).sub(quay));
  // Rocky shores: a broken line of white water 3-6 px wide at the base, breathing slowly.
  const rockFoam = smoothstep(0.045, 0.012, edge)
    .mul(smoothstep(0.38, 0.62, lace))
    .mul(breath.mul(0.5).add(0.5))
    .mul(hard)
    .mul(0.45);
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
