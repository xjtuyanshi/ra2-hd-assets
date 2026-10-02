import type { SpriteFrame } from '../../../ra2-assets/src/manifest';
import { PIXELS_PER_CELL_EDGE } from '../world';

/** Camera-space nearness per original screen row; height follows the native gradient-2 ratio. */
export const GROUND_DEPTH = Math.sqrt(3) / PIXELS_PER_CELL_EDGE;
export const VERTICAL_DEPTH = GROUND_DEPTH / 3;
/** Native ground units draw after building bodies (4) and their test-only door parts (4.001). */
export const NATIVE_UNIT_RENDER_ORDER = 4.002;

export interface NativeDepthOffset {
  /** This draw point relative to the owner body's draw point, in original screen pixels. */
  offset?: readonly [number, number];
  /** Nearness of this draw point relative to the owner, in world units, counted only once. */
  anchorPush?: number;
}

export type NativeSpriteDepth = NativeDepthOffset &
  (
    | { mode: 'body'; origin: readonly [number, number]; base: number }
    | { mode: 'ground'; bonus: number }
    | { mode: 'card'; bottom: number; bonus: number }
  );

export interface BuildingZShape {
  pointMove?: readonly [number, number];
  normalZAdjust?: number;
}

export function signedDepthSample(byte: number): number {
  return (byte << 24) >> 24;
}

/** The asset extractor applies this once; library depthTemplate bytes already contain the transformed value. */
export function transformRawDepthSample(raw: number): number {
  return signedDepthSample(raw === 0 ? 0 : (raw - 65) & 255);
}

export function bodyTemplateOrigin(
  width: number,
  height: number,
  pointMove: readonly [number, number] = [0, 0],
  buildState?: string,
): readonly [number, number] | undefined {
  if (width >= 8) return undefined;
  const skipMove = buildState === 'building' || buildState === 'selling';
  return [
    198 + (skipMove ? 0 : pointMove[0]) - 30 * (width - height),
    446 + (skipMove ? 0 : pointMove[1]) - 15 * (width + height - 2),
  ];
}

export function frameInclusiveBottom(frame: SpriteFrame): number {
  return frame.offset[1] + frame.rect[3] - 1;
}

/** The drawn body's inclusive bottom is clipped to BUILDNGZ before its constant row baseline is selected. */
export function buildingDepthProfile(
  frame: SpriteFrame,
  foundation: readonly [number, number],
  zShape: BuildingZShape | undefined,
  buildState: string | undefined,
  unloading: 'door' | 'roof' | undefined,
  template: { width: number; height: number } | undefined,
): NativeSpriteDepth | undefined {
  if (!template) return undefined;
  const normal = unloading === 'door' ? -20 : unloading === 'roof' ? -40 : (zShape?.normalZAdjust ?? 0);
  const origin = bodyTemplateOrigin(foundation[0], foundation[1], zShape?.pointMove, buildState);
  if (!origin) return { mode: 'card', bottom: frameInclusiveBottom(frame), bonus: 1 - normal };
  const height = Math.min(frame.rect[3], template.height - (origin[1] + frame.offset[1]));
  return { mode: 'body', origin, base: frame.offset[1] + height - normal };
}

/** Attached test-only native images use their owner's body depth in HD, including a shifted draw point. */
export function attachedBodyDepth(
  body: NativeSpriteDepth,
  offset: readonly [number, number],
  anchorPush: number,
): NativeSpriteDepth {
  return { ...body, offset, anchorPush };
}

export function bodyTemplatePush(
  bytes: ArrayLike<number>,
  width: number,
  height: number,
  origin: readonly [number, number],
  base: number,
  px: number,
  py: number,
): number {
  // Native color clips outside the shape. HD fringe pixels instead repeat the nearest valid depth sample.
  const x = Math.max(0, Math.min(width - 1, origin[0] + Math.floor(px)));
  const y = Math.max(0, Math.min(height - 1, origin[1] + Math.floor(py)));
  return (base + signedDepthSample(bytes[y * width + x]!)) * GROUND_DEPTH;
}

export function groundPush(py: number, bonus: number): number {
  return (py + bonus) * GROUND_DEPTH;
}

export function cardPushRows(py: number, bottom: number, bonus = 0): number {
  return bottom + bonus + Math.floor((bottom - py) / 3);
}

export function nativeCardPush(py: number, bottom: number, bonus = 0): number {
  return cardPushRows(py, bottom, bonus) * GROUND_DEPTH;
}

/** Occupied refinery cells are a type policy, independent of contacts, missions or motion. */
export function addRefineryFoundation(
  cells: Set<string>,
  refinery: boolean,
  x: number,
  y: number,
  foundation: readonly [number, number],
): void {
  if (!refinery) return;
  for (let dy = 0; dy < foundation[1]; dy++)
    for (let dx = 0; dx < foundation[0]; dx++) cells.add(`${Math.floor(x) + dx},${Math.floor(y) + dy}`);
}

export function harvesterRefineryBonus(harvester: boolean, x: number, y: number, cells: ReadonlySet<string>): number {
  return harvester && cells.has(`${Math.floor(x / 256)},${Math.floor(y / 256)}`) ? 13 : 0;
}
