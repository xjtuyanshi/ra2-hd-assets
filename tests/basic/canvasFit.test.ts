import { describe, expect, it, vi } from 'vitest';
import { calculateCanvasFit, displayMatchedFrameSize } from '../../src/ui/pages/game/canvasFit';
import { installCanvasFit } from '../../src/ui/pages/game/gameInput';

describe('HD canvas resize lifecycle', () => {
  it('fits CSS immediately, waits for a stable area to allocate backing, and cancels a pending resize on destroy', () => {
    vi.useFakeTimers();
    const area = { width: 800, height: 600 };
    const stage = { getBoundingClientRect: () => area };
    const canvas = {
      width: 1,
      height: 1,
      style: { width: '', height: '', aspectRatio: '' },
      closest: () => stage,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: Number.parseFloat(canvas.style.width),
        height: Number.parseFloat(canvas.style.height),
      }),
    };
    vi.stubGlobal('window', { devicePixelRatio: 1.5, setTimeout, clearTimeout });
    vi.stubGlobal('document', Object.assign(new EventTarget(), { fullscreenElement: null }));
    vi.stubGlobal('matchMedia', () => new EventTarget());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const redraw = vi.fn();
    const fit = installCanvasFit(canvas as unknown as HTMLCanvasElement, () => ({ width: 800, height: 600 }), redraw, {
      fillStage: () => true,
      devicePixelBacking: () => true,
    });
    try {
      expect([canvas.width, canvas.height]).toEqual([1200, 900]);
      expect(redraw).not.toHaveBeenCalled();
      Object.assign(area, { width: 900, height: 675 });
      fit();
      expect(canvas.style.width).toBe('900px');
      expect(canvas.width).toBe(1200);
      vi.advanceTimersByTime(100);
      Object.assign(area, { width: 1000, height: 750 });
      fit();
      expect(canvas.style.width).toBe('1000px');
      vi.advanceTimersByTime(199);
      expect(canvas.width).toBe(1200);
      vi.advanceTimersByTime(1);
      expect([canvas.width, canvas.height]).toEqual([1500, 1125]);
      expect(redraw).toHaveBeenCalledTimes(1);
      // A real game video-mode switch cannot wait on an old logical coordinate space.
      Object.assign(area, { width: 900, height: 675 });
      fit(640, 480);
      expect(canvas.width).toBe(1350);
      expect(redraw).toHaveBeenCalledTimes(2);
      Object.assign(area, { width: 1200, height: 900 });
      fit();
      fit.destroy();
      vi.advanceTimersByTime(1000);
      expect(canvas.width).toBe(1350);
      expect(redraw).toHaveBeenCalledTimes(2);
    } finally {
      fit.destroy();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('canvas 等比适配', () => {
  it('fills an enlarged owner window at DPR 1.5 despite the original negotiated scale', () => {
    const fit = calculateCanvasFit({
      stageWidth: 2741,
      stageHeight: 1603,
      frameWidth: 1152,
      frameHeight: 608,
      devicePixelRatio: 1.5,
      integerScale: true,
      preferredScale: 3,
      fillStage: true,
    })!;
    expect(fit.cssWidth).toBeCloseTo(2741, 0);
    expect(fit.scale).toBeGreaterThan(3);
    expect(fit.scale).toBe(fit.fillScale);
  });
  it('按 1440×900 帧适配宽舞台并保持 16:10', () => {
    const result = calculateCanvasFit({
      stageWidth: 1920,
      stageHeight: 1080,
      frameWidth: 1440,
      frameHeight: 900,
      devicePixelRatio: 1,
    });

    expect(result).toEqual({
      cssWidth: 1728,
      cssHeight: 1080,
      backingWidth: 2880,
      backingHeight: 1800,
      scale: 1.2,
      fillScale: 1.2,
    });
    expect(result!.cssWidth / result!.cssHeight).toBeCloseTo(1440 / 900);
  });

  it('按 800×600 帧适配高舞台并保持 4:3', () => {
    const result = calculateCanvasFit({
      stageWidth: 1000,
      stageHeight: 900,
      frameWidth: 800,
      frameHeight: 600,
      devicePixelRatio: 1,
    });

    expect(result).toEqual({
      cssWidth: 1000,
      cssHeight: 750,
      backingWidth: 1600,
      backingHeight: 1200,
      scale: 1.25,
      fillScale: 1.25,
    });
    expect(result!.cssWidth / result!.cssHeight).toBeCloseTo(800 / 600);
  });

  it('在非整数缩放和高 DPR 下仍不改变帧比例', () => {
    const result = calculateCanvasFit({
      stageWidth: 1237,
      stageHeight: 777,
      frameWidth: 1440,
      frameHeight: 900,
      devicePixelRatio: 1.25,
    });

    expect(result).not.toBeNull();
    expect(result!.cssWidth).toBeLessThanOrEqual(1237);
    expect(result!.cssHeight).toBeLessThanOrEqual(777);
    expect(result!.cssWidth / result!.cssHeight).toBeCloseTo(1440 / 900, 2);
    expect(result!.backingWidth).toBeGreaterThan(0);
    expect(result!.backingHeight).toBeGreaterThan(0);
  });

  it('拒绝无效尺寸，避免产生非法 CSS 或 backing 尺寸', () => {
    expect(
      calculateCanvasFit({
        stageWidth: 0,
        stageHeight: 900,
        frameWidth: 800,
        frameHeight: 600,
        devicePixelRatio: 1,
      }),
    ).toBeNull();
    expect(
      calculateCanvasFit({
        stageWidth: 1000,
        stageHeight: 900,
        frameWidth: Number.NaN,
        frameHeight: 600,
        devicePixelRatio: 1,
      }),
    ).toBeNull();
  });

  it('在极小舞台中也完整缩小，不因 backing 下限产生裁切', () => {
    const result = calculateCanvasFit({
      stageWidth: 123,
      stageHeight: 80,
      frameWidth: 1440,
      frameHeight: 900,
      devicePixelRatio: 1,
    });

    expect(result).not.toBeNull();
    expect(result!.cssWidth).toBeLessThanOrEqual(123);
    expect(result!.cssHeight).toBeLessThanOrEqual(80);
    expect(result!.backingWidth).toBeGreaterThanOrEqual(360);
    expect(result!.backingHeight).toBeGreaterThanOrEqual(225);
  });

  it('略高于整数倍的适配取整数倍：每个帧像素恰好落在整数个设备像素上', () => {
    // 1727 frame pixels in a 3456-device-pixel stage: 2.0012x would resample the whole frame by a fraction of a pixel.
    const result = calculateCanvasFit({
      stageWidth: 1728,
      stageHeight: 1080,
      frameWidth: 1727,
      frameHeight: 1079,
      devicePixelRatio: 2,
    });
    expect(result).toMatchObject({
      cssWidth: 1727,
      cssHeight: 1079,
      backingWidth: 3454,
      backingHeight: 2158,
      scale: 2,
    });
    expect(result!.fillScale).toBeCloseTo(3456 / 1727, 9);
    // More than 1 % above a whole scale still fills the stage.
    expect(
      calculateCanvasFit({
        stageWidth: 1728,
        stageHeight: 1080,
        frameWidth: 1152,
        frameHeight: 744,
        devicePixelRatio: 2,
      })!.scale,
    ).toBeCloseTo(2160 / 744, 6);
  });

  it('integerScale 向下取整到整数倍并留边；不足 2 倍时仍铺满舞台', () => {
    const fullscreen = calculateCanvasFit({
      stageWidth: 1728,
      stageHeight: 1117,
      frameWidth: 1728,
      frameHeight: 992,
      devicePixelRatio: 2,
      integerScale: true,
    });
    // Height would allow 2.25x; the width allows exactly 2x.
    expect(fullscreen).toMatchObject({ cssWidth: 1728, cssHeight: 992, backingWidth: 3456, backingHeight: 1984 });
    expect([fullscreen!.scale, fullscreen!.fillScale]).toEqual([2, 2]);
    const larger = calculateCanvasFit({
      stageWidth: 1728,
      stageHeight: 1080,
      frameWidth: 1152,
      frameHeight: 744,
      devicePixelRatio: 2,
      integerScale: true,
    });
    expect(larger).toMatchObject({ cssWidth: 1152, cssHeight: 744, scale: 2 });
    expect(larger!.fillScale).toBeCloseTo(2160 / 744, 9);
    const menu = calculateCanvasFit({
      stageWidth: 1728,
      stageHeight: 1080,
      frameWidth: 800,
      frameHeight: 600,
      devicePixelRatio: 2,
      integerScale: true,
    });
    // 3 device pixels per frame pixel on screen; the backing store keeps its 2x cap.
    expect(menu).toMatchObject({ cssWidth: 1200, cssHeight: 900, backingWidth: 1600, backingHeight: 1200, scale: 3 });
    // A window made smaller after the frame size was chosen: 1.84x fills it; half size at 1x would be worse.
    const shrunk = calculateCanvasFit({
      stageWidth: 1728,
      stageHeight: 992,
      frameWidth: 1728,
      frameHeight: 1080,
      devicePixelRatio: 2,
      integerScale: true,
    });
    expect(shrunk!.scale).toBeCloseTo(1984 / 1080, 9);
    expect(shrunk!.cssHeight).toBe(992);
    const small = calculateCanvasFit({
      stageWidth: 700,
      stageHeight: 500,
      frameWidth: 1728,
      frameHeight: 1080,
      devicePixelRatio: 1,
      integerScale: true,
    });
    expect(small!.scale).toBeCloseTo(700 / 1728, 6);
    expect(small!.cssWidth).toBeLessThanOrEqual(700);
  });
});

describe('按显示器匹配的帧尺寸', () => {
  const limits = { minWidth: 800, minHeight: 600, maxWidth: 2560, maxHeight: 1600 };
  const match = (stageWidth: number, stageHeight: number, devicePixelRatio: number, devicePixelsPerFramePixel = 2) =>
    displayMatchedFrameSize({ stageWidth, stageHeight, devicePixelRatio, devicePixelsPerFramePixel, limits });

  it('每个帧像素占 2 个设备像素：DPR 2 取窗口的 CSS 尺寸，DPR 1 的 4K 取一半', () => {
    expect(match(1728, 1080, 2)).toEqual({ width: 1728, height: 1080 });
    expect(match(1728, 1117, 2)).toEqual({ width: 1728, height: 1116 });
    expect(match(3840, 2160, 1)).toEqual({ width: 1920, height: 1080 });
    expect(match(1920, 1080, 2)).toEqual({ width: 1920, height: 1080 });
    // Fractional stage sizes and odd device sizes round down to even frame sizes.
    expect(match(1727.5, 991.5, 2)).toEqual({ width: 1726, height: 990 });
  });

  it('匹配结果按整数倍恰好放进舞台', () => {
    for (const [width, height, dpr] of [
      [1728, 1080, 2],
      [1727.5, 991.5, 2],
      [3840, 2160, 1],
      [1503, 911, 1.5],
    ] as const) {
      const size = match(width, height, dpr)!;
      const fit = calculateCanvasFit({
        stageWidth: width,
        stageHeight: height,
        frameWidth: size.width,
        frameHeight: size.height,
        devicePixelRatio: dpr,
        integerScale: true,
      })!;
      expect(fit.scale, `${width}x${height}@${dpr}`).toBe(2);
      expect(fit.cssWidth * dpr).toBe(size.width * 2);
    }
  });

  it.each([2741, 2741.3333])('keeps the 4112-pixel fullscreen raster at CSS width %s and DPR 1.5', (width) => {
    const size = match(width, 1720, 1.5)!;
    expect(size).toEqual({ width: 2056, height: 1290 });
    const fit = calculateCanvasFit({
      stageWidth: width,
      stageHeight: 1720,
      frameWidth: size.width,
      frameHeight: size.height,
      devicePixelRatio: 1.5,
      preferredScale: 2,
      fillStage: true,
    })!;
    expect(fit).toMatchObject({ scale: 2, fillScale: 2, backingWidth: 4112, backingHeight: 2580 });
    expect(fit.cssWidth * 1.5).toBe(4112);
    expect(fit.cssHeight * 1.5).toBe(2580);
  });

  it('经典和适中保持所选倍率并把原版部分直接画到设备分辨率', () => {
    for (const [scale, width, height] of [
      [3, 1152, 608],
      [2.5, 1382, 730],
    ] as const) {
      expect(match(1728, 914, 2, scale)).toEqual({ width, height });
      expect(
        calculateCanvasFit({
          stageWidth: 1728,
          stageHeight: 914,
          frameWidth: width,
          frameHeight: height,
          devicePixelRatio: 2,
          integerScale: true,
          preferredScale: scale,
        }),
      ).toMatchObject({ scale, backingWidth: width * scale, backingHeight: height * scale });
    }
  });

  it('窗口太小时退到 1 倍或最小尺寸，太大时取上限', () => {
    // 1280x720 device pixels: 640x360 at 2x is below the minimum, so one frame pixel per device pixel.
    expect(match(1280, 720, 1)).toEqual({ width: 1280, height: 720 });
    expect(match(700, 500, 1)).toEqual({ width: 800, height: 600 });
    expect(match(3008, 1692, 2)).toEqual({ width: 2560, height: 1600 });
    expect(match(0, 500, 1)).toBeNull();
    expect(match(1728, 1080, 2, Number.NaN)).toBeNull();
  });
});
