/** Renderer-independent projection contract and CPU twins of the shader's coordinate math. */
export type ProjectionPartName = 'body' | 'turret';
export type Point2 = [number, number];
export type Point3 = [number, number, number];
export type ProjectionJacobian = [Point3, Point3];

export interface ProjectionFrame {
  k: number;
  facing: number;
  /** Atlas pixels, top-left origin; may lie outside the cropped rect. */
  pivot: Point2;
  rect: [number, number, number, number];
}

export interface ProjectionPartManifest {
  colour: string;
  paint: string;
  size: Point2;
  frames: ProjectionFrame[];
}

export interface VoxelProjectionManifest {
  version: 1;
  type: string;
  frames: 16 | 32;
  facingStep: number;
  scale: number;
  jacobian: ProjectionJacobian;
  house: { first: 16; count: 16 } | null;
  parts: { body?: ProjectionPartManifest; turret?: ProjectionPartManifest };
  /**
   * Page exposure: the colour pages store their sRGB values divided by this number and the shader multiplies it back
   * before decoding (house paint is not on the colour pages and is not scaled). A page drawn from bakes at the bake
   * level cannot hold anything brighter than the bake's white, so a light hull's top faces stop at
   * 255 x level / levelRef on screen while the original reaches white; a page stored with headroom keeps them.
   * Absent (every manifest written before this field existed): 1.
   */
  exposure?: number;
  registration: { part: ProjectionPartName; k: number; iou: number; scale: number; dx: number; dy: number }[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function tuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(finite);
}

/** Only relative asset paths within the projection directory are accepted. */
export function projectionPath(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[\w-]+\/)*[\w.-]+$/.test(value) && !value.split('/').includes('..');
}

export function parseVoxelProjectionManifest(
  value: unknown,
  requiredParts: readonly ProjectionPartName[] = ['body'],
): VoxelProjectionManifest {
  const m = record(value, 'voxel projection manifest');
  if (m.version !== 1 || typeof m.type !== 'string' || !m.type) throw new Error('Invalid projection version/type');
  if ((m.frames !== 16 && m.frames !== 32) || m.facingStep !== 256 / m.frames)
    throw new Error('Invalid projection frame count/step');
  if (!finite(m.scale) || m.scale <= 0) throw new Error('Invalid projection scale');
  if (!Array.isArray(m.jacobian) || m.jacobian.length !== 2 || !m.jacobian.every((row) => tuple(row, 3)))
    throw new Error('Invalid projection Jacobian');
  if (m.house !== null) {
    const house = record(m.house, 'projection house ramp');
    if (house.first !== 16 || house.count !== 16) throw new Error('Invalid projection house ramp');
  }
  const parts = record(m.parts, 'projection parts');
  for (const name of requiredParts) {
    if (!parts[name]) throw new Error(`Missing projection part: ${name}`);
  }
  if (Object.keys(parts).length === 0) throw new Error('Missing projection part: body or turret');
  for (const [name, value] of Object.entries(parts)) {
    if (name !== 'body' && name !== 'turret') throw new Error(`Unknown projection part: ${name}`);
    const part = record(value, `projection ${name}`);
    if (!projectionPath(part.colour) || !projectionPath(part.paint)) throw new Error('Invalid projection atlas path');
    if (!tuple(part.size, 2) || !part.size.every((n) => Number.isInteger(n) && n > 0) || part.size[0]! > 4096)
      throw new Error('Invalid projection atlas size');
    if (!Array.isArray(part.frames) || part.frames.length !== m.frames) throw new Error('Incomplete projection frames');
    const ks = new Set<number>();
    part.frames.forEach((value, i) => {
      const frame = record(value, 'projection frame');
      if (!Number.isInteger(frame.k) || (frame.k as number) < 0 || ks.has(frame.k as number))
        throw new Error('Invalid or duplicate bake frame');
      ks.add(frame.k as number);
      if (frame.facing !== i * (m.facingStep as number))
        throw new Error('Projection facings must be uniformly spaced from zero');
      if (!tuple(frame.pivot, 2) || !tuple(frame.rect, 4)) throw new Error('Invalid projection pivot/rect');
      const [x, y, w, h] = frame.rect as [number, number, number, number];
      if (
        !frame.rect.every(Number.isInteger) ||
        x < 0 ||
        y < 0 ||
        w <= 0 ||
        h <= 0 ||
        x + w > (part.size as number[])[0]! ||
        y + h > (part.size as number[])[1]!
      )
        throw new Error('Projection rect outside atlas');
    });
  }
  if (!Array.isArray(m.registration)) throw new Error('Missing projection registration');
  for (const value of m.registration) {
    const r = record(value, 'projection registration');
    if (
      !(r.part === 'body' || r.part === 'turret') ||
      !parts[r.part] ||
      !Number.isInteger(r.k) ||
      !finite(r.iou) ||
      r.iou < 0 ||
      r.iou > 1 ||
      !finite(r.scale) ||
      r.scale < 0.94 ||
      r.scale > 1.06 ||
      !finite(r.dx) ||
      Math.abs(r.dx) > 16 ||
      !finite(r.dy) ||
      Math.abs(r.dy) > 16
    )
      throw new Error('Invalid projection registration');
  }
  if (m.exposure !== undefined && (!finite(m.exposure) || m.exposure < 1 || m.exposure > 4))
    throw new Error('Invalid projection page exposure');
  return m as unknown as VoxelProjectionManifest;
}

export function parseVoxelProjectionIndex(value: unknown): Record<string, string> {
  const index = record(value, 'projection index');
  if (index.version !== 1) throw new Error('Invalid projection index version');
  const types = record(index.types, 'projection index types');
  for (const file of Object.values(types))
    if (!projectionPath(file)) throw new Error('Invalid projection manifest path');
  return types as Record<string, string>;
}

export function wrapFacing(facing: number): number {
  return ((facing % 256) + 256) % 256;
}

/** Column-major world matrix, matching three.js and including parent yaw, scale and ground tilt. */
export function facingFromMatrix(matrix: ArrayLike<number>): number {
  const theta = Math.atan2(-matrix[2]!, matrix[0]!);
  return wrapFacing(((Math.PI / 2 - theta) * 256) / (2 * Math.PI));
}

export function projectionFramePair(facing: number, frames: number, blend = 1): { k0: number; k1: number; w: number } {
  const f = wrapFacing(facing) / (256 / frames);
  const k0 = Math.floor(f) % frames;
  const fraction = f - Math.floor(f);
  const crossfade = Math.max(0, Math.min(1, blend));
  return { k0, k1: (k0 + 1) % frames, w: (fraction < 0.5 ? 0 : 1) * (1 - crossfade) + fraction * crossfade };
}

export function projectVoxelPoint(
  local: Point3,
  matrix: ArrayLike<number>,
  frame: Pick<ProjectionFrame, 'pivot' | 'facing'>,
  jacobian: ProjectionJacobian,
): Point2 {
  const theta = Math.atan2(-matrix[2]!, matrix[0]!);
  const delta = Math.PI / 2 - (2 * Math.PI * frame.facing) / 256 - theta;
  const x = matrix[0]! * local[0] + matrix[4]! * local[1] + matrix[8]! * local[2];
  const y = matrix[1]! * local[0] + matrix[5]! * local[1] + matrix[9]! * local[2];
  const z = matrix[2]! * local[0] + matrix[6]! * local[1] + matrix[10]! * local[2];
  const c = Math.cos(delta),
    s = Math.sin(delta);
  const d: Point3 = [c * x + s * z, y, -s * x + c * z];
  return [
    frame.pivot[0] + jacobian[0].reduce((sum, j, i) => sum + j * d[i]!, 0),
    frame.pivot[1] + jacobian[1].reduce((sum, j, i) => sum + j * d[i]!, 0),
  ];
}
