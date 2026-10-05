import type { Vector3 } from 'three/webgpu';
import type { SpriteFrame } from '../../../ra2-assets/src/manifest';
import { CARD_CLEARANCE } from './cardDepth';
import { frameInclusiveBottom, GROUND_DEPTH, TERRAIN_OBJECT_DEPTH_BONUS } from './nativeDepth';
import { VOXEL_CARD_KAPPA, voxelScreenPlace, type VoxelCardExtent, type VoxelCardTies } from './voxelNativeDepth';

/**
 * The depth cards of the map's terrain objects (trees), for the one decision the fragment depths cannot make cleanly:
 * a vehicle whose card nearly ties with a tree's.
 *
 * Both cards come one unit nearer every three rows, each counted from its own bottom row, and the voxel keeps six
 * percent of its physical depth (VOXEL_CARD_KAPPA). Over the row or so of travel in which the two cards cross, the
 * nearer one therefore changed from row to row and the tree showed through the hull in stripes (sandbox replay of a
 * frozen RiverRam frame, Rhino moved past a tree in half-row steps: clean behind, striped for about one row, clean in
 * front). The engine compares whole integer cards and draws a tree over every unit registered before it, and the
 * original's own frozen frame at that place shows the tree in front. So a vehicle that is not in front of an
 * overlapping tree along its whole height and depth is put behind it as a whole: its card bonus is lowered by the
 * amount the nearest part of it would otherwise win by. Elsewhere the bonus is unchanged.
 *
 * SHP units keep their plain cards: infantry tie with a tree only within about a row of its foot.
 */
interface Card {
  left: number;
  right: number;
  top: number;
  /** Absolute row of the frame's inclusive bottom. */
  bottom: number;
  /** View depth of the draw point, world units. */
  depth: number;
  /** Bottom row below the draw point plus the card's bonus: the card's nearness at its bottom row, in rows. */
  rows: number;
}

/** Side of the screen-space buckets in native pixels (a tree spans about one, a vehicle's bounds at most four). */
const BUCKET = 96;
/** Native pixels by which bounds may miss each other and still count as overlapping (soft edges, the bitmap margin). */
const OVERLAP_PAD = 2;
/** A vehicle put behind a tree clears its card by half a depth unit (a painter bias is at most a quarter). */
const TIE_MARGIN = 0.5 * GROUND_DEPTH;

/** Thirds of a row by which a bottom distance may be off in single-precision shader arithmetic. */
const PHASE_EPSILON = 1e-4;

const place = { column: 0, row: 0, depth: 0 };
const key = (x: number, y: number) => (Math.floor(x / BUCKET) + 4096) * 8192 + Math.floor(y / BUCKET) + 4096;

export class TerrainObjectCards implements VoxelCardTies {
  private readonly buckets = new Map<number, Card[]>();
  /** Number of cards registered. */
  size = 0;

  /** Register the card of an upright terrain object drawn with `frame` at the world draw point `anchor`. */
  add(anchor: Vector3, frame: SpriteFrame, bonus = TERRAIN_OBJECT_DEPTH_BONUS): void {
    const { column, row, depth } = voxelScreenPlace(anchor, place);
    const bottom = frameInclusiveBottom(frame);
    const card: Card = {
      left: column + frame.offset[0],
      right: column + frame.offset[0] + frame.rect[2],
      top: row + frame.offset[1],
      bottom: row + bottom,
      depth,
      rows: bottom + bonus,
    };
    for (let y = Math.floor(card.top / BUCKET); y <= Math.floor(card.bottom / BUCKET); y++)
      for (let x = Math.floor(card.left / BUCKET); x <= Math.floor(card.right / BUCKET); x++) {
        const at = key(x * BUCKET, y * BUCKET);
        const list = this.buckets.get(at);
        if (list) list.push(card);
        else this.buckets.set(at, [card]);
      }
    this.size++;
  }

  /**
   * Fragment depth of the unit minus the tree's at one screen pixel, world units (positive = the tree is nearer):
   *   depth(unit anchor) - depth(tree anchor) + G * (tree rows - unit bottom - unit bonus + tree steps - unit steps)
   *   + KAPPA * behind + CARD_CLEARANCE - bias
   * Both step counts are floors of thirds of the rows above each card's bottom, so their difference is -floor(d / 3)
   * or one less, d being the unit's bottom row minus the tree's; `behind` spans the unit's extent. The unit is wholly
   * in front when the largest value is negative.
   */
  tieBonus(anchor: Vector3, bottom: number, bonus: number, bias: number, extent: VoxelCardExtent): number {
    if (!this.size) return 0;
    const { column, row, depth } = voxelScreenPlace(anchor, place);
    const left = column + extent.left - OVERLAP_PAD;
    const right = column + extent.right + OVERLAP_PAD;
    const top = row + extent.top - OVERLAP_PAD;
    const low = row + bottom + OVERLAP_PAD;
    let result = 0;
    for (let y = Math.floor(top / BUCKET); y <= Math.floor(low / BUCKET); y++)
      for (let x = Math.floor(left / BUCKET); x <= Math.floor(right / BUCKET); x++) {
        const list = this.buckets.get(key(x * BUCKET, y * BUCKET));
        if (!list) continue;
        for (const card of list) {
          if (card.right < left || card.left > right || card.bottom < top || card.top > low) continue;
          const thirds = (row + bottom - card.bottom) / 3;
          const base = depth - card.depth + GROUND_DEPTH * (card.rows - bottom - bonus) + CARD_CLEARANCE - bias;
          const farthest =
            base - GROUND_DEPTH * Math.floor(thirds - PHASE_EPSILON) + VOXEL_CARD_KAPPA * extent.behindMax;
          if (farthest <= 0) continue;
          const nearest =
            base - GROUND_DEPTH * (Math.floor(thirds + PHASE_EPSILON) + 1) + VOXEL_CARD_KAPPA * extent.behindMin;
          if (nearest >= TIE_MARGIN) continue;
          result = Math.min(result, (nearest - TIE_MARGIN) / ((1 - VOXEL_CARD_KAPPA) * GROUND_DEPTH));
        }
      }
    return result;
  }
}
