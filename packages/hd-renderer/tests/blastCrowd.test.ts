import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BLAST_CROWD, BlastCrowd, CharLedger, ENHANCED } from '../src/effects';

describe('enhanced char ledger', () => {
  it.each([
    [1, 8, 1],
    [4, 1, 2],
    [0, 10, 2],
  ])('grants %i-cell-separated blasts %i seconds apart exactly %i marks', (distance, delay, marks) => {
    const ledger = new CharLedger();
    const claims = [ledger.claim(0, new Vector3()), ledger.claim(delay, new Vector3(distance, 0, 0))];
    expect(claims.filter(Boolean)).toHaveLength(marks);
  });

  it('compares x/z distance, including the radius boundary and ignoring height', () => {
    const ledger = new CharLedger();
    expect(ledger.claim(0, new Vector3())).toBe(true);
    expect(ledger.claim(1, new Vector3(0, 100, ENHANCED.char.radius))).toBe(false);
    expect(ledger.claim(2, new Vector3(2, 0, 2))).toBe(true);
  });

  it('does not renew a rejected mark or retain mutable positions or future clock history', () => {
    const ledger = new CharLedger();
    const at = new Vector3();
    expect(ledger.claim(0, at)).toBe(true);
    at.x = 100;
    expect(ledger.claim(ENHANCED.char.life, new Vector3())).toBe(false);
    expect(ledger.claim(ENHANCED.char.life + 0.01, new Vector3())).toBe(true);
    expect(ledger.claim(0, new Vector3())).toBe(true);
  });

  it('keeps char faint, bounded and short-lived so the native smudge is the lasting mark', () => {
    expect(ENHANCED.char).toMatchObject({ width: 1.8, fadeIn: 0.15, radius: 2.5 });
    expect(ENHANCED.char.opacity).toBeGreaterThan(0);
    expect(ENHANCED.char.opacity).toBeLessThanOrEqual(0.35);
    expect(ENHANCED.char.life).toBeGreaterThanOrEqual(8);
    expect(ENHANCED.char.life).toBeLessThanOrEqual(10);
    expect(ENHANCED.char.maxWidth).toBeLessThanOrEqual(2.5);
  });
});

describe('enhanced blast cluster budget', () => {
  it.each([
    [18, 5, 2],
    [36, 10, 3],
  ])('keeps a lone blast request up to the ceilings (%i chunks, %i billows, %i columns)', (debris, smoke, late) => {
    const crowd = new BlastCrowd();
    expect(crowd.grant(0, new Vector3(), debris, smoke, late)).toEqual({ debris, smoke, late });
  });

  it('caps an oversized lone request and defaults omitted column requests to zero', () => {
    expect(new BlastCrowd().grant(0, new Vector3(), 100, 100, 100)).toEqual({ debris: 36, smoke: 10, late: 3 });
    expect(new BlastCrowd().grant(0, new Vector3(), 18, 5)).toEqual({ debris: 18, smoke: 5, late: 0 });
  });

  it('shares a hard budget across twelve collapse blasts, with floors only while allowance remains', () => {
    const crowd = new BlastCrowd();
    let debris = 0;
    let smoke = 0;
    let late = 0;
    for (let i = 0; i < 12; i++) {
      const g = crowd.grant(
        i * 0.12,
        new Vector3(i % 3, 0, Math.floor(i / 3) * 0.5),
        Math.round(ENHANCED.debris.count + 2 * ENHANCED.debris.perScale),
        Math.round(ENHANCED.smoke.count + 2 * ENHANCED.smoke.perScale),
        Math.round(ENHANCED.column.count + 1.5 * ENHANCED.column.perScale),
      );
      expect(g.debris).toBeGreaterThanOrEqual(0);
      expect(g.debris).toBeLessThanOrEqual(BLAST_CROWD.debris - debris);
      expect(g.smoke).toBeGreaterThanOrEqual(0);
      expect(g.smoke).toBeLessThanOrEqual(BLAST_CROWD.smoke - smoke);
      expect(g.late).toBeGreaterThanOrEqual(0);
      expect(g.late).toBeLessThanOrEqual(BLAST_CROWD.late - late);
      debris += g.debris;
      smoke += g.smoke;
      late += g.late;
    }
    expect(debris).toBeGreaterThanOrEqual(20);
    expect(debris).toBeLessThanOrEqual(40);
    expect(debris).toBeLessThanOrEqual(BLAST_CROWD.debris);
    expect(BLAST_CROWD).toMatchObject({ smoke: 10, late: 3, floor: { debris: 2, smoke: 1, late: 0 } });
    expect(smoke).toBe(10);
    expect(late).toBe(3);
  });

  it('uses the small floors near exhaustion without creating particles beyond the ceiling', () => {
    const crowd = new BlastCrowd();
    const at = new Vector3();
    crowd.grant(0, at, 33, 8, 1);
    expect(crowd.grant(0.1, at, 18, 10, 3)).toEqual({ debris: 2, smoke: 1, late: 1 });
    expect(crowd.grant(0.2, at, 18, 10, 3)).toEqual({ debris: 1, smoke: 1, late: 0 });
    expect(crowd.grant(0.3, at, 18, 10, 3)).toEqual({ debris: 0, smoke: 0, late: 0 });
  });

  it('spends column and billow allowances independently', () => {
    const crowd = new BlastCrowd();
    const at = new Vector3();
    expect(crowd.grant(0, at, 0, 10)).toEqual({ debris: 0, smoke: 10, late: 0 });
    expect(crowd.grant(0.1, at, 18, 5, 3)).toEqual({ debris: 18, smoke: 0, late: 3 });
  });

  it('does not share with distant or old blasts', () => {
    const crowd = new BlastCrowd();
    crowd.grant(0, new Vector3(), BLAST_CROWD.debris, BLAST_CROWD.smoke, BLAST_CROWD.late);
    expect(crowd.grant(0.5, new Vector3(BLAST_CROWD.radius + 1, 0, 0), 18, 10, 3)).toEqual({
      debris: 18,
      smoke: 10,
      late: 3,
    });
    expect(crowd.grant(BLAST_CROWD.window + 0.1, new Vector3(), 18, 10, 3)).toEqual({ debris: 18, smoke: 10, late: 3 });
  });
});
