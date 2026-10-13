import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISPLAY_RESOLUTION,
  displayMatchIsStale,
  loadStoredResolutionChoice,
  parseResolutionChoice,
  resolutionChoiceValue,
  resolveResolutionChoice,
  resolveResolutionViewScale,
  storeResolutionChoice,
} from '../../src/ui/pages/game/vmPageResolution';

afterEach(() => vi.unstubAllGlobals());

function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  return values;
}

const stage = (width: number, height: number) =>
  ({ getBoundingClientRect: () => ({ width, height }) }) as unknown as Element;

describe('分辨率选择', () => {
  it.each([2741, 2741.3333])('retains exact Wide scale for a rounded device raster at CSS width %s', (width) => {
    const area = { width, height: 1720 };
    const frame = resolveResolutionChoice('wide', null, 1.5, area);
    expect(frame).toEqual({ width: 2056, height: 1290 });
    expect(resolveResolutionViewScale('wide', null, 1.5, frame, area)).toBe(2);
  });
  it('retains the negotiated scale after reloading a smaller native window', () => {
    expect(
      resolveResolutionViewScale(
        'wide',
        stage(1728, 920),
        2,
        { width: 1728, height: 1116 },
        { width: 1728, height: 1117 },
      ),
    ).toBe(2);
  });
  it('解析预设、匹配窗口与跟随 INI；自定义尺寸只在显式允许时接受', () => {
    expect(parseResolutionChoice('1440x900')).toEqual({ width: 1440, height: 900 });
    expect(parseResolutionChoice('display')).toBe(DISPLAY_RESOLUTION);
    expect(parseResolutionChoice('classic')).toBe('classic');
    expect(parseResolutionChoice('moderate')).toBe('moderate');
    expect(parseResolutionChoice('wide')).toBe('wide');
    expect(parseResolutionChoice('')).toBeNull();
    expect(parseResolutionChoice('ini')).toBeNull();
    expect(parseResolutionChoice(null)).toBeUndefined();
    expect(parseResolutionChoice('1728x1080')).toBeUndefined();
    expect(parseResolutionChoice('1728x1080', true)).toEqual({ width: 1728, height: 1080 });
    expect(parseResolutionChoice('9999x9999', true)).toBeUndefined();
    expect(parseResolutionChoice('fit', true)).toBeUndefined();
    expect(resolutionChoiceValue(DISPLAY_RESOLUTION)).toBe('display');
    expect(resolutionChoiceValue({ width: 800, height: 600 })).toBe('800x600');
    expect(resolutionChoiceValue(null)).toBe('');
  });

  it('区分从未选择与明确跟随 INI', () => {
    const values = stubStorage();
    expect(loadStoredResolutionChoice('yr')).toBeUndefined();
    storeResolutionChoice('yr', null);
    expect(values.get('vm-resolution-yr')).toBe('ini');
    expect(loadStoredResolutionChoice('yr')).toBeNull();
    storeResolutionChoice('yr', DISPLAY_RESOLUTION);
    expect(loadStoredResolutionChoice('yr')).toBe(DISPLAY_RESOLUTION);
    storeResolutionChoice('yr', 'moderate');
    expect(loadStoredResolutionChoice('yr')).toBe('moderate');
    storeResolutionChoice('yr', { width: 1280, height: 720 });
    expect(loadStoredResolutionChoice('yr')).toEqual({ width: 1280, height: 720 });
    expect(loadStoredResolutionChoice('ra2')).toBeUndefined();
    // A value another build stored is treated as never chosen instead of being passed to the game.
    values.set('vm-resolution-yr', '1366x768');
    expect(loadStoredResolutionChoice('yr')).toBeUndefined();
  });

  it('migrates the old remembered Classic default once and retains later explicit views', () => {
    const values = stubStorage();
    values.set('vm-resolution-yr', 'classic');
    expect(loadStoredResolutionChoice('yr')).toBe('wide');
    expect(values.get('vm-resolution-yr')).toBe('wide');
    expect(loadStoredResolutionChoice('yr')).toBe('wide');
    storeResolutionChoice('yr', 'classic');
    expect(loadStoredResolutionChoice('yr')).toBe('classic');
    values.set('vm-resolution-ra2', 'classic');
    expect(loadStoredResolutionChoice('ra2')).toBe('wide');
    expect(loadStoredResolutionChoice('yr')).toBe('classic');
  });

  it('preserves existing non-Classic choices during default migration', () => {
    const values = stubStorage();
    for (const choice of ['moderate', 'wide', 'display', 'ini', '1280x720']) {
      values.set('vm-resolution-yr', choice);
      expect(loadStoredResolutionChoice('yr')).toEqual(parseResolutionChoice(choice));
      expect(values.get('vm-resolution-yr')).toBe(choice);
    }
  });

  it('匹配窗口按启动时的舞台与设备像素比换算；其余选择原样返回', () => {
    expect(resolveResolutionChoice(DISPLAY_RESOLUTION, stage(1728, 1080), 2)).toEqual({ width: 1728, height: 1080 });
    expect(resolveResolutionChoice(DISPLAY_RESOLUTION, stage(3840, 2160), 1)).toEqual({ width: 1920, height: 1080 });
    expect(resolveResolutionChoice(DISPLAY_RESOLUTION, null, 2)).toBeNull();
    expect(resolveResolutionChoice({ width: 1024, height: 768 }, stage(1728, 1080), 2)).toEqual({
      width: 1024,
      height: 768,
    });
    expect(resolveResolutionChoice(null, stage(1728, 1080), 2)).toBeNull();
    expect(resolveResolutionChoice('classic', stage(1728, 914), 2)).toEqual({ width: 1152, height: 608 });
    expect(resolveResolutionChoice('classic', stage(1728, 1117), 2)).toEqual({ width: 1152, height: 744 });
    expect(resolveResolutionChoice('moderate', stage(1728, 914), 2)).toEqual({ width: 1382, height: 730 });
  });

  it('只在匹配尺寸的画面不再贴合窗口时提示刷新；菜单页等其他尺寸不提示', () => {
    const matched = { width: 1728, height: 1080 };
    // The matched frame at its whole scale, filling the stage.
    expect(displayMatchIsStale(matched, matched, 2, 2)).toBe(false);
    // A slightly larger stage (browser toolbar hidden in fullscreen): still a whole scale with a narrow border.
    expect(displayMatchIsStale(matched, matched, 2, 2.17)).toBe(false);
    // The window shrank: the frame is resampled.
    expect(displayMatchIsStale(matched, matched, 1.67, 1.67)).toBe(true);
    // The window grew a lot: whole pixels, but wide borders that a reload would fill.
    expect(displayMatchIsStale(matched, matched, 2, 2.6)).toBe(true);
    // The games' 800x600 menu pages are shown at their own whole scale inside the same stage: no hint.
    expect(displayMatchIsStale(matched, { width: 800, height: 600 }, 3, 3.6)).toBe(false);
    // Not a display-matched session.
    expect(displayMatchIsStale(null, matched, 1.67, 1.67)).toBe(false);
  });
});
