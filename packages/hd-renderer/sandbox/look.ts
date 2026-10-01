import type GUI from 'three/addons/libs/lil-gui.module.min.js';
import { applyLookPreset, LOOK_PRESETS, type HdRenderer, type HdSettings, type LookPreset } from '../src/HdRenderer';
import type { RenderState } from '../src/contract';
import { smoothVoxelOptions, DEFAULT_SMOOTH_VOXEL, type SmoothVoxelOptions } from '../src/ra2/voxelSmooth';
import { VOXEL_PBR_DEFAULTS, voxelPbrFor, type VoxelPbrKnob } from '../src/ra2/voxelPbr';
import { voxelProjectionFor } from '../src/ra2/voxelProjection';

const PROJECTION_KNOBS = ['relight', 'blend', 'strength', 'gain', 'saturation', 'levelRef', 'sharpen', 'paintShade', 'paintSpec'] as const;
type ProjectionKnob = (typeof PROJECTION_KNOBS)[number];

/**
 * Capture load-time vehicle options: ?vlook=engine|remaster, ?vsmooth=key:value and ?vproj=vehicles-hd.
 * vproj is relative to the HD cache root served by Vite; ?vlook=remaster&vproj=vehicles-hd is recommended.
 * Projection knobs are uniforms at window.__hd.voxelProjection.{relight,blend,strength}.value.
 */
export function voxelLookParams(params: URLSearchParams): {
  voxelLook: 'engine' | 'remaster';
  smoothVoxel: Readonly<SmoothVoxelOptions>;
  voxelProjection?: string;
} {
  const options: Partial<SmoothVoxelOptions> = {};
  for (const entry of (params.get('vsmooth') ?? '').split(',')) {
    const [key, value] = entry.split(':');
    if (!key || value === undefined || !Object.hasOwn(DEFAULT_SMOOTH_VOXEL, key)) continue;
    if (key === 'shape') {
      if (value === 'imls' || value === 'occupancy') options.shape = value;
    } else if (key === 'groundOcclusion') {
      if (['true', 'false', '0', '1'].includes(value)) options.groundOcclusion = value === 'true' || value === '1';
    } else if (value.trim() && Number.isFinite(Number(value))) {
      (options as Record<string, unknown>)[key] = Number(value);
    }
  }
  return {
    voxelLook: params.get('vlook') === 'remaster' ? 'remaster' : 'engine',
    smoothVoxel: smoothVoxelOptions(options),
    voxelProjection: params.get('vproj')?.trim()
      ? `/${params
          .get('vproj')!
          .trim()
          .replace(/^\/+|\/+$/g, '')}`
      : undefined,
  };
}

/**
 * Sandbox parameters of the enhanced look (src/ra2/spriteLook.ts): ?look=faithful|golden picks a preset (golden also
 * moves the hour to its golden afternoon unless ?time is given); single settings override it: ?relight= ?spec= ?glass= ?ao=
 * ?shfollow= ?shsoft= ?wetrefl= ?contrast= ?sunpath=fixed|arc ?adapt= ?vsheen= ?vsheencap= ?vao=. Call before HdRenderer.init().
 */
export function applyLookParams(hd: HdRenderer, params: URLSearchParams, state: RenderState): void {
  hd.settings.voxelLook = params.get('vlook') === 'remaster' ? 'remaster' : 'engine';
  const pbr = voxelPbrFor(hd.nodes);
  for (const entry of (params.get('vk') ?? '').split(',')) {
    const [key, value] = entry.split(':');
    if (key && Object.hasOwn(VOXEL_PBR_DEFAULTS, key) && value?.trim() && Number.isFinite(Number(value))) {
      pbr[key as VoxelPbrKnob].value = Number(value);
    }
  }
  // ?vpk=relight:0.5,gain:1,saturation:1,levelRef:1.7,blend:1,strength:1 sets projected-redraw uniforms.
  const projection = voxelProjectionFor(hd.nodes);
  for (const entry of (params.get('vpk') ?? '').split(',')) {
    const [key, value] = entry.split(':');
    const knob = projection[key as ProjectionKnob];
    if (key && PROJECTION_KNOBS.includes(key as ProjectionKnob) && value?.trim() && Number.isFinite(Number(value))) {
      knob.value = Number(value);
    }
  }
  const preset = params.get('look') as LookPreset | null;
  if (preset && preset in LOOK_PRESETS) {
    const hour = applyLookPreset(hd.settings, preset);
    if (hour !== undefined && !params.has('time')) state.environment.timeOfDay = hour;
  }
  const numbers: [string, keyof HdSettings][] = [
    ['relight', 'relight'],
    ['spec', 'specular'],
    ['glass', 'glass'],
    ['ao', 'occlusion'],
    ['shfollow', 'shadowFollow'],
    ['shsoft', 'shadowSoftness'],
    ['wetrefl', 'wetReflections'],
    ['adapt', 'adaptExposure'],
    ['contrast', 'lightContrast'],
    ['vsheen', 'voxelSheen'],
    ['vsheencap', 'voxelSheenCap'],
    ['vao', 'voxelOcclusion'],
  ];
  const settings = hd.settings as unknown as Record<string, unknown>;
  for (const [param, key] of numbers) {
    const value = Number(params.get(param));
    if (params.has(param) && Number.isFinite(value)) settings[key] = value;
  }
  const path = params.get('sunpath');
  if (path === 'fixed' || path === 'arc') hd.settings.sunPath = path;
}

/** "现代光影" folder of the sandbox GUI. */
export function addLookGui(gui: GUI, hd: HdRenderer, state: RenderState): void {
  const folder = gui.addFolder('现代光影（增强版）');
  const apply = () => hd.applySettings();
  const presets = {
    faithful: () => {
      applyLookPreset(hd.settings, 'faithful');
      apply();
      folder.controllersRecursive().forEach((c) => c.updateDisplay());
    },
    golden: () => {
      const hour = applyLookPreset(hd.settings, 'golden');
      if (hour !== undefined) state.environment.timeOfDay = hour;
      apply();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
  };
  folder.add(presets, 'faithful').name('预设：原版保真');
  folder.add(presets, 'golden').name('预设：金色午后');
  folder.add(hd.settings, 'sunPath', { 固定方位: 'fixed', 东升西落: 'arc' }).name('太阳轨迹').onChange(apply);
  folder.add(hd.settings, 'relight', 0, 1.5, 0.01).name('逐像素重打光');
  folder.add(hd.settings, 'lightContrast', 0.5, 3, 0.01).name('明暗对比');
  folder.add(hd.settings, 'specular', 0, 2, 0.01).name('立面高光');
  folder.add(hd.settings, 'glass', 0, 2, 0.01).name('玻璃反射');
  folder.add(hd.settings, 'occlusion', 0, 1.5, 0.01).name('环境光遮蔽');
  folder.add(hd.settings, 'shadowFollow', 0, 1, 0.01).name('影子随太阳');
  folder.add(hd.settings, 'shadowSoftness', 0, 2, 0.01).name('影子柔化');
  folder.add(hd.settings, 'wetReflections', 0, 2, 0.01).name('湿地倒影');
  folder.add(hd.settings, 'adaptExposure', 0, 1, 0.01).name('曝光自适应');
}
