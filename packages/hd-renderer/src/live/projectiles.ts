import { Group, Quaternion, Vector3 } from 'three/webgpu';
import { facingFrame } from '../../../ra2-assets/src/art';
import { cardPush } from '../ra2/sprites';
import { LEVEL_HEIGHT } from '../world';
import type { EffectArt } from './effectArt';
import type { LiveBullet, LiveVoxelAnim } from './effects';
import { engineAnchor, engineDepth, type EffectInstance } from './effectSprites';
import type { VoxelUnits } from './voxelUnits';

/**
 * Projectiles and debris with their original art, drawn only when the host reports what they are (bridge H1: bullet
 * type/frame/velocity, VoxelAnim type/orientation). Without a type a bullet is a small grey dot (LiveEffectsDriver),
 * never an HD fire tracer.
 *
 *   - SHP shells: BulletClass::AnimFrame, or for Rotates=yes art the direction of flight (facing index from the
 *     velocity, frames being evenly spaced directions like other RA2 directional art).
 *   - Voxel missiles and debris: meshes from the effect sidecar through VoxelUnits, turned along the velocity or by the
 *     reader's tumbling quaternion.
 */

/** Engine facing (0..255, 0 = north, clockwise) of a lepton velocity; screen-space like the engine's DirStruct. */
export function velocityFacing(vx: number, vy: number): number {
  // Map north is -Y; clockwise towards +X.
  const angle = Math.atan2(vx, -vy);
  return ((Math.round((angle / (Math.PI * 2)) * 256) % 256) + 256) % 256;
}

/** SHP frame of a projectile: its own frame, or the direction of flight for rotating art. */
export function bulletFrame(bullet: LiveBullet, frames: number, rotates: boolean): number {
  if (frames <= 1) return 0;
  if (rotates && bullet.velocity && (bullet.velocity.x !== 0 || bullet.velocity.y !== 0))
    return facingFrame(velocityFacing(bullet.velocity.x, bullet.velocity.y), frames);
  return (((bullet.frame ?? 0) % frames) + frames) % frames;
}

export class Projectiles {
  private readonly meshes = new Map<string, { root: Group; type: string }>();
  private readonly alive = new Set<string>();
  private readonly direction = new Vector3();
  private readonly nose = new Vector3(1, 0, 0);

  constructor(
    private readonly art: EffectArt,
    private readonly voxels: VoxelUnits,
    private readonly parent: Group,
    /** Palette row key for voxel art (house-remapped when the owner is known). */
    private readonly voxelPalette: (owner: number | undefined) => string,
  ) {}

  /** SHP projectile cards for this frame; voxel projectiles and debris are placed as meshes. */
  update(
    bullets: readonly LiveBullet[],
    debris: readonly LiveVoxelAnim[],
    hidden: (x: number, y: number, z: number) => boolean,
    out: EffectInstance[],
  ): void {
    const alive = this.alive;
    alive.clear();
    for (const bullet of bullets) {
      if (!bullet.type || hidden(bullet.x, bullet.y, bullet.z)) continue;
      const found = this.art.bullet(bullet.type);
      if (!found) continue;
      if (found.art.voxel) {
        const key = `b${bullet.uid}`;
        const mesh = this.mesh(key, found.art.voxel, undefined);
        if (!mesh) continue;
        alive.add(key);
        mesh.root.position.set(bullet.x / 256, (bullet.z / 104) * LEVEL_HEIGHT, bullet.y / 256);
        const v = bullet.velocity;
        if (v && (v.x || v.y || v.z)) {
          // The model's nose is local +x; aim it along the flight direction in world space.
          this.direction.set(v.x / 256, (v.z / 104) * LEVEL_HEIGHT, v.y / 256).normalize();
          mesh.root.quaternion.setFromUnitVectors(this.nose, this.direction);
        }
        continue;
      }
      const sprite = found.sprite;
      if (!sprite?.frames.length) continue;
      const frame = sprite.frames[bulletFrame(bullet, sprite.frames.length, !!found.art.rotates)];
      if (!frame || frame.rect[2] <= 0) continue;
      out.push({
        anchor: engineAnchor(bullet.x, bullet.y, bullet.z),
        frame,
        palette: 'fx:anim',
        alpha: found.art.translucent ? 0.5 : 1,
        push: cardPush(frame),
        draw: 'card',
        pass: 'air',
        depth: engineDepth(bullet.x, bullet.y, bullet.z),
        // Translucent shells mix like the engine's; only opaque ones may glow.
        glow: !found.art.translucent,
      });
    }
    for (const piece of debris) {
      if (hidden(piece.x, piece.y, piece.z)) continue;
      const key = `d${piece.uid}`;
      const mesh = this.mesh(key, piece.type, piece.owner);
      if (!mesh) continue;
      alive.add(key);
      mesh.root.position.set(piece.x / 256, (piece.z / 104) * LEVEL_HEIGHT, piece.y / 256);
      engineQuaternion(piece.rotation, mesh.root.quaternion);
    }
    for (const [key, mesh] of this.meshes)
      if (!alive.has(key)) {
        this.voxels.dispose(mesh);
        this.meshes.delete(key);
      }
  }

  private mesh(key: string, voxel: string, owner: number | undefined): { root: Group; type: string } | null {
    const known = this.meshes.get(key);
    if (known) return known;
    const model = this.art.voxel(voxel);
    if (!model) return null;
    const palette = this.voxelPalette(owner);
    const unit = this.voxels.build(model, palette, `fx:${voxel}@${palette}`);
    const entry = { root: unit.root, type: voxel };
    this.parent.add(unit.root);
    this.meshes.set(key, entry);
    return entry;
  }
}

/**
 * The reader's debris orientation (engine world frame: X map x, Y map y, Z up) as a world quaternion (x = map x,
 * y = up, z = map y). Swapping Y and Z is a reflection, which reverses the rotation's sense. Not yet compared with a
 * live capture (the bridge does not pass VoxelAnims yet).
 */
export function engineQuaternion(
  [x, y, z, w]: readonly [number, number, number, number],
  out = new Quaternion(),
): Quaternion {
  return out.set(-x, -z, -y, w).normalize();
}
