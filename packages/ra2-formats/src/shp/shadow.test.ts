import { describe, expect, it } from 'vitest';
import { shadowFrameIndex } from './shpFile.js';

// The SHP(TS) shadow convention (verified against the real RA2 install, stage 3):
// a sprite stores its drop shadows as the SECOND HALF of the frame list, so the
// shadow of body frame `i` is frame `i + frameCount/2`. `shadowFrameIndex`
// captures exactly that split, refusing odd counts / out-of-range body frames.
describe('shadowFrameIndex', () => {
  it('maps a body frame to its shadow half for an even count', () => {
    // ngcnst.shp probed as 6 frames: bodies 0..2, shadows 3..5.
    expect(shadowFrameIndex(0, 6)).toBe(3);
    expect(shadowFrameIndex(1, 6)).toBe(4);
    expect(shadowFrameIndex(2, 6)).toBe(5);
  });

  it('maps every body frame of a large even sprite (cons.shp 602 frames)', () => {
    // cons.shp: 301 body frames (0..300), 301 shadow frames (301..601).
    expect(shadowFrameIndex(0, 602)).toBe(301);
    expect(shadowFrameIndex(300, 602)).toBe(601);
  });

  it('returns undefined for a body index in the shadow half (already a shadow)', () => {
    expect(shadowFrameIndex(3, 6)).toBeUndefined();
    expect(shadowFrameIndex(5, 6)).toBeUndefined();
  });

  it('returns undefined for an odd frame count (no clean split)', () => {
    expect(shadowFrameIndex(0, 5)).toBeUndefined();
    expect(shadowFrameIndex(1, 7)).toBeUndefined();
  });

  it('returns undefined for zero/negative counts and out-of-range indices', () => {
    expect(shadowFrameIndex(0, 0)).toBeUndefined();
    expect(shadowFrameIndex(-1, 6)).toBeUndefined();
    expect(shadowFrameIndex(6, 6)).toBeUndefined();
  });
});
