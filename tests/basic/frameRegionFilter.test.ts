import { describe, expect, it } from 'vitest';
import { frameRegionFilterShader, frameRegionScissor } from '../../src/graphics/frameRegionFilter';

describe('selected native frame smoothing', () => {
  it('uses device-pixel boundary rounding and converts to the GL bottom-left origin', () => {
    expect(
      frameRegionScissor(
        { x: 10, y: 20, width: 100, height: 60 },
        { width: 800, height: 600 },
        { width: 2000, height: 1800 },
      ),
    ).toEqual({ x: 25, y: 1560, width: 250, height: 180 });
    expect(
      frameRegionScissor(
        { x: 11, y: 1, width: 3, height: 1 },
        { width: 800, height: 600 },
        { width: 1400, height: 900 },
      ),
    ).toEqual({ x: 19, y: 897, width: 6, height: 1 });
  });
  it.each([
    { x: -1, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 801, height: 2 },
    { x: 0, y: 599, width: 2, height: 2 },
    { x: 1.5, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: Infinity, height: 2 },
  ])('rejects invalid native bounds without a GPU pass: %j', (r) => {
    expect(frameRegionScissor(r, { width: 800, height: 600 }, { width: 1600, height: 1200 })).toBeNull();
  });
  it.each(['indexed', 'rgba', 'rgb565'] as const)('interpolates decoded %s colours within the aperture', (kind) => {
    const shader = frameRegionFilterShader(kind);
    expect(shader).toContain('clamp(at, ivec2(sampleRect.xy), ivec2(sampleRect.zw) - ivec2(1))');
    expect(shader).toContain('mix(top, bottom, weight.y)');
    expect(shader).not.toContain('keyRgb');
    if (kind === 'indexed') expect(shader).toContain('texelFetch(palette, ivec2(i, 0), 0).rgb');
    if (kind === 'rgba') expect(shader).toContain('texelFetch(rgbaFrame, at, 0).rgb');
    if (kind === 'rgb565') expect(shader).toContain('rgb = (rgb << uvec3(3u, 2u, 3u)) | (rgb >> uvec3(2u, 4u, 2u))');
  });
});
