import type GUI from 'three/addons/libs/lil-gui.module.min.js';
import { applyLookPreset, LOOK_PRESETS, type HdRenderer, type HdSettings, type LookPreset } from '../src/HdRenderer';
import type { RenderState } from '../src/contract';

/**
 * Sandbox parameters of the enhanced look: ?look=faithful|golden|cinematic picks a preset (the enhanced presets also
 * move the hour to their afternoon unless ?time is given); single settings override it: ?relight= ?spec= ?glass= ?ao=
 * ?shfollow= ?shsoft= ?wetrefl= ?contrast= ?sunpath=fixed|arc ?adapt= ?vsheen= ?vsheencap= ?vao=. Call before HdRenderer.init().
 * Display grade: ?wbadapt= ?gbal=r,g,b ?gcon= ?glift= ?gsat= ?gshadow=r,g,b ?ghigh=r,g,b.
 */
export function applyLookParams(hd: HdRenderer, params: URLSearchParams, state: RenderState): void {
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
    ['wbadapt', 'whiteAdapt'],
    ['mtadapt', 'mapTintAdapt'],
    ['gcon', 'gradeContrast'],
    ['glift', 'gradePivotLift'],
    ['gsat', 'gradeSaturation'],
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
  const triples = [
    ['gbal', 'gradeBalance'],
    ['gshadow', 'gradeShadowTint'],
    ['ghigh', 'gradeHighlightTint'],
  ] as const;
  for (const [param, key] of triples) {
    const parts = params.get(param)?.split(',');
    if (parts?.length !== 3 || parts.some((v) => v.trim() === '')) continue;
    const value = parts.map(Number);
    if (value.every(Number.isFinite)) hd.settings[key] = value as [number, number, number];
  }
  hd.settings.whiteAdapt = Math.min(1, Math.max(0, hd.settings.whiteAdapt));
  hd.settings.gradeContrast = Math.min(1, Math.max(-0.5, hd.settings.gradeContrast));
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
    cinematic: () => {
      const hour = applyLookPreset(hd.settings, 'cinematic');
      if (hour !== undefined) state.environment.timeOfDay = hour;
      apply();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
  };
  folder.add(presets, 'faithful').name('预设：原版保真');
  folder.add(presets, 'golden').name('预设：金色午后');
  folder.add(presets, 'cinematic').name('预设：电影感（批准风格）');
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
  folder.add(hd.settings, 'whiteAdapt', 0, 1, 0.01).name('白平衡自适应');
  folder.add(hd.settings, 'mapTintAdapt', 0, 1, 0.01).name('地图色调中和');
  const tintControls = [
    ['gradeBalance', '色彩平衡'],
    ['gradeShadowTint', '暗部色调'],
    ['gradeHighlightTint', '亮部色调'],
  ] as const;
  for (const [key, label] of tintControls) {
    for (const [i, channel] of ['R', 'G', 'B'].entries()) {
      // Resolve the settings array on every access: applying another preset replaces its RGB triples.
      const control = {
        get value(): number {
          return hd.settings[key][i]!;
        },
        set value(value: number) {
          hd.settings[key][i] = value;
        },
      };
      folder.add(control, 'value', 0, 2, 0.01).name(`${label} ${channel}`).onChange(apply);
    }
  }
  folder.add(hd.settings, 'gradeContrast', -0.5, 1, 0.01).name('对比 S 曲线').onChange(apply);
  folder.add(hd.settings, 'gradePivotLift', -0.5, 0.5, 0.01).name('中间调提亮').onChange(apply);
  folder.add(hd.settings, 'gradeSaturation', 0, 2, 0.01).name('饱和度').onChange(apply);
}
