import {
  Color,
  DataTexture,
  EnvironmentNode,
  MeshStandardNodeMaterial,
  NearestFilter,
  NoColorSpace,
  PhysicalLightingModel,
  RGBAFormat,
  UnsignedByteType,
  type NodeBuilder,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraWorldMatrix,
  ceil,
  cos,
  float,
  floor,
  fract,
  mix,
  modelPosition,
  normalView,
  normalWorld,
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
  roughness,
  sRGBTransferEOTF,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, objectLight, type AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { objectLevelAt, paletteGrade, paletteNodes, srgbScale, type MapLightGrade } from './mapLighting';
import { highlightRoughness, poweredOcclusion, spriteLookFor, type SpriteLookState } from './spriteLook';
import { ra2VoxelClass, VOXEL_CLASS_ID } from './voxelClasses';
import { VOXEL_TO_WORLD } from './voxelScale';
import { voxelLightingFor } from './vpl';

export const VOXEL_PBR_DEFAULTS = Object.freeze({
  brightness: 1,
  aoStrength: 0.8,
  envStrength: 0.5,
  shadeSmooth: 1,
  edgeLight: 0.08,
  tread: 0.8,
  treadPeriod: 0.8,
  treadHeight: 3.5,
  dust: 0.1,
  streaks: 0.12,
  sunGain: 0.85,
  fill: 0.55,
  houseSat: 1.3,
  houseGain: 1.1,
  wear: 0.2,
  wearStart: 1,
  cavity: 0.4,
  cavityStart: 0.6,
  grime: 0.25,
  grimeHeight: 4,
  microNoise: 0.06,
  specular: 1,
  lightStrength: 1,
});
export type VoxelPbrKnob = keyof typeof VOXEL_PBR_DEFAULTS;

export class VoxelPbrState {
  readonly brightness = uniform(VOXEL_PBR_DEFAULTS.brightness);
  readonly aoStrength = uniform(VOXEL_PBR_DEFAULTS.aoStrength);
  readonly envStrength = uniform(VOXEL_PBR_DEFAULTS.envStrength);
  readonly shadeSmooth = uniform(VOXEL_PBR_DEFAULTS.shadeSmooth);
  readonly edgeLight = uniform(VOXEL_PBR_DEFAULTS.edgeLight);
  readonly tread = uniform(VOXEL_PBR_DEFAULTS.tread);
  readonly treadPeriod = uniform(VOXEL_PBR_DEFAULTS.treadPeriod);
  readonly treadHeight = uniform(VOXEL_PBR_DEFAULTS.treadHeight);
  readonly dust = uniform(VOXEL_PBR_DEFAULTS.dust);
  readonly streaks = uniform(VOXEL_PBR_DEFAULTS.streaks);
  readonly sunGain = uniform(VOXEL_PBR_DEFAULTS.sunGain);
  readonly fill = uniform(VOXEL_PBR_DEFAULTS.fill);
  readonly houseSat = uniform(VOXEL_PBR_DEFAULTS.houseSat);
  readonly houseGain = uniform(VOXEL_PBR_DEFAULTS.houseGain);
  readonly dustColour = uniform(new Color(0.55, 0.48, 0.38).convertSRGBToLinear());
  readonly wear = uniform(VOXEL_PBR_DEFAULTS.wear);
  readonly wearStart = uniform(VOXEL_PBR_DEFAULTS.wearStart);
  readonly cavity = uniform(VOXEL_PBR_DEFAULTS.cavity);
  readonly cavityStart = uniform(VOXEL_PBR_DEFAULTS.cavityStart);
  readonly grime = uniform(VOXEL_PBR_DEFAULTS.grime);
  readonly grimeHeight = uniform(VOXEL_PBR_DEFAULTS.grimeHeight);
  readonly microNoise = uniform(VOXEL_PBR_DEFAULTS.microNoise);
  readonly specular = uniform(VOXEL_PBR_DEFAULTS.specular);
  readonly lightStrength = uniform(VOXEL_PBR_DEFAULTS.lightStrength);
  readonly skyZenith = uniform(new Color(0.45, 0.5, 0.58));
  readonly skyHorizon = uniform(new Color(0.7, 0.68, 0.64));
  readonly groundColour = uniform(new Color(0.22, 0.2, 0.16));
  readonly byPalette = new WeakMap<Uint8Array, MeshStandardNodeMaterial>();
}
const states = new WeakMap<AtmosphereNodes, VoxelPbrState>();
export function voxelPbrFor(nodes: AtmosphereNodes = DEFAULT_ATMOSPHERE_NODES): VoxelPbrState {
  let state = states.get(nodes);
  if (!state) {
    state = new VoxelPbrState();
    states.set(nodes, state);
  }
  return state;
}

/**
 * Shade row of the engine's voxel lighting table (voxels.vpl) whose colours serve as the remaster albedo. A voxel's
 * stored palette index is its colour at row 16 (N.L + highlight = 1); the engine shows lit faces through rows well
 * above that (a flat top reaches about row 29), so the stored colours are systematically darker than what players
 * know: the Soviet MCV's hull is stored mid grey and only the table turns it white. Taking the albedo from a lit row
 * keeps each voxel's own ramp (the table never leaves it) and lets physical lighting supply the shading around it.
 */
export const VPL_ALBEDO_ROW = 22;

const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number): number =>
  Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055));
/** Largest brightening the lit row may apply; more turns every light ramp into flat white. */
const MAX_ALBEDO_GAIN = 6;

/**
 * The stored colour brightened to the lit row's luminance, keeping its own hue and saturation (the table's high rows
 * also drift towards white, which bleached the Rhino's khaki and the Allied blue). Clipping scales all channels
 * together, so a saturated colour stays saturated.
 */
export function litAlbedo(
  r: number,
  g: number,
  b: number,
  lr: number,
  lg: number,
  lb: number,
): [number, number, number] {
  const rgb = [toLinear(r), toLinear(g), toLinear(b)];
  const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  const base = lum(rgb);
  const gain =
    base > 1e-4 ? Math.min(MAX_ALBEDO_GAIN, Math.max(1, lum([toLinear(lr), toLinear(lg), toLinear(lb)]) / base)) : 1;
  const lit = rgb.map((c) => c * gain);
  const peak = Math.max(1, ...lit);
  return lit.map((c) => toSrgb(c / peak)) as [number, number, number];
}

/** The engine table as loaded by vpl.ts (256 entries per shade row). */
export interface VoxelShadeTable {
  table: Uint8Array;
  sections: number;
}

/** Raw sRGB and linear material parameters share a nearest-filtered texture; conversion belongs to row 0 only. */
export function voxelPbrLookupTexture(
  palette: Uint8Array,
  shades: VoxelShadeTable | null = null,
  row = VPL_ALBEDO_ROW,
): DataTexture {
  const bytes = new Uint8Array(256 * 3 * 4);
  const shadeRow = shades ? Math.max(0, Math.min(shades.sections - 1, Math.round(row))) * 256 : 0;
  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3]!;
    const g = palette[i * 3 + 1]!;
    const b = palette[i * 3 + 2]!;
    const j = shades ? shades.table[shadeRow + i]! : i;
    bytes.set([...litAlbedo(r, g, b, palette[j * 3]!, palette[j * 3 + 1]!, palette[j * 3 + 2]!), 255], i * 4);
    const m = ra2VoxelClass(i, r, g, b);
    bytes.set(
      [
        Math.round(m.roughness * 255),
        Math.round(m.metalness * 255),
        VOXEL_CLASS_ID[m.kind],
        Math.round(m.emissive * 255),
      ],
      (256 + i) * 4,
    );
  }
  const lut = new DataTexture(bytes, 256, 3, RGBAFormat, UnsignedByteType);
  lut.colorSpace = NoColorSpace;
  lut.minFilter = NearestFilter;
  lut.magFilter = NearestFilter;
  lut.generateMipmaps = false;
  lut.needsUpdate = true;
  return lut;
}

/** Smooth trilinear value noise, in voxel coordinates. An explicit Fn layout shares repeated detail samples. */
const valueNoise = Fn(([p]: ShaderNode[]) => {
  const i: ShaderNode = floor(p);
  const f: ShaderNode = fract(p);
  const u: ShaderNode = f.mul(f).mul(float(3).sub(f.mul(2)));
  const hash = (v: ShaderNode) => fract(sin(v.dot(vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  return mix(
    mix(
      mix(hash(i), hash(i.add(vec3(1, 0, 0))), u.x),
      mix(hash(i.add(vec3(0, 1, 0))), hash(i.add(vec3(1, 1, 0))), u.x),
      u.y,
    ),
    mix(
      mix(hash(i.add(vec3(0, 0, 1))), hash(i.add(vec3(1, 0, 1))), u.x),
      mix(hash(i.add(vec3(0, 1, 1))), hash(i.add(vec3(1, 1, 1))), u.x),
      u.y,
    ),
    u.z,
  );
}).setLayout({ name: 'voxelValueNoise', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

/** HemisphereLight already supplies diffuse sky. A stock EnvironmentNode would add that sky a second time. */
class SpecularSky extends EnvironmentNode {
  override setup(builder: NodeBuilder): undefined {
    const context = builder.context as { radiance: ShaderNode };
    context.radiance.addAssign(this.envNode);
    return undefined;
  }
}

class RemasterLighting extends PhysicalLightingModel {
  constructor(
    private readonly ao: ShaderNode,
    private readonly state: VoxelPbrState,
    private readonly look: SpriteLookState,
  ) {
    super();
  }
  override start(builder: NodeBuilder): void {
    super.start(builder);
    const { reflectedLight: reflected } = builder.context as { reflectedLight: Record<string, ShaderNode> };
    const diffuse = this.ao.mul(this.state.brightness);
    const specular = diffuse.mul(this.state.specular);
    // Apply once after all lights: multiplying in direct() would repeatedly darken earlier lights.
    // Key/fill balance: sunGain scales the direct (sun) terms, fill the sky's diffuse, so vehicles can carry the
    // directional contrast of the painted art around them without changing the scene's lights.
    (reflected.directDiffuse as ShaderNode).mulAssign(diffuse.mul(this.state.sunGain));
    (reflected.directDiffuse as ShaderNode).mulAssign(this.look.sunGain);
    (reflected.indirectDiffuse as ShaderNode).mulAssign(diffuse.mul(this.state.fill));
    (reflected.directSpecular as ShaderNode).mulAssign(specular.mul(this.state.sunGain));
    (reflected.directSpecular as ShaderNode).mulAssign(
      this.look.sunGain.mul(this.look.specularSize.mul(this.look.specularSize)),
    );
    (reflected.indirectSpecular as ShaderNode).mulAssign(specular);
  }
}

class RemasterMaterial extends MeshStandardNodeMaterial {
  ao!: ShaderNode;
  state!: VoxelPbrState;
  look!: SpriteLookState;
  override setupEnvironment(): EnvironmentNode | null {
    return this.envNode ? new SpecularSky(this.envNode) : null;
  }
  override setupLightingModel(): PhysicalLightingModel {
    return new RemasterLighting(this.ao, this.state, this.look);
  }
}

function createMaterial(
  lut: DataTexture,
  grade: MapLightGrade | null,
  nodes: AtmosphereNodes,
): MeshStandardNodeMaterial {
  const state = voxelPbrFor(nodes);
  const material = nodes.own(new RemasterMaterial());
  nodes.own(lut);
  material.name = 'voxel-remaster';
  material.state = state;
  const u: ShaderNode = attribute('pindex', 'float').add(0.5).div(256);
  const raw: ShaderNode = sRGBTransferEOTF(texture(lut, vec2(u, 1 / 6)).rgb);
  const shade: ShaderNode = attribute('pshade', 'float').clamp(0, 255);
  const shadeLow: ShaderNode = sRGBTransferEOTF(texture(lut, vec2(floor(shade).add(0.5).div(256), 1 / 6)).rgb);
  // Geometry bounds pshade to its own integer ramp endpoints. ceil keeps the upper tap inside that ramp,
  // including its final entry, for any shadeRamp without making palette materials depend on geometry options.
  const shadeHigh: ShaderNode = sRGBTransferEOTF(texture(lut, vec2(ceil(shade).add(0.5).div(256), 1 / 6)).rgb);
  const colour: ShaderNode = mix(raw, mix(shadeLow, shadeHigh, fract(shade)), state.shadeSmooth.clamp());
  const params: ShaderNode = texture(lut, vec2(u, 0.5));
  const id: ShaderNode = params.b.mul(255);
  const isClass = (kind: keyof typeof VOXEL_CLASS_ID): ShaderNode =>
    float(1).sub(step(0.5, id.sub(VOXEL_CLASS_ID[kind]).abs()));
  const house = isClass('house');
  const paint = house.add(isClass('paint'));
  const armour = paint.add(isClass('metal'));
  const glass = isClass('glass');
  const pos: ShaderNode = attribute('vpos', 'vec3');
  const curvature: ShaderNode = attribute('curvature', 'float');
  const look = (material.look = spriteLookFor(nodes));
  const ao: ShaderNode = poweredOcclusion(
    float(1).sub(attribute('occlusion', 'float').mul(state.aoStrength)).clamp(),
    look.aoPower,
  );
  material.ao = ao;
  const noise: ShaderNode = valueNoise(pos.div(0.7));
  const micro: ShaderNode = valueNoise(pos.mul(1.43))
    .mul(4 / 7)
    .add(valueNoise(pos.mul(2.86)).mul(2 / 7))
    .add(valueNoise(pos.mul(5.72)).mul(1 / 7));
  const wear: ShaderNode = smoothstep(state.wearStart, state.wearStart.add(1.2), curvature)
    .mul(noise.mul(0.6).add(0.4))
    .mul(state.wear)
    // House paint stays unworn: its stripes are one or two voxels wide, so curvature-driven wear would grey out the
    // faction colour at game distance.
    .mul(paint.sub(house))
    .clamp();
  const cavity: ShaderNode = smoothstep(state.cavityStart, state.cavityStart.add(1.2), curvature.negate())
    .mul(state.cavity)
    .clamp();
  // positionLocal includes section bounds/transform, so height is above the PART's model ground, in voxel units.
  const modelPos: ShaderNode = positionLocal.div(VOXEL_TO_WORLD);
  const lowerHull: ShaderNode = float(1).sub(smoothstep(0, state.grimeHeight.max(0.001), modelPos.y));
  const grime: ShaderNode = lowerHull.mul(noise).mul(state.grime).clamp();
  const edge: ShaderNode = smoothstep(0, 1.2, curvature).mul(armour.sub(house)).mul(state.edgeLight).clamp();
  const track: ShaderNode = isClass('dark')
    .add(isClass('rubber'))
    .mul(float(1).sub(smoothstep(state.treadHeight.sub(0.5), state.treadHeight, modelPos.y)))
    .mul(state.tread)
    .clamp();
  const frequency: ShaderNode = float(2 * Math.PI).div(state.treadPeriod.max(0.001));
  const phase: ShaderNode = pos.x.mul(frequency);
  const ridge: ShaderNode = sin(phase).mul(0.5).add(0.5);
  // Analytic ridge slope, lifted into view-space by the surface derivatives of voxel x. This follows section
  // transforms and avoids mistaking a view-space x tilt for the model's forward direction. Height is in voxels.
  const r1: ShaderNode = positionView.dFdy().cross(normalView);
  const r2: ShaderNode = normalView.cross(positionView.dFdx());
  const determinant: ShaderNode = positionView.dFdx().dot(r1);
  const gradient: ShaderNode = r1.mul(pos.x.dFdx()).add(r2.mul(pos.x.dFdy()));
  const slope: ShaderNode = cos(phase).mul(frequency).mul(0.08).mul(track);
  material.normalNode = normalView
    .mul(determinant.abs().max(1e-12))
    .sub(gradient.mul(determinant.sign()).mul(slope).mul(VOXEL_TO_WORLD))
    .normalize();
  const dust: ShaderNode = smoothstep(0.6, 0.9, normalWorld.y)
    .max(lowerHull)
    .mul(smoothstep(0.2, 0.8, valueNoise(pos.mul(0.25))))
    .mul(state.dust)
    .clamp();
  // Model-local y is vertical (vpos.z is section height); stretch the noise sixfold along model height.
  const streaks: ShaderNode = float(1)
    .sub(smoothstep(0.15, 0.35, normalWorld.y.abs()))
    .mul(smoothstep(0.62, 0.78, valueNoise(modelPos.mul(vec3(2, 1 / 3, 2)))))
    .mul(state.streaks)
    .clamp();
  // House paint: the remap ramps are pale where the engine's VPL would brighten and saturate them with light; a
  // physically lit albedo needs that saturation back to read as the faction colour at game distance.
  const grey: ShaderNode = colour.dot(vec3(0.2126, 0.7152, 0.0722));
  const housePaint: ShaderNode = mix(vec3(grey), colour, state.houseSat).max(0).mul(state.houseGain).min(1);
  let albedo: ShaderNode = mix(colour, housePaint, house);
  albedo = albedo.mul(float(1).add(micro.mul(2).sub(1).mul(state.microNoise).mul(paint)));
  albedo = mix(albedo, vec3(0.45), wear).mul(float(1).sub(cavity.mul(0.65)));
  albedo = mix(albedo, vec3(1), edge.mul(0.2));
  albedo = albedo.mul(mix(1, ridge.mul(0.45).add(0.55), track));
  albedo = mix(albedo, vec3(0.36, 0.31, 0.25), grime);
  albedo = albedo.mul(float(1).sub(streaks.mul(0.25)));
  albedo = mix(albedo, state.dustColour, dust);
  let r: ShaderNode = mix(params.r, 0.3, wear);
  r = mix(mix(r, 0.95, cavity), 0.9, grime);
  r = mix(r, 0.9, dust);
  material.roughnessNode = highlightRoughness(
    mix(r, 0.12, glass).clamp(0.04, 1),
    mix(look.specularSize, look.specularSize.max(0).sqrt(), glass),
  );
  material.metalnessNode = mix(mix(mix(params.g, 0.9, wear), 0, grime), 0, dust).clamp();
  const lit = srgbScale(albedo, objectLevelAt(grade, modelPosition.xz).add(voxelLightingFor(nodes).voxelExtraLight));
  // Standard Lambert already divides irradiance by pi. HdRenderer's noon exposure is pi/E_noon; no emissive
  // daylight fill or second exposure factor belongs here. Metal energy conservation and GGX remain physical.
  material.colorNode = mix(moonlit(lit, nodes), lit, house);
  const local: ShaderNode = objectLight(positionWorld.xz, nodes)
    .mul(1 / Math.PI)
    .mul(float(0.55).add(normalWorld.y.max(0).mul(0.45)));
  material.emissiveNode = lit
    .mul(local.add(params.a.mul(state.lightStrength)))
    .mul(ao)
    .mul(state.brightness);
  const reflection: ShaderNode = positionViewDirection.negate().reflect(normalView);
  const direction: ShaderNode = mix(reflection, normalView, roughness.pow(4))
    .normalize()
    .transformDirection(cameraWorldMatrix);
  const sky: ShaderNode = mix(state.skyHorizon, state.skyZenith, direction.y.max(0).pow(0.6));
  const environment: ShaderNode = mix(state.groundColour, sky, smoothstep(-0.12, 0.12, direction.y));
  // GGX supplies Fresnel, including glass grazing reflections; the class only increases its environment gain.
  material.envNode = environment.mul(state.envStrength).mul(float(1).add(glass.mul(1.5)));
  return material;
}

const GREY = new Uint8Array(768).map((_, i) => Math.floor(i / 3));
export function voxelPbrMaterialFor(
  palette: Uint8Array | null,
  nodes = paletteNodes(palette) ?? DEFAULT_ATMOSPHERE_NODES,
): MeshStandardNodeMaterial {
  const state = voxelPbrFor(nodes);
  const key = palette ?? GREY;
  let material = state.byPalette.get(key);
  if (!material) {
    const shades = voxelLightingFor(nodes).loaded;
    const row = (globalThis as { __vplRow?: number }).__vplRow ?? VPL_ALBEDO_ROW;
    material = createMaterial(voxelPbrLookupTexture(key, shades, row), paletteGrade(palette), nodes);
    state.byPalette.set(key, material);
  }
  return material;
}
