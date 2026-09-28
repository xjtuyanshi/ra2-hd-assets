import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  NeutralToneMapping,
  PCFSoftShadowMap,
  RenderPipeline,
  Scene,
  Vector3,
  WebGPURenderer,
  type ToneMapping,
} from 'three/webgpu';
import { float, length, pass, renderOutput, screenUV, smoothstep, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { RenderEvent, RenderState } from './contract';
import { EffectsLayer } from './effects';
import { Lighting } from './lighting';
import { ObjectLayer } from './objects';
import { buildTerrain, type TerrainBuild } from './terrain';
import { buildWater, type WaterUniforms } from './water';
import { buildRain, type RainSystem } from './weather';
import type { HdWorld } from './ra2/world';
import { IsoCamera, LEVEL_HEIGHT, cellToWorld } from './world';

export type ToneMapper = 'agx' | 'neutral' | 'aces';

export interface HdSettings {
  toneMapper: ToneMapper;
  exposure: number;
  bloom: number;
  vignette: number;
  shadows: boolean;
  antialias: boolean;
}

const TONE_MAPPERS: Record<ToneMapper, ToneMapping> = {
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
};

/**
 * Consumes RenderState snapshots and draws the HD battlefield. It owns no game rules and never writes game state:
 * visual randomness, interpolation and effects live entirely on this side of the contract.
 */
export class HdRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly view = new IsoCamera();
  readonly settings: HdSettings = {
    toneMapper: 'neutral',
    exposure: 1,
    bloom: 0.55,
    vignette: 0.25,
    shadows: true,
    antialias: true,
  };
  private pipeline!: RenderPipeline;
  private readonly bloomStrength = uniform(0.55);
  private readonly vignetteStrength = uniform(0.25);
  private readonly lighting: Lighting;
  private readonly objects = new ObjectLayer();
  private readonly effects = new EffectsLayer();
  private terrain!: TerrainBuild;
  private water: { uniforms: WaterUniforms } | null = null;
  private rain!: RainSystem;
  /** Present when drawing an original map; null for the procedural sandbox. */
  private world: HdWorld | null = null;
  private waterY = 0;
  private bounds = { width: 0, height: 0 };
  private readonly seenEvents = new Set<number>();
  private state: RenderState;
  private startTime = performance.now();
  private readonly shakeOffset = new Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    initial: RenderState,
    options: { forceWebGL?: boolean } = {},
  ) {
    this.state = initial;
    this.renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: options.forceWebGL ?? false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.lighting = new Lighting(initial.map.width, initial.map.height);
  }

  /** 'WebGPU' or 'WebGL2' once init() resolved. */
  get backend(): string {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  /** Build the scene from the procedural state, or from an original map when `world` is given. */
  async init(world?: HdWorld): Promise<void> {
    await this.renderer.init();
    this.scene.background = new Color(0x0b0c0e);
    let waterY: number | null;
    if (world) {
      this.world = world;
      this.terrain = world.terrain;
      this.bounds = { width: world.width, height: world.height };
      waterY = world.waterY;
      this.scene.add(world.root);
      this.view.target.copy(world.focus);
    } else {
      const map = this.state.map;
      this.terrain = buildTerrain(map);
      this.bounds = { width: map.width, height: map.height };
      waterY = map.waterLevel * LEVEL_HEIGHT;
      this.scene.add(this.objects.root);
      this.view.target.set(map.width / 2, 0, map.height / 2);
    }
    this.waterY = waterY ?? -1000;
    if (world?.water) this.water = { uniforms: world.water };
    if (waterY !== null) {
      const water = buildWater(this.bounds.width, this.bounds.height, waterY, this.terrain.heightTexture);
      this.water = water;
      this.scene.add(water.mesh);
    }
    this.rain = buildRain(this.bounds.width, this.bounds.height, this.terrain.heightTexture, this.waterY);
    this.scene.add(this.terrain.mesh, this.lighting.root, this.effects.root, this.rain.object);
    this.buildPipeline();
    this.applySettings();
  }

  private buildPipeline(): void {
    const scenePass = pass(this.scene, this.view.camera);
    const hdr = scenePass.getTextureNode('output');
    const glow = bloom(hdr, 1, 0.45, 0.85);
    glow.strength = this.bloomStrength;
    const vignette = float(1).sub(
      smoothstep(0.45, 1.05, length(screenUV.sub(0.5).mul(1.6))).mul(this.vignetteStrength),
    );
    const composite = hdr.add(glow).mul(vignette);
    this.pipeline = new RenderPipeline(this.renderer);
    // Anti-aliasing must run on the tone-mapped, display-referred image.
    this.pipeline.outputColorTransform = false;
    const display = renderOutput(composite);
    this.pipeline.outputNode = this.settings.antialias ? fxaa(display) : display;
  }

  applySettings(): void {
    this.renderer.toneMapping = TONE_MAPPERS[this.settings.toneMapper];
    this.bloomStrength.value = this.settings.bloom;
    this.vignetteStrength.value = this.settings.vignette;
    this.lighting.sun.castShadow = this.settings.shadows;
    this.buildPipeline();
  }

  setState(state: RenderState): void {
    this.state = state;
    if (!this.world) this.objects.sync(state.objects, this.terrain.heightAt);
    for (const event of state.events) this.handleEvent(event);
  }

  private handleEvent(event: RenderEvent): void {
    // Events are idempotent by id: replays or renderer toggles must not spawn effects twice.
    if (this.seenEvents.has(event.id)) return;
    this.seenEvents.add(event.id);
    if (this.seenEvents.size > 4096) this.seenEvents.clear();
    if (event.kind === 'explosion') {
      const ground = this.terrain.heightAt(event.x, event.y);
      const at = cellToWorld(event.x, event.y, 0).setY(Math.max(ground, this.waterY));
      const env = this.state.environment;
      const wind = new Vector3(Math.cos(env.windDirection), 0, Math.sin(env.windDirection)).multiplyScalar(
        env.windStrength * 0.8,
      );
      this.effects.explode(this.seconds(), at, event.scale, wind);
    }
  }

  private seconds(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.view.resize(cssWidth, cssHeight);
  }

  frame(deltaSeconds: number): void {
    const env = this.state.environment;
    const raining = env.weather === 'rain' || env.weather === 'storm';
    const rainAmount = raining ? env.weatherIntensity : 0;
    // Surfaces wet quickly under rain and dry slowly after it stops.
    const wet = this.terrain.wetness;
    wet.value = raining
      ? Math.min(1, wet.value + deltaSeconds * 0.25 * rainAmount)
      : Math.max(0, wet.value - deltaSeconds * 0.02);

    this.lighting.follow(this.view.target);
    this.lighting.update(env.timeOfDay, raining ? 0.35 + 0.5 * rainAmount : 0);
    const light = this.lighting.state;
    // Original maps are calibrated so flat ground at noon shows the tile art at its original brightness; other times
    // and weather scale from there. The procedural sandbox keeps its own per-key exposure.
    this.renderer.toneMappingExposure = this.world
      ? (this.settings.exposure * Math.PI) / this.lighting.referenceIrradiance()
      : this.settings.exposure * light.exposure;
    if (this.water) {
      const w = this.water.uniforms;
      w.sunDirection.value.copy(light.sunDirection);
      w.sunColor.value.copy(light.sunColor).multiplyScalar(this.lighting.sun.intensity / 3);
      w.skyZenith.value.copy(light.skyZenith);
      w.skyHorizon.value.copy(light.skyHorizon);
      w.ambient.value.copy(light.ambient);
      w.rain.value = rainAmount;
      w.wind.value = env.windStrength + rainAmount * 0.3;
    }
    this.objects.night.value = light.night;

    this.rain.intensity.value = rainAmount;
    this.rain.windX.value = Math.cos(env.windDirection) * env.windStrength * 0.4;
    this.rain.windZ.value = Math.sin(env.windDirection) * env.windStrength * 0.4;
    this.rain.center.value.copy(this.view.target);

    // Camera shake decays quickly; it is purely presentational.
    this.effects.shake = Math.max(0, this.effects.shake - deltaSeconds);
    const s = this.effects.shake * 0.15;
    this.shakeOffset.set((Math.random() - 0.5) * s, 0, (Math.random() - 0.5) * s);
    this.view.update();
    this.view.camera.position.add(this.shakeOffset);
    this.view.camera.updateMatrixWorld();

    const right = new Vector3().setFromMatrixColumn(this.view.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.view.camera.matrixWorld, 1);
    this.effects.update(this.seconds(), right, up);
    const sprites = this.world?.sprites;
    if (sprites) {
      sprites.cameraRight.value.copy(right);
      sprites.cameraUp.value.copy(up);
      sprites.toCamera.value.setFromMatrixColumn(this.view.camera.matrixWorld, 2);
      // Unlit original art follows the scene's light level relative to the noon reference (1 = original look).
      this.lighting.flatIrradianceColor(sprites.light.value).multiplyScalar(1 / this.lighting.referenceIrradiance());
    }
    this.pipeline.render();
  }

  /** Ground point under a CSS-pixel position, for sandbox interaction. */
  pick(clientX: number, clientY: number): Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = { x: ((clientX - rect.left) / rect.width) * 2 - 1, y: -((clientY - rect.top) / rect.height) * 2 + 1 };
    const origin = new Vector3(ndc.x, ndc.y, -1).unproject(this.view.camera);
    const direction = new Vector3(ndc.x, ndc.y, 1).unproject(this.view.camera).sub(origin).normalize();
    // March along the view ray against the height field; robust and cheap for a single click.
    for (let t = 0; t < 400; t += 0.05) {
      const p = origin.clone().addScaledVector(direction, t);
      if (p.x < 0 || p.z < 0 || p.x > this.bounds.width || p.z > this.bounds.height) continue;
      if (p.y <= Math.max(this.terrain.heightAt(p.x, p.z), this.waterY)) return p;
    }
    return null;
  }
}
