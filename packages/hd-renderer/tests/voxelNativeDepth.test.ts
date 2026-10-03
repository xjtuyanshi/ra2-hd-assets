import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardNodeMaterial, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { IsoCamera, PIXELS_PER_CELL_EDGE } from '../src/world';
import { AtmosphereNodes } from '../src/atmosphere';
import { TerrainDepth } from '../src/terrainDepth';
import { GROUND_DEPTH, NATIVE_UNIT_RENDER_ORDER, nativeCardPush } from '../src/ra2/nativeDepth';
import { setShadowGround } from '../src/ra2/voxelShadow';
import {
  VOXEL_CARD_KAPPA,
  voxelBitmapBottom,
  voxelCardDelta,
  voxelFragmentRow,
  voxelNativeDepthNode,
} from '../src/ra2/voxelNativeDepth';
import { createVoxelMaterial, instantiateVoxel, updateVoxelNativeDepth, VOXEL_CLEARANCE } from '../src/ra2/voxels';

const forward = new Vector3(-Math.sqrt(3 / 8), -0.5, -Math.sqrt(3 / 8));

describe('native voxel card projection', () => {
  it('matches the fixed camera screen rows at nonzero anchors, heights and zoom', () => {
    const iso = new IsoCamera();
    const anchor = new Vector3(35.25, 3.75, 7.5);
    const point = new Vector3(35.9, 4.4, 8.7);
    for (const zoom of [0.5, 1, 3]) {
      iso.zoom = zoom;
      iso.target.set(20, 0, 15);
      iso.resize(800, 600);
      iso.update();
      const a = anchor.clone().project(iso.camera);
      const p = point.clone().project(iso.camera);
      const nativeRows = ((a.y - p.y) * 300) / zoom;
      expect(voxelFragmentRow(point, anchor)).toBeCloseTo(nativeRows, 10);
    }
    expect(voxelFragmentRow(anchor.clone().add(new Vector3(1, 0, 1)), anchor)).toBeCloseTo(30, 10);
    expect(voxelFragmentRow(anchor.clone().add(new Vector3(0, 1, 0)), anchor)).toBeCloseTo(
      -Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE,
      10,
    );
  });

  it('bounds card approximation error by KAPPA and retains internal face ordering', () => {
    const anchor = new Vector3(12, 2, 8);
    const bottom = 17;
    const bonus = 13;
    let maxDistanceToCard = 0;
    let maxResidual = 0;
    for (let bits = 0; bits < 8; bits++) {
      const offset = new Vector3(bits & 1 ? 0.8 : -0.6, bits & 2 ? 1.4 : -0.2, bits & 4 ? 0.9 : -0.7);
      const point = anchor.clone().add(offset);
      const physical = offset.dot(forward);
      const ideal = -nativeCardPush(voxelFragmentRow(point, anchor), bottom, bonus);
      const corrected = physical - voxelCardDelta(point, anchor, bottom, bonus);
      expect(corrected - ideal).toBeCloseTo(VOXEL_CARD_KAPPA * (physical - ideal), 12);
      maxDistanceToCard = Math.max(maxDistanceToCard, Math.abs(physical - ideal));
      maxResidual = Math.max(maxResidual, Math.abs(corrected - ideal));
    }
    expect(maxResidual).toBeLessThanOrEqual(VOXEL_CARD_KAPPA * maxDistanceToCard + 1e-12);

    // Two faces on the same camera ray share the card row; the nearer face must remain nearer.
    const front = anchor.clone().add(new Vector3(0.2, 0.6, 0.1));
    const back = front.clone().addScaledVector(forward, 1.5);
    const nearDepth = front.clone().sub(anchor).dot(forward) - voxelCardDelta(front, anchor, bottom);
    const farDepth = back.clone().sub(anchor).dot(forward) - voxelCardDelta(back, anchor, bottom);
    expect(voxelFragmentRow(front, anchor)).toBeCloseTo(voxelFragmentRow(back, anchor), 12);
    expect(farDepth - nearDepth).toBeCloseTo(1.5 * VOXEL_CARD_KAPPA, 12);
  });

  it('uses the per-fragment floor and an additive refinery bonus', () => {
    const anchor = new Vector3();
    const row = (py: number) => new Vector3(py / 30, 0, py / 30);
    for (const py of [-4.01, -4, -3.99, 1.25, 10.1]) {
      const point = row(py);
      const physical = point.dot(forward);
      expect(voxelCardDelta(point, anchor, 2)).toBeCloseTo(
        (1 - VOXEL_CARD_KAPPA) * (physical + (2 + Math.floor((2 - py) / 3)) * GROUND_DEPTH),
        12,
      );
      expect(voxelCardDelta(point, anchor, 2, 13) - voxelCardDelta(point, anchor, 2)).toBeCloseTo(
        (1 - VOXEL_CARD_KAPPA) * 13 * GROUND_DEPTH,
        12,
      );
    }
  });
});

describe('posed voxel bitmap bounds', () => {
  it('refreshes static card bounds when renderer attachment adds terrain tilt', () => {
    const geometry = new BoxGeometry(2, 1, 4);
    const material = new MeshStandardNodeMaterial();
    const unit = instantiateVoxel([{ role: 'body', geometry, turretOffset: 0 }], material);
    updateVoxelNativeDepth(unit, unit.root.position);
    const flat = unit.root.nativeDepth.bottom;
    const scene = new Scene();
    scene.add(unit.root);
    setShadowGround(scene, { height: () => 0, normal: (_x, _z, out) => out.set(-1, 1, 0).normalize() });
    scene.updateMatrixWorld(true);
    expect(unit.root.nativeDepth.bottom).not.toBe(flat);
    expect(unit.root.nativeDepth.bottom).toBe(voxelBitmapBottom(unit.root.partMeshes, unit.root.position));
    geometry.dispose();
    material.dispose();
  });

  it('projects all eight world AABB corners after facing and articulation while excluding every twin', () => {
    const body = new BoxGeometry(2, 1, 4);
    const barrel = new BoxGeometry(2, 0.2, 0.2);
    barrel.translate(1, 1, 0);
    const material = new MeshStandardNodeMaterial();
    const unit = instantiateVoxel(
      [
        { role: 'body', geometry: body, turretOffset: 0 },
        { role: 'barrel', geometry: barrel, turretOffset: 3 },
      ],
      material,
    );
    unit.root.position.set(10, 2, 20);
    const anchor = unit.root.position.clone();
    updateVoxelNativeDepth(unit, anchor, 13);
    const firstBottom = unit.root.nativeDepth.bottom;
    // Body has y=-0.5, and the offset barrel extends the union to x=5. The union's z maximum remains 2.
    expect(firstBottom).toBe(Math.floor(15 * (5 + 2) + 0.5 * Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE));
    expect(unit.root.nativeDepth).toMatchObject({ bonus: 13, enabled: 1 });
    for (const mesh of unit.root.partMeshes) expect(mesh.userData.voxelNativeDepth).toBe(unit.root.nativeDepth);
    for (const twin of unit.root.children.filter(
      (child) => child instanceof Mesh && !unit.root.partMeshes.includes(child),
    )) {
      twin.scale.setScalar(1000);
      expect(twin.userData.voxelNativeDepth).toBeUndefined();
    }
    expect(voxelBitmapBottom(unit.root.partMeshes, anchor)).toBe(firstBottom);

    unit.turret!.rotation.y = Math.PI;
    updateVoxelNativeDepth(unit, anchor);
    expect(unit.root.nativeDepth.bottom).toBeLessThan(firstBottom);
    const turnedTurret = unit.root.nativeDepth.bottom;
    unit.root.rotation.y = Math.PI / 4;
    updateVoxelNativeDepth(unit, anchor);
    expect(unit.root.nativeDepth.bottom).not.toBe(turnedTurret);

    // Ground/bridge anchor and model translate together: bitmap bounds remain relative to that draw point.
    const bottom = unit.root.nativeDepth.bottom;
    const translation = new Vector3(50, 3.5, -20);
    unit.root.position.add(translation);
    anchor.add(translation);
    updateVoxelNativeDepth(unit, anchor);
    expect(unit.root.nativeDepth.bottom).toBe(bottom);
    unit.root.setPainterBias(0.125);
    updateVoxelNativeDepth(unit, anchor, 0, false);
    expect(unit.root.nativeDepth.enabled).toBe(0);
    expect(unit.root.partMeshes[0]!.userData.painterDepth.bias).toBeCloseTo(VOXEL_CLEARANCE + 0.125);
    body.dispose();
    barrel.dispose();
    material.dispose();
  });
});

describe('native ground voxel color pass', () => {
  it('shares a late depth-writing variant, preserves physical sources/twins, and restores flight', () => {
    const geometry = new BoxGeometry();
    const nodes = new AtmosphereNodes();
    const material = createVoxelMaterial(nodes);
    const capture = new TerrainDepth(1);
    const first = instantiateVoxel([{ role: 'body', geometry, turretOffset: 0 }], material);
    const second = instantiateVoxel([{ role: 'body', geometry, turretOffset: 0 }], material);
    const mesh = first.root.partMeshes[0]!;
    mesh.renderOrder = 17;
    capture.setCaptured(mesh, true, -3);
    const capturedLayers = mesh.layers.mask;
    const twins = first.root.children.filter((child): child is Mesh => child instanceof Mesh && child !== mesh);
    const originalTwins = twins.map((twin) => twin.material);
    updateVoxelNativeDepth(first, first.root.position);
    updateVoxelNativeDepth(second, second.root.position);
    const variant = mesh.material as MeshStandardNodeMaterial;
    expect(variant).not.toBe(material);
    expect(second.root.partMeshes[0]!.material).toBe(variant);
    expect(variant.transparent).toBe(true);
    expect(variant.depthWrite).toBe(true);
    expect(variant.depthNode).toBe(material.depthNode);
    expect(mesh.renderOrder).toBe(NATIVE_UNIT_RENDER_ORDER);
    expect(material.transparent).toBe(false);
    expect(mesh.userData.objectDepthAnchorCode).toBe(-3);
    expect(mesh.layers.mask).toBe(capturedLayers);
    twins.forEach((twin, i) => expect(twin.material).toBe(originalTwins[i]));
    updateVoxelNativeDepth(first, first.root.position, 0, false);
    expect(mesh.material).toBe(material);
    expect(mesh.renderOrder).toBe(17);
    expect(material.transparent).toBe(false);
    const dispose = vi.spyOn(variant, 'dispose');
    nodes.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    capture.dispose();
    geometry.dispose();
  });
});

describe('voxel native depth shaders', () => {
  it.each([false, true])('builds fragment rows, floor and additive painter depth (WebGL=%s)', (forceWebGL) => {
    const material = new MeshStandardNodeMaterial();
    const geometry = new BoxGeometry();
    const unit = instantiateVoxel([{ role: 'body', geometry, turretOffset: 0 }], material);
    updateVoxelNativeDepth(unit, new Vector3(1, 2, 3), 13);
    const mesh = unit.root.partMeshes[0]!;
    const canvas = {
      width: 64,
      height: 64,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
    const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const iso = new IsoCamera();
    iso.resize(64, 64);
    iso.update();
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new Scene();
    builder.camera = iso.camera;
    builder.build();
    expect(builder.fragmentShader).toContain('voxelNativeRow');
    expect(builder.fragmentShader).toContain('voxelNativeDelta');
    expect(builder.fragmentShader).toContain('floor(');
    expect(builder.fragmentShader).toContain('0.94');
    expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
    geometry.dispose();
    material.dispose();
  });

  it('omits all native and painter corrections from shadow shaders', () => {
    const material = new MeshStandardNodeMaterial();
    Object.assign(material, { isShadowPassMaterial: true });
    material.depthNode = voxelNativeDepthNode();
    const geometry = new BoxGeometry();
    const mesh = new Mesh(geometry, material);
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new Scene();
    builder.camera = new IsoCamera().camera;
    builder.build();
    expect(builder.fragmentShader).not.toContain('voxelNative');
    expect(builder.fragmentShader).not.toContain('0.94');
    geometry.dispose();
    material.dispose();
  });
});
