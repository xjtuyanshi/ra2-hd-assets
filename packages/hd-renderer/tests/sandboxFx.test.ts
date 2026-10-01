import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveView, type LiveSnapshot } from '../src/live/liveView';

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
        manifest: {
          grid: { width: 64, height: 32 },
          waypoints: [{ x: 10, y: 12 }],
          theater: 'temperate',
          objects: [
            { kind: 'overlay', type: 'TIB01', x: 10, y: 12, z: 0, frame: 1 },
            { kind: 'overlay', type: 'GEM01', x: 11, y: 12, z: 0, frame: 0 },
            { kind: 'overlay', type: 'WALL', x: 10, y: 13, z: 0, frame: 9 },
          ],
        },
        height: new Uint8Array(64 * 32).fill(2),
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/library.json')
        ? {
            ok: true,
            json: async () => ({
              overlays: { TIB01: { tiberium: true }, GEM01: { tiberium: true }, WALL: { tiberium: false } },
            }),
          }
        : { ok: false },
    ),
  );
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

describe('ore bench snapshots', () => {
  it('publishes map overlays through the live library contract only when enabled', async () => {
    expect((await bench('?fx=&warm=0')).at(-1)!.overlays).toBeUndefined();
    const snapshots = await bench('?fx=&ore=1&warm=2');
    const overlays = snapshots.at(-1)!.overlays!;
    expect(overlays.types).toEqual(['TIB01', 'GEM01', 'WALL']);
    expect(overlays.data[12 * 64 + 10]).toBe(1);
    expect(overlays.data[13 * 64 + 10]).toBe(9);
    expect(snapshots.every((s) => s.overlays!.revision === 1)).toBe(true);
    expect(snapshots.at(-1)!.localHouse).toBe(0);
  });

  it('replaces map overlays with the requested growth rows and dense fields', async () => {
    const snapshots = await bench('?fx=&ostages=GEM01,TIB01&ospace=2&ofill=2&warm=0');
    const overlays = snapshots.at(-1)!.overlays!;
    expect(overlays.types).toEqual(['GEM01', 'TIB01']);
    expect(overlays.data[12 * 64 + 32]).toBe(11);
    expect(overlays.index[14 * 64 + 10]).toBe(1);
    expect(overlays.index[13 * 64 + 10]).toBe(-1);
    expect(overlays.data[13 * 64 + 35]).toBe(11);
  });

  it('harvests by logic time, preserves old snapshots, supports advance, and does not deplete on repeated reads', async () => {
    const snapshots = await bench('?fx=&harvest=0,0;0.3,0;0.3,4&hrate=0.6&hspeed=0.5&harvester=HARV&house=6&warm=2');
    const fx = (window as unknown as { __fx: { advance(ms: number): void; snapshot(): LiveSnapshot } }).__fx;
    const initial = snapshots.at(-1)!;
    expect(initial.objects[0]).toMatchObject({ type: 'HARV', owner: 0, x: 2560, y: 3072, facingRaw: 16384 });
    expect(initial.houses[0]).toMatchObject({ colorIndex: 6 });
    fx.advance(600);
    const first = fx.snapshot();
    expect(first.objects[0]).toMatchObject({ facingRaw: 32768 });
    expect(first.overlays!.revision).toBe(2);
    expect(first.overlays!.data[12 * 64 + 10]).toBe(0);
    expect(first.overlays!.index[12 * 64 + 11]).toBe(-1);
    expect(first.overlays!.data[13 * 64 + 10]).toBe(9);
    expect(initial.overlays!.data[12 * 64 + 10]).toBe(1);
    expect(fx.snapshot().overlays).toBe(first.overlays);
    fx.advance(600);
    const second = fx.snapshot();
    expect(second.overlays!.revision).toBe(3);
    expect(second.overlays!.index[12 * 64 + 10]).toBe(-1);
    fx.advance(20_000);
    const end = fx.snapshot();
    expect(end.overlays!.revision).toBe(3);
    expect(end.objects[0]!.x).toBe(Math.round(10.3 * 256));
    expect(end.objects[0]!.y).toBe(16 * 256);
  });
});
