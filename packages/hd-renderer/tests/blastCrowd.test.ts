import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BLAST_CROWD, BlastCrowd } from '../src/effects';

describe('enhanced blast cluster budget', () => {
  it('leaves a lone blast untouched', () => {
    const crowd = new BlastCrowd();
    expect(crowd.grant(0, new Vector3(0, 0, 0), 102, 34)).toEqual({ debris: 102, smoke: 34 });
  });

  it('shares one budget across a collapse-like cluster, with a small floor per blast', () => {
    const crowd = new BlastCrowd();
    let debris = 0;
    let smoke = 0;
    for (let i = 0; i < 12; i++) {
      const g = crowd.grant(i * 0.12, new Vector3(i % 3, 0, Math.floor(i / 3) * 0.5), 102, 34);
      expect(g.debris).toBeGreaterThanOrEqual(BLAST_CROWD.floor.debris);
      debris += g.debris;
      smoke += g.smoke;
    }
    expect(debris).toBeLessThanOrEqual(BLAST_CROWD.debris + 12 * BLAST_CROWD.floor.debris);
    expect(smoke).toBeLessThanOrEqual(BLAST_CROWD.smoke + 12 * BLAST_CROWD.floor.smoke);
  });

  it('does not share with distant or old blasts', () => {
    const crowd = new BlastCrowd();
    crowd.grant(0, new Vector3(0, 0, 0), 170, 90);
    expect(crowd.grant(0.5, new Vector3(BLAST_CROWD.radius + 1, 0, 0), 102, 34)).toEqual({ debris: 102, smoke: 34 });
    expect(crowd.grant(BLAST_CROWD.window + 0.1, new Vector3(0, 0, 0), 102, 34)).toEqual({ debris: 102, smoke: 34 });
  });
});
