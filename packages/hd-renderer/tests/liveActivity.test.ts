import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import { countCompilations } from '../src/compileCounter';
import { LiveView, type LiveActivity, type LiveObject } from '../src/live/liveView';

describe('shader and pipeline creations counted at the backend', () => {
  it('reports each creation and leaves the calls themselves unchanged', () => {
    const made: string[] = [];
    const backend = {
      label: 'gpu',
      createProgram(this: { label: string }, program: { stage: string }) {
        made.push(`${this.label}:program:${program.stage}`);
        return 'module';
      },
      createRenderPipeline(this: { label: string }, object: string, promises: unknown) {
        made.push(`${this.label}:pipeline:${object}:${promises}`);
      },
      draw: vi.fn(),
    };
    const draw = backend.draw;
    const seen: string[] = [];
    expect(countCompilations(backend, (kind) => seen.push(kind))).toBe(true);
    // Arguments, receiver and return value pass through.
    expect(backend.createProgram({ stage: 'vertex' })).toBe('module');
    backend.createProgram({ stage: 'fragment' });
    backend.createRenderPipeline('mesh', null);
    expect(made).toEqual(['gpu:program:vertex', 'gpu:program:fragment', 'gpu:pipeline:mesh:null']);
    expect(seen).toEqual(['shader', 'shader', 'pipeline']);
    // Nothing else of the backend is touched: a frame that builds nothing calls nothing of this.
    expect(backend.draw).toBe(draw);
  });

  it('counts what it can and says so when a backend has neither call', () => {
    const seen: string[] = [];
    const partial = { createRenderPipeline: vi.fn() };
    expect(countCompilations(partial, (kind) => seen.push(kind))).toBe(true);
    partial.createRenderPipeline();
    expect(seen).toEqual(['pipeline']);
    expect(countCompilations({}, () => undefined)).toBe(false);
    expect(countCompilations(null, () => undefined)).toBe(false);
    expect(countCompilations({ createProgram: 'not a function' }, () => undefined)).toBe(false);
  });
});

const object = (uid: number, kind: LiveObject['kind'], type: string): LiveObject => ({
  id: uid,
  uid,
  kind,
  type,
  owner: 0,
  x: 0,
  y: 0,
  z: 0,
  facingRaw: 0,
  health: 1,
  isSelected: false,
});

/** A view that has just rendered the frame whose clock is 5000. */
function view(compiled: { at: number; shaders: number; pipelines: number } | null) {
  const objects = [
    object(1, 'building', 'NACNST'),
    object(2, 'building', 'NAREFN'),
    object(3, 'vehicle', 'HARV'),
    object(4, 'infantry', 'E2'),
    object(5, 'infantry', 'E2'),
    object(6, 'infantry', 'DOG'),
  ];
  const visual = (type: string, builtAt: number) => ({ type, root: new Group(), mode: 'library-sprite', builtAt });
  const visuals = new Map([
    [1, visual('NACNST', 1000)],
    // Built in the frame rendered last: a refinery, its free miner (drawn with the image the engine chose).
    [2, visual('NAREFN', 5000)],
    [3, visual('HORV', 5000)],
    // A second conscript is no new kind, a first dog is.
    [4, visual('CONS', 2000)],
    [5, visual('CONS', 5000)],
    [6, visual('DOG', 5000)],
    // Gone from the match (a destroyed building kept for a frame): not counted.
    [9, visual('NAPOWR', 5000)],
  ]);
  const state = {
    lastRender: 5000,
    visuals,
    current: { byUid: new Map(objects.map((o) => [o.uid, o])) },
    compiled,
    pageUploads: { pending: 2 },
    voxelUnits: { loading: 1 },
    library: { loading: 3 },
    effectArt: { loading: 0 },
    waitingArt: 0,
    cache: { voxels: new Map() },
    effectDriver: { logicFps: 20.37 },
  };
  return Object.assign(Object.create(LiveView.prototype), state) as unknown as {
    activity(): LiveActivity;
  } & typeof state;
}

describe('what the view was busy with in its last frame', () => {
  it('reports work in progress and what that frame started: shaders, pipelines and kinds of object seen first', () => {
    const v = view({ at: 5000, shaders: 6, pipelines: 3 });
    expect(v.activity()).toEqual({
      pageUploads: 2,
      voxelMeshes: 1,
      // Three library files and one mesh.
      loadingArt: 4,
      shaders: 6,
      pipelines: 3,
      newKinds: ['building:NAREFN', 'vehicle:HORV', 'infantry:DOG'],
      logicFps: 20.4,
    });
  });

  it('counts nothing for a frame that built nothing, although an earlier one did', () => {
    const v = view({ at: 4000, shaders: 6, pipelines: 3 });
    v.lastRender = 6000;
    expect(v.activity()).toMatchObject({ shaders: 0, pipelines: 0, newKinds: [] });
  });

  it('says that creations cannot be counted on a backend without the two calls', () => {
    expect(view(null).activity()).toMatchObject({ shaders: null, pipelines: null });
  });

  it('names at most eight new kinds (a match start brings dozens in one frame)', () => {
    const v = view(null);
    v.visuals.clear();
    v.current.byUid.clear();
    for (let uid = 1; uid <= 30; uid++) {
      v.current.byUid.set(uid, object(uid, 'building', `B${uid}`));
      v.visuals.set(uid, { type: `B${uid}`, root: new Group(), mode: 'library-sprite', builtAt: 5000 });
    }
    expect(v.activity().newKinds).toHaveLength(8);
  });
});
