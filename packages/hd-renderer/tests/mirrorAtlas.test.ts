import { describe, expect, it } from 'vitest';
import { reflector } from 'three/tsl';
import {
  Box3,
  NodeFrame,
  OrthographicCamera,
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type Camera,
  type RenderTarget,
} from 'three/webgpu';
import {
  MirrorAtlas,
  mirrorAtlasLayout,
  mirrorAtlasTileRect,
  mirrorAtlasUv,
  mirrorCamera,
  type MirrorAtlasRenderer,
} from '../src/mirrorAtlas';
import type { ShaderNode } from '../src/tsl';

/** A fixed dimetric camera above the ground, looking at (x, 0, z) from 30 degrees above the horizon. */
function dimetric(x = 13, z = -9, coordinateSystem = WebGPUCoordinateSystem): OrthographicCamera {
  const camera = new OrthographicCamera(-20, 20, 12, -12, 0.1, 400);
  camera.coordinateSystem = coordinateSystem;
  camera.updateProjectionMatrix();
  const pitch = Math.PI / 6;
  const target = new Vector3(x, 0, z);
  camera.position
    .copy(target)
    .addScaledVector(new Vector3(Math.cos(pitch) * Math.SQRT1_2, Math.sin(pitch), Math.cos(pitch) * Math.SQRT1_2), 150);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

interface Call {
  camera: Camera;
  target: RenderTarget | null;
  mrt: unknown;
  scissorTest: boolean;
  viewport: number[];
  scissor: number[];
  size: [number, number];
  autoClear: boolean;
  channels: boolean[];
  hidden: boolean;
  projection: number[];
  world: number[];
}

/** A renderer that records the state every nested render saw. */
function recorder(coordinateSystem = WebGPUCoordinateSystem, buffer: [number, number] = [1280, 720]) {
  const calls: Call[] = [];
  const hidden = { visible: true };
  const state = { target: null as RenderTarget | null, mrt: 'app-mrt' as unknown, scissorTest: false };
  const onRender: (() => void)[] = [];
  const renderer = {
    coordinateSystem,
    autoClear: false,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    getDrawingBufferSize: (v: Vector2) => v.set(buffer[0], buffer[1]),
    getRenderTarget: () => state.target,
    setRenderTarget: (target: RenderTarget | null) => void (state.target = target),
    getMRT: () => state.mrt,
    setMRT: (mrt: never) => void (state.mrt = mrt),
    getScissorTest: () => state.scissorTest,
    setScissorTest: (enabled: boolean) => void (state.scissorTest = enabled),
    clear: () => undefined,
    render: (_scene: unknown, camera: Camera) => {
      const target = state.target;
      calls.push({
        camera,
        target,
        mrt: state.mrt,
        scissorTest: state.scissorTest,
        viewport: target ? target.viewport.toArray() : [],
        scissor: target ? target.scissor.toArray() : [],
        size: target ? [target.width, target.height] : [0, 0],
        autoClear: renderer.autoClear,
        channels: [renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil],
        hidden: hidden.visible,
        projection: camera.projectionMatrix.toArray(),
        world: camera.matrixWorld.toArray(),
      });
      for (const hook of onRender) hook();
    },
  };
  return { renderer: renderer as typeof renderer & MirrorAtlasRenderer, calls, hidden, state, onRender };
}

const scene = { name: '' } as never;

describe('mirror atlas layout', () => {
  it('fits any number of planes into a near-square grid of equal tiles', () => {
    expect([1, 2, 3, 4, 5, 9].map(mirrorAtlasLayout)).toEqual([
      { columns: 1, rows: 1 },
      { columns: 2, rows: 1 },
      { columns: 2, rows: 2 },
      { columns: 2, rows: 2 },
      { columns: 3, rows: 2 },
      { columns: 3, rows: 3 },
    ]);
    // Four tiles of half the drawing buffer fill exactly one buffer-sized target, without overlap.
    const rects = [0, 1, 2, 3].map((index) => mirrorAtlasTileRect(index, 2, 640, 360));
    expect(rects).toEqual([
      [0, 0, 640, 360],
      [640, 0, 640, 360],
      [0, 360, 640, 360],
      [640, 360, 640, 360],
    ]);
  });

  it('never lets a lookup leave its own tile, however far the rippled UV strays', () => {
    const [columns, rows, width, height] = [2, 2, 640, 360];
    for (let index = 0; index < 4; index++) {
      const [x, y] = mirrorAtlasTileRect(index, columns, width, height);
      for (const [u, v] of [
        [0.5, 0.5],
        [0, 0],
        [1, 1],
        [-3, 0.2],
        [0.7, 9],
        [1.0001, -0.0001],
      ]) {
        const [au, av] = mirrorAtlasUv(u!, v!, index, columns, rows, width, height);
        const px = au * columns * width;
        const py = av * rows * height;
        // At least half a texel inside: a bilinear tap then reads only this tile's texels.
        expect(px).toBeGreaterThanOrEqual(x + 0.5 - 1e-9);
        expect(px).toBeLessThanOrEqual(x + width - 0.5 + 1e-9);
        expect(py).toBeGreaterThanOrEqual(y + 0.5 - 1e-9);
        expect(py).toBeLessThanOrEqual(y + height - 0.5 + 1e-9);
      }
      // Inside the tile the mapping is the plain offset and scale.
      expect(mirrorAtlasUv(0.25, 0.75, index, columns, rows, width, height)).toEqual([
        ((index % 2) + 0.25) / 2,
        (Math.floor(index / 2) + 0.75) / 2,
      ]);
    }
  });
});

describe('mirror camera', () => {
  it.each([
    [WebGPUCoordinateSystem, 0, 'orthographic'],
    [WebGPUCoordinateSystem, 4.9, 'orthographic'],
    [WebGLCoordinateSystem, 1.6, 'orthographic'],
    [WebGPUCoordinateSystem, 1.6, 'perspective'],
  ] as const)(
    "is exactly three's reflector camera (coordinate system %s, plane y=%s, %s)",
    (coordinateSystem, y, kind) => {
      let camera: Camera = dimetric(13, -9, coordinateSystem);
      if (kind === 'perspective') {
        const perspective = new PerspectiveCamera(40, 16 / 9, 0.5, 300);
        perspective.coordinateSystem = coordinateSystem;
        perspective.updateProjectionMatrix();
        perspective.position.copy(camera.position);
        perspective.quaternion.copy(camera.quaternion);
        perspective.updateMatrixWorld();
        camera = perspective;
      }
      // Reference: three's own reflector on a plane at height y (its target's +Z is the mirror normal).
      const reference = reflector({ resolutionScale: 0.5, depth: true });
      reference.target.rotateX(-Math.PI / 2);
      reference.target.position.y = y;
      reference.target.updateMatrixWorld();
      const { renderer, calls } = recorder(coordinateSystem);
      const frame = new NodeFrame();
      Object.assign(frame, { scene, camera, renderer, material: { visible: true } });
      reference.reflector.updateBefore(frame);
      expect(calls).toHaveLength(1);

      const mine = camera.clone();
      expect(
        mirrorCamera(
          camera,
          mine,
          new Vector3(0, y, 0),
          new Vector3(0, 1, 0),
          coordinateSystem === WebGPUCoordinateSystem,
        ),
      ).toBe(true);
      mine.projectionMatrix.toArray().forEach((value, i) => expect(value).toBeCloseTo(calls[0]!.projection[i]!, 12));
      mine.matrixWorld.toArray().forEach((value, i) => expect(value).toBeCloseTo(calls[0]!.world[i]!, 10));
      reference.dispose();
    },
  );

  it('refuses a camera below the plane', () => {
    const camera = dimetric();
    expect(mirrorCamera(camera, camera.clone(), new Vector3(0, 500, 0), new Vector3(0, 1, 0), true)).toBe(false);
  });
});

describe('mirror atlas rendering', () => {
  const planes = (count: number) => Array.from({ length: count }, (_, i) => ({ y: i * 1.6 }));

  it('renders every plane into its own tile of one target, clearing the target once', () => {
    const atlas = new MirrorAtlas(planes(4), { resolutionScale: 0.5 });
    const { renderer, calls, hidden, state } = recorder();
    const camera = dimetric();
    expect(atlas.render(renderer, scene, camera, hidden)).toBe(4);
    expect(calls).toHaveLength(4);
    calls.forEach((call, index) => {
      expect(call.target).toBe(atlas.renderTarget);
      expect(call.size).toEqual([1280, 720]); // 2 x 2 tiles of half the 1280 x 720 drawing buffer
      expect(call.viewport).toEqual(mirrorAtlasTileRect(index, 2, 640, 360));
      expect(call.scissor).toEqual(call.viewport);
      expect(call.scissorTest).toBe(true);
      expect(call.mrt).toBeNull();
      expect(call.hidden).toBe(false); // the sampling material is never drawn into the texture it samples
      // A render pass clears its whole attachment: only the first tile may clear, and a colour scene background
      // forces a clear unless the per-channel switches are off too.
      expect(call.autoClear).toBe(index === 0);
      expect(call.channels).toEqual(index === 0 ? [true, true, true] : [false, false, false]);
      expect(call.camera).toBe(atlas.tiles[index]!.reflector.getVirtualCamera(camera));
      expect(atlas.tiles[index]!.reflector.hasOutput).toBe(true);
    });
    // Each plane has its own mirrored camera.
    expect(new Set(calls.map((call) => call.projection.join())).size).toBe(4);
    expect(atlas.texelMargin.value.toArray()).toEqual([0.5 / 640, 0.5 / 360]);
    // Everything the caller had set is back.
    expect(state).toEqual({ target: null, mrt: 'app-mrt', scissorTest: false });
    expect([renderer.autoClear, renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil]).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(hidden.visible).toBe(true);
    expect(atlas.renderTarget.viewport.toArray()).toEqual([0, 0, 1280, 720]);
    atlas.dispose();
  });

  it('uses two textures whatever the number of planes', () => {
    for (const count of [1, 2, 3, 4, 6]) {
      const atlas = new MirrorAtlas(planes(count));
      const textures = new Set<unknown>();
      const visit = (node: ShaderNode, seen = new Set<ShaderNode>()) => {
        if (seen.has(node)) return;
        seen.add(node);
        if (node.isTextureNode) textures.add(node.value);
        for (const child of node.getChildren()) visit(child, seen);
      };
      for (const tile of atlas.tiles) {
        const uv = tile.uvNode.add(0.01);
        visit(tile.sample(uv));
        visit(tile.getDepthNode().sample(uv));
      }
      expect([...textures]).toEqual([atlas.renderTarget.texture, atlas.renderTarget.depthTexture]);
      atlas.dispose();
    }
  });

  it('samples colour and depth of one place through one shared atlas UV', () => {
    const atlas = new MirrorAtlas(planes(4));
    const tile = atlas.tiles[2]!;
    const uv = tile.uvNode.add(0.01);
    const colour = tile.sample(uv);
    const depth = tile.getDepthNode().sample(uv);
    expect(colour.uvNode).toBe(depth.uvNode);
    expect(colour.uvNode).toBe(tile.atlasUv(uv));
    // Another place, or the same place of another tile, has a UV of its own.
    expect(tile.sample(tile.uvNode.add(0.02)).uvNode).not.toBe(colour.uvNode);
    expect(atlas.tiles[1]!.sample(uv).uvNode).not.toBe(colour.uvNode);
    atlas.dispose();
  });

  it('keeps the scheduling node on every sample, so the material that samples the atlas renders it', () => {
    const atlas = new MirrorAtlas(planes(2));
    const colour = atlas.tiles[1]!.sample(atlas.tiles[1]!.uvNode);
    const depth = atlas.tiles[1]!.getDepthNode().sample(atlas.tiles[1]!.uvNode);
    for (const sample of [colour, depth, colour.clone(), depth.sample(atlas.tiles[0]!.uvNode)])
      expect(sample._atlasNode).toBe(atlas.node);
    expect(colour.value).toBe(atlas.renderTarget.texture);
    expect(depth.value).toBe(atlas.renderTarget.depthTexture);
    atlas.dispose();
  });

  it('skips planes whose surface is off screen and leaves the target alone when none is visible', () => {
    const near = new Box3(new Vector3(10, 0, -12), new Vector3(16, 0, -6));
    const far = new Box3(new Vector3(400, 0, 400), new Vector3(410, 0, 410));
    const atlas = new MirrorAtlas([
      { y: 0, bounds: far },
      { y: 1.6, bounds: near },
      { y: 3.2, bounds: far },
    ]);
    const { renderer, calls, hidden, state } = recorder();
    const camera = dimetric();
    expect(atlas.render(renderer, scene, camera, hidden)).toBe(1);
    expect(calls).toHaveLength(1);
    // The visible plane keeps its own tile (index 1) and, being the first of this pass, clears.
    expect(calls[0]!.viewport).toEqual(mirrorAtlasTileRect(1, 2, 640, 360));
    expect(calls[0]!.autoClear).toBe(true);
    expect(atlas.tiles.map((tile) => tile.reflector.hasOutput)).toEqual([false, true, false]);

    calls.length = 0;
    const away = dimetric(-300, -300);
    expect(atlas.render(renderer, scene, away, hidden)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(state.target).toBeNull();
    expect(hidden.visible).toBe(true);
    atlas.dispose();
  });

  it('restores the renderer and the hidden material when a nested render throws', () => {
    const atlas = new MirrorAtlas(planes(2));
    const { renderer, hidden, state, onRender } = recorder();
    onRender.push(() => {
      throw new Error('device lost');
    });
    expect(() => atlas.render(renderer, scene, dimetric(), hidden)).toThrow('device lost');
    expect(state).toEqual({ target: null, mrt: 'app-mrt', scissorTest: false });
    expect(renderer.autoClear).toBe(false);
    expect(hidden.visible).toBe(true);
    atlas.dispose();
  });

  it('gives the frame back to the object being drawn after each nested render, and never re-enters', () => {
    const atlas = new MirrorAtlas(planes(3));
    const { renderer, calls, onRender } = recorder();
    const camera = dimetric();
    const material = { visible: true };
    const object = { name: 'ground' };
    const frame = new NodeFrame();
    Object.assign(frame, { scene, camera, renderer, material, object });
    const seenByNested: unknown[] = [];
    let reentered: unknown = 'not called';
    onRender.push(() => {
      // three r186 draws the nested scene with the same NodeFrame: it leaves its own last object behind.
      seenByNested.push([frame.camera, frame.material, frame.object]);
      if (calls.length === 1) reentered = atlas.node.updateBefore(frame);
      Object.assign(frame, { camera: null, material: { visible: true }, object: { name: 'tree' }, scene: null });
    });
    atlas.node.updateBefore(frame);
    expect(calls).toHaveLength(3);
    expect(reentered).toBe(false);
    // Every nested render started from the caller's frame, not from what the previous nested render left.
    for (const seen of seenByNested) expect(seen).toEqual([camera, material, object]);
    expect([frame.camera, frame.material, frame.object, frame.scene, frame.renderer]).toEqual([
      camera,
      material,
      object,
      scene,
      renderer,
    ]);
    expect(material.visible).toBe(true);

    // Without a camera or a material there is nothing to mirror; three's scheduler takes false as "not updated".
    calls.length = 0;
    Object.assign(frame, { camera: null });
    expect(atlas.node.updateBefore(frame)).toBe(false);
    expect(calls).toHaveLength(0);
    atlas.dispose();
  });

  it('caps the tile scale below the whole drawing buffer and rejects an empty atlas', () => {
    // A tile the size of the drawing buffer would be taken for "no viewport" by three and drawn over the whole atlas.
    const atlas = new MirrorAtlas(planes(1), { resolutionScale: 1 });
    expect(atlas.resolutionScale).toBeLessThan(1);
    expect(atlas.tileSize(1280, 720)).toEqual([960, 540]);
    atlas.dispose();
    expect(() => new MirrorAtlas([])).toThrow();
  });
});
