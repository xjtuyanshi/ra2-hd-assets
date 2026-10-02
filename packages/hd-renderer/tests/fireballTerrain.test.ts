import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  Color,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  Vector3,
  WebGPURenderer,
  type NodeFrame,
} from 'three/webgpu';
import { float, mrt, vec4 } from 'three/tsl';
import { HdRenderer } from '../src/HdRenderer';
import { EffectsLayer, ENHANCED, anchoredDepthShift } from '../src/effects';
import { EffectSpriteLayer, effectSphereRadius, MESH_IDLE_SECONDS } from '../src/live/effectSprites';
import type { Ra2Cache } from '../src/ra2/cache';
import { CARD_CLEARANCE, cardDepthPush } from '../src/ra2/cardDepth';
import { FIREBALL_VOLUME } from '../src/ra2/fireballDepth';
import {
  TerrainDepth,
  TERRAIN_DEPTH_EPSILON,
  TERRAIN_DEPTH_LAYER,
  FRONT_DEPTH_LAYER,
  DepthClass,
  terrainDepthPull,
} from '../src/terrainDepth';
import { PIXELS_PER_CELL_EDGE } from '../src/world';
import {
  anchor,
  blast,
  crops,
  displayed,
  fireDepth,
  horizontal,
  right,
  toCamera,
  unitPointOnRay,
  up,
  viewDir,
} from './fixtures/fireball';
import { createScenario } from '../sandbox/scenario';

const near = 0.1;
const far = 400;
// Use the real orthographic depth slope with a camera origin in front of these synthetic cards.
const normalized = (nearness: number) => (150 - near - nearness) / (far - near);
const surface = (fragment: Vector3, distance: number) =>
  unitPointOnRay(fragment, distance).dot(toCamera) + CARD_CLEARANCE;

describe('Air fire terrain-class depth pull', () => {
  it.each(
    crops.flatMap((crop) => [
      { ...crop, hd: false },
      { ...crop, hd: true },
    ]),
  )('covers tree, bush and wall pixels at the centre, sphere edge and drawn corners of $id (HD=$hd)', (crop) => {
    const card = blast(crop, crop.hd);
    const { cx, cy, lo, width, height } = displayed(card);
    const R = effectSphereRadius(card);
    let sphereMisses = 0;
    for (const kind of ['tree', 'bush', 'wall'])
      for (const distance of [0.5, 1, 1.4, 2, 3])
        for (const r of [0, 0.9 * R, R, 1.1 * R]) {
          // A diagonal reaches outside the sphere while remaining inside both synthetic displayed crops.
          const sx = cx + r / Math.SQRT2;
          const sy = cy + r / Math.SQRT2;
          expect(sx).toBeLessThanOrEqual(lo.x + width);
          expect(sy).toBeLessThanOrEqual(lo.y);
          expect(sy).toBeGreaterThanOrEqual(lo.y - height);
          const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
          const tree = normalized(surface(fragment, distance));
          const fire = normalized(fireDepth(card, sx, sy));
          expect(terrainDepthPull(fire, tree, near, far), `${kind} d=${distance} r/R=${r / R}`).toBeLessThan(tree);
          if (fire >= tree) sphereMisses++;
          if (distance >= 2 || (distance >= 1 && r >= 0.9 * R)) expect(fire).toBeGreaterThan(tree);
        }
    expect(sphereMisses).toBeGreaterThan(30);
  });

  it.each(crops)(
    'keeps every maximum-R $id fragment behind the 1.5-cell foreground unit, with/without a rear tree',
    (crop) => {
      const card = blast(crop);
      card.hd!.size = Math.max(1.3, (FIREBALL_VOLUME.maxRadius * 2 * PIXELS_PER_CELL_EDGE) / crop.width);
      expect(effectSphereRadius(card)).toBeCloseTo(FIREBALL_VOLUME.maxRadius);
      const { lo, width, height } = displayed(card);
      for (let x = 0; x <= 80; x++)
        for (let y = 0; y <= 80; y++) {
          const sx = lo.x + (width * x) / 80;
          const sy = lo.y - (height * y) / 80;
          const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
          const unit = normalized(surface(fragment, 1.5));
          const fire = normalized(fireDepth(card, sx, sy));
          for (const tree of [1, normalized(surface(fragment, 1))])
            expect(terrainDepthPull(fire, tree, near, far) - unit).toBeGreaterThan(0.03 / (far - near));
        }
    },
  );

  it.each(crops)(
    'engulfs a unit inside $id, with/without a rear tree, and leaves rear terrain/far texels unchanged',
    (crop) => {
      const card = blast(crop);
      const { cx, cy } = displayed(card);
      const R = effectSphereRadius(card);
      for (const distance of [0, 0.5, 0.8])
        for (const fraction of [0, 0.3, 0.6]) {
          const sx = cx + fraction * R;
          const sy = cy;
          const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
          const fire = normalized(fireDepth(card, sx, sy));
          const unit = normalized(surface(fragment, distance));
          for (const tree of [1, normalized(surface(fragment, -0.5))])
            expect(terrainDepthPull(fire, tree, near, far)).toBeLessThan(unit);
          for (const tree of [1, normalized(surface(fragment, -0.5)), normalized(surface(fragment, -1))])
            expect(terrainDepthPull(fire, tree, near, far)).toBe(fire);
        }
      expect(terrainDepthPull(1, 1, near, far)).toBe(1);
      expect(terrainDepthPull(1 - 1e-7, 1, near, far)).toBe(1 - 1e-7);
    },
  );

  it('preserves the lifted-two puff / terror-drone 1.5-cells-south regression after the pull', () => {
    const centre = anchor.clone().add(new Vector3(0, 2, 0));
    for (let x = -2; x <= 2; x += 0.1)
      for (let y = -2; y <= 2; y += 0.1) {
        const fragment = centre.clone().addScaledVector(right, x).addScaledVector(up, y);
        const unit = normalized(surface(fragment, 1.5));
        const puff = normalized(
          fragment.dot(toCamera) + anchoredDepthShift(fragment, centre, anchor.y, viewDir, FIREBALL_VOLUME.maxRadius),
        );
        for (const tree of [1, normalized(surface(fragment, 1))])
          expect(terrainDepthPull(puff, tree, near, far)).toBeGreaterThan(unit);
      }
  });

  it.each(crops)(
    'leaves rear trees/bushes unchanged across the complete $id card, including ground-following rows',
    (crop) => {
      for (const hd of [false, true]) {
        const card = blast(crop, hd);
        const { lo, width, height } = displayed(card);
        for (let x = 0; x <= 30; x++)
          for (let y = 0; y <= 30; y++) {
            const sx = lo.x + (width * x) / 30;
            const sy = lo.y - (height * y) / 30;
            const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
            const fire = normalized(fireDepth(card, sx, sy));
            for (const distance of [-0.5, -1, -3]) {
              const base = anchor.clone().addScaledVector(horizontal, distance);
              const relative = fragment.clone().sub(base);
              const tree = normalized(
                base.dot(toCamera) +
                  cardDepthPush(relative.dot(right) * PIXELS_PER_CELL_EDGE, -relative.dot(up) * PIXELS_PER_CELL_EDGE),
              );
              expect(terrainDepthPull(fire, tree, near, far)).toBe(fire);
            }
            expect(terrainDepthPull(fire, 1, near, far)).toBe(fire);
          }
      }
    },
  );

  it('clears depth quantization without consuming the foreground sphere margin', () => {
    const eps = TERRAIN_DEPTH_EPSILON / (far - near);
    expect(eps).toBeGreaterThan(41 / 2 ** 24);
    expect(eps).toBeGreaterThan(20 / 2 ** 23);
    expect(TERRAIN_DEPTH_EPSILON).toBeLessThan(0.03205 / 30);
    const pulled = terrainDepthPull(0.7, 0.5, near, far);
    expect(Math.fround(pulled)).toBeLessThan(Math.round(0.5 * (2 ** 24 - 1)) / (2 ** 24 - 1));
  });
});

function mesh(name: string): Mesh {
  const result = new Mesh(new PlaneGeometry(), new MeshBasicNodeMaterial());
  result.name = name;
  result.frustumCulled = false;
  return result;
}
function release(mesh: Mesh): void {
  mesh.geometry.dispose();
  (mesh.material as MeshBasicNodeMaterial).dispose();
}

/** CPU renderer facade; render-list projection below uses r186's actual _projectObject, not a layer simulation. */
function captureFixture() {
  const target = new RenderTarget(4, 4);
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.sortObjects = false;
  renderer.setRenderTarget(target);
  renderer.setClearDepth(0.8);
  renderer.autoClear = true;
  renderer.autoClearColor = false;
  const clear = vi.spyOn(renderer, 'clear').mockImplementation(() => {});
  vi.spyOn(renderer, 'getDrawingBufferSize').mockImplementation((out) => out.set(320, 180));
  const draws: Mesh[][] = [];
  const project = renderer as unknown as {
    _projectObject(object: Object3D, camera: OrthographicCamera, order: number, list: unknown, clipping: unknown): void;
  };
  const render = vi.spyOn(renderer, 'render').mockImplementation((scene, camera) => {
    const list: Mesh[] = [];
    project._projectObject(scene, camera as OrthographicCamera, 0, { push: (mesh: Mesh) => list.push(mesh) }, {});
    draws.push(list);
  });
  return { renderer, target, clear, render, draws };
}

describe('terrain-only capture ownership and mirror gate', () => {
  it('projects only the registered main meshes, copies the camera, and restores target/MRT/clear state on success/failure', () => {
    const depth = new TerrainDepth();
    const fixture = captureFixture();
    const { renderer, target, clear, render, draws } = fixture;
    const attachments = mrt({ output: vec4(0) });
    renderer.setMRT(attachments);
    renderer.setRenderTarget(target, 2, 1);
    clear.mockImplementation(() => {
      expect([depth.target, depth.frontTarget]).toContain(renderer.getRenderTarget());
      expect(renderer.getMRT()).toBeNull();
      expect(renderer.getClearDepth()).toBe(1);
      expect(scene.background).toBeNull();
      expect(scene.backgroundNode).toBeNull();
    });
    const scene = new Scene();
    scene.background = new Color(0x123456);
    scene.backgroundNode = vec4(0.1, 0.2, 0.3, 1);
    const background = scene.background;
    const backgroundNode = scene.backgroundNode;
    const trees = mesh('tree-main');
    const overlay = mesh('overlay-main');
    const children = ['under', 'over'].flatMap((pass) => {
      const treeChild = mesh(`tree-${pass}`);
      const overlayChild = mesh(`overlay-${pass}`);
      trees.add(treeChild);
      overlay.add(overlayChild);
      return [treeChild, overlayChild];
    });
    const others = ['live-sprites', 'buildings', 'voxels', 'terrain', 'water', 'effects'].map(mesh);
    scene.add(trees, overlay, ...others);
    const camera = new OrthographicCamera(-20, 20, 12, -12, near, far);
    camera.position.set(5, 6, 7);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const unregister = depth.register(trees);
    depth.register(overlay);
    try {
      const materials = [trees.material, overlay.material];
      depth.render(renderer, scene, camera);
      expect(scene.background).toBe(background);
      expect(scene.backgroundNode).toBe(backgroundNode);
      expect(draws).toEqual([[trees, overlay]]);
      expect([trees.material, overlay.material]).toEqual(materials);
      expect(children.every((child) => !child.layers.isEnabled(TERRAIN_DEPTH_LAYER))).toBe(true);
      expect(depth.camera.position).toEqual(camera.position);
      for (const key of ['matrixWorld', 'matrixWorldInverse', 'projectionMatrix', 'projectionMatrixInverse'] as const)
        expect(depth.camera[key]).toEqual(camera[key]);
      expect(depth.camera.layers.mask).toBe((1 << TERRAIN_DEPTH_LAYER) >>> 0);
      expect(camera.layers.mask).toBe(1);
      expect(depth.target.width).toBe(320);
      expect(depth.target.height).toBe(180);
      expect(depth.target.samples).toBe(0);
      expect(depth.target.stencilBuffer).toBe(false);
      expect(depth.target.depthTexture!.type).toBe(FloatType);
      expect(clear).toHaveBeenCalledWith(false, true, false);
      expect(renderer.getRenderTarget()).toBe(target);
      expect(renderer.getMRT()).toBe(attachments);
      expect(renderer.getActiveCubeFace()).toBe(2);
      expect(renderer.getActiveMipmapLevel()).toBe(1);
      expect(renderer.autoClear).toBe(true);
      expect(renderer.autoClearColor).toBe(false);
      expect(renderer.getClearDepth()).toBe(0.8);
      render.mockImplementationOnce(() => {
        throw new Error('capture failed');
      });
      expect(() => depth.render(renderer, scene, camera)).toThrow('capture failed');
      expect(scene.background).toBe(background);
      expect(scene.backgroundNode).toBe(backgroundNode);
      expect(renderer.getRenderTarget()).toBe(target);
      expect(renderer.getMRT()).toBe(attachments);
      expect(renderer.getActiveCubeFace()).toBe(2);
      expect(renderer.getActiveMipmapLevel()).toBe(1);
      expect(renderer.getClearDepth()).toBe(0.8);
      expect(renderer.autoClear).toBe(true);
      unregister();
      expect(trees.layers.mask).toBe(1);
    } finally {
      depth.dispose();
      [trees, overlay, ...children, ...others].forEach(release);
      target.dispose();
    }
  });

  it('clears hidden/empty frames to far, resizes without replacing the shared texture, and disposes once', () => {
    const depth = new TerrainDepth();
    const { renderer, target, clear, render } = captureFixture();
    const scene = new Scene();
    const parent = new Object3D();
    const occluder = mesh('tree');
    parent.add(occluder);
    scene.add(parent);
    depth.register(occluder);
    const texture = depth.target.depthTexture;
    const frontTexture = depth.frontTarget.depthTexture;
    const frontDispose = vi.spyOn(depth.frontTarget, 'dispose');
    const frontTextureDispose = vi.spyOn(frontTexture!, 'dispose');
    const targetDispose = vi.spyOn(depth.target, 'dispose');
    const textureDispose = vi.spyOn(texture!, 'dispose');
    try {
      parent.visible = false;
      depth.render(renderer, scene, new OrthographicCamera());
      expect(render).not.toHaveBeenCalled();
      expect(clear).toHaveBeenCalledTimes(2);
      parent.visible = true;
      (occluder as Mesh & { count: number }).count = 0;
      depth.render(renderer, scene, new OrthographicCamera());
      expect(render).not.toHaveBeenCalled();
      expect(clear).toHaveBeenCalledTimes(4);
      vi.mocked(renderer.getDrawingBufferSize).mockImplementation((out) => out.set(640, 360));
      depth.resize(renderer);
      expect(depth.target.width).toBe(640);
      expect(depth.target.height).toBe(360);
      expect(depth.target.depthTexture).toBe(texture);
      expect(depth.frontTarget.width).toBe(640);
      expect(depth.frontTarget.height).toBe(360);
      expect(depth.frontTarget.depthTexture).toBe(frontTexture);
      targetDispose.mockClear();
      frontDispose.mockClear();
      depth.dispose();
      depth.dispose();
      expect(targetDispose).toHaveBeenCalledTimes(1);
      expect(textureDispose).toHaveBeenCalledTimes(1);
      expect(frontDispose).toHaveBeenCalledTimes(1);
      expect(frontTextureDispose).toHaveBeenCalledTimes(1);
      expect(occluder.layers.mask).toBe(1);
      expect(() => depth.register(occluder)).toThrow('after disposal');
    } finally {
      depth.dispose();
      release(occluder);
      target.dispose();
    }
  });

  it('captures COVER and FRONT independently, skips empty FRONT draws, and gates nested captures/mirrors', () => {
    const depth = new TerrainDepth();
    const { renderer, target, clear, draws, render } = captureFixture();
    const scene = new Scene();
    const tree = mesh('tree');
    const covered = mesh('covered-hull');
    const front = mesh('front-turret');
    const child = mesh('shadow-child');
    covered.add(child);
    scene.add(tree, covered, front);
    const camera = new OrthographicCamera();
    const mirror = camera.clone();
    const reflection = new RenderTarget(2, 2);
    const update = (camera: OrthographicCamera) => {
      depth.captureClass.update({ renderer, camera } as NodeFrame);
      depth.enabled.update({ renderer, camera } as NodeFrame);
      return depth.captureClass.value;
    };
    depth.setMainPass(target, camera);
    depth.register(tree);
    depth.setClass(covered, DepthClass.COVER);
    depth.setClass(front, DepthClass.FRONT);
    const original = render.getMockImplementation()!;
    render.mockImplementation((scene, camera) => {
      const captureCamera = camera as OrthographicCamera;
      expect(update(captureCamera)).toBe(camera === depth.camera ? DepthClass.COVER : DepthClass.FRONT);
      expect(depth.enabled.value).toBe(0);
      const currentTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(reflection);
      expect(update(mirror)).toBe(0);
      renderer.setRenderTarget(currentTarget);
      expect(update(captureCamera)).toBe(camera === depth.camera ? DepthClass.COVER : DepthClass.FRONT);
      original(scene, camera);
    });
    try {
      expect(depth.captureClass.value).toBe(0);
      depth.render(renderer, scene, camera);
      expect(draws).toEqual([[tree, covered], [front]]);
      expect(clear).toHaveBeenCalledTimes(2);
      expect(child.layers.mask).toBe(1);
      expect(depth.frontCamera.layers.mask).toBe(1 << FRONT_DEPTH_LAYER);
      expect(depth.frontTarget.depthTexture!.type).toBe(FloatType);
      expect(depth.frontTarget.samples).toBe(0);
      expect(update(depth.frontCamera)).toBe(0);
      depth.renderMainPass(() => {
        expect(update(camera)).toBe(0);
        expect(depth.enabled.value).toBe(1);
      });
      depth.setClass(front, DepthClass.NONE);
      draws.length = 0;
      depth.render(renderer, scene, camera);
      expect(draws).toEqual([[tree, covered]]);
      expect(front.layers.mask).toBe(1);
      render.mockImplementationOnce(() => {
        throw new Error('capture failure');
      });
      expect(() => depth.render(renderer, scene, camera)).toThrow('capture failure');
      expect(depth.captureClass.value).toBe(0);
      expect(update(depth.camera)).toBe(0);
      expect(renderer.getRenderTarget()).toBe(target);
    } finally {
      depth.dispose();
      [tree, covered, front, child].forEach(release);
      target.dispose();
      reflection.dispose();
    }
  });

  it('updates the actual object uniform for main -> mirror -> main and defaults off outside the pipeline/WebGPU', () => {
    const depth = new TerrainDepth();
    const { renderer, target } = captureFixture();
    const camera = new OrthographicCamera();
    const mirror = camera.clone();
    const reflection = new RenderTarget(2, 2);
    const scene = new Scene();
    depth.setMainPass(target, camera);
    const update = (activeCamera = camera) => {
      depth.enabled.update({ renderer, camera: activeCamera } as NodeFrame);
      return depth.enabled.value;
    };
    try {
      expect(depth.enabled.value).toBe(0);
      expect(update()).toBe(0);
      depth.render(renderer, scene, camera);
      depth.renderMainPass(() => {
        expect(update()).toBe(1);
        renderer.setRenderTarget(reflection);
        expect(update(mirror)).toBe(0);
        renderer.setRenderTarget(target);
        expect(update()).toBe(1);
        expect(update(mirror)).toBe(0);
      });
      expect(update()).toBe(0);
      (renderer.backend as unknown as { isWebGPUBackend: boolean }).isWebGPUBackend = false;
      depth.renderMainPass(() => expect(update()).toBe(0));
      depth.render(renderer, scene, camera);
      depth.renderMainPass(() => expect(update()).toBe(0));
      expect(() =>
        depth.renderMainPass(() => {
          throw new Error('main failed');
        }),
      ).toThrow('main failed');
      expect(depth.enabled.value).toBe(0);
    } finally {
      depth.dispose();
      target.dispose();
      reflection.dispose();
    }
  });

  it('wires only LiveView tree/overlay mains; non-live worlds can contain buildings and never register them', () => {
    const live = readFileSync(new URL('../src/live/liveView.ts', import.meta.url), 'utf8');
    const world = readFileSync(new URL('../src/ra2/world.ts', import.meta.url), 'utf8');
    const renderer = readFileSync(new URL('../src/HdRenderer.ts', import.meta.url), 'utf8');
    expect(live.match(/terrainDepth.register\([^)]*\)/g)).toEqual([
      'terrainDepth.register(world.sprites.mesh)',
      'terrainDepth.register(this.cellLayer.mesh)',
      'terrainDepth.register(layer.mesh)',
    ]);
    expect(live).toContain("includeObject: (object) => object.kind === 'tree'");
    expect(world).toContain("if (object.kind === 'building')");
    expect(world).not.toContain('terrainDepth.register');
    expect(renderer).not.toContain('terrainDepth.register');
    expect(renderer).toContain('this.terrainDepth.render(this.renderer, this.scene, this.view.camera)');
    expect(renderer).toContain('this.terrainDepth.renderMainPass(() => this.pipeline!.render())');
  });

  it('HdRenderer owns resize/disposal and excludes the capture target from pipeline rebuild ownership', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const canvas = {
      width: 1,
      height: 1,
      style: {},
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;
    const hd = new HdRenderer(canvas, createScenario(2, 2));
    const dispose = vi.spyOn(hd.terrainDepth, 'dispose');
    const target = hd.terrainDepth.target;
    const targetDispose = vi.spyOn(target, 'dispose');
    vi.spyOn(hd.renderer, 'dispose').mockImplementation(() => {});
    try {
      hd.resize(100, 60);
      expect(hd.terrainDepth.target.width).toBe(200);
      expect(hd.terrainDepth.target.height).toBe(120);
      targetDispose.mockClear();
      const internal = hd as unknown as { buildPipeline(): void };
      internal.buildPipeline();
      hd.settings.antialias = 'none';
      internal.buildPipeline();
      expect(hd.terrainDepth.target).toBe(target);
      expect(targetDispose).not.toHaveBeenCalled();
      hd.dispose();
      hd.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      hd.dispose();
      vi.unstubAllGlobals();
    }
  });
});

/** Build the actual bundled r186 WGSL graph without a device. This is not GPU shader validation. */
function shaders(mesh: Mesh) {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = renderer.hasCompatibility = () => false;
  const backend = renderer.backend as unknown as {
    capabilities: { getUniformBufferLimit(): number };
    createNodeBuilder(
      mesh: Mesh,
      renderer: WebGPURenderer,
    ): {
      camera: OrthographicCamera;
      scene: Scene;
      build(): void;
      fragmentShader: string;
      vertexShader: string;
    };
  };
  backend.capabilities.getUniformBufferLimit = () => 65536;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.camera = new OrthographicCamera(-1, 1, 1, -1, near, far);
  builder.scene = new Scene();
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
}

describe('Air material and explosion-garnish construction', () => {
  it.each([false, true])(
    'pulls native/HD explosion and collapse cards only in Air, excluding flat/shadow through the draw scalar (HD=%s)',
    (hd) => {
      const depth = new TerrainDepth();
      const texture = new DataTexture(new Uint8Array(256 * 4), 256, 1);
      const cache = { paletteAtlas: texture, paletteRow: new Map([['anim', 0]]) } as unknown as Ra2Cache;
      const atlas = { texture, width: 256, height: 1 };
      const layer = new EffectSpriteLayer(
        cache,
        () => atlas,
        undefined,
        () => atlas,
        undefined,
        depth,
      );
      try {
        for (const category of ['explosion', 'collapse', 'smoke', 'muzzle'] as const)
          for (const pass of ['air', 'ground', 'top'] as const)
            for (const draw of ['card', 'flat', 'shadow'] as const) {
              const card = { ...blast(crops[0], hd), pass, draw, category };
              layer.setInstances([card], 0);
              const mesh = layer.root.children.find((child) => child.visible)! as Mesh;
              const shader = shaders(mesh);
              expect(shader.fragment.includes('terrainDepthPullEnabled')).toBe(pass === 'air');
              if (pass === 'air') {
                expect(shader.fragment).toContain('textureLoad(');
                expect(shader.fragment).toContain('min(');
                expect(shader.vertex).toMatch(/(nodeVar\d+) = floor\(/);
                const drawVar = shader.vertex.match(/(nodeVar\d+) = floor\(/)![1]!;
                expect(shader.vertex).toContain(`${drawVar} == 0.0`);
              }
            }
      } finally {
        layer.setInstances([], MESH_IDLE_SECONDS + 1);
        texture.dispose();
        depth.dispose();
      }
    },
  );

  it('pulls fire core, blast, halos, smoke billows/columns and explosion sparks/embers, while gating shared pools', () => {
    const depth = new TerrainDepth();
    const effects = new EffectsLayer(undefined, depth);
    type Pool = { mesh: Mesh; params: { getW(index: number): number } };
    const pools = effects as unknown as Record<string, Pool>;
    try {
      const affected = ['garnishFire', 'blast', 'halo', 'billow', 'column', 'sparks', 'airborneEmbers'];
      for (const key of affected) {
        const shader = shaders(pools[key]!.mesh);
        expect(shader.fragment, key).toContain('terrainDepthPullEnabled');
        expect(shader.fragment, key).toContain('textureLoad(');
      }
      for (const key of [
        'fireballs',
        'flames',
        'smoke',
        'muzzleStar',
        'scorch',
        'shock',
        'embers',
        'dots',
        'debris',
        'debrisShadow',
        'shimmer',
        'dust',
        'beams',
      ])
        expect(shaders(pools[key]!.mesh).fragment, key).not.toContain('terrainDepthPullEnabled');
      effects.explode(0, anchor, 1, new Vector3(), { enhanced: true, maxSize: 2 });
      expect(pools.garnishFire!.params.getW(0)).toBeLessThan(0);
      expect(pools.halo!.params.getW(0)).toBe(-3);
      expect(pools.sparks!.params.getW(0)).toBe(4);
      expect(pools.airborneEmbers!.params.getW(0)).toBeLessThan(0);
      effects.muzzleFlash(0, anchor, 1, { enhanced: true });
      expect(pools.garnishFire!.params.getW(1)).toBeGreaterThanOrEqual(0);
      expect(pools.halo!.params.getW(1)).toBeGreaterThanOrEqual(0);
      effects.fireEmbers(0, anchor.clone(), 1, new Vector3());
      expect(
        Array.from({ length: ENHANCED.embers.pool }, (_, i) => pools.airborneEmbers!.params.getW(i)).some(
          (mode) => mode > 0,
        ),
      ).toBe(true);
      // Explosion temperature magnitude remains in the existing authored range.
      expect(Math.abs(pools.airborneEmbers!.params.getW(0))).toBeGreaterThanOrEqual(ENHANCED.embers.temperature[0]);
      expect(Math.abs(pools.airborneEmbers!.params.getW(0))).toBeLessThanOrEqual(ENHANCED.embers.temperature[1]);
    } finally {
      effects.root.children.forEach((child) => release(child as Mesh));
      depth.dispose();
    }
  });

  it('omits the pull sampler from the WebGL2 fallback shader graph', () => {
    const depth = new TerrainDepth();
    const m = mesh('fallback');
    (m.material as MeshBasicNodeMaterial).depthNode = depth.node(float(0.5));
    // Exercise the same Fn backend branch with the CPU WGSL builder, without creating a WebGL context.
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    (renderer.backend as unknown as { isWebGPUBackend: boolean }).isWebGPUBackend = false;
    renderer.hasFeature = renderer.hasCompatibility = () => false;
    const backend = renderer.backend as unknown as {
      capabilities: { getUniformBufferLimit(): number };
      createNodeBuilder(
        mesh: Mesh,
        renderer: WebGPURenderer,
      ): { camera: OrthographicCamera; scene: Scene; build(): void; fragmentShader: string };
    };
    backend.capabilities.getUniformBufferLimit = () => 65536;
    try {
      const builder = backend.createNodeBuilder(m, renderer);
      builder.camera = new OrthographicCamera();
      builder.scene = new Scene();
      builder.build();
      expect(builder.fragmentShader).not.toContain('terrainDepthPullEnabled');
      expect(builder.fragmentShader).not.toContain('textureLoad(');
    } finally {
      release(m);
      depth.dispose();
    }
  });
});
