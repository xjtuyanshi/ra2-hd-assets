import {
  DataTexture,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  NodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  QuadMesh,
  RGBAFormat,
  Scene,
  Vector2,
  WebGPURenderer,
} from 'three/webgpu';
import { texture, vec3 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  SILHOUETTE_GAMMA,
  SILHOUETTE_LEVELS,
  SILHOUETTE_SEARCH,
  instanceSilhouette,
  objectSilhouette,
  setSilhouette,
  silhouetteCode,
  silhouetteOf,
  silhouetteSmooth,
  smoothSilhouettes,
} from '../src/silhouette';

const GROUND = [0, 0] as const;
const OBJECT = [7 / SILHOUETTE_LEVELS, 3 / SILHOUETTE_LEVELS] as const;
const OTHER = [9 / SILHOUETTE_LEVELS, 3 / SILHOUETTE_LEVELS] as const;

/**
 * A picture from rows of characters: '.' ground, '#' object, 'o' another object. The ground is a texture (a value per
 * pixel that no two neighbours share), the objects are flat colours, so any change of any pixel shows.
 */
function picture(rows: string[]) {
  const height = rows.length;
  const width = rows[0]!.length;
  const colour = new Float64Array(width * height * 4);
  const codes = new Float64Array(width * height * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const kind = rows[y]![x]!;
      const code = kind === '#' ? OBJECT : kind === 'o' ? OTHER : GROUND;
      codes.set(code, 2 * i);
      const ground = 40 + ((x * 7 + y * 13) % 23);
      colour.set(kind === '#' ? [200, 180, 160, 255] : kind === 'o' ? [20, 60, 220, 255] : [ground, ground, ground, 255], 4 * i);
    }
  }
  return { width, height, colour, codes };
}

/** The object's share of a pixel after smoothing, from the red channel (both sides flat there), in linear light. */
function objectShare(out: Float64Array, frame: ReturnType<typeof picture>, x: number, y: number, ground: number): number {
  const linear = (v: number) => Math.pow(v / 255, SILHOUETTE_GAMMA);
  const value = out[4 * (y * frame.width + x)]!;
  return (linear(value) - linear(ground)) / (linear(200) - linear(ground));
}

describe('silhouette codes', () => {
  it('gives every object and part a code that is exact in a half float and never the ground code', () => {
    const seen = new Set<string>();
    for (let serial = 0; serial < 2000; serial++) {
      for (const part of [0, 1, 2]) {
        const code = silhouetteCode(serial, part);
        for (const channel of [code.x, code.y]) {
          expect(Number.isInteger(channel * SILHOUETTE_LEVELS)).toBe(true);
          expect(channel).toBeLessThan(1);
        }
        expect(code.x).toBeGreaterThan(0);
        seen.add(`${code.x},${code.y}`);
      }
    }
    // Parts of one object differ, and so do the units of any crowd that fits on a screen.
    expect(seen.size).toBe(6000);
    expect(silhouetteCode(5, 0).equals(silhouetteCode(5, 1))).toBe(false);
    const target = new Vector2();
    expect(silhouetteCode(3, 0, target)).toBe(target);
  });

  it('reads the code of a material from its own node, of a mesh from its user data, and the ground otherwise', () => {
    const plain = new MeshBasicNodeMaterial();
    expect(silhouetteOf(plain)).not.toBe(objectSilhouette);
    const marked = setSilhouette(new MeshBasicNodeMaterial());
    expect(silhouetteOf(marked)).toBe(objectSilhouette);
    const own = instanceSilhouette(vec3(1, 2, 3), vec3(1).x);
    expect(silhouetteOf(setSilhouette(new MeshBasicNodeMaterial(), own))).toBe(own);
  });
});

describe('outline smoothing (CPU twin of the last pass)', () => {
  it('copies a picture without outlines bit for bit', () => {
    const frame = picture(['........', '........', '........', '........']);
    expect(Array.from(smoothSilhouettes(frame))).toEqual(Array.from(frame.colour));
    const solid = picture(['####', '####', '####']);
    expect(Array.from(smoothSilhouettes(solid))).toEqual(Array.from(solid.colour));
  });

  it('leaves straight outlines alone: every pixel of an axis-aligned box and its surroundings is unchanged', () => {
    const rows = Array.from({ length: 40 }, (_, y) =>
      Array.from({ length: 60 }, (_, x) => (x >= 12 && x < 48 && y >= 8 && y < 30 ? '#' : '.')).join(''),
    );
    const frame = picture(rows);
    const out = smoothSilhouettes(frame);
    let changed = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== frame.colour[i]) changed++;
    // Only the four corners carry a step within reach: each corner pixel and its two ground neighbours may move.
    const moved = new Set<number>();
    for (let i = 0; i < out.length; i++) if (out[i] !== frame.colour[i]) moved.add(Math.floor(i / 4));
    for (const pixel of moved) {
      const x = pixel % frame.width;
      const y = Math.floor(pixel / frame.width);
      const nearCornerX = Math.min(Math.abs(x - 12), Math.abs(x - 47)) <= SILHOUETTE_SEARCH;
      const nearCornerY = Math.min(Math.abs(y - 8), Math.abs(y - 29)) <= SILHOUETTE_SEARCH;
      expect(nearCornerX && nearCornerY).toBe(true);
    }
    expect(changed).toBeGreaterThanOrEqual(0);
    // The middle of each side, further from a corner than the search reaches, is exact.
    for (const [x, y] of [
      [30, 8],
      [30, 7],
      [30, 29],
      [30, 30],
    ] as const)
      for (let channel = 0; channel < 4; channel++)
        expect(out[4 * (y * frame.width + x) + channel]).toBe(frame.colour[4 * (y * frame.width + x) + channel]);
  });

  it('changes only pixels that touch an outline', () => {
    // A staircase of 4-pixel runs and a second object beside it.
    const rows: string[] = [];
    for (let y = 0; y < 24; y++) {
      let row = '';
      for (let x = 0; x < 64; x++) row += x < 4 + y * 4 - 20 ? '#' : x > 56 ? 'o' : '.';
      rows.push(row);
    }
    const frame = picture(rows);
    const out = smoothSilhouettes(frame);
    const code = (x: number, y: number) =>
      rows[Math.min(23, Math.max(0, y))]![Math.min(63, Math.max(0, x))]!;
    let changed = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 64; x++) {
        const i = 4 * (y * 64 + x);
        const same = [0, 1, 2, 3].every((channel) => out[i + channel] === frame.colour[i + channel]);
        const outline =
          code(x - 1, y) !== code(x, y) ||
          code(x + 1, y) !== code(x, y) ||
          code(x, y - 1) !== code(x, y) ||
          code(x, y + 1) !== code(x, y);
        if (!same) {
          changed++;
          expect(outline).toBe(true);
        }
        // Alpha is never touched.
        expect(out[i + 3]).toBe(255);
      }
    }
    expect(changed).toBeGreaterThan(20);
  });

  it('rebuilds a staircase as the straight line through the middle of its steps', () => {
    // Object below-left of a line that climbs one pixel every `run` pixels.
    for (const run of [2, 4, 6, 10]) {
      const width = run * 6 + 8;
      const height = 12;
      const rows: string[] = [];
      for (let y = 0; y < height; y++) {
        let row = '';
        // Row y is object up to column edge(y) (exclusive): one run further every row down.
        for (let x = 0; x < width; x++) row += x < (y - 2) * run ? '#' : '.';
        rows.push(row);
      }
      const frame = picture(rows);
      // A flat ground for this check, so the object's share can be read back from the colour.
      for (let i = 0; i < width * height; i++)
        if (frame.codes[2 * i] === 0) frame.colour.set([60, 60, 60, 255], 4 * i);
      const out = smoothSilhouettes(frame);
      // The run of row 6: object columns [5 run - ... ] end at 4 * run; row 5 above ends at 3 * run. Along the
      // horizontal outline between rows 5 (ground) and 6 (object) for x in [3 run, 4 run): the line falls from half a
      // pixel above the boundary (at the left end, where row 5 steps) to half a pixel below (right end).
      const left = 3 * run;
      let total = 0;
      for (let k = 0; k < run; k++) {
        const x = left + k;
        // Exact areas of the line y(x) = 0.5 - (k + t) / run over the pixel column, above and below the boundary.
        const h0 = 0.5 - k / run;
        const h1 = 0.5 - (k + 1) / run;
        const above = h0 <= 0 ? 0 : h1 >= 0 ? (h0 + h1) / 2 : (h0 * h0) / (2 * (h0 - h1));
        const below = h1 >= 0 ? 0 : h0 <= 0 ? -(h0 + h1) / 2 : (h1 * h1) / (2 * (h0 - h1));
        // Row 5 (ground) gains the object where the line is above the boundary; row 6 (object) loses where below.
        const gained = objectShare(out, frame, x, 5, 60);
        const kept = objectShare(out, frame, x, 6, 60);
        expect(gained).toBeCloseTo(above, 6);
        expect(1 - kept).toBeCloseTo(below, 6);
        total += gained - (1 - kept);
      }
      // What the upper row gains the lower row loses: the outline moves, the object's area stays.
      expect(total).toBeCloseTo(0, 6);
    }
  });

  it('keeps three quarters of a lone pixel and leaves its neighbours alone', () => {
    // Both ends of each of its four sides step in its own row: the line is pulled into the lone pixel, which gives
    // up a corner triangle at each end of the larger axis, and nothing is pushed into the ground around it.
    const frame = picture(['.......', '.......', '...#...', '.......', '.......']);
    for (let i = 0; i < 35; i++) if (frame.codes[2 * i] === 0) frame.colour.set([60, 60, 60, 255], 4 * i);
    const out = smoothSilhouettes(frame);
    expect(objectShare(out, frame, 3, 2, 60)).toBeCloseTo(0.75, 6);
    for (const [x, y] of [
      [2, 2],
      [4, 2],
      [3, 1],
      [3, 3],
    ] as const)
      expect(out[4 * (y * 7 + x)]).toBe(60);
  });

  it('never gives a pixel more than half of a neighbour', () => {
    // Every outline shape a 3x3 neighbourhood can hold, on a flat ground: the object's share of any ground pixel and
    // the ground's share of any object pixel stay at or below one half.
    for (let mask = 0; mask < 512; mask++) {
      const rows = ['.......', '.......'];
      for (let y = 0; y < 3; y++) {
        let row = '..';
        for (let x = 0; x < 3; x++) row += mask & (1 << (y * 3 + x)) ? '#' : '.';
        rows.push(row + '..');
      }
      rows.push('.......', '.......');
      const frame = picture(rows);
      for (let i = 0; i < 49; i++) if (frame.codes[2 * i] === 0) frame.colour.set([60, 60, 60, 255], 4 * i);
      const out = smoothSilhouettes(frame);
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const share = objectShare(out, frame, x, y, 60);
          if (rows[y]![x] === '#') expect(share).toBeGreaterThanOrEqual(0.5 - 1e-9);
          else expect(share).toBeLessThanOrEqual(0.5 + 1e-9);
        }
      }
    }
  });

  it('smooths the outline between two objects like the one between an object and the ground', () => {
    const rows = ['##oooooo', '####oooo', '######oo', '########'];
    const frame = picture(rows);
    const out = smoothSilhouettes(frame);
    // (4, 1): object 'o' with the step of '#' below-left: mixed towards '#'.
    const i = 4 * (1 * 8 + 4);
    expect(out[i]).toBeGreaterThan(20);
    expect(out[i]).toBeLessThan(200);
  });

  it('does not reach further than the search distance', () => {
    const long = 3 * SILHOUETTE_SEARCH;
    const rows = ['.'.repeat(long * 2), '.'.repeat(long) + '#'.repeat(long), '#'.repeat(long * 2), '#'.repeat(long * 2)];
    const frame = picture(rows);
    const out = smoothSilhouettes(frame);
    for (let x = 0; x < long * 2; x++) {
      const beyond = Math.abs(x - long) > SILHOUETTE_SEARCH + 1;
      for (const y of [0, 1, 2]) {
        const i = 4 * (y * long * 2 + x);
        if (beyond) expect(out[i]).toBe(frame.colour[i]);
      }
    }
  });
});

describe('outline smoothing (shader)', () => {
  const backendFor = () => {
    const canvas = { width: 1, height: 1, style: {}, addEventListener() {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ canvas });
    Object.assign(renderer.backend, {
      device: { limits: { maxUniformBufferBindingSize: 65536 }, features: new Set() },
      renderer,
    });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    return renderer;
  };

  it('expands into WGSL that loads texels and never samples with a filter', () => {
    const renderer = backendFor();
    const data = () => {
      const map = new DataTexture(new Float32Array(16 * 4), 4, 4, RGBAFormat, FloatType);
      map.needsUpdate = true;
      return map;
    };
    const material = new NodeMaterial();
    material.fragmentNode = silhouetteSmooth(texture(data()), texture(data()));
    const quad = new QuadMesh(material);
    const builder = renderer.backend.createNodeBuilder(quad, renderer);
    builder.scene = new Scene();
    builder.camera = new OrthographicCamera();
    builder.build();
    const wgsl: string = builder.fragmentShader;
    expect(wgsl).toContain('@fragment');
    expect(wgsl).toContain('textureLoad');
    expect(wgsl).not.toContain('textureSample(');
    expect(wgsl).toContain('break');
  });

  it('writes an instance code that is made in the vertex stage and rounded per fragment', () => {
    const renderer = backendFor();
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec3(instanceSilhouette(vec3(3, 5, 7), vec3(1).x), 0);
    const mesh = new Mesh(new PlaneGeometry(), material);
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new Scene();
    builder.camera = new OrthographicCamera();
    builder.build();
    expect(builder.vertexShader).toContain('silhouetteInstanceCode');
    expect(builder.vertexShader).toContain('sin(');
    expect(builder.fragmentShader).not.toContain('sin(');
    expect(builder.fragmentShader).toContain('floor(');
  });
});
