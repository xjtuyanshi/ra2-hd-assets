import { RENDER_STATE_VERSION, type RenderObject, type RenderState, type TerrainClass } from '../src/contract';

/**
 * Procedural stand-in for a real map until a base adapter feeds RenderState: coast, beach, a raised plateau with
 * ramps, roads, a paved base, trees, two forces and a ship. Deterministic so screenshots are comparable across runs.
 */
export function createScenario(width = 56, height = 56): RenderState {
  const cornerHeights = new Float32Array((width + 1) * (height + 1));
  const at = (x: number, y: number) => y * (width + 1) + x;
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      // Coast along the south-west edge with a wobbly shoreline.
      const coast = x * 0.9 + (height - y) * 0.7 + 6 * valueNoise(x * 0.12, y * 0.12) - 22;
      // Plateau in the north-east.
      const plateau = Math.hypot(x - 42, y - 12) < 9 + 3 * valueNoise(x * 0.2 + 5, y * 0.2) ? 5 : 2;
      // Continuous heights near the coast let the waterline contour follow the noise instead of the corner grid.
      cornerHeights[at(x, y)] = coast < 0 ? Math.max(-1.5, coast * 0.25) : coast < 4 ? Math.min(1, coast / 3) : plateau;
    }
  }
  // RA2 slopes rise at most one level per cell edge; leave a few 3-level drops on the plateau as cliffs.
  for (let pass = 0; pass < 6; pass++) {
    for (let y = 0; y <= height; y++) {
      for (let x = 0; x <= width; x++) {
        const cliff = x > 34 && y < 8;
        const limit = cliff ? 3 : 1;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx > width || ny > height) continue;
          const h = cornerHeights[at(x, y)]!;
          const n = cornerHeights[at(nx, ny)]!;
          if (h - n > limit) cornerHeights[at(x, y)] = n + limit;
        }
      }
    }
  }

  const waterLevel = 0.6;
  const terrain: TerrainClass[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const corners = [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)].map((i) => cornerHeights[i]!);
      const avg = corners.reduce((a, b) => a + b, 0) / 4;
      let kind: TerrainClass = 'clear';
      if (avg < waterLevel) kind = 'water';
      else if (avg < 1.35) kind = 'beach';
      else if ((y === 27 || y === 28) && x > 12 && x < 52) kind = 'road';
      else if ((x === 31 || x === 32) && y > 16 && y < 50) kind = 'road';
      else if (x >= 20 && x <= 30 && y >= 30 && y <= 41) kind = 'pavement';
      else if (valueNoise(x * 0.25 + 11, y * 0.25 + 3) > 0.62) kind = 'rough';
      terrain.push(kind);
    }
  }

  const objects: RenderObject[] = [];
  let id = 1;
  const building = (type: string, x: number, y: number, w: number, h: number, house: number) =>
    objects.push({
      id: id++,
      kind: 'building',
      type,
      house,
      x,
      y,
      z: 2,
      facing: 0,
      health: 1,
      footprint: { width: w, height: h },
    });
  building('GACNST', 21, 31, 3, 3, 1);
  building('GAPOWR', 25, 31, 2, 2, 1);
  building('GAPILE', 21, 35, 2, 2, 1);
  building('GAREFN', 25, 35, 3, 3, 1);
  building('GAWEAP', 21, 38, 3, 3, 1);
  for (let i = 0; i < 6; i++) {
    objects.push({
      id: id++,
      kind: 'vehicle',
      type: 'MTNK',
      house: 1,
      x: 34 + (i % 3) * 1.3,
      y: 30 + Math.floor(i / 3) * 1.3,
      z: 2,
      facing: -0.8,
      turretFacing: -0.8,
      health: 1,
    });
  }
  for (let i = 0; i < 5; i++) {
    objects.push({
      id: id++,
      kind: 'vehicle',
      type: 'HTNK',
      house: 2,
      x: 44 + (i % 3) * 1.4,
      y: 21 + Math.floor(i / 3) * 1.4,
      z: 2,
      facing: 2.3,
      turretFacing: 2.3,
      health: 1,
    });
  }
  objects.push({ id: id++, kind: 'ship', type: 'DEST', house: 1, x: 9, y: 46, z: waterLevel, facing: 0.6, health: 1 });
  for (let i = 0; i < 70; i++) {
    const x = 2 + hash(i * 3.1) * (width - 4);
    const y = 2 + hash(i * 7.7) * (height - 4);
    const cell = terrain[Math.floor(y) * width + Math.floor(x)];
    if (cell === 'clear' || cell === 'rough')
      objects.push({ id: id++, kind: 'tree', type: 'TREE', house: -1, x, y, z: 0, facing: hash(i) * 6, health: 1 });
  }

  return {
    version: RENDER_STATE_VERSION,
    tick: 0,
    map: {
      width,
      height,
      theater: 'temperate',
      cornerHeights,
      terrain,
      waterLevel,
      lighting: { ambient: 0.1, level: 0.032, red: 1, green: 1, blue: 1, ground: 0 },
    },
    objects,
    events: [],
    environment: { timeOfDay: 15, weather: 'clear', weatherIntensity: 0.8, windDirection: 0.4, windStrength: 0.35 },
  };
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const r = (i: number, j: number) => hash(i * 57 + j * 131);
  const s = (t: number) => t * t * (3 - 2 * t);
  const top = r(xi, yi) + (r(xi + 1, yi) - r(xi, yi)) * s(xf);
  const bottom = r(xi, yi + 1) + (r(xi + 1, yi + 1) - r(xi, yi + 1)) * s(xf);
  return top + (bottom - top) * s(yf);
}
