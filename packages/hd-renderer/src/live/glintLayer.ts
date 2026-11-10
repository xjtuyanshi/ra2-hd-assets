import { Color, DoubleSide, MeshBasicNodeMaterial, NormalBlending, SRGBColorSpace, type Vector3 } from 'three/webgpu';
import { float, instancedBufferAttribute, length, positionGeometry, smoothstep, uv, vec4 } from 'three/tsl';
import type { AtmosphereNodes } from '../atmosphere';
import { DirtyAttribute } from '../dirtyAttribute';
import { InstancedQuad } from '../instancedQuad';
import { CARD_CLEARANCE, GROUND_DEPTH, VERTICAL_DEPTH } from '../ra2/cardDepth';
import { spriteLookFor } from '../ra2/spriteLook';
import { bindUnlitSpriteMaterial } from '../ra2/unlitSprites';
import type { ShaderNode } from '../tsl';
import { MIRROR_SKIP_LAYER, PIXELS_PER_CELL_EDGE } from '../world';

/**
 * Dot profile in engine pixels from the pixel's centre: fully opaque inside CORE, gone at EDGE. Its area (about 1.05
 * engine px²) matches the engine's single pixel; at a device pixel ratio of 2-3 it is a 2-3 device-pixel bright
 * core with a soft rim instead of a hard square.
 */
export const GLINT_DOT = { core: 0.35, edge: 0.8 } as const;
/** Extra nearness over an upright card standing in the glint's own cell at the same pixel. */
export const GLINT_DEPTH_MARGIN = 0.05;
/** Glints drawn at most per pass (an ore cell has at most one; about 16 % of them show at any time). */
export const GLINT_CAPACITY = 8192;
/** After the units and the cell overlays (3, 4, 4.002) and the effect cards (6..8): the engine draws them last. */
export const GLINT_RENDER_ORDER = 8.5;

/**
 * Camera-space pull of a glint drawn `dy` engine rows below its cell centre (negative = above): the depth an upright
 * card anchored at the cell centre has at that row (cardDepth.ts: below its base it follows the ground, above it
 * stands vertically), plus CARD_CLEARANCE and a margin. So the cell's own ore art and anything standing in that cell
 * never hide it, while objects in nearer cells, and nearer terrain, do. This is the one deliberate deviation: the
 * engine writes the pixel with no Z test at all, over every object.
 */
export function glintPull(dy: number): number {
  return Math.max(dy * GROUND_DEPTH, -dy * VERTICAL_DEPTH) + CARD_CLEARANCE + GLINT_DEPTH_MARGIN;
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = new Color().setRGB(i / 255, 0, 0, SRGBColorSpace);
  return c.r;
});

/**
 * One fixed GPU pool for the engine's single-pixel cell glints (ra2/cellGlints.ts). Each glint is a camera-facing
 * dot at a whole engine-pixel offset from its cell centre, drawn into the self-lit attachment (unlitSprites.ts) like
 * an unlit palette pixel of the same colour: no map lighting, no scene events, no night grade, so it keeps its full
 * brightness at night as the engine's raw surface write does. The common shroud post pass still masks it. Mirrors
 * leave it out (MIRROR_SKIP_LAYER). LiveView owns construction and disposal.
 */
export class GlintLayer {
  readonly mesh: InstancedQuad;
  /** Per glint: anchor (x, y, z, pull), pixel centre offset (dx, dy, 0, 0), linear colour (r, g, b, 1). */
  private readonly data = new DirtyAttribute(new Float32Array(GLINT_CAPACITY * 12), 12);
  private count = 0;
  private warned = false;

  constructor(nodes: AtmosphereNodes, cameraRight: ShaderNode, cameraUp: ShaderNode, toCamera: ShaderNode) {
    const shared = this.data.interleaved();
    const anchor: ShaderNode = instancedBufferAttribute(shared, 'vec4', 12, 0);
    const offset: ShaderNode = instancedBufferAttribute(shared, 'vec4', 12, 4);
    const colour: ShaderNode = instancedBufferAttribute(shared, 'vec4', 12, 8);
    const ppu = float(PIXELS_PER_CELL_EDGE);
    const side = GLINT_DOT.edge * 2 + 0.2;
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthTest = true;
    material.depthWrite = false;
    material.blending = NormalBlending;
    material.side = DoubleSide;
    // Screen x right, engine y down: the same camera-plane placement as an upright sprite card (sprites.ts).
    material.positionNode = anchor.xyz
      .add(cameraRight.mul(offset.x.add(positionGeometry.x.mul(side)).div(ppu)))
      .sub(cameraUp.mul(offset.y.sub(positionGeometry.y.mul(side)).div(ppu)))
      .add(toCamera.mul(anchor.w));
    const d: ShaderNode = length(uv().sub(0.5).mul(side));
    const alpha: ShaderNode = float(1).sub(smoothstep(GLINT_DOT.core, GLINT_DOT.edge, d));
    // Self-lit art's convention: linear palette colour times the clear-noon base light (sprites.ts, isUnlit).
    material.colorNode = vec4(colour.rgb.mul(spriteLookFor(nodes).unlitBaseLight), alpha);
    bindUnlitSpriteMaterial(material, float(1), nodes);
    this.mesh = new InstancedQuad(material, GLINT_CAPACITY);
    this.mesh.name = 'live-cell-glints';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = GLINT_RENDER_ORDER;
    this.mesh.layers.set(MIRROR_SKIP_LAYER);
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Glints written since the last begin(). */
  get size(): number {
    return this.count;
  }

  begin(): void {
    this.count = 0;
  }

  /** A glint at `anchor` (the cell centre on its ground, world units), `dx`/`dy` engine px, 8-bit display colour. */
  add(anchor: Vector3, dx: number, dy: number, r: number, g: number, b: number): void {
    if (this.count >= GLINT_CAPACITY) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[HD] more than ${GLINT_CAPACITY} ore glints at once; the rest are not drawn.`);
      }
      return;
    }
    const n = this.count++;
    const data = this.data;
    // The engine's pixel (dx, dy) covers dx..dx + 1: its centre is half a pixel further.
    data.setXYZW(n, anchor.x, anchor.y, anchor.z, glintPull(dy + 0.5));
    for (let i = 4; i < 8; i++) data.setComponent(n, i, i === 4 ? dx + 0.5 : i === 5 ? dy + 0.5 : 0);
    data.setComponent(n, 8, SRGB_TO_LINEAR[r & 255]!);
    data.setComponent(n, 9, SRGB_TO_LINEAR[g & 255]!);
    data.setComponent(n, 10, SRGB_TO_LINEAR[b & 255]!);
    data.setComponent(n, 11, 1);
  }

  end(): void {
    this.data.flush();
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
