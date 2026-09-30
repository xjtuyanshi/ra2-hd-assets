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
  float,
  floor,
  fract,
  mix,
  modelPosition,
  normalView,
  normalWorld,
  positionLocal,
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
import { ra2VoxelClass, VOXEL_CLASS_ID } from './voxelClasses';
import { VOXEL_TO_WORLD } from './voxelScale';
import { voxelLightingFor } from './vpl';

export const VOXEL_PBR_DEFAULTS = Object.freeze({
  brightness: 1,
  aoStrength: 0.8,
  envStrength: 0.6,
  wear: 0.5,
  wearStart: 0.6,
  cavity: 0.4,
  cavityStart: 0.6,
  grime: 0.35,
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
  readonly wear = uniform(VOXEL_PBR_DEFAULTS.wear);
  readonly wearStart = uniform(VOXEL_PBR_DEFAULTS.wearStart);
  readonly cavity = uniform(VOXEL_PBR_DEFAULTS.cavity);
  readonly cavityStart = uniform(VOXEL_PBR_DEFAULTS.cavityStart);
  readonly grime = uniform(VOXEL_PBR_DEFAULTS.grime);
  readonly grimeHeight = uniform(VOXEL_PBR_DEFAULTS.grimeHeight);
  readonly microNoise = uniform(VOXEL_PBR_DEFAULTS.microNoise);
  readonly specular = uniform(VOXEL_PBR_DEFAULTS.specular);
  readonly lightStrength = uniform(VOXEL_PBR_DEFAULTS.lightStrength);
  readonly skyZenith = uniform(new Color(0.18, 0.32, 0.58));
  readonly skyHorizon = uniform(new Color(0.65, 0.7, 0.8));
  readonly groundColour = uniform(new Color(0.1, 0.09, 0.07));
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

/** Raw sRGB and linear material parameters share a nearest-filtered texture; conversion belongs to row 0 only. */
export function voxelPbrLookupTexture(palette: Uint8Array): DataTexture {
  const bytes = new Uint8Array(256 * 3 * 4);
  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3]!;
    const g = palette[i * 3 + 1]!;
    const b = palette[i * 3 + 2]!;
    bytes.set([r, g, b, 255], i * 4);
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

/** Smooth trilinear value noise, in voxel coordinates. Explicit Fn layouts keep the three octave shader compact. */
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
  ) {
    super();
  }
  override start(builder: NodeBuilder): void {
    super.start(builder);
    const { reflectedLight: reflected } = builder.context as { reflectedLight: Record<string, ShaderNode> };
    const diffuse = this.ao.mul(this.state.brightness);
    const specular = diffuse.mul(this.state.specular);
    // Apply once after all lights: multiplying in direct() would repeatedly darken earlier lights.
    (reflected.directDiffuse as ShaderNode).mulAssign(diffuse);
    (reflected.indirectDiffuse as ShaderNode).mulAssign(diffuse);
    (reflected.directSpecular as ShaderNode).mulAssign(specular);
    (reflected.indirectSpecular as ShaderNode).mulAssign(specular);
  }
}

class RemasterMaterial extends MeshStandardNodeMaterial {
  ao!: ShaderNode;
  state!: VoxelPbrState;
  override setupEnvironment(): EnvironmentNode | null {
    return this.envNode ? new SpecularSky(this.envNode) : null;
  }
  override setupLightingModel(): PhysicalLightingModel {
    return new RemasterLighting(this.ao, this.state);
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
  const params: ShaderNode = texture(lut, vec2(u, 0.5));
  const id: ShaderNode = params.b.mul(255);
  const isClass = (kind: keyof typeof VOXEL_CLASS_ID): ShaderNode =>
    float(1).sub(step(0.5, id.sub(VOXEL_CLASS_ID[kind]).abs()));
  const house = isClass('house');
  const paint = house.add(isClass('paint'));
  const glass = isClass('glass');
  const pos: ShaderNode = attribute('vpos', 'vec3');
  const curvature: ShaderNode = attribute('curvature', 'float');
  const ao: ShaderNode = float(1).sub(attribute('occlusion', 'float').mul(state.aoStrength)).clamp();
  material.ao = ao;
  const noise: ShaderNode = valueNoise(pos.div(0.7));
  const micro: ShaderNode = valueNoise(pos.mul(1.43))
    .mul(4 / 7)
    .add(valueNoise(pos.mul(2.86)).mul(2 / 7))
    .add(valueNoise(pos.mul(5.72)).mul(1 / 7));
  const wear: ShaderNode = smoothstep(state.wearStart, state.wearStart.add(1.2), curvature)
    .mul(noise.mul(0.6).add(0.4))
    .mul(state.wear)
    .mul(paint)
    .clamp();
  const cavity: ShaderNode = smoothstep(state.cavityStart, state.cavityStart.add(1.2), curvature.negate())
    .mul(state.cavity)
    .clamp();
  // positionLocal includes section bounds/transform, so height is above the PART's model ground, in voxel units.
  const grime: ShaderNode = float(1)
    .sub(smoothstep(0, state.grimeHeight.max(0.001), positionLocal.y.div(VOXEL_TO_WORLD)))
    .mul(noise)
    .mul(state.grime)
    .clamp();
  let albedo: ShaderNode = raw.mul(float(1).add(micro.mul(2).sub(1).mul(state.microNoise).mul(paint)));
  albedo = mix(albedo, vec3(0.45), wear).mul(float(1).sub(cavity.mul(0.65)));
  albedo = mix(albedo, vec3(0.36, 0.31, 0.25), grime);
  let r: ShaderNode = mix(params.r, 0.3, wear);
  r = mix(mix(r, 0.95, cavity), 0.9, grime);
  material.roughnessNode = mix(r, 0.12, glass).clamp(0.04, 1);
  material.metalnessNode = mix(mix(params.g, 0.9, wear), 0, grime).clamp();
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
    material = createMaterial(voxelPbrLookupTexture(key), paletteGrade(palette), nodes);
    state.byPalette.set(key, material);
  }
  return material;
}
