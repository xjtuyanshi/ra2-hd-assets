import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  float,
  floor,
  instancedBufferAttribute,
  positionGeometry,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { MapObject, SpriteFrame } from '../../../ra2-assets/src/manifest';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import { ra2Screen, screenToCell, type Ra2Cache } from './cache';

export interface SpriteInstance {
  /** World-space anchor: the engine's draw point for this object (canvas centre goes here). */
  anchor: Vector3;
  frame: SpriteFrame;
  /** Palette row key; remappable art uses its house row (see paletteFor). */
  palette: string;
  /** World units to pull the card towards the camera so terrain around the base never cuts it (see cardPush). */
  push: number;
  shadow: boolean;
  /** Lay the art on the ground as a decal (ore, smudges, flat overlays) instead of a camera-facing card. */
  flat?: boolean;
}

/**
 * Push that makes a camera-facing card draw over its own footprint, as the engine's painter order does. A pixel d world
 * units below the anchor on screen sees ground d * cot(30°) nearer to the camera than the anchor, so the card must come
 * forward at least that far for its lowest pixel.
 */
export function cardPush(frame: SpriteFrame): number {
  const below = Math.max(0, frame.offset[1] + frame.rect[3]) / PIXELS_PER_CELL_EDGE;
  return below * Math.sqrt(3) + 0.03;
}

/**
 * Original SHP art as camera-facing cards. With the fixed orthographic camera a card of w x h pixels / PPU world units
 * covers exactly the pixels the engine would draw, so placement matches the original frame for frame. Colour comes
 * from the palette atlas at draw time (index 0 transparent, 16-31 house-remapped), which is also where HD
 * replacements will later plug in.
 */
export class SpriteLayer {
  readonly mesh: InstancedMesh;
  /** Scene light level applied to unlit sprites (1 = the original's full-bright daylight). */
  readonly light = uniform(new Color(1, 1, 1));
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));

  constructor(cache: Ra2Cache, instances: SpriteInstance[]) {
    const count = Math.max(1, instances.length);
    const anchor = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const rect = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const params = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const flags = new InstancedBufferAttribute(new Float32Array(count), 1);
    // Decals first, then shadows, then upright art, so later layers sit on top of earlier ones.
    const layer = (s: SpriteInstance) => (s.flat ? 0 : s.shadow ? 1 : 2);
    const ordered = [...instances].sort((a, b) => layer(a) - layer(b));
    ordered.forEach((s, i) => {
      anchor.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
      rect.setXYZW(i, s.frame.rect[0], s.frame.rect[1], s.frame.rect[2], s.frame.rect[3]);
      params.setXYZW(i, s.frame.offset[0], s.frame.offset[1], cache.paletteRow.get(s.palette) ?? 0, s.push);
      // 0 = upright card, 1 = ground decal, 2 = shadow decal.
      flags.setX(i, s.shadow ? 2 : s.flat ? 1 : 0);
    });

    const atlasSize = vec2(cache.manifest.spriteAtlas.width, cache.manifest.spriteAtlas.height);
    const paletteRows = float(cache.paletteAtlas.image.height);
    const aAnchor: ShaderNode = instancedBufferAttribute(anchor, 'vec3');
    const aRect: ShaderNode = instancedBufferAttribute(rect, 'vec4');
    const aParams: ShaderNode = instancedBufferAttribute(params, 'vec4');
    const aFlat: ShaderNode = instancedBufferAttribute(flags, 'float');
    const ppu = float(PIXELS_PER_CELL_EDGE);

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = NormalBlending;
    material.alphaTest = 0.5;
    // Raster-relative coordinates from the quad's own UVs (u right, v down). positionLocal cannot be used here: once
    // positionNode is set it refers to the displaced position in the fragment stage.
    const u: ShaderNode = uv().x;
    const v: ShaderNode = float(1).sub(uv().y);
    const pushAmount: ShaderNode = aParams.w;
    // Vertex stage: corners from the untouched geometry attribute (+-0.5).
    const gu: ShaderNode = positionGeometry.x.add(0.5);
    const gv: ShaderNode = float(0.5).sub(positionGeometry.y);
    material.positionNode = Fn(() => {
      const px = aParams.x.add(gu.mul(aRect.z));
      const py = aParams.y.add(gv.mul(aRect.w));
      const card = aAnchor
        .add(this.cameraRight.mul(px.div(ppu)))
        .sub(this.cameraUp.mul(py.div(ppu)))
        .add(this.toCamera.mul(pushAmount));
      // Ground decal: invert the engine projection at the anchor's height (1 px right = (1/60, -1/60) cells,
      // 1 px down = (1/30, 1/30) cells), so the art covers exactly the same screen pixels while lying on the ground.
      const decal = aAnchor.add(vec3(px.div(60).add(py.div(30)), 0.02, py.div(30).sub(px.div(60))));
      return aFlat.greaterThan(0.5).select(decal, card);
    })();
    material.colorNode = Fn(() => {
      const texel = vec2(aRect.x.add(u.mul(aRect.z)), aRect.y.add(v.mul(aRect.w)));
      const index = floor(texture(cache.spriteAtlas, texel.div(atlasSize)).r.mul(255).add(0.5));
      const paletteUv = vec2(index.add(0.5).div(256), aParams.z.add(0.5).div(paletteRows));
      const lit: ShaderNode = texture(cache.paletteAtlas, paletteUv).rgb.mul(this.light);
      const isShadow = aFlat.greaterThan(1.5);
      const opaque = index.greaterThan(0.5).select(float(1), float(0));
      return isShadow.select(vec4(0, 0, 0, opaque.mul(0.55)), vec4(lit, opaque));
    })();

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, count);
    this.mesh.count = instances.length;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'ra2-sprites';
  }
}

/**
 * World anchor for a map object's engine draw point: the projected top corner of its cell plus `drawOffset`, lifted
 * back onto the ground plane at the object's level so the card sits where the engine draws it.
 */
export function objectAnchor(object: MapObject): Vector3 {
  const [sx, sy] = ra2Screen(object.x, object.y, object.z);
  const [dx, dy] = object.drawOffset ?? [0, 15];
  const [x, y] = screenToCell(sx + dx, sy + dy, object.z);
  return new Vector3(x, object.z * LEVEL_HEIGHT, y);
}
