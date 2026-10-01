import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveView, type LiveSnapshot } from '../src/live/liveView';
import { engineAnchor } from '../src/live/effectSprites';
import { waveRings } from '../src/live/beams';
import { Vector3 } from 'three/webgpu';

const random = Math.random;

afterEach(() => {
  Math.random = random;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run the real bench module with a snapshot sink. No browser, renderer, GPU or game assets are involved. */
async function bench(query: string) {
  vi.resetModules();
  const snapshots: LiveSnapshot[] = [];
  const live = {
    world: {
      cache: {
        manifest: { grid: { width: 32, height: 32 }, waypoints: [{ x: 10, y: 12 }], theater: 'temperate' },
        height: new Uint8Array(32 * 32).fill(2),
      },
    },
    // The bench reads the renderer's node set for the vehicle look state; undefined selects the default set.
    hd: { nodes: undefined, stats: vi.fn() },
    resize: vi.fn(),
    render: vi.fn(),
    push: (snapshot: LiveSnapshot) => snapshots.push(snapshot),
  };
  vi.stubGlobal('location', { search: query });
  vi.stubGlobal('document', {
    querySelector: (selector: string) => (selector === '#view' ? { clientWidth: 320, clientHeight: 200 } : {}),
  });
  vi.stubGlobal('performance', { now: () => 0 });
  vi.stubGlobal('window', {});
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  // resetModules creates the same fresh LiveView module that the bench's dynamic import will see.
  const { LiveView: BenchLiveView } = await import('../src/live/liveView');
  vi.spyOn(BenchLiveView, 'create').mockResolvedValue(live as unknown as LiveView);
  await import('../sandbox/fx');
  return snapshots;
}

describe('building bench snapshots', () => {
  it('uses cell offsets, owner slots and health while allowing normal anims', async () => {
    const snapshots = await bench('?fx=bldgs,TWLT070&bldgs=NACNST:0:0,NAPOWR:4:-2:1&health=0.4&warm=2&time=0.4');
    expect(snapshots[0]!.objects).toMatchObject([
      { type: 'NACNST', kind: 'building', x: 10 * 256, y: 12 * 256, z: 208, owner: 0, health: 0.4 },
      { type: 'NAPOWR', kind: 'building', x: 14 * 256, y: 10 * 256, owner: 1, health: 0.4 },
    ]);
    expect(snapshots[0]!.effects?.anims).toEqual([]);
    expect(snapshots.at(-1)!.effects?.anims?.map((a) => a.type)).toEqual(['TWLT070']);
    expect(snapshots.at(-1)!.frame - snapshots[2]!.frame).toBe(6);
  });

  it('withholds only the listed buildings during warm-up, then starts a stable appearance at spawn', async () => {
    const snapshots = await bench('?fx=units,bldgs,TWLT070&bldgs=NACNST:0:0&make=1&warm=61&time=0.4');
    expect(snapshots.slice(0, 61).every((s) => s.objects.every((o) => o.type !== 'NACNST'))).toBe(true);
    expect(snapshots[0]!.objects.some((o) => o.type === 'GAPOWR')).toBe(true);
    const spawn = snapshots[61]!;
    const building = spawn.objects.find((o) => o.type === 'NACNST')!;
    expect(spawn.frame - snapshots[0]!.frame).toBe(61);
    expect(building).toMatchObject({ health: 1, owner: 0 });
    expect(snapshots.slice(61).every((s) => s.objects.find((o) => o.type === 'NACNST')?.uid === building.uid)).toBe(
      true,
    );
    expect(spawn.effects?.anims?.map((a) => a.type)).toEqual(['TWLT070']);
  });

  it('preserves the squad preset when building-only options are present', async () => {
    const snapshots = await bench('?fx=squad,TWLT070&health=0.4&make=1&warm=2');
    const first = snapshots[0]!.objects;
    expect(first.some((o) => o.type === 'MTNK')).toBe(true);
    expect(first.some((o) => o.type === 'HTNK')).toBe(true);
    expect(first.filter((o) => o.kind === 'building').map((o) => o.type)).toEqual(['GAPOWR', 'NAREFN']);
    expect(first.every((o) => o.health === 1)).toBe(true);
    expect(snapshots.at(-1)!.objects).toEqual(first);
  });
});

describe('native beam bench snapshots', () => {
  it('spawns all five beam kinds around cx/cy and freezes their mid-life state across time', async () => {
    const snapshots = await bench('?fx=beams&cx=14&cy=16&warm=2&time=0.4');
    expect(snapshots[0]!.effects?.radBeams).toEqual([]);
    const fx = snapshots[2]!.effects!;
    expect(fx.anims).toEqual([]);
    expect(fx.radBeams?.map((b) => b.type)).toEqual(['rad', 'temporal', 'eruption']);
    expect(fx.waves?.map((b) => b.type)).toEqual(['magnetron', 'sonic']);
    expect([...fx.radBeams!, ...fx.waves!].every((b) => b.progress === 0.5)).toBe(true);
    expect(fx.radBeams![0]!.source).toEqual({
      x: Math.round((14 - 1.9 - 2.5) * 256),
      y: Math.round((16 - 1.9 + 2.5) * 256),
      z: 312,
    });
    expect(snapshots.at(-1)!.effects).toEqual(fx);
  });

  it.each([
    ['0', 0],
    ['0.8', 0.8],
    ['1', 1],
    ['3', 1],
    ['-1', 0],
    ['NaN', 0.5],
  ])('accepts and bounds bprogress=%s', async (value, progress) => {
    const snapshots = await bench(`?fx=beams&bprogress=${value}&warm=0`);
    const fx = snapshots.at(-1)!.effects!;
    expect(fx.radBeams![0]!.progress).toBe(progress);
    expect(fx.radBeams![0]!.age).toBe(Number(progress) * 20);
    expect(fx.waves![0]!.intensity).toBe(100 * (1 - Number(progress)));
  });

  it('centres the magnetron and sonic ellipses on their own bench lines, below the three ribbon rows', async () => {
    const snapshots = await bench('?fx=beams&cx=14&cy=16&warm=0');
    const fx = snapshots.at(-1)!.effects!;
    const screenY = ({ x, y, z }: { x: number; y: number; z: number }) => ((x + y) * 15) / 256 - (z * 15) / 104;
    const rows = [...fx.radBeams!, ...fx.waves!];
    rows.forEach((beam, i) => {
      expect(screenY(beam.source)).toBe(screenY(beam.target));
      if (i) expect(screenY(beam.source)).toBeGreaterThan(screenY(rows[i - 1]!.source));
    });
    for (const wave of fx.waves!) {
      const from = engineAnchor(wave.source.x, wave.source.y, wave.source.z);
      const to = engineAnchor(wave.target.x, wave.target.y, wave.target.z);
      for (const ring of waveRings(wave)) {
        const centre = ring
          .slice(0, -1)
          .reduce((sum, p) => sum.add(p), new Vector3())
          .divideScalar(ring.length - 1);
        const t = centre.clone().sub(from).dot(to.clone().sub(from)) / from.distanceToSquared(to);
        expect(centre.distanceTo(from.clone().lerp(to, t))).toBeLessThan(1e-10);
      }
    }
  });
});
