import {
  Color,
  DataTexture,
  MeshStandardNodeMaterial,
  NearestFilter,
  NoColorSpace,
  PhysicalLightingModel,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  type NodeBuilder,
} from 'three/webgpu';
import {
  BRDF_GGX,
  BRDF_Lambert,
  Fn,
  attribute,
  clamp,
  diffuseColor,
  dot,
  float,
  floor,
  max,
  min,
  mix,
  modelPosition,
  modelWorldMatrix,
  normalView,
  normalWorld,
  output,
  positionGeometry,
  positionWorld,
  roughness,
  sRGBTransferEOTF,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { VoxelLightingFile } from '../../../ra2-assets/src/vpl';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, objectLight, type AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { finishSceneLighting, sceneLitColour } from '../lighting';
import { objectLevelAt, paletteGrade, paletteNodes, srgbScale, type MapLightGrade } from './mapLighting';
import { inheritSlotBinder, slotMaterial, textureSlot } from '../materialSlots';
import { setSilhouette } from '../silhouette';
import { applyObjectTint, meshObjectTint } from '../objectTint';
import { VoxelProjectionInputs, voxelProjectionFor, type VoxelProjectionPart } from './voxelProjection';
import { projectedVoxelColour } from './voxelProjectionNodes';
import {
  registerVoxelReflectionColour,
  registerVoxelReflectionVariant,
  voxelReflectionAmbient,
  voxelReflectionNormal,
} from './voxelReflectionColour';
import { highlightRoughness, poweredOcclusion, spriteLookFor, type SpriteLookState } from './spriteLook';

/**
 * Voxel shading the way the engine does it (YR 1.001). Before drawing a voxel unit, TechnoClass (@0x706F4D) has
 * @0x753D00 build a shade index for every entry of the section's normal table (@0x7586F0):
 *
 *   L = VoxelLightSource (@0x887470) taken into the unit's model space by the inverse of its draw matrix,
 *   V = (0, 0, 1) through the inverse of the identity matrix at @0x887430, i.e. the model's own up axis,
 *   H = normalize(L + V), b = N . H,
 *   section = int(16 * (max(0, N . L) + max(0, b / (3 - 2 b))))
 *
 * and draws each voxel with palette[vpl[section][index]]: one row of voxels.vpl per shade, row 16 about the identity,
 * lower rows darker, higher rows brighter up to white (the "specular" term b / (3 - 2b) is a rational highlight lobe
 * around the half vector between the light and the model's up axis). The result is then lit like every object: the
 * cell's light plus the rules' extra object light ([AudioVisual] ExtraUnitLight / ExtraAircraftLight, 0.2 in YR),
 * applied to the palette colour in its own (sRGB) scale and clipped at white. Every section is decoded with its own
 * normal table (ra2-assets voxelNormals.ts).
 *
 * Here the same table picks the colour (emissive, scaled by the scene's light level so the time of day and weather
 * still apply), a weak physical diffuse term lets the HD sun add a little modelling, and a mild corner occlusion marks
 * creases at HD zoom. Without the table (no `pnpm hd:materials` sidecar) a smooth curve on the raw palette colour
 * stands in.
 */

/** Engine voxel light (voxelLightSource) in the voxel camera's frame. */
const ENGINE_VOXEL_LIGHT: readonly [number, number, number] = [-0.5, -0.70710678, 0.5];
/** Rows of the voxel camera's rotation (voxelDefaultMatrix at 0xB44318 in YR 1.001): engine world to voxel view. */
const ENGINE_VOXEL_VIEW: readonly (readonly [number, number, number])[] = [
  [0.70819062, 0.70602125, 0],
  [-0.35316691, 0.35425207, 0.86589754],
  [0.61134201, -0.61322051, 0.50022137],
];
/** Shade sections per unit of (diffuse + specular): the float 16.0 at 0x7F6960. */
export const ENGINE_SECTION_SCALE = 16;
/** The highlight's parameter p in b / (p - (p - 1) b): the float 3.0 TechnoClass passes (0x40400000 @0x706F23). */
export const ENGINE_SPECULAR = 3;

/**
 * The engine's voxel light in HD world axes as derived from its constants: the engine dots model-space normals with
 * the light taken through the inverse draw matrix, which equals dotting world normals with M^T * light; taking engine
 * world axes as (map x, -map y, up) and HD axes as (map x, up, map y) gives about (0.201, -0.362, 0.910). Checked per
 * pixel against captures of the original: a free light search lands within 6 degrees of it.
 */
export function derivedVoxelLight(out = new Vector3()): Vector3 {
  const [lx, ly, lz] = ENGINE_VOXEL_LIGHT;
  const m = ENGINE_VOXEL_VIEW;
  const ex = m[0]![0] * lx + m[1]![0] * ly + m[2]![0] * lz;
  const ey = m[0]![1] * lx + m[1]![1] * ly + m[2]![1] * lz;
  const ez = m[0]![2] * lx + m[1]![2] * ly + m[2]![2] * lz;
  return out.set(ex, ez, -ey).normalize();
}

/** The engine's shade section for a unit normal `n` (HD world axes) on a unit standing upright (CPU twin). */
export function engineVoxelSection(n: readonly [number, number, number], light = derivedVoxelLight()): number {
  const up = new Vector3(0, 1, 0);
  const l = light.clone().normalize();
  const h = l.clone().add(up).normalize();
  const diffuse = Math.max(0, n[0] * l.x + n[1] * l.y + n[2] * l.z);
  const b = n[0] * h.x + n[1] * h.y + n[2] * h.z;
  const specular = Math.max(0, b / (ENGINE_SPECULAR - (ENGINE_SPECULAR - 1) * b));
  const total = diffuse + specular;
  return total < 0 ? 0 : Math.trunc(total * ENGINE_SECTION_SCALE);
}

/**
 * Extra object light of vehicles and aircraft, added to the cell's light level and applied to the lit palette colour
 * in its own (sRGB) scale, clipped at white. The rules give ExtraUnitLight / ExtraAircraftLight 0.2 in YR; measured on
 * 15 isolated vehicles against the engine's framebuffer (same-moment frozen pairs, XMP29U2), 0.2 with the engine's
 * shade rule alone draws the hulls 9 % brighter than the original, and 0.1 plus the HD sun term below 3 %.
 */
export const VOXEL_EXTRA_LIGHT = 0.1;

/**
 * Weight of the physical (HD sun) diffuse term relative to the table colour: a little modelling that follows the HD
 * time of day, on top of the engine's fixed voxel light.
 */
const SUN_DIFFUSE = 0.06;
/**
 * Cap on the optional GGX sheen (linear, before exposure); off by default (voxelSheen 0). The enhanced look raises it
 * (voxelSheenCap) so paint and bare metal catch real glints.
 */
const SPECULAR_CAP = 0.05;
/**
 * Strength of the corner occlusion (0 = none): HD-only crease darkening at close zoom, kept mild (the engine has none;
 * at 0.15 it changes the hulls' mean brightness and contrast by under 1 %).
 */
const OCCLUSION_STRENGTH = 0.15;

/**
 * Scene light level for voxels, set every frame by the renderer: flat-ground irradiance / pi, which the exposure turns
 * into 1 at clear noon (so noon shows exactly the table colours).
 */
export class VoxelLightingState {
  readonly voxelFill = uniform(new Color(0, 0, 0));
  readonly voxelDebug = uniform(0);
  readonly voxelExtraLight = uniform(VOXEL_EXTRA_LIGHT);
  readonly voxelOcclusion = uniform(OCCLUSION_STRENGTH);
  readonly voxelSheen = uniform(0);
  readonly voxelSheenCap = uniform(SPECULAR_CAP);
  readonly voxelSunDiffuse = uniform(SUN_DIFFUSE);
  /**
   * The look's light gains as voxel units take them, set every frame by the renderer (HdRenderer vehicleLookGains:
   * the scene's sunGain / specularSize / aoPower unless the look gives vehicles their own) and 1 in the faithful
   * branch: sun weight of the direct and form light, highlight size (lobe width and squared intensity) and crease AO
   * power. Separate from the sprite look so a look can light vehicles apart from terrain, buildings and infantry.
   */
  readonly sunGain = uniform(1);
  readonly specularSize = uniform(1);
  readonly aoPower = uniform(1);
  /** Linear gain on the finished voxel unit colour (HdSettings.vehicleExposure; 1 = none). */
  readonly exposure = uniform(1);
  readonly lightDirection = uniform(derivedVoxelLight());
  loaded: LoadedTable | null = null;
  loading: Promise<boolean> | null = null;
  loadingUrl = '';
  readonly byPalette = new WeakMap<Uint8Array, MeshStandardNodeMaterial>();
  readonly byProjection = new WeakMap<VoxelProjectionPart, WeakMap<Uint8Array, MeshStandardNodeMaterial>>();
  /** Shader graphs by `sections|kind` and map grade: every material above is a clone of one of their prototypes. */
  readonly graphs = new Map<string, Map<MapLightGrade | null, VoxelGraph>>();
  /** Lookup texture of a palette for the table it was made with. */
  readonly lookups = new WeakMap<Uint8Array, { table: LoadedTable | null; texture: DataTexture }>();
}

/**
 * One shader graph for every palette and every projected part: the prototype material and the slots its shader reads
 * the palette's lookup texture and the part from (see materialSlots.ts). A house colour or a unit type seen for the
 * first time then costs a clone and a small texture, no shader build and no pipeline.
 */
interface VoxelGraph {
  prototype: VoxelMaterial;
  lookup: ShaderNode;
  projection: VoxelProjectionInputs | null;
}

const states = new WeakMap<AtmosphereNodes, VoxelLightingState>();

/** Per-renderer voxel uniforms, material cache and selected VPL table. */
export function voxelLightingFor(nodes: AtmosphereNodes = DEFAULT_ATMOSPHERE_NODES): VoxelLightingState {
  let state = states.get(nodes);
  if (!state) {
    state = new VoxelLightingState();
    states.set(nodes, state);
  }
  return state;
}

/** Legacy standalone-material controls; renderers use voxelLightingFor(renderer.nodes). */
export const { voxelFill, voxelDebug, voxelExtraLight, voxelOcclusion, voxelSheen, voxelSunDiffuse } =
  voxelLightingFor();

interface LoadedTable {
  table: Uint8Array;
  sections: number;
}

/**
 * Load the voxel lighting sidecar (voxels-vpl.json + .png). The table is install-wide (the same for every map), so a
 * page loads it once; a different URL loads again. Resolves false, and voxels use the fallback curve, when it is
 * missing or unreadable.
 */
export function loadVoxelLighting(jsonUrl: string, nodes = DEFAULT_ATMOSPHERE_NODES): Promise<boolean> {
  const state = voxelLightingFor(nodes);
  if (state.loading && state.loadingUrl === jsonUrl) return state.loading;
  state.loadingUrl = jsonUrl;
  state.loading = (async () => {
    try {
      const response = await fetch(jsonUrl);
      if (!response.ok) return false;
      const file = (await response.json()) as VoxelLightingFile;
      const base = jsonUrl.slice(0, jsonUrl.lastIndexOf('/') + 1);
      const image = await fetch(base + file.table.file);
      if (!image.ok) return false;
      const bitmap = await createImageBitmap(await image.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const sections = bitmap.height;
      const width = bitmap.width;
      bitmap.close();
      if (width !== 256 || sections < 1) return false;
      const table = new Uint8Array(256 * sections);
      for (let i = 0; i < table.length; i++) table[i] = rgba[i * 4]!;
      state.loaded = { table, sections };
      if (file.fit?.light) state.lightDirection.value.fromArray(file.fit.light).normalize();
      return true;
    } catch {
      return false;
    }
  })();
  return state.loading;
}

class VoxelLightingModel extends PhysicalLightingModel {
  constructor(
    private readonly raw: ShaderNode,
    private readonly matp: ShaderNode,
    private readonly state: VoxelLightingState,
    private readonly sceneMultiplier: ShaderNode,
  ) {
    super();
  }

  override finish(builder: NodeBuilder): void {
    super.finish(builder);
    finishSceneLighting(builder, this.sceneMultiplier);
  }

  override direct({
    lightDirection: l,
    lightColor,
    reflectedLight,
  }: Parameters<PhysicalLightingModel['direct']>[0]): void {
    const live: ShaderNode = float(1).sub(step(0.5, this.state.voxelDebug));
    const dotNL: ShaderNode = (normalView as ShaderNode).dot(l).clamp();
    const irradiance: ShaderNode = dotNL.mul(lightColor).mul(this.state.sunGain);
    (reflectedLight.directDiffuse as ShaderNode).addAssign(
      irradiance.mul(BRDF_Lambert({ diffuseColor: (diffuseColor as ShaderNode).rgb })),
    );
    const f0: ShaderNode = mix(vec3(0.04), this.raw, this.matp.y);
    const specular: ShaderNode = irradiance
      .mul(
        BRDF_GGX({
          lightDirection: l,
          f0,
          f90: 1,
          roughness: highlightRoughness(roughness, this.state.specularSize),
        } as never),
      )
      .mul(this.matp.z)
      .mul(this.state.voxelSheen)
      .mul(this.state.specularSize.mul(this.state.specularSize))
      .mul(live);
    (reflectedLight.directSpecular as ShaderNode).addAssign(min(specular, vec3(this.state.voxelSheenCap)));
  }

  // No sky or environment term: the table colour already carries the original's ambient level.
  override indirect(): void {}
}

class VoxelMaterial extends MeshStandardNodeMaterial {
  raw!: ShaderNode;
  matp!: ShaderNode;
  state!: VoxelLightingState;
  look!: SpriteLookState;
  sceneMultiplier!: ShaderNode;
  override copy(source: this): this {
    super.copy(source);
    // Three copies initialized fields only; these lighting inputs are assigned after construction.
    this.raw = source.raw;
    this.matp = source.matp;
    this.state = source.state;
    this.look = source.look;
    this.sceneMultiplier = source.sceneMultiplier;
    // A clone draws the palette and the part its source draws (opacity and native-depth variants of one unit).
    inheritSlotBinder(this, source);
    return this;
  }
  override setupLightingModel(): PhysicalLightingModel {
    return new VoxelLightingModel(this.raw, this.matp, this.state, this.sceneMultiplier);
  }
}

/**
 * Highlight class of a palette colour: [roughness, metalness, specular weight]. House paint is glossy lacquer, very dark
 * entries are rubber and track shadows (almost no highlight), unsaturated greys are bare metal, everything else matte
 * paint.
 */
export function materialClass(index: number, r: number, g: number, b: number): [number, number, number] {
  if (index >= 16 && index <= 31) return [0.32, 0.15, 1.0];
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [linear(r / 255), linear(g / 255), linear(b / 255)];
  const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const max = Math.max(lr, lg, lb);
  const sat = max > 0 ? (max - Math.min(lr, lg, lb)) / max : 0;
  if (lum < 0.025) return [0.85, 0, 0.2];
  if (sat < 0.18) return [0.3, 0.55, 1.0];
  return [0.45, 0.1, 0.7];
}

/**
 * Per-palette lookup texture (raw bytes, sampled texel-exactly): rows 0..sections-1 hold the lit colour of palette index
 * i in section s, palette[table[s][i]] (sRGB); row `sections` the raw palette colour (sRGB); row `sections + 1` the
 * highlight class (materialClass, linear bytes). Geometry therefore carries palette indices only and is shared by every
 * house: a new house colour costs one small texture and material, not a new mesh.
 */
function lookupTexture(palette: Uint8Array, table: LoadedTable | null): DataTexture {
  const sections = table?.sections ?? 0;
  const rows = sections + 2;
  const data = new Uint8Array(256 * rows * 4);
  const put = (row: number, i: number, r: number, g: number, b: number) => {
    const o = (row * 256 + i) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  };
  for (let s = 0; s < sections; s++) {
    for (let i = 0; i < 256; i++) {
      const c = table!.table[s * 256 + i]!;
      put(s, i, palette[c * 3]!, palette[c * 3 + 1]!, palette[c * 3 + 2]!);
    }
  }
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = [palette[i * 3]!, palette[i * 3 + 1]!, palette[i * 3 + 2]!];
    put(sections, i, r, g, b);
    const [rough, metal, spec] = materialClass(i, r, g, b);
    put(sections + 1, i, Math.round(rough * 255), Math.round(metal * 255), Math.round(spec * 255));
  }
  const lut = new DataTexture(data, 256, rows, RGBAFormat, UnsignedByteType);
  lut.colorSpace = NoColorSpace;
  lut.magFilter = NearestFilter;
  lut.minFilter = NearestFilter;
  lut.generateMipmaps = false;
  lut.needsUpdate = true;
  return lut;
}

/**
 * The shader graph of one kind of voxel material: plain, or projected with or without house paint (`house`: the only
 * thing about a redraw that changes the shader). The palette's lookup texture and the projected part are slots.
 */
function createGraph(
  sections: number,
  grade: MapLightGrade | null,
  nodes: AtmosphereNodes,
  house: boolean | null,
): VoxelGraph {
  const state = voxelLightingFor(nodes);
  const { voxelFill, voxelDebug, voxelExtraLight, voxelOcclusion, voxelSunDiffuse, lightDirection } = state;
  // Every part mesh drawn with a material of this graph carries its unit's silhouette code (see VoxelUnit).
  const material = setSilhouette(new VoxelMaterial());
  material.sceneMultiplier = nodes.sceneObjectMul;
  material.state = state;
  const look = (material.look = spriteLookFor(nodes));
  nodes.own(material);
  const lut = textureSlot();
  const projection = house === null ? null : new VoxelProjectionInputs();
  material.name = sections ? 'voxel-vpl' : 'voxel-fallback';
  if (projection) material.name += '-projected';
  const rows = sections + 2;
  const occlusion: ShaderNode = attribute('occlusion', 'float');
  const ao: ShaderNode = poweredOcclusion(float(1).sub(occlusion.mul(voxelOcclusion)), state.aoPower);
  const pindex: ShaderNode = attribute('pindex', 'float');
  const u: ShaderNode = pindex.add(0.5).div(256);
  const row = (r: ShaderNode | number): ShaderNode => texture(lut, vec2(u, float(r).add(0.5).div(rows))).rgb;
  const raw: ShaderNode = sRGBTransferEOTF(row(sections));
  const matp: ShaderNode = row(sections + 1);
  material.raw = raw;
  material.matp = matp;
  const n: ShaderNode = normalWorld;
  const paletteLit = (normal: ShaderNode, matrix: ShaderNode): ShaderNode => {
    const d: ShaderNode = dot(normal, lightDirection);
    if (sections) {
      // The engine's shade (see above): the view vector is the model's own up axis in world space.
      const up: ShaderNode = matrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();
      const b: ShaderNode = dot(normal, lightDirection.add(up).normalize());
      const specular: ShaderNode = max(b.div(float(ENGINE_SPECULAR).sub(b.mul(ENGINE_SPECULAR - 1))), 0);
      const section: ShaderNode = clamp(floor(max(d, 0).add(specular).mul(ENGINE_SECTION_SCALE)), 0, sections - 1);
      return sRGBTransferEOTF(row(section));
    }
    // A smooth stand-in on the raw palette colour for the retail table's median brightening at the engine's sections.
    return raw.mul(
      float(0.85)
        .add(max(d, 0).mul(0.37))
        .add(max(min(d, 0), -0.625).mul(0.45)),
    );
  };
  let lit: ShaderNode = paletteLit(n, modelWorldMatrix);
  // Switches are blended arithmetically rather than with select(): TSL compiles a select of shared sub-expressions
  // into branches that each compute them once, leaving the other branch reading an unassigned variable.
  const debugOn: ShaderNode = step(0.5, voxelDebug);
  const debugColour: ShaderNode = mix(
    vec3(pindex.div(255), n.x.mul(0.5).add(0.5), n.y.mul(0.5).add(0.5)),
    vec3(pindex.div(255), n.z.mul(0.5).add(0.5), occlusion),
    step(1.5, voxelDebug),
  );
  const live: ShaderNode = float(1).sub(debugOn);
  // The cell's light for objects at the unit's origin plus the units' extra light, in the palette's scale.
  const level: ShaderNode = objectLevelAt(grade, modelPosition.xz).add(voxelExtraLight);
  lit = srgbScale(lit, level);
  // Scene light on the night-desaturated colour (house paint keeps its colour), local lights (lamps, fires,
  // explosions) on the full colour, strongest on faces turned up towards the lit ground's glow.
  const paint: ShaderNode = step(15.5, pindex).mul(step(pindex, 31.5));
  const local: ShaderNode = objectLight(positionWorld.xz, nodes)
    .mul(1 / Math.PI)
    .mul(float(0.55).add(max(n.y, 0).mul(0.45)));
  let shaded: ShaderNode = sceneLitColour(mix(moonlit(lit, nodes), lit, paint).mul(voxelFill), nodes.sceneObjectMul)
    .add(lit.mul(local))
    .mul(ao);
  let uncovered: ShaderNode = float(1);
  if (projection) {
    const projected = projectedVoxelColour(
      projection,
      house === true,
      voxelProjectionFor(nodes),
      (index) => sRGBTransferEOTF(texture(lut, vec2(index.add(0.5).div(256), (sections + 0.5) / rows)).rgb),
      lightDirection,
      look.sunDirection,
      state,
    );
    const projState = voxelProjectionFor(nodes);
    const formAo: ShaderNode = poweredOcclusion(float(1).sub(occlusion.mul(projState.formAO.clamp())), state.aoPower);
    const colour: ShaderNode = srgbScale(projected.colour, level.div(projState.levelRef.max(0.01))).mul(formAo);
    const projectedShade: ShaderNode = sceneLitColour(
      mix(moonlit(colour, nodes), colour, projected.paint).mul(voxelFill),
      nodes.sceneObjectMul,
    ).add(colour.mul(local));
    // The redraw already contains AO and directional shading. Only uncovered engine art receives mesh AO/sheen.
    shaded = mix(shaded, projectedShade, projected.coverage);
    uncovered = float(1).sub(projected.coverage);
    material.matp = vec3(matp.xy, matp.z.mul(uncovered));
  }
  material.emissiveNode = mix(shaded, debugColour, debugOn);
  material.colorNode = raw.mul(voxelSunDiffuse).mul(ao).mul(live).mul(uncovered);
  material.roughnessNode = matp.x;
  // Metalness only shapes the highlight (see VoxelLightingModel); the diffuse term stays a plain weak Lambert.
  material.metalnessNode = float(0);
  // The drawn unit's picture tint (objectTint.ts) on the finished colour, highlights included: per-mesh data of this
  // one graph, so a unit under the Iron Curtain compiles nothing.
  material.outputNode = Fn(() =>
    vec4(
      applyObjectTint(output.rgb.mul(state.exposure), meshObjectTint.x, meshObjectTint.y, level, look.unlitBaseLight),
      output.a,
    ),
  )();
  registerVoxelReflectionColour(material, (sourceMatrix) => {
    const sourceNormal = voxelReflectionNormal(sourceMatrix);
    const sourceOrigin: ShaderNode = sourceMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const sourcePosition: ShaderNode = sourceMatrix.mul(vec4(positionGeometry, 1)).xyz;
    const sourceLevel: ShaderNode = objectLevelAt(grade, sourceOrigin.xz).add(voxelExtraLight);
    const sourceLit: ShaderNode = srgbScale(paletteLit(sourceNormal, sourceMatrix), sourceLevel);
    const sourceLocal: ShaderNode = objectLight(sourcePosition.xz, nodes)
      .mul(1 / Math.PI)
      .mul(float(0.55).add(max(sourceNormal.y, 0).mul(0.45)));
    let ceiling: ShaderNode = mix(moonlit(sourceLit, nodes), sourceLit, paint)
      .mul(voxelFill)
      .add(sourceLit.mul(sourceLocal))
      .mul(ao);
    // The VPL palette ramp is the engine's fixed sculpted surface colour, independent of the scene's sun. Raw
    // palette indices alone would turn its pale/white hulls dark grey; retain that ramp at half ambient radiance.
    let albedo: ShaderNode = mix(moonlit(sourceLit, nodes), sourceLit, paint).mul(ao);
    if (projection) {
      const projState = voxelProjectionFor(nodes);
      const projected = projectedVoxelColour(
        projection,
        house === true,
        projState,
        (index) => sRGBTransferEOTF(texture(lut, vec2(index.add(0.5).div(256), (sections + 0.5) / rows)).rgb),
        lightDirection,
        look.sunDirection,
        state,
        { matrix: sourceMatrix, position: positionGeometry, normal: sourceNormal },
      );
      const formAo: ShaderNode = poweredOcclusion(float(1).sub(occlusion.mul(projState.formAO.clamp())), state.aoPower);
      const projectionLevel: ShaderNode = sourceLevel.div(projState.levelRef.max(0.01));
      const projectedAlbedo: ShaderNode = srgbScale(projected.albedo, projectionLevel).mul(formAo);
      const projectedLit: ShaderNode = srgbScale(projected.colour, projectionLevel).mul(formAo);
      albedo = mix(albedo, mix(moonlit(projectedAlbedo, nodes), projectedAlbedo, projected.paint), projected.coverage);
      ceiling = mix(
        ceiling,
        mix(moonlit(projectedLit, nodes), projectedLit, projected.paint)
          .mul(voxelFill)
          .add(projectedLit.mul(sourceLocal)),
        projected.coverage,
      );
    }
    // The exact source emissive term is a lower bound on its complete (nonnegative) lighting. Clamp to that
    // bound so darker source faces stay dark; direct sun/glints above never add radiance to the water twin.
    return voxelReflectionAmbient(albedo, voxelFill, ceiling).mul(state.exposure);
  });
  return { prototype: material, lookup: lut, projection };
}

/** The graph for the lighting table in use, a palette's map grade and a kind of projection, built on first use. */
function graphFor(
  state: VoxelLightingState,
  nodes: AtmosphereNodes,
  grade: MapLightGrade | null,
  house: boolean | null,
): VoxelGraph {
  const sections = state.loaded?.sections ?? 0;
  const key = `${sections}|${house === null ? 'plain' : house ? 'projected-house' : 'projected'}`;
  let grades = state.graphs.get(key);
  if (!grades) state.graphs.set(key, (grades = new Map()));
  let graph = grades.get(grade);
  if (!graph) grades.set(grade, (graph = createGraph(sections, grade, nodes, house)));
  return graph;
}

/** A palette's lookup texture for the lighting table in use (one per palette, whatever draws with it). */
function lookupFor(state: VoxelLightingState, nodes: AtmosphereNodes, palette: Uint8Array): DataTexture {
  const cached = state.lookups.get(palette);
  if (cached && cached.table === state.loaded) return cached.texture;
  const texture = nodes.own(lookupTexture(palette, state.loaded));
  state.lookups.set(palette, { table: state.loaded, texture });
  return texture;
}

/**
 * A material of `graph` for one palette (and one projected part): a clone of the prototype, which three draws with
 * the prototype's shader and pipeline, bound to its own lookup texture and part before each of its objects is drawn.
 */
function graphMaterial(
  graph: VoxelGraph,
  nodes: AtmosphereNodes,
  lookup: DataTexture,
  part?: VoxelProjectionPart,
): MeshStandardNodeMaterial {
  const material = nodes.own(
    slotMaterial(graph.prototype, () => {
      graph.lookup.value = lookup;
      if (part) graph.projection!.bind(part);
    }),
  );
  // The water twin of every clone is the prototype's (see voxelShadow.ts): one more shader that is built once.
  registerVoxelReflectionVariant(material, graph.prototype);
  return material;
}

/** Palette for callers without one: a grey ramp. */
const GREY = new Uint8Array(768).map((_, i) => Math.floor(i / 3));

/**
 * The material for voxels drawn with `palette` (a house-remapped palette gets its own lookup texture), cached per
 * palette. Uses the fallback curve when the lighting table was not loaded before the palette's first use.
 */
export function voxelMaterialFor(
  palette: Uint8Array | null,
  nodes = paletteNodes(palette) ?? DEFAULT_ATMOSPHERE_NODES,
): MeshStandardNodeMaterial {
  const state = voxelLightingFor(nodes);
  const key = palette ?? GREY;
  let material = state.byPalette.get(key);
  if (!material) {
    const graph = graphFor(state, nodes, paletteGrade(palette), null);
    material = graphMaterial(graph, nodes, lookupFor(state, nodes, key));
    state.byPalette.set(key, material);
  }
  return material;
}

/** A palette can share a material only within one projection part, including both turret and barrel meshes. */
export function voxelProjectedMaterialFor(
  palette: Uint8Array | null,
  projection: VoxelProjectionPart,
  nodes = paletteNodes(palette) ?? DEFAULT_ATMOSPHERE_NODES,
): MeshStandardNodeMaterial {
  const state = voxelLightingFor(nodes);
  let palettes = state.byProjection.get(projection);
  if (!palettes) {
    palettes = new WeakMap();
    state.byProjection.set(projection, palettes);
  }
  const key = palette ?? GREY;
  let material = palettes.get(key);
  if (!material) {
    const graph = graphFor(state, nodes, paletteGrade(palette), !!projection.manifest.house);
    material = graphMaterial(graph, nodes, lookupFor(state, nodes, key), projection);
    palettes.set(key, material);
  }
  return material;
}
