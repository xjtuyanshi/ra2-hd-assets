/**
 * ?vbake=1 (development only): isolated renders of placed voxel units for the vehicle redraw pipeline
 * (packages/ra2-assets/python/vehicle_projection.py bakes). Exposes window.__bake:
 *   isolate(rgb)          show only the source meshes of the placed voxel units (no terrain, sprites or shadows) over a
 *                         flat background colour, post effects that bleed into the background off
 *   pose(i, facing, part) put unit i at engine facing 0..255 (turret aligned) and show 'all' | 'body' | 'turret'
 *   swapMaterials(i, j)   draw unit i with unit j's palette materials (house colour difference = house paint mask)
 *   project(i)            canvas pixel positions of unit i's origin and turret pivot
 *   normals(i, part)      data URL of a world-normal pass (rgb = n * 0.5 + 0.5, alpha = coverage) at canvas size
 * Everything it draws is derived from the player's game files and stays in untracked directories.
 */
import {
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  RenderTarget,
  UnsignedByteType,
  Vector3,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { normalWorld, vec4 } from 'three/tsl';
import type { HdRenderer } from '../src/HdRenderer';
import type { HdWorld } from '../src/ra2/world';
import { VoxelUnit } from '../src/ra2/voxels';

interface BakeUnit {
  root: VoxelUnit;
  body: Mesh[];
  turret: Group | null;
  turretMeshes: Mesh[];
  materials: Map<Mesh, Material | Material[]>;
}

export function installBake(hd: HdRenderer, world: HdWorld): void {
  const units: BakeUnit[] = [];
  world.root.traverse((o: Object3D) => {
    if (!(o instanceof VoxelUnit)) return;
    const body: Mesh[] = [];
    const turretMeshes: Mesh[] = [];
    let turret: Group | null = null;
    for (const child of o.children) {
      if (child instanceof Mesh && child.name !== 'voxel-shadow') body.push(child);
      else if (child instanceof Group) {
        turret = child;
        child.traverse((c) => {
          if (c instanceof Mesh && c.name !== 'voxel-shadow') turretMeshes.push(c);
        });
      }
    }
    const materials = new Map<Mesh, Material | Material[]>();
    for (const m of [...body, ...turretMeshes]) materials.set(m, m.material);
    units.push({ root: o, body, turret, turretMeshes, materials });
  });
  const shown = new Set<Object3D>();
  const normalMaterial = new MeshBasicNodeMaterial();
  normalMaterial.colorNode = vec4(normalWorld.mul(0.5).add(0.5), 1);
  let target: RenderTarget | null = null;

  const api = {
    count: () => units.length,
    info: (i: number) => {
      const u = units[i]!;
      return {
        body: u.body.length,
        turret: u.turretMeshes.length,
        turretOffset: u.turret ? u.turret.position.x : null,
        position: u.root.position.toArray(),
      };
    },
    isolate(rgb: [number, number, number]) {
      hd.settings.bloom = 0;
      hd.settings.vignette = 0;
      hd.settings.sharpness = -1;
      hd.applySettings();
      shown.clear();
      for (const u of units) for (const m of [...u.body, ...u.turretMeshes]) shown.add(m);
      hd.scene.traverse((o) => {
        const any = o as Object3D & { isMesh?: boolean; isPoints?: boolean; isSprite?: boolean; isLine?: boolean };
        if (any.isMesh || any.isPoints || any.isSprite || any.isLine) o.visible = shown.has(o);
      });
      hd.scene.background = new Color().setRGB(rgb[0], rgb[1], rgb[2]);
      return shown.size;
    },
    background(rgb: [number, number, number]) {
      (hd.scene.background as Color).setRGB(rgb[0], rgb[1], rgb[2]);
    },
    pose(i: number, facing: number, part: 'all' | 'body' | 'turret') {
      units.forEach((u, k) => {
        const on = k === i;
        for (const m of u.body) m.visible = on && part !== 'turret';
        for (const m of u.turretMeshes) m.visible = on && part !== 'body';
      });
      const u = units[i]!;
      u.root.rotation.y = Math.PI / 2 - (facing / 256) * Math.PI * 2;
      if (u.turret) u.turret.rotation.y = 0;
      u.root.updateMatrix();
      u.root.updateMatrixWorld(true);
    },
    swapMaterials(i: number, j: number | null) {
      const u = units[i]!;
      const meshes = [...u.body, ...u.turretMeshes];
      if (j === null) {
        for (const m of meshes) m.material = u.materials.get(m)!;
        return;
      }
      const v = units[j]!;
      const donors = [...v.body, ...v.turretMeshes];
      meshes.forEach((m, k) => {
        m.material = v.materials.get(donors[k]!)!;
      });
    },
    project(i: number) {
      const u = units[i]!;
      const cam = hd.view.camera;
      const canvas = hd.renderer.domElement;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const px = (p: Vector3) => {
        const v = p.clone().project(cam);
        return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
      };
      const origin = new Vector3().setFromMatrixPosition(u.root.matrixWorld);
      const pivot = u.turret ? new Vector3().setFromMatrixPosition(u.turret.matrixWorld) : origin.clone();
      return { origin: px(origin), pivot: px(pivot), originWorld: origin.toArray(), pivotWorld: pivot.toArray() };
    },
    async normals(i: number, part: 'all' | 'body' | 'turret'): Promise<string> {
      api.pose(i, facingOf(units[i]!), part);
      const canvas = hd.renderer.domElement;
      const w = canvas.width;
      const h = canvas.height;
      if (!target || target.width !== w || target.height !== h) {
        target?.dispose();
        target = new RenderTarget(w, h, { samples: 4, type: UnsignedByteType, colorSpace: NoColorSpace });
      }
      const scene = hd.scene;
      const background = scene.background;
      scene.background = null;
      scene.overrideMaterial = normalMaterial;
      const renderer = hd.renderer;
      const clear = renderer.getClearColor(new Color());
      const clearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(new Color(0, 0, 0), 0);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, hd.view.camera);
      renderer.setRenderTarget(null);
      renderer.setClearColor(clear, clearAlpha);
      scene.overrideMaterial = null;
      scene.background = background;
      const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)) as Uint8Array;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      const image = ctx.createImageData(w, h);
      // WebGPU read-backs pad each row to 256 bytes.
      const stride = Math.ceil((w * 4) / 256) * 256;
      for (let y = 0; y < h; y++) image.data.set(pixels.subarray(y * stride, y * stride + w * 4), y * w * 4);
      ctx.putImageData(image, 0, 0);
      return c.toDataURL('image/png');
    },
  };
  function facingOf(u: BakeUnit): number {
    return Math.round(((Math.PI / 2 - u.root.rotation.y) / (Math.PI * 2)) * 256);
  }
  (window as unknown as { __bake: typeof api }).__bake = api;
}
