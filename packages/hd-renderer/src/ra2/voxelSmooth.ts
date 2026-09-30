import type { VoxelSection } from '../../../ra2-assets/src/manifest';
import { sectionNormalsMode } from '../../../ra2-assets/src/voxelNormals';
import { lookupNormal, normalTableFor } from '../../../ra2-formats/src/vxl/vxlNormals';
import { VOXEL_TO_WORLD } from './voxelScale';

export interface SmoothVoxelOptions {
  supersample: number;
  shape: 'occupancy' | 'imls';
  smoothSigma: number;
  imlsRadius: number;
  bandIn: number;
  bandOut: number;
  storedNormals: number;
  aoRays: number;
  aoLength: number;
  groundOcclusion: boolean;
}

export const DEFAULT_SMOOTH_VOXEL: Readonly<SmoothVoxelOptions> = Object.freeze({
  supersample: 3,
  shape: 'imls',
  smoothSigma: 0.55,
  imlsRadius: 1.1,
  bandIn: 0.3,
  bandOut: 0.3,
  storedNormals: 0.35,
  aoRays: 48,
  aoLength: 10,
  groundOcclusion: true,
});

/** GPU-independent output. Each consecutive group of four vertices is one palette-constant quad. */
export interface SmoothMeshData {
  position: Float32Array;
  normal: Float32Array;
  pindex: Float32Array;
  occlusion: Float32Array;
  curvature: Float32Array;
  vpos: Float32Array;
  indices: Uint16Array | Uint32Array;
}

/** Validate before allocating: malformed review parameters must not silently select another geometry variant. */
export function smoothVoxelOptions(options: Partial<SmoothVoxelOptions> = {}): Readonly<SmoothVoxelOptions> {
  const result = { ...DEFAULT_SMOOTH_VOXEL, ...options };
  for (const name of [
    'supersample',
    'smoothSigma',
    'imlsRadius',
    'bandIn',
    'bandOut',
    'storedNormals',
    'aoRays',
    'aoLength',
  ] as const) {
    if (!Number.isFinite(result[name]) || result[name] < 0) throw new RangeError(`Invalid smooth voxel ${name}`);
  }
  if (
    !Number.isInteger(result.supersample) ||
    // An aligned lattice needs an interior sample to preserve a one-voxel cross-section.
    result.supersample < 2 ||
    result.supersample > 8 ||
    !Number.isInteger(result.aoRays) ||
    result.aoRays > 256 ||
    result.storedNormals > 1 ||
    result.imlsRadius <= 0 ||
    result.imlsRadius > 4 ||
    result.smoothSigma > 4 ||
    result.bandIn >= 0.5 ||
    result.bandOut > 1 ||
    result.aoLength > 256 ||
    (result.shape !== 'imls' && result.shape !== 'occupancy') ||
    typeof result.groundOcclusion !== 'boolean'
  )
    throw new RangeError('Invalid smooth voxel options');
  return Object.freeze(result);
}

const BORDER = 3;
// Exactly representable in Float32: a rounded sentinel would defeat the empty-line fast path in the EDT.
const FAR = 2 ** 30;
const EDGES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7]);

/** Felzenszwalb-Huttenlocher lower envelopes of squared parabolas, separable and exact on the lattice. */
function edt(data: Float32Array, nx: number, ny: number, nz: number): void {
  const length = Math.max(nx, ny, nz);
  const input = new Float64Array(length);
  const sites = new Int32Array(length);
  const cuts = new Float64Array(length + 1);
  const line = (base: number, stride: number, n: number) => {
    let count = -1;
    for (let q = 0; q < n; q++) {
      const value = data[base + q * stride]!;
      input[q] = value;
      if (value >= FAR) continue;
      let cut = -Infinity;
      while (count >= 0) {
        const p = sites[count]!;
        cut = (value + q * q - input[p]! - p * p) / (2 * (q - p));
        if (cut > cuts[count]!) break;
        count--;
      }
      sites[++count] = q;
      cuts[count] = count === 0 ? -Infinity : cut;
      cuts[count + 1] = Infinity;
    }
    if (count < 0) return;
    let k = 0;
    for (let q = 0; q < n; q++) {
      while (cuts[k + 1]! < q) k++;
      const p = sites[k]!;
      data[base + q * stride] = (q - p) * (q - p) + input[p]!;
    }
  };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) line(z * nx * ny + y * nx, 1, nx);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) line(z * nx * ny + x, nx, ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) line(y * nx + x, nx * ny, nz);
}

/** Sliding-window dilation selects only the intermediate halo required by a subsequent convolution pass. */
function blurSupport(mask: Uint8Array, n: number, stride: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let base = 0; base < mask.length; base += stride * n) {
    for (let inner = 0; inner < stride; inner++) {
      let sum = 0;
      for (let q = 0; q <= Math.min(radius, n - 1); q++) sum += mask[base + inner + q * stride]!;
      for (let q = 0; q < n; q++) {
        out[base + inner + q * stride] = sum > 0 ? 1 : 0;
        if (q - radius >= 0) sum -= mask[base + inner + (q - radius) * stride]!;
        if (q + radius + 1 < n) sum += mask[base + inner + (q + radius + 1) * stride]!;
      }
    }
  }
  return out;
}

function gaussian(
  data: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  sigma: number,
  band: Uint8Array,
): Float32Array {
  if (sigma === 0) return data.slice();
  const radius = Math.ceil(3 * sigma);
  const kernel = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) total += kernel[i + radius] = Math.exp(-0.5 * (i / sigma) ** 2);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  let src = data;
  let dst = new Float32Array(data.length);
  const first = dst;
  const second = new Float32Array(data.length);
  const sizes = [nx, ny, nz];
  const strides = [1, nx, nx * ny];
  const ySupport = blurSupport(band, nz, nx * ny, radius);
  const support = [blurSupport(ySupport, ny, nx, radius), ySupport, band];
  for (let axis = 0; axis < 3; axis++) {
    const stride = strides[axis]!;
    const n = sizes[axis]!;
    for (let base = 0; base < data.length; base += stride * n) {
      for (let inner = 0; inner < stride; inner++) {
        for (let q = 0; q < n; q++) {
          if (!support[axis]![base + inner + q * stride]) continue;
          let value = 0;
          for (let j = -radius; j <= radius; j++) {
            value += src[base + inner + Math.max(0, Math.min(n - 1, q + j)) * stride]! * kernel[j + radius]!;
          }
          dst[base + inner + q * stride] = value;
        }
      }
    }
    src = dst;
    dst = dst === first ? second : first;
  }
  return src;
}

/**
 * Pure meshing entry: only data and arithmetic, no renderer, DOM, caches of model data, or GPU ownership.
 * An aligned boundary lattice makes the EDT exact for the union of cubes, including corners: a nearest point on
 * an exposed face is itself on this lattice. One boundary EDT supplies BOTH the inside and outside distances;
 * their signs come from occupancy. Binary centre-to-centre EDTs with a half-sample subtraction are not exact at
 * corners. The three-voxel empty border closes every part independently.
 */
export function buildSmoothSection(section: VoxelSection, options: SmoothVoxelOptions): SmoothMeshData {
  const o = smoothVoxelOptions(options);
  const encoded = atob(section.voxels);
  const raw = new Uint8Array(encoded.length);
  for (let i = 0; i < raw.length; i++) raw[i] = encoded.charCodeAt(i);
  const [sx, sy, sz] = section.size;
  const s = o.supersample;
  const nx = (sx + 2 * BORDER) * s + 1;
  const ny = (sy + 2 * BORDER) * s + 1;
  const nz = (sz + 2 * BORDER) * s + 1;
  const xy = nx * ny;
  const count = xy * nz;
  const gx = sx + 2;
  const gxy = gx * (sy + 2);
  const cells = new Int32Array(gxy * (sz + 2));
  const filled = (x: number, y: number, z: number): number =>
    x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz ? cells[x + 1 + gx * (y + 1) + gxy * (z + 1)]! : 0;
  for (let i = 0; i < raw.length; i += 5) cells[raw[i]! + 1 + gx * (raw[i + 1]! + 1) + gxy * (raw[i + 2]! + 1)] = i + 1;
  const distance = new Float32Array(count).fill(FAR);
  const inside = new Uint8Array(count);
  const exposed = new Uint8Array(raw.length / 5);
  const faceOffsets = [1, -1, gx, -gx, gxy, -gxy];
  const strides = [1, nx, xy];
  for (let i = 0; i < raw.length; i += 5) {
    const x = raw[i]!;
    const y = raw[i + 1]!;
    const z = raw[i + 2]!;
    const base = (x + BORDER) * s + (y + BORDER) * s * nx + (z + BORDER) * s * xy;
    const k = x + 1 + gx * (y + 1) + gxy * (z + 1);
    for (let dz = 0; dz < s; dz++)
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) inside[base + dx + dy * nx + dz * xy] = 1;
    for (let face = 0; face < 6; face++) {
      if (cells[k + faceOffsets[face]!]) continue;
      exposed[i / 5] = 1;
      const axis = face >> 1;
      const start = base + (face % 2 === 0 ? s * strides[axis]! : 0);
      const u = strides[(axis + 1) % 3]!;
      const v = strides[(axis + 2) % 3]!;
      for (let b = 0; b <= s; b++) for (let a = 0; a <= s; a++) distance[start + a * u + b * v] = 0;
    }
  }
  edt(distance, nx, ny, nz);
  const band = Math.max(o.bandIn, o.bandOut) + 1.5 / s;
  const active = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    distance[i] = (Math.sqrt(distance[i]!) / s) * (inside[i] ? -1 : 1);
    active[i] = Math.abs(distance[i]!) < band ? 1 : 0;
  }
  const table = normalTableFor(sectionNormalsMode(section, raw));
  let field: Float32Array;
  if (o.shape === 'occupancy') field = gaussian(distance, nx, ny, nz, o.smoothSigma * s, active);
  else {
    // IMLS uses artist normals to recover intended planes rather than smoothing the voxel stair steps alone.
    // Splat precomputed normal-specific kernels: equivalent to querying a spatial hash within 3h, but no exp(),
    // neighbour allocations, or repeated normal lookups in the per-sample loop. Only the surface band accumulates.
    field = new Float32Array(count);
    const weight = new Float32Array(count);
    const kernels = new Map<
      number,
      { offsets: Int32Array; weight: Float32Array; value: Float32Array; xyz: Int16Array }
    >();
    for (let i = 0; i < raw.length; i += 5) {
      if (!exposed[i / 5]) continue;
      const normalIndex = raw[i + 4]!;
      let kernel = kernels.get(normalIndex);
      if (!kernel) {
        const n = lookupNormal(table, normalIndex);
        const q = n.map((c) => 0.5 + 0.5 * c);
        const radius = 3 * o.imlsRadius;
        const offsets: number[] = [];
        const weights: number[] = [];
        const values: number[] = [];
        const coords: number[] = [];
        for (let z = Math.ceil((q[2]! - radius) * s); z <= Math.floor((q[2]! + radius) * s); z++) {
          for (let y = Math.ceil((q[1]! - radius) * s); y <= Math.floor((q[1]! + radius) * s); y++) {
            for (let x = Math.ceil((q[0]! - radius) * s); x <= Math.floor((q[0]! + radius) * s); x++) {
              const dx = x / s - q[0]!;
              const dy = y / s - q[1]!;
              const dz = z / s - q[2]!;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > radius * radius) continue;
              const w = Math.exp(-d2 / (o.imlsRadius * o.imlsRadius));
              offsets.push(x + y * nx + z * xy);
              coords.push(x, y, z);
              weights.push(w);
              values.push(w * (n[0] * dx + n[1] * dy + n[2] * dz));
            }
          }
        }
        kernel = {
          offsets: Int32Array.from(offsets),
          weight: Float32Array.from(weights),
          value: Float32Array.from(values),
          xyz: Int16Array.from(coords),
        };
        kernels.set(normalIndex, kernel);
      }
      const bx = (raw[i]! + BORDER) * s;
      const by = (raw[i + 1]! + BORDER) * s;
      const bz = (raw[i + 2]! + BORDER) * s;
      const base = bx + by * nx + bz * xy;
      const reach = Math.ceil((3 * o.imlsRadius + 1) * s);
      const safe = bx >= reach && by >= reach && bz >= reach && bx + reach < nx && by + reach < ny && bz + reach < nz;
      for (let j = 0; j < kernel.offsets.length; j++) {
        const k = base + kernel.offsets[j]!;
        if (!active[k]) continue;
        // Wide review radii may reach past the fixed border: prevent row wrapping in the flattened grid.
        if (!safe) {
          const x = bx + kernel.xyz[j * 3]!;
          const y = by + kernel.xyz[j * 3 + 1]!;
          const z = bz + kernel.xyz[j * 3 + 2]!;
          if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue;
        }
        field[k] += kernel.value[j]!;
        weight[k] += kernel.weight[j]!;
      }
    }
    for (let i = 0; i < count; i++) field[i] = weight[i]! > 1e-8 ? field[i]! / weight[i]! : distance[i]!;
  }
  // The band constrains displacement, not merely smoothing strength: even one-voxel rods retain a negative core.
  for (let i = 0; i < count; i++)
    field[i] = active[i]
      ? Math.min(Math.max(field[i]!, distance[i]! - o.bandOut), distance[i]! + o.bandIn)
      : distance[i]!;

  const corner = new Int32Array([0, 1, nx, nx + 1, xy, xy + 1, xy + nx, xy + nx + 1]);
  const vertexAt = new Int32Array(count).fill(-1);
  // An upper bound is cheap compared with growing JS arrays; compact only after the surface walk.
  let capacity = 0;
  for (let i = 0; i < count; i++) if (active[i]) capacity++;
  const vp = new Float32Array(capacity * 3);
  const netCells = new Int32Array(capacity);
  let vertices = 0;
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        const k = x + y * nx + z * xy;
        let mask = 0;
        for (let c = 0; c < 8; c++) if (field[k + corner[c]!]! < 0) mask |= 1 << c;
        if (!mask || mask === 255) continue;
        let ax = 0;
        let ay = 0;
        let az = 0;
        let crossings = 0;
        for (let e = 0; e < EDGES.length; e += 2) {
          const a = EDGES[e]!;
          const b = EDGES[e + 1]!;
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
          const fa = field[k + corner[a]!]!;
          const fb = field[k + corner[b]!]!;
          const t = fa / (fa - fb);
          ax += (a & 1) + ((b & 1) - (a & 1)) * t;
          ay += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          az += (a >> 2) + ((b >> 2) - (a >> 2)) * t;
          crossings++;
        }
        vertexAt[k] = vertices;
        netCells[vertices] = k;
        vp[vertices * 3] = (x + ax / crossings) / s - BORDER;
        vp[vertices * 3 + 1] = (y + ay / crossings) / s - BORDER;
        vp[vertices * 3 + 2] = (z + az / crossings) / s - BORDER;
        vertices++;
      }
  const sample = (x: number, y: number, z: number): number => {
    const fx = Math.max(0, Math.min(nx - 1.000001, (x + BORDER) * s));
    const fy = Math.max(0, Math.min(ny - 1.000001, (y + BORDER) * s));
    const fz = Math.max(0, Math.min(nz - 1.000001, (z + BORDER) * s));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const ty = fy - iy;
    const tz = fz - iz;
    const k = ix + iy * nx + iz * xy;
    const a = field[k]! * (1 - tx) + field[k + 1]! * tx;
    const b = field[k + nx]! * (1 - tx) + field[k + nx + 1]! * tx;
    const c = field[k + xy]! * (1 - tx) + field[k + xy + 1]! * tx;
    const d = field[k + xy + nx]! * (1 - tx) + field[k + xy + nx + 1]! * tx;
    return (a * (1 - ty) + b * ty) * (1 - tz) + (c * (1 - ty) + d * ty) * tz;
  };
  const nearest = (x: number, y: number, z: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    let best = -1;
    let bestD = Infinity;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = filled(ix + dx, iy + dy, iz + dz) - 1;
          if (j < 0) continue;
          const a = ix + dx + 0.5 - x;
          const b = iy + dy + 0.5 - y;
          const c = iz + dz + 0.5 - z;
          const d = a * a + b * b + c * c;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
    return best;
  };
  const modelP = new Float32Array(vertices * 3);
  const modelN = new Float32Array(vertices * 3);
  const ao = new Float32Array(vertices);
  const curvature = new Float32Array(vertices);
  const m = section.transform;
  const stepX = (section.maxBounds[0] - section.minBounds[0]) / Math.max(1, sx);
  const stepY = (section.maxBounds[1] - section.minBounds[1]) / Math.max(1, sy);
  const stepZ = (section.maxBounds[2] - section.minBounds[2]) / Math.max(1, sz);
  const groundX = m[8]! * stepX;
  const groundY = m[9]! * stepY;
  const groundZ = m[10]! * stepZ;
  const groundOffset =
    m[8]! * section.minBounds[0] + m[9]! * section.minBounds[1] + m[10]! * section.minBounds[2] + m[11]!;
  const rays = new Float32Array(o.aoRays * 3);
  for (let r = 0; r < o.aoRays; r++) {
    const u = (r + 0.5) / o.aoRays;
    const phi = r * Math.PI * (3 - Math.sqrt(5));
    rays[r * 3] = Math.sqrt(u) * Math.cos(phi);
    rays[r * 3 + 1] = Math.sqrt(u) * Math.sin(phi);
    rays[r * 3 + 2] = Math.sqrt(1 - u);
  }
  for (let v = 0; v < vertices; v++) {
    const p = v * 3;
    const x = vp[p]!;
    const y = vp[p + 1]!;
    const z = vp[p + 2]!;
    const e = 1 / s;
    const xp = sample(x + e, y, z);
    const xm = sample(x - e, y, z);
    const yp = sample(x, y + e, z);
    const ym = sample(x, y - e, z);
    const zp = sample(x, y, z + e);
    const zm = sample(x, y, z - e);
    let a = xp - xm;
    let b = yp - ym;
    let c = zp - zm;
    let len = Math.hypot(a, b, c) || 1;
    a /= len;
    b /= len;
    c /= len;
    const j = nearest(x, y, z);
    const stored = lookupNormal(table, j < 0 ? 0 : raw[j + 4]!);
    a = a * (1 - o.storedNormals) + stored[0] * o.storedNormals;
    b = b * (1 - o.storedNormals) + stored[1] * o.storedNormals;
    c = c * (1 - o.storedNormals) + stored[2] * o.storedNormals;
    len = Math.hypot(a, b, c);
    // Opposing field/artist normals can cancel at an exact 0.5 blend. Keep a unit fallback in that singular case.
    if (len < 1e-10) {
      a = stored[0];
      b = stored[1];
      c = stored[2];
      len = Math.hypot(a, b, c) || 1;
    }
    a /= len;
    b /= len;
    c /= len;
    curvature[v] = Math.max(-4, Math.min(4, (xp + xm + yp + ym + zp + zm - 6 * sample(x, y, z)) * s * s));
    const bx = section.minBounds[0] + x * stepX;
    const by = section.minBounds[1] + y * stepY;
    const bz = section.minBounds[2] + z * stepZ;
    modelP[p] = (m[0]! * bx + m[1]! * by + m[2]! * bz + m[3]!) * VOXEL_TO_WORLD;
    modelP[p + 1] = (m[8]! * bx + m[9]! * by + m[10]! * bz + m[11]!) * VOXEL_TO_WORLD;
    modelP[p + 2] = -(m[4]! * bx + m[5]! * by + m[6]! * bz + m[7]!) * VOXEL_TO_WORLD;
    const rx = m[0]! * a + m[1]! * b + m[2]! * c;
    const ry = m[4]! * a + m[5]! * b + m[6]! * c;
    const rz = m[8]! * a + m[9]! * b + m[10]! * c;
    len = Math.hypot(rx, ry, rz) || 1;
    modelN[p] = rx / len;
    modelN[p + 1] = rz / len;
    modelN[p + 2] = -ry / len;
    // Cosine-distributed deterministic rays. A hit at t contributes sqrt(1-t/length); distant occluders fade out.
    // Trace once per net vertex, before duplicating quads. Ground tests use the transformed model height, never
    // section z: translated/rotated turrets and barrels must not acquire a fictitious ground at their local origin.
    if (!o.aoRays || !o.aoLength) continue;
    ao[v] = ambientOcclusion(
      x,
      y,
      z,
      a,
      b,
      c,
      rays,
      o.aoLength,
      o.groundOcclusion,
      cells,
      gx,
      gxy,
      sx,
      sy,
      sz,
      groundX,
      groundY,
      groundZ,
      groundOffset,
    );
  }
  // The four cells around an X/Y/Z edge in positive-axis winding.
  const rings = [
    [0, -nx, -nx - xy, -xy],
    [0, -xy, -xy - 1, -1],
    [0, -1, -1 - nx, -nx],
  ];
  let quads = 0;
  for (let v = 0; v < vertices; v++) {
    const k = netCells[v]!;
    for (let axis = 0; axis < 3; axis++) if (field[k]! < 0 !== field[k + strides[axis]!]! < 0) quads++;
  }
  const out: SmoothMeshData = {
    position: new Float32Array(quads * 12),
    normal: new Float32Array(quads * 12),
    pindex: new Float32Array(quads * 4),
    occlusion: new Float32Array(quads * 4),
    curvature: new Float32Array(quads * 4),
    vpos: new Float32Array(quads * 12),
    indices: quads * 4 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6),
  };
  let quad = 0;
  const ids = new Int32Array(4);
  for (let v = 0; v < vertices; v++) {
    const k = netCells[v]!;
    for (let axis = 0; axis < 3; axis++) {
      if (field[k]! < 0 === field[k + strides[axis]!]! < 0) continue;
      const ring = rings[axis]!;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let j = 0; j < 4; j++) {
        const v = vertexAt[k + ring[field[k]! < 0 ? j : (4 - j) % 4]!]!;
        ids[j] = v;
        cx += vp[v * 3]!;
        cy += vp[v * 3 + 1]!;
        cz += vp[v * 3 + 2]!;
      }
      // Palette indices cannot interpolate: every quad owns four vertices, even though geometry/AO are shared.
      const a = ids[0]! * 3;
      const b = ids[1]! * 3;
      const c = ids[2]! * 3;
      const ux = vp[b]! - vp[a]!;
      const uy = vp[b + 1]! - vp[a + 1]!;
      const uz = vp[b + 2]! - vp[a + 2]!;
      const vx = vp[c]! - vp[a]!;
      const vy = vp[c + 1]! - vp[a + 1]!;
      const vz = vp[c + 2]! - vp[a + 2]!;
      let dx = uy * vz - uz * vy;
      let dy = uz * vx - ux * vz;
      let dz = ux * vy - uy * vx;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      const pal = nearest(cx * 0.25 - dx * 0.6, cy * 0.25 - dy * 0.6, cz * 0.25 - dz * 0.6);
      for (let j = 0; j < 4; j++) {
        const v = ids[j]!;
        const dst = quad * 4 + j;
        for (let axis = 0; axis < 3; axis++) {
          out.position[dst * 3 + axis] = modelP[v * 3 + axis]!;
          out.normal[dst * 3 + axis] = modelN[v * 3 + axis]!;
          out.vpos[dst * 3 + axis] = vp[v * 3 + axis]!;
        }
        out.pindex[dst] = pal < 0 ? 0 : raw[pal + 3]!;
        out.occlusion[dst] = ao[v]!;
        out.curvature[dst] = curvature[v]!;
      }
      const base = quad * 4;
      const offset = quad * 6;
      out.indices[offset] = base;
      out.indices[offset + 1] = base + 1;
      out.indices[offset + 2] = base + 2;
      out.indices[offset + 3] = base;
      out.indices[offset + 4] = base + 2;
      out.indices[offset + 5] = base + 3;
      quad++;
    }
  }
  return out;
}

/** Ray bounds allow the occupancy hot loop to use a single indexed load per half-voxel step. */
function ambientOcclusion(
  x: number,
  y: number,
  z: number,
  a: number,
  b: number,
  c: number,
  rays: Float32Array,
  length: number,
  ground: boolean,
  cells: Int32Array,
  gx: number,
  gxy: number,
  sx: number,
  sy: number,
  sz: number,
  groundX: number,
  groundY: number,
  groundZ: number,
  groundOffset: number,
): number {
  const ox = x + 0.6 * a;
  const oy = y + 0.6 * b;
  const oz = z + 0.6 * c;
  const h0 = groundX * ox + groundY * oy + groundZ * oz + groundOffset;
  if (ground && h0 < 0) return 1;
  if (
    ox >= 0 &&
    ox < sx &&
    oy >= 0 &&
    oy < sy &&
    oz >= 0 &&
    oz < sz &&
    cells[Math.floor(ox) + 1 + gx * (Math.floor(oy) + 1) + gxy * (Math.floor(oz) + 1)]
  )
    return 1;
  const tangentLength = Math.sqrt(a * a + b * b);
  const tx = tangentLength > 1e-6 ? -b / tangentLength : 1;
  const ty = tangentLength > 1e-6 ? a / tangentLength : 0;
  const ux = -c * ty;
  const uy = c * tx;
  const uz = a * ty - b * tx;
  let sum = 0;
  for (let r = 0; r < rays.length; r += 3) {
    const ra = rays[r]!;
    const rb = rays[r + 1]!;
    const rc = rays[r + 2]!;
    const dx = tx * ra + ux * rb + a * rc;
    const dy = ty * ra + uy * rb + b * rc;
    const dz = uz * rb + c * rc;
    const dh = groundX * dx + groundY * dy + groundZ * dz;
    let hit = length;
    if (ground && dh < 0) hit = Math.min(hit, (Math.floor((-h0 / dh) * 2) + 1) * 0.5);
    if (
      (ox < 0 && dx <= 0) ||
      (ox >= sx && dx >= 0) ||
      (oy < 0 && dy <= 0) ||
      (oy >= sy && dy >= 0) ||
      (oz < 0 && dz <= 0) ||
      (oz >= sz && dz >= 0)
    ) {
      if (hit < length) sum += Math.sqrt(1 - hit / length);
      continue;
    }
    // Slabs include all sample points inside the occupancy box, still on the same t = n/2 lattice.
    // Parallel rays outside a slab cannot hit; an infinite interval handles parallel rays inside it.
    const idx = 1 / dx;
    const idy = 1 / dy;
    const idz = 1 / dz;
    const ax = dx === 0 ? -Infinity : -ox * idx;
    const bx = dx === 0 ? Infinity : (sx - ox) * idx;
    const ay = dy === 0 ? -Infinity : -oy * idy;
    const by = dy === 0 ? Infinity : (sy - oy) * idy;
    const az = dz === 0 ? -Infinity : -oz * idz;
    const bz = dz === 0 ? Infinity : (sz - oz) * idz;
    if (!(
      (dx === 0 && (ox < 0 || ox >= sx)) ||
      (dy === 0 && (oy < 0 || oy >= sy)) ||
      (dz === 0 && (oz < 0 || oz >= sz))
    )) {
      const start = Math.max(0, Math.ceil(Math.max(Math.min(ax, bx), Math.min(ay, by), Math.min(az, bz)) * 2) / 2);
      const end = Math.min(hit, Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz));
      for (let t = start; t < end; t += 0.5) {
        const ix = Math.floor(ox + dx * t);
        const iy = Math.floor(oy + dy * t);
        const iz = Math.floor(oz + dz * t);
        const k = ix + 1 + gx * (iy + 1) + gxy * (iz + 1);
        if (cells[k]) {
          hit = t;
          break;
        }
      }
    }
    if (hit < length) sum += Math.sqrt(1 - hit / length);
  }
  return rays.length ? sum / (rays.length / 3) : 0;
}
