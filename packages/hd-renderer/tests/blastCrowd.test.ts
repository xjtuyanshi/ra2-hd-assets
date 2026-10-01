import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BLAST_CROWD, BlastCrowd, ENHANCED } from '../src/effects';

describe('enhanced blast cluster budget', () => {
  it('leaves a lone blast untouched', () => {
    const crowd = new BlastCrowd();
    expect(crowd.grant(0, new Vector3(0, 0, 0), 18, 10)).toEqual({ debris: 18, smoke: 10 });
  });

  it('shares a hard budget across twelve collapse blasts, with floors only while allowance remains', () => {
    const crowd = new BlastCrowd();
    let debris = 0;
    let smoke = 0;
    for (let i = 0; i < 12; i++) {
      const g = crowd.grant(
        i * 0.12,
        new Vector3(i % 3, 0, Math.floor(i / 3) * 0.5),
        Math.round(ENHANCED.debris.count + 2 * ENHANCED.debris.perScale),
        15,
      );
      expect(g.debris).toBeGreaterThanOrEqual(0);
      expect(g.debris).toBeLessThanOrEqual(BLAST_CROWD.debris - debris);
      debris += g.debris;
      smoke += g.smoke;
    }
    expect(debris).toBeGreaterThanOrEqual(20);
    expect(debris).toBeLessThanOrEqual(40);
    expect(debris).toBeLessThanOrEqual(BLAST_CROWD.debris);
    expect(smoke).toBeLessThanOrEqual(BLAST_CROWD.smoke);
  });

  it('uses the small floors near exhaustion without creating particles beyond the ceiling', () => {
    const crowd = new BlastCrowd();
    const at = new Vector3();
    crowd.grant(0, at, 33, 12);
    expect(crowd.grant(0.1, at, 18, 10)).toEqual({ debris: 2, smoke: 1 });
    expect(crowd.grant(0.2, at, 18, 10)).toEqual({ debris: 1, smoke: 1 });
    expect(crowd.grant(0.3, at, 18, 10)).toEqual({ debris: 0, smoke: 0 });
  });

  it('does not share with distant or old blasts', () => {
    const crowd = new BlastCrowd();
    crowd.grant(0, new Vector3(0, 0, 0), BLAST_CROWD.debris, BLAST_CROWD.smoke);
    expect(crowd.grant(0.5, new Vector3(BLAST_CROWD.radius + 1, 0, 0), 18, 10)).toEqual({ debris: 18, smoke: 10 });
    expect(crowd.grant(BLAST_CROWD.window + 0.1, new Vector3(0, 0, 0), 18, 10)).toEqual({ debris: 18, smoke: 10 });
  });
});
