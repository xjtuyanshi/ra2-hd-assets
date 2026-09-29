import { Color, Matrix4, Vector2, Vector3, type Camera } from 'three/webgpu';
import { exp, float, getViewPosition, min, mix, mx_noise_float, time, uniform, vec3, vec4 } from 'three/tsl';
import { night, referenceLevel, sampleLightField, sceneBrightness } from './atmosphere';
import type { ShaderNode } from './tsl';

/** Mist never covers more than this fraction of a pixel (readability cap, docs/remaster/PLAN.md). */
export const MIST_CAP = 0.2;

/**
 * Thin ground mist composited over the HDR scene before bloom: density follows height above the ground (not screen
 * height, so there is no top-to-bottom haze gradient in the fixed view), drifts slowly with the wind, takes the scene's
 * light level and glows around lamps through the light field. Uniform-driven while it shows: weather and night only
 * change `amount`. The renderer leaves apply() out of its pipeline while the amount is 0 (a clear day), rebuilding the
 * pipeline when the mist starts or stops.
 */
export class Mist {
  /** 0..MIST_CAP overall density (set per frame from weather and night). */
  readonly amount = uniform(0);
  readonly tint = uniform(new Color(0.62, 0.68, 0.78));
  readonly wind = uniform(new Vector2(0.4, 0.15));
  private readonly projectionInverse = uniform(new Matrix4());
  private readonly cameraWorld = uniform(new Matrix4());
  /** World direction the (orthographic) scene camera looks along. */
  private readonly viewDirection = uniform(new Vector3(0, -1, 0));

  /** Track the scene camera (the pipeline's own quad camera is not the one the depth came from). */
  update(camera: Camera): void {
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.cameraWorld.value.copy(camera.matrixWorld);
    this.viewDirection.value.set(0, 0, -1).transformDirection(camera.matrixWorld);
  }

  /** World position of a scene-pass pixel from its depth (background pixels land on the far plane). */
  worldPosition(depth: ShaderNode, screen: ShaderNode): ShaderNode {
    const view: ShaderNode = getViewPosition(screen, depth, this.projectionInverse);
    return this.cameraWorld.mul(vec4(view, 1)).xyz;
  }

  /**
   * Where the view ray through `world` meets the ground plane y = 0 (xz). Flat layers drawn on that plane, like the
   * live view's shroud, are addressed by this point; the camera is orthographic, so every point of a pixel's ray gives
   * the same answer.
   */
  groundPlanePoint(world: ShaderNode): ShaderNode {
    const d = this.viewDirection;
    return world.xz.sub(d.xz.mul(world.y.div(d.y)));
  }

  /** Mist over `hdr` (vec4 scene colour) given the scene pass's depth and the pixel's world position. */
  apply(hdr: ShaderNode, depth: ShaderNode, world: ShaderNode): ShaderNode {
    // Background (no geometry) sits at the far plane: treat it as ground level.
    const height = depth.greaterThanEqual(0.9999).select(float(0), world.y.max(0));
    const drift = world.xz.mul(0.15).add(this.wind.mul(time.mul(0.05)));
    const variation = float(0.75).add(
      mx_noise_float(vec3(drift, time.mul(0.02)))
        .mul(0.25)
        .add(0.25),
    );
    const density = min(
      this.amount.mul(variation).mul(float(0.6).add(exp(height.mul(-1 / 2.5)).mul(0.4))),
      float(MIST_CAP),
    );
    // In-scattered light: the sky's level (dimmer at night, so the veil never lifts dark wet streets to grey) and the
    // lamps' glow around them.
    const colour = this.tint
      .mul(sceneBrightness.mul(mix(float(0.45), float(0.26), night)))
      .add(sampleLightField(world.xz).div(referenceLevel).mul(0.25));
    return vec4(mix(hdr.rgb, colour, density), hdr.a);
  }
}
