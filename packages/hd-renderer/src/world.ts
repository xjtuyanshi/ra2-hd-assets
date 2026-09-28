import { OrthographicCamera, Vector3 } from 'three/webgpu';

/**
 * World units: one map cell = 1 unit on the ground plane (x = cell x, z = cell y), +y up.
 *
 * RA2 draws a cell as a 60x30 px diamond and lifts each height level by 15 px. With a 2:1 dimetric camera (yaw 45°,
 * pitch 30°) a unit cell spans 60 px when sqrt(2) world units map to 60 px, and a vertical world unit shrinks by
 * cos(30°). Solving 15 px = h * cos(30°) * (60 / sqrt(2)) gives the level height below, so HD geometry lines up with
 * the original silhouettes and click boxes.
 */
export const LEVEL_HEIGHT = 15 / (Math.cos(Math.PI / 6) * (60 / Math.SQRT2));
export const PIXELS_PER_CELL_EDGE = 60 / Math.SQRT2;

export function cellToWorld(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, z * LEVEL_HEIGHT, y);
}

/** Fixed RA2-style projection: no rotation, orthographic, zoom only. */
export class IsoCamera {
  readonly camera: OrthographicCamera;
  readonly target = new Vector3();
  zoom = 1;
  private readonly direction = new Vector3();

  constructor() {
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    const pitch = Math.PI / 6;
    // RA2 screens show the map's +X axis running down-right and +Y down-left, so screen-down is +x +y (world +x +z):
    // the camera sits on that side of the target and looks back towards -x -z.
    this.direction.set(Math.cos(pitch) * Math.SQRT1_2, Math.sin(pitch), Math.cos(pitch) * Math.SQRT1_2).normalize();
  }

  /** Fit the frustum so that one cell edge covers PIXELS_PER_CELL_EDGE CSS pixels at zoom 1. */
  resize(cssWidth: number, cssHeight: number): void {
    const halfWidth = cssWidth / PIXELS_PER_CELL_EDGE / 2 / this.zoom;
    const halfHeight = cssHeight / PIXELS_PER_CELL_EDGE / 2 / this.zoom;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    this.camera.position.copy(this.target).addScaledVector(this.direction, 150);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Pan in screen space (CSS pixels), keeping the target on the ground plane. */
  panPixels(dx: number, dy: number): void {
    const unitsPerPixel = 1 / PIXELS_PER_CELL_EDGE / this.zoom;
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
    const forward = new Vector3(-this.direction.x, 0, -this.direction.z).normalize();
    // Screen-up covers 1/sin(pitch) ground units per unit of screen height.
    this.target.addScaledVector(right, -dx * unitsPerPixel);
    this.target.addScaledVector(forward, (dy * unitsPerPixel) / Math.sin(Math.PI / 6));
  }
}
