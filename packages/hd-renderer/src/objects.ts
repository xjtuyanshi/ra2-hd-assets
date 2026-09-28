import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Object3D,
} from 'three/webgpu';
import { mx_noise_float, positionLocal, uniform } from 'three/tsl';
import { HOUSE_COLORS, type RenderObject } from './contract';
import { LEVEL_HEIGHT, cellToWorld } from './world';

/**
 * Placeholder geometry for the sandbox. Real assets arrive as glTF (vehicles) or relightable sprite atlases
 * (buildings/infantry) keyed by RenderObject.type; until then these stand-ins exercise lighting, shadows and motion.
 */
export class ObjectLayer {
  readonly root = new Object3D();
  /** 0..1, raised at night so building windows glow. */
  readonly night = uniform(0);
  private readonly nodes = new Map<number, { group: Group; turret?: Object3D }>();
  private readonly houseMaterials = new Map<number, MeshStandardNodeMaterial>();
  private readonly dark = metal(0x2a2b2c, 0.35, 0.8);
  private readonly steel = metal(0x6c7074, 0.5, 0.45);
  private readonly concrete = matte(0x9a968c);
  private readonly bark = matte(0x4a3423);
  private readonly leaves = matte(0x2f5a1f);
  private readonly windows: MeshStandardNodeMaterial;

  constructor() {
    this.windows = new MeshStandardNodeMaterial({ color: 0x1b2430, roughness: 0.2, metalness: 0.1 });
    // Warm window light that flickers slightly per pane at night.
    const flicker = mx_noise_float(positionLocal.mul(4)).mul(0.25).add(0.75);
    this.windows.emissiveNode = uniform(new Color(1.0, 0.72, 0.35))
      .mul(this.night.mul(3.0))
      .mul(flicker);
  }

  sync(objects: readonly RenderObject[], heightAt: (x: number, z: number) => number): void {
    const seen = new Set<number>();
    for (const object of objects) {
      seen.add(object.id);
      let node = this.nodes.get(object.id);
      if (!node) {
        node = this.create(object);
        this.nodes.set(object.id, node);
        this.root.add(node.group);
      }
      const ground = object.kind === 'ship' ? object.z : heightAt(object.x, object.y) / LEVEL_HEIGHT;
      cellToWorld(object.x, object.y, object.kind === 'aircraft' ? object.z : ground, node.group.position);
      // Facing 0 points to map north-east (screen right-up); rotate about +y (clockwise seen from above).
      node.group.rotation.y = -object.facing;
      if (node.turret && object.turretFacing !== undefined)
        node.turret.rotation.y = -(object.turretFacing - object.facing);
    }
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        this.root.remove(node.group);
        this.nodes.delete(id);
      }
    }
  }

  private house(house: number): MeshStandardNodeMaterial {
    let material = this.houseMaterials.get(house);
    if (!material) {
      material = metal(house < 0 ? 0x8a8a80 : HOUSE_COLORS[house % HOUSE_COLORS.length]!, 0.45, 0.4);
      this.houseMaterials.set(house, material);
    }
    return material;
  }

  private create(object: RenderObject) {
    const group = new Group();
    group.name = `${object.type}#${object.id}`;
    let turret: Object3D | undefined;
    const add = (mesh: Mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    switch (object.kind) {
      case 'vehicle': {
        // Local +x is the vehicle's forward axis.
        add(new Mesh(new BoxGeometry(0.78, 0.16, 0.5), this.house(object.house))).position.y = 0.2;
        for (const side of [-1, 1])
          add(new Mesh(new BoxGeometry(0.84, 0.16, 0.13), this.dark)).position.set(0, 0.09, side * 0.25);
        turret = new Group();
        turret.position.y = 0.3;
        const dome = new Mesh(new CylinderGeometry(0.17, 0.2, 0.12, 16), this.house(object.house));
        dome.castShadow = true;
        const barrel = new Mesh(new CylinderGeometry(0.03, 0.035, 0.5, 10), this.steel);
        barrel.rotation.z = Math.PI / 2;
        barrel.position.set(0.3, 0.02, 0);
        barrel.castShadow = true;
        turret.add(dome, barrel);
        group.add(turret);
        break;
      }
      case 'ship': {
        const hull = add(new Mesh(new BoxGeometry(1.6, 0.22, 0.45), this.house(object.house)));
        hull.position.y = 0.05;
        add(new Mesh(new BoxGeometry(0.45, 0.28, 0.3), this.steel)).position.set(-0.2, 0.3, 0);
        break;
      }
      case 'building': {
        const w = object.footprint?.width ?? 2;
        const d = object.footprint?.height ?? 2;
        const h = 0.55 + (w * d) / 20;
        const body = add(new Mesh(new BoxGeometry(w * 0.86, h, d * 0.86), this.concrete));
        body.position.set(w / 2, h / 2, d / 2);
        const roof = add(new Mesh(new BoxGeometry(w * 0.6, 0.12, d * 0.6), this.house(object.house)));
        roof.position.set(w / 2, h + 0.06, d / 2);
        const band = add(new Mesh(new BoxGeometry(w * 0.87, 0.1, d * 0.87), this.windows));
        band.position.set(w / 2, h * 0.62, d / 2);
        const stack = add(new Mesh(new CylinderGeometry(0.1, 0.13, 0.7, 12), this.steel));
        stack.position.set(w * 0.25, h + 0.35, d * 0.25);
        // Buildings are anchored at their footprint's top-left cell, not their centre.
        group.userData.anchor = 'footprint';
        break;
      }
      case 'tree': {
        add(new Mesh(new CylinderGeometry(0.04, 0.06, 0.35, 8), this.bark)).position.y = 0.17;
        const crown = add(new Mesh(new ConeGeometry(0.3, 0.8, 10), this.leaves));
        crown.position.y = 0.7;
        break;
      }
      default:
        add(new Mesh(new BoxGeometry(0.2, 0.3, 0.2), this.house(object.house))).position.y = 0.15;
    }
    return { group, turret };
  }
}

function metal(hex: number, metalness: number, roughness: number): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ color: hex, metalness, roughness });
}

function matte(hex: number): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ color: hex, metalness: 0, roughness: 0.9 });
}
