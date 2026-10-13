import '../helpers/chineseLocale';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVmFrameRenderer, keyRectUv, rgb565ToRgb888 } from '../../src/ui/pages/game/vmFrameRenderer';
import { parsePassthroughFlags } from '../../src/ui/pages/game/hdBridge';
import { AiUpscale } from '../../src/ui/pages/game/aiUpscale';
import { fsrUpscaleMode, spatialUpscaleEnabled } from '../../src/ui/pages/game/spatialUpscale';
import type { VmFrame } from '../../src/vm86/win32';
import { validFrameOverlay, type FrameOverlayJournal } from '../../src/graphics/frameOverlayData';
import { frameOverlayVertices } from '../../src/graphics/frameOverlay';

class FakeCanvas {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext(this);

  getContext(kind: string): FakeCanvasContext | null {
    return kind === '2d' ? this.context : null;
  }
}

class FakeCanvasContext {
  readonly calls: string[] = [];
  lastImage: ImageData | null = null;
  imageSmoothingEnabled = true;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
  fillStyle: string | CanvasGradient | CanvasPattern = '';

  constructor(readonly canvas: FakeCanvas) {}

  createImageData(width: number, height: number): ImageData {
    this.calls.push(`createImageData:${width}x${height}`);
    return {
      colorSpace: 'srgb',
      data: new Uint8ClampedArray(width * height * 4),
      height,
      width,
    } as ImageData;
  }

  putImageData(image: ImageData): void {
    this.lastImage = image;
    this.calls.push('putImageData');
  }
  fillRect(): void {
    this.calls.push('fillRect');
  }
  drawImage(): void {
    this.calls.push('drawImage');
  }
}

class FakeWebGl {
  readonly calls: string[] = [];
  readonly deletedTextures: unknown[] = [];
  readonly deletedPrograms: unknown[] = [];
  readonly deletedBuffers: unknown[] = [];
  readonly deletedShaders: unknown[] = [];
  readonly RENDERER = 1;
  readonly VERTEX_SHADER = 2;
  readonly FRAGMENT_SHADER = 3;
  readonly COMPILE_STATUS = 4;
  readonly LINK_STATUS = 5;
  readonly ARRAY_BUFFER = 6;
  readonly STATIC_DRAW = 7;
  readonly DYNAMIC_DRAW = 39;
  readonly TRIANGLES = 40;
  readonly NO_ERROR = 0;
  readonly FLOAT = 8;
  readonly TEXTURE0 = 10;
  readonly TEXTURE1 = 11;
  readonly TEXTURE2 = 12;
  readonly TEXTURE3 = 13;
  readonly TEXTURE4 = 14;
  readonly TEXTURE_2D = 14;
  readonly TEXTURE_MIN_FILTER = 15;
  readonly TEXTURE_MAG_FILTER = 16;
  readonly TEXTURE_WRAP_S = 17;
  readonly TEXTURE_WRAP_T = 18;
  readonly NEAREST = 19;
  readonly CLAMP_TO_EDGE = 20;
  readonly UNPACK_ALIGNMENT = 21;
  readonly R8 = 22;
  readonly RED = 23;
  readonly RGBA = 24;
  readonly UNSIGNED_BYTE = 25;
  readonly TRIANGLE_STRIP = 26;
  readonly COLOR_BUFFER_BIT = 27;
  readonly BLEND = 28;
  readonly ZERO = 0;
  readonly CONSTANT_ALPHA = 38;
  readonly SRC_ALPHA = 29;
  readonly ONE_MINUS_SRC_ALPHA = 30;
  readonly R16UI = 31;
  readonly RED_INTEGER = 32;
  readonly UNSIGNED_SHORT = 33;
  readonly RGBA8 = 34;
  readonly FRAMEBUFFER = 35;
  readonly COLOR_ATTACHMENT0 = 36;
  readonly FRAMEBUFFER_COMPLETE = 37;
  readonly uploads: unknown[][] = [];

  readonly loseContextCalls: string[] = [];
  /** Mock only WEBGL_lose_context; other extensions such as debug_renderer_info still return null. */
  getExtension(name: string): object | null {
    if (name === 'WEBGL_lose_context') return { loseContext: () => this.loseContextCalls.push(name) };
    return null;
  }
  getParameter(): string {
    return 'fake-gpu';
  }
  createShader(): object {
    return {};
  }
  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean {
    return true;
  }
  getShaderInfoLog(): null {
    return null;
  }
  createProgram(): object {
    return {};
  }
  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return true;
  }
  getProgramInfoLog(): null {
    return null;
  }
  createTexture(): object {
    return {};
  }
  createBuffer(): object {
    return {};
  }
  createVertexArray(): object {
    return {};
  }
  bindVertexArray(): void {}
  deleteVertexArray(): void {}
  getError(): number {
    return this.NO_ERROR;
  }
  isContextLost(): boolean {
    return false;
  }
  createFramebuffer(): object {
    return {};
  }
  deleteFramebuffer(): void {}
  bindFramebuffer(): void {
    this.calls.push('bindFramebuffer');
  }
  framebufferTexture2D(): void {}
  checkFramebufferStatus(): number {
    return this.FRAMEBUFFER_COMPLETE;
  }
  useProgram(): void {
    this.calls.push('useProgram');
  }
  bindBuffer(): void {}
  bufferData(): void {}
  getAttribLocation(_program: object, name: string): number {
    return name === 'position' ? 0 : 1;
  }
  enableVertexAttribArray(): void {}
  vertexAttribPointer(): void {}
  activeTexture(): void {}
  bindTexture(): void {}
  texParameteri(): void {}
  uniform1i(location: { name: string }, value: number): void {
    this.calls.push(`uniform:${location.name}:${value}`);
  }
  uniform2f(location: { name: string }, x: number, y: number): void {
    this.calls.push(`uniform:${location.name}:${x},${y}`);
  }
  getUniformLocation(_program: object, name: string): object {
    return { name };
  }
  pixelStorei(): void {}
  viewport(): void {
    this.calls.push('viewport');
  }
  clearColor(): void {}
  clear(): void {
    this.calls.push('clear');
  }
  texImage2D(...args: unknown[]): void {
    this.uploads.push(args);
    this.calls.push('texImage2D');
  }
  texSubImage2D(...args: unknown[]): void {
    this.uploads.push(args);
    this.calls.push('texSubImage2D');
  }
  drawArrays(): void {
    this.calls.push('drawArrays');
  }
  uniform4f(location: { name: string }, ...values: number[]): void {
    this.calls.push(`uniform4f:${location.name}:${values.join(',')}`);
  }
  uniform3f(location: { name: string }, ...values: number[]): void {
    this.calls.push(`uniform3f:${location.name}:${values.map((v) => v.toFixed(3)).join(',')}`);
  }
  uniform1ui(location: { name: string }, value: number): void {
    this.calls.push(`uniform1ui:${location.name}:${value}`);
  }
  enable(): void {}
  colorMask(...mask: boolean[]): void {
    this.calls.push(`colorMask:${mask.join(',')}`);
  }
  scissor(x: number, y: number, width: number, height: number): void {
    this.calls.push(`scissor:${x},${y},${width},${height}`);
  }
  blendFunc(...values: number[]): void {
    this.calls.push(`blendFunc:${values.join(',')}`);
  }
  blendColor(...values: number[]): void {
    this.calls.push(`blendColor:${values.join(',')}`);
  }
  disable(): void {}
  deleteTexture(texture: unknown): void {
    this.deletedTextures.push(texture);
  }
  deleteProgram(program: unknown): void {
    this.deletedPrograms.push(program);
  }
  deleteShader(shader: unknown): void {
    this.deletedShaders.push(shader);
  }
  deleteBuffer(buffer: unknown): void {
    this.deletedBuffers.push(buffer);
  }
}

function indexedFrame(width = 2, height = 1): VmFrame {
  return {
    width,
    height,
    pixels: new Uint8Array(width * height),
    palette: new Uint8Array(256 * 4),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('atomic native overlay presentation', () => {
  function picture(): VmFrame {
    const frame = {
      ...indexedFrame(4, 4),
      rgb565: new Uint16Array(16).fill(0xffff),
      matchGeneration: 7,
      drawGeneration: 91,
    };
    const overlayJournal: FrameOverlayJournal = {
      matchGeneration: 7,
      drawGeneration: 91,
      width: 4,
      height: 4,
      cleanRgb565: new Uint16Array(16).fill(0xf81f),
      commands: [
        { kind: 'rect', x: 1, y: 1, width: 2, height: 1, colour: 0x7e0, clip: { x: 0, y: 0, width: 4, height: 4 } },
      ],
    };
    return { ...frame, overlayJournal };
  }

  it('selects the clean plane only with a complete matched journal and keyed HD output', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    const frame = picture();
    renderer.draw(frame, 8, 8);
    expect(gl.uploads.at(-1)?.at(-1)).toBe(frame.rgb565);
    renderer.setTransparentKey({ rect: { x: 0, y: 0, width: 4, height: 4 }, rgb565: 0xf81f });
    renderer.draw(frame, 8, 8);
    expect(gl.uploads.at(-1)?.at(-1)).toBe(frame.overlayJournal!.cleanRgb565);
    renderer.setTransparentKey(null);
    renderer.draw(frame, 8, 8);
    expect(gl.uploads.at(-1)?.at(-1)).toBe(frame.rgb565);
    expect(frame.rgb565![0]).toBe(0xffff);
    renderer.destroy();
  });

  it.each([
    'generation',
    'unknown-match',
    'unknown-draw',
    'incomplete',
    'unknown-command',
    'device-failure',
    'device-allocation',
    'device-draw',
    'context-lost',
  ] as const)('keeps every original pixel on %s', (failure) => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.setTransparentKey({ rect: { x: 0, y: 0, width: 4, height: 4 }, rgb565: 0xf81f });
    const frame = picture();
    if (failure === 'generation') frame.drawGeneration!++;
    if (failure === 'unknown-match') frame.matchGeneration = frame.overlayJournal!.matchGeneration = 0;
    if (failure === 'unknown-draw') frame.drawGeneration = frame.overlayJournal!.drawGeneration = 0;
    if (failure === 'incomplete') frame.overlayJournal!.cleanRgb565 = new Uint16Array(15);
    if (failure === 'unknown-command') frame.overlayJournal!.commands = [{ kind: 'text' } as never];
    if (failure === 'device-failure')
      vi.spyOn(gl, 'createVertexArray').mockImplementation(() => {
        throw new Error('lost');
      });
    if (failure === 'device-allocation') vi.spyOn(gl, 'getError').mockReturnValueOnce(0x505);
    if (failure === 'device-draw') vi.spyOn(gl, 'getError').mockReturnValueOnce(0).mockReturnValueOnce(0x502);
    if (failure === 'context-lost') vi.spyOn(gl, 'isContextLost').mockReturnValue(true);
    renderer.draw(frame, 8, 8);
    expect(gl.uploads.at(-1)?.at(-1)).toBe(frame.rgb565);
    renderer.destroy();
  });

  it('clips vectors in source coordinates and expands native colour exactly', () => {
    const data = frameOverlayVertices(
      [{ kind: 'rect', x: -2, y: 1, width: 5, height: 2, colour: 0x7e0, clip: { x: 1, y: 0, width: 3, height: 2 } }],
      4,
      4,
    );
    expect(data.length).toBe(30);
    for (let index = 0; index < data.length; index += 5) {
      expect(data[index]).toBeGreaterThanOrEqual(-0.5);
      expect(data[index]).toBeLessThanOrEqual(0.5);
      expect(data[index + 1]).toBeGreaterThanOrEqual(0);
      expect(data[index + 1]).toBeLessThanOrEqual(0.5);
      expect([...data.slice(index + 2, index + 5)]).toEqual([0, 1, 0]);
    }
  });

  it('rejects concave or self-intersecting polygons instead of drawing an incorrect fan', () => {
    const frame = picture(),
      journal = frame.overlayJournal!;
    journal.commands = [
      {
        kind: 'polygon',
        colour: 0xffff,
        clip: { x: 0, y: 0, width: 4, height: 4 },
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
          { x: 4, y: 0 },
        ],
      },
    ];
    expect(validFrameOverlay(frame, journal)).toBe(false);
  });
});

describe('VmFrameRenderer 生命周期', () => {
  it('实时切换复用上下文、释放旧管线，同模式和销毁后不再分配', () => {
    const gl = new FakeWebGl();
    const getContext = vi.fn(() => gl);
    const canvas = { width: 20, height: 10, dataset: { upscale: '旧状态' }, getContext };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    const frame = indexedFrame();
    renderer.draw(frame, 20, 10);
    renderer.setUpscaleMode('bicubic');
    expect(renderer.upscaleMode).toBe('bicubic');
    expect(canvas.dataset.upscale).toBeUndefined();
    expect(gl.deletedPrograms).toHaveLength(4);
    renderer.draw(frame, 20, 10);
    expect(renderer.upscaleStatus).toContain('插值');
    renderer.setUpscaleMode('bicubic');
    expect(gl.deletedPrograms).toHaveLength(4);
    renderer.setUpscaleMode('fast');
    expect(renderer.detail).toContain('CNN');
    renderer.setUpscaleMode('gan');
    expect(renderer.detail).toContain('GAN');
    renderer.setUpscaleMode('off');
    expect(renderer.upscaleStatus).toBeNull();
    renderer.destroy();
    renderer.setUpscaleMode('gan');
    expect(renderer.upscaleMode).toBe('off');
    expect(gl.deletedPrograms).toHaveLength(20);
    expect(gl.deletedTextures).toHaveLength(20);
    // Two shaders per program: release handles after linking, including on failure.
    expect(gl.deletedShaders).toHaveLength(40);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('换档只替换显示管线不释放上下文，只有终态销毁才 loseContext', () => {
    const gl = new FakeWebGl();
    const canvas = { width: 20, height: 10, dataset: {}, getContext: vi.fn(() => gl) };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    renderer.setUpscaleMode('bicubic');
    renderer.setUpscaleMode('off');
    // Backends share the context; releasing it during a mode switch would give the new backend a lost context.
    expect(gl.loseContextCalls).toHaveLength(0);
    renderer.destroy();
    expect(gl.loseContextCalls).toHaveLength(1);
    renderer.destroy();
    expect(gl.loseContextCalls).toHaveLength(1);
  });

  it('Canvas 2D 实时请求 AI 明确显示回退，关闭后清除提示', () => {
    const canvas = new FakeCanvas();
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);
    renderer.setUpscaleMode('gan');
    expect(renderer.upscaleStatus).toContain('Canvas 2D');
    renderer.setUpscaleMode('off');
    expect(renderer.upscaleStatus).toBeNull();
    renderer.destroy();
  });

  it('releases the old session GPU objects while retaining a context for an in-place restart', () => {
    const gl = new FakeWebGl();
    const canvas = { width: 20, height: 10, dataset: {}, getContext: vi.fn(() => gl) };
    const first = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    first.destroy(true);
    expect(gl.deletedPrograms).toHaveLength(4);
    expect(gl.deletedTextures).toHaveLength(4);
    expect(gl.loseContextCalls).toHaveLength(0);
    // The presenter and the old page cleanup both dispose the same old renderer.
    first.destroy();
    expect(gl.loseContextCalls).toHaveLength(0);
    const next = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement);
    next.draw(indexedFrame(), 20, 10);
    expect(next.backend).toBe('WebGL2');
    next.destroy();
    expect(gl.loseContextCalls).toHaveLength(1);
  });

  it('Canvas 2D 同时覆盖 indexed/RGBA 帧，并在 destroy 后静默 no-op', () => {
    const canvas = new FakeCanvas();
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);
    const first = indexedFrame();
    const rgba: VmFrame = {
      width: 2,
      height: 1,
      pixels: new Uint8Array(2),
      palette: new Uint8Array(256 * 4),
      rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
    };

    renderer.setTransparentRects([{ x: 0, y: 0, width: 1, height: 1 }]);
    renderer.clear();
    renderer.draw(first, 20, 10);
    renderer.draw(rgba, 20, 10);
    const callsBeforeDestroy = canvas.context.calls.length;
    renderer.destroy();
    renderer.destroy();
    renderer.clear();
    renderer.draw(first, 20, 10);

    expect(canvas.context.calls).toContain('fillRect');
    expect(canvas.context.calls).toContain('drawImage');
    expect(canvas.context.calls.length).toBe(callsBeforeDestroy);
  });

  it('帧尺寸变化会重新创建缓存图像，销毁后不再触碰 context', () => {
    const canvas = new FakeCanvas();
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);

    renderer.draw(indexedFrame(2, 1), 20, 10);
    renderer.draw(indexedFrame(3, 2), 30, 20);
    expect(canvas.context.calls.filter((call) => call.startsWith('createImageData')).length).toBe(2);
    renderer.destroy();
    renderer.clear();
    expect(canvas.context.calls).not.toContain('fillRect');
  });

  it('WebGL2 destroy releases all GPU resources and makes later draw/clear no-op', () => {
    const gl = new FakeWebGl();
    const canvas = {
      width: 320,
      height: 200,
      getContext: (kind: string) => (kind === 'webgl2' ? gl : null),
    };
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, true);
    expect(renderer.backend).toBe('WebGL2');
    renderer.draw(indexedFrame(), 320, 200);
    renderer.draw({ ...indexedFrame(), rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) }, 320, 200);
    const callsBeforeDestroy = gl.calls.length;
    renderer.destroy();
    renderer.destroy();
    expect(gl.deletedTextures).toHaveLength(4);
    expect(gl.deletedPrograms).toHaveLength(4);
    expect(gl.deletedBuffers).toHaveLength(1);
    renderer.clear();
    renderer.draw(indexedFrame(), 320, 200);
    expect(gl.calls.length).toBe(callsBeforeDestroy);
  });

  it('关键色直通：只有矩形内的键色透明，旁路放大与后处理，同帧不重复上传', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      'fsr',
    );
    const frame = { ...indexedFrame(4, 2), rgb565: new Uint16Array(8) };
    renderer.setTransparentKey({ rect: { x: 1, y: 0, width: 2, height: 2 }, rgb565: 0xf81f });
    renderer.draw(frame, 8, 4);
    expect(gl.calls).toContain('uniform4f:keyRect:0.25,0,0.75,1');
    expect(gl.calls).toContain('uniform1ui:keyPacked:63519');
    renderer.draw(frame, 8, 4);
    expect(gl.uploads).toHaveLength(1);
    expect(gl.calls.some((call) => call.startsWith('uniform:upscale'))).toBe(false);
    renderer.draw({ ...indexedFrame(4, 2), rgba: new Uint8Array(32) }, 8, 4);
    expect(gl.calls).toContain('uniform3f:keyRgb:1.000,0.000,1.000');
    renderer.setTransparentKey(null);
    renderer.draw(frame, 8, 4);
    expect(gl.calls.some((call) => call.startsWith('uniform:upscale'))).toBe(true);
    renderer.destroy();
    // indexed/rgba/rgb565/cursor plus the three key programs.
    expect(gl.deletedPrograms).toHaveLength(7);
  });

  it('prepareTransparentKey compiles the key programs ahead of the first keyed frame, once', () => {
    const gl = new FakeWebGl();
    const created = vi.spyOn(gl, 'createProgram');
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    const before = created.mock.calls.length;
    renderer.prepareTransparentKey();
    // One program per frame format (indexed, RGBA, RGB565).
    expect(created.mock.calls.length - before).toBe(3);
    renderer.prepareTransparentKey();
    expect(created.mock.calls.length - before).toBe(3);
    // The first keyed frame finds them: nothing is compiled inside its draw.
    const frame = { ...indexedFrame(4, 2), rgb565: new Uint16Array(8) };
    renderer.setTransparentKey({ rect: { x: 1, y: 0, width: 2, height: 2 }, rgb565: 0xf81f });
    renderer.draw(frame, 8, 4);
    expect(gl.calls).toContain('uniform1ui:keyPacked:63519');
    expect(created.mock.calls.length - before).toBe(3);
    renderer.destroy();
    // The prepared programs are released with the rest, and a destroyed renderer prepares nothing.
    expect(gl.deletedPrograms).toHaveLength(7);
    renderer.prepareTransparentKey();
    expect(created.mock.calls.length - before).toBe(3);
  });

  it('切换放大档位时键色与透明矩形交给新管线', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    const frame = { ...indexedFrame(4, 2), rgb565: new Uint16Array(8) };
    renderer.setTransparentKey({ rect: { x: 1, y: 0, width: 2, height: 2 }, rgb565: 0xf81f });
    // A mid-session switch (toolbar, or the live model's beforeLoad) must not drop the key: the battlefield would turn
    // solid magenta under a steady HD view.
    renderer.setUpscaleMode('bicubic');
    renderer.draw(frame, 8, 4);
    expect(gl.calls).toContain('uniform1ui:keyPacked:63519');
    expect(gl.calls).toContain('uniform4f:keyRect:0.25,0,0.75,1');
    expect(gl.calls.some((call) => call.startsWith('uniform:upscale'))).toBe(false);
    renderer.setTransparentKey(null);
    renderer.setTransparentRect({ x: 1, y: 0, width: 2, height: 1 });
    renderer.setUpscaleMode('off');
    gl.calls.length = 0;
    renderer.draw(frame, 8, 4);
    expect(gl.calls.some((call) => call.startsWith('uniform1ui:keyPacked'))).toBe(false);
    // Alpha forced opaque first, then the scaled rectangle (x 2..6, y 0..2 of 8x4) cleared, scissor origin bottom-left.
    const punch = gl.calls.slice(gl.calls.indexOf('colorMask:false,false,false,true'));
    expect(punch.slice(0, 3)).toEqual(['colorMask:false,false,false,true', 'clear', 'colorMask:true,true,true,true']);
    expect(punch).toContain('scissor:2,2,4,2');
    renderer.destroy();
  });

  it('fades a live region with premultiplied RGB and alpha, before drawing the independent cursor', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.setOpacityRegion({ rect: { x: 1, y: 0, width: 2, height: 1 }, opacity: 0.5 });
    renderer.setUpscaleMode('bicubic');
    const frame = indexedFrame(4, 2);
    gl.calls.length = 0;
    renderer.draw(frame, 8, 4);
    expect(gl.calls).toContain('scissor:2,2,4,2');
    expect(gl.calls).toContain('blendColor:0,0,0,0.5');
    expect(gl.calls).toContain(`blendFunc:${gl.ZERO},${gl.CONSTANT_ALPHA}`);
    const draws = gl.calls.filter((call) => call === 'drawArrays').length;
    renderer.setOpacityRegion(null);
    gl.calls.length = 0;
    renderer.draw(frame, 8, 4);
    expect(gl.calls.some((call) => call.startsWith('blendColor:'))).toBe(false);
    expect(gl.calls.filter((call) => call === 'drawArrays')).toHaveLength(draws - 1);
    renderer.destroy();
  });

  it('透明矩形按目标尺寸缩放并裁到画布内', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.setTransparentRect({ x: -1, y: 1, width: 10, height: 5 });
    renderer.draw(indexedFrame(4, 2), 8, 4);
    expect(gl.calls).toContain('scissor:0,0,8,2');
    // An empty intersection still forces the frame opaque but clears nothing.
    renderer.setTransparentRect({ x: 5, y: 0, width: 2, height: 2 });
    gl.calls.length = 0;
    renderer.draw(indexedFrame(4, 2), 8, 4);
    expect(gl.calls).toContain('colorMask:false,false,false,true');
    expect(gl.calls.some((call) => call.startsWith('scissor:'))).toBe(false);
    renderer.setTransparentRect(null);
    gl.calls.length = 0;
    renderer.draw(indexedFrame(4, 2), 8, 4);
    expect(gl.calls.some((call) => call.startsWith('colorMask:'))).toBe(false);
    renderer.destroy();
  });

  it.each(['off', 'bicubic', 'fsr-rcas', 'fast'] as const)(
    'extra holes survive %s backend replacement and precede the cursor',
    (mode) => {
      const gl = new FakeWebGl();
      const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
      renderer.setTransparentRect({ x: 0, y: 0, width: 1, height: 1 });
      renderer.setTransparentRects([
        { x: 2, y: 0, width: 2, height: 1 },
        { x: -2, y: 1, width: 3, height: 2 },
      ]);
      renderer.setUpscaleMode(mode);
      const frame = {
        ...indexedFrame(4, 2),
        cursor: {
          handle: 1,
          x: 1,
          y: 1,
          width: 1,
          height: 1,
          hotspotX: 0,
          hotspotY: 0,
          rgba: new Uint8Array([255, 255, 255, 255]),
        },
      };
      renderer.draw(frame, 8, 4);
      expect(gl.calls).toContain('scissor:0,2,2,2');
      expect(gl.calls).toContain('scissor:4,2,4,2');
      expect(gl.calls).toContain('scissor:0,0,2,2');
      expect(gl.calls.indexOf('colorMask:false,false,false,true')).toBeGreaterThan(gl.calls.indexOf('drawArrays'));
      expect(gl.calls.lastIndexOf('scissor:0,0,2,2')).toBeLessThan(
        gl.calls.findIndex((call) => call.startsWith('uniform4f:cursorRect')),
      );
      renderer.setTransparentRects([]);
      renderer.setTransparentRect(null);
      gl.calls.length = 0;
      renderer.draw(frame, 8, 4);
      expect(gl.calls.some((call) => call.startsWith('scissor:'))).toBe(false);
      renderer.destroy();
    },
  );

  it.each([false, true])('clears holes after AI presentation (cached=%s) and post-processing', (cached) => {
    const gl = new FakeWebGl();
    vi.spyOn(AiUpscale.prototype, 'prepare').mockReturnValue(true);
    vi.spyOn(AiUpscale.prototype, 'hasFrame').mockReturnValue(cached);
    vi.spyOn(AiUpscale.prototype, 'bindInput').mockImplementation(() => undefined);
    const infer = vi.spyOn(AiUpscale.prototype, 'infer').mockImplementation(() => gl.calls.push('AI infer'));
    vi.spyOn(AiUpscale.prototype, 'draw').mockImplementation(() => gl.calls.push('AI draw'));
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      null,
      false,
      true,
    );
    renderer.setPostProcess(() => ({ draw: () => gl.calls.push('post process'), destroy: () => undefined }));
    renderer.setTransparentRects([{ x: 2, y: 0, width: 2, height: 1 }]);
    renderer.draw(indexedFrame(4, 2), 8, 4);
    expect(infer).toHaveBeenCalledTimes(cached ? 0 : 1);
    expect(gl.calls.indexOf('AI draw')).toBeLessThan(gl.calls.indexOf('post process'));
    expect(gl.calls.indexOf('post process')).toBeLessThan(gl.calls.indexOf('scissor:4,2,4,2'));
    renderer.destroy();
  });

  it('extra holes keep key alpha and do not clear the superseded singular hole', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.setTransparentRect({ x: 0, y: 0, width: 1, height: 1 });
    renderer.setTransparentKey({ rect: { x: 0, y: 0, width: 2, height: 2 }, rgb565: 0xf81f });
    renderer.setTransparentRects([{ x: 2, y: 0, width: 2, height: 1 }]);
    renderer.setUpscaleMode('bicubic');
    renderer.draw(indexedFrame(4, 2), 8, 4);
    expect(gl.calls.filter((call) => call.startsWith('scissor:'))).toEqual(['scissor:4,2,4,2']);
    expect(gl.calls.some((call) => call.startsWith('colorMask:'))).toBe(false);
    renderer.destroy();
  });

  it('调色板帧的键色直通上传调色板并比较 RGB888 键值', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.setTransparentKey({ rect: { x: 0, y: 0, width: 2, height: 1 }, rgb565: 0xf81f });
    const frame = indexedFrame();
    renderer.draw(frame, 2, 1);
    expect(gl.calls).toContain('uniform3f:keyRgb:1.000,0.000,1.000');
    expect(gl.calls).toContain('uniform4f:keyRect:0,0,1,1');
    // Index texture, then the 256x1 palette.
    expect(gl.uploads.map((args) => [args[3], args[4]])).toEqual([
      [2, 1],
      [256, 1],
    ]);
    expect(gl.uploads[1]![8]).toBe(frame.palette);
    renderer.draw(frame, 2, 1);
    expect(gl.uploads).toHaveLength(2);
    renderer.destroy();
  });

  it('键色换算与 HD 桥参数', () => {
    expect(rgb565ToRgb888(0xf81f)).toEqual([255, 0, 255]);
    expect(rgb565ToRgb888(0x07e0)).toEqual([0, 255, 0]);
    expect(rgb565ToRgb888(0x0841)).toEqual([8, 8, 8]);
    expect(keyRectUv({ x: -10, y: 5, width: 1000, height: 10 }, 100, 20)).toEqual([0, 0.25, 1, 0.75]);
    expect(parsePassthroughFlags(null)).toBe(7);
    expect(parsePassthroughFlags('terrain,objects')).toBe(3);
    expect(parsePassthroughFlags('all')).toBe(7);
    expect(parsePassthroughFlags('none')).toBe(0);
    // Parsed as given; without terrain the bridge cannot key and uses the transparent rectangle (hdBridge.test.ts).
    expect(parsePassthroughFlags('objects,effects')).toBe(6);
    expect(parsePassthroughFlags('5')).toBe(5);
    expect(parsePassthroughFlags('15')).toBe(7);
  });

  it('RGB565 Canvas 回退准确转色，同一帧光标重画不重复转换', () => {
    const canvas = new FakeCanvas(),
      base = new FakeCanvas();
    vi.stubGlobal('document', { createElement: () => base });
    const renderer = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false);
    const frame = { ...indexedFrame(3, 1), rgb565: new Uint16Array([0xf800, 0x07e0, 0x001f]) };
    renderer.draw(frame, 3, 1);
    renderer.draw(frame, 3, 1);
    expect([...base.context.lastImage!.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect(base.context.calls.filter((call) => call === 'putImageData')).toHaveLength(1);
  });

  it('GPU 紧凑帧只上传一次，RGBA/整数格式切换重新分配纹理', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    const frame = { ...indexedFrame(), rgb565: new Uint16Array([0xf800, 0x07e0]) };
    renderer.draw(frame, 2, 1);
    renderer.draw(frame, 2, 1);
    expect(gl.uploads).toHaveLength(1);
    expect(gl.uploads[0]).toEqual([
      gl.TEXTURE_2D,
      0,
      gl.R16UI,
      2,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      frame.rgb565,
    ]);
    renderer.draw({ ...frame, rgb565: frame.rgb565.slice() }, 2, 1);
    expect(gl.calls.filter((call) => call === 'texSubImage2D')).toHaveLength(1);
    renderer.draw({ ...indexedFrame(), rgba: new Uint8Array(8) }, 2, 1);
    renderer.draw(frame, 2, 1);
    expect(gl.calls.filter((call) => call === 'texImage2D')).toHaveLength(3);
  });

  it('空间重建必须显式开启，1:1/缩小不启用，也不增加同帧上传', () => {
    for (const search of ['', '?sr=0', '?sr=true', '?other=1']) expect(spatialUpscaleEnabled(search)).toBe(false);
    expect(spatialUpscaleEnabled('?debug=1&sr=1')).toBe(true);
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement, true, true);
    expect(renderer.detail).toContain('实验空间重建');
    const frame = { ...indexedFrame(4, 4), rgb565: new Uint16Array(16) };
    renderer.draw(frame, 8, 8);
    renderer.draw(frame, 4, 4);
    renderer.draw(frame, 2, 2);
    expect(gl.calls.filter((call) => call.startsWith('uniform:upscale:'))).toEqual([
      'uniform:upscale:1',
      'uniform:upscale:0',
      'uniform:upscale:0',
    ]);
    expect(gl.uploads).toHaveLength(1);
    renderer.destroy();
    expect(gl.deletedPrograms).toHaveLength(4);
    expect(gl.deletedTextures).toHaveLength(4);
  });

  it('FSR 1.0 必须显式开启，1:1/缩小走原采样直通', () => {
    for (const search of ['', '?sr=0', '?sr=1', '?sr=ai']) expect(fsrUpscaleMode(search)).toBeNull();
    expect(fsrUpscaleMode('?debug=1&sr=fsr')).toBe('fsr');
    expect(fsrUpscaleMode('?sr=fsr-rcas')).toBe('fsr-rcas');
    expect(fsrUpscaleMode('?sr=fsr-rcas-soft')).toBe('fsr-rcas-soft');
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      'fsr',
    );
    expect(renderer.detail).toContain('FSR 1.0');
    expect(renderer.upscaleMode).toBe('fsr');
    const frame = { ...indexedFrame(4, 4), rgb565: new Uint16Array(16) };
    renderer.draw(frame, 8, 8);
    renderer.draw(frame, 4, 4);
    renderer.draw(frame, 2, 2);
    expect(gl.calls.filter((call) => call.startsWith('uniform:upscale:'))).toEqual([
      'uniform:upscale:1',
      'uniform:upscale:0',
      'uniform:upscale:0',
    ]);
    expect(renderer.upscaleStatus).toContain('FSR 1.0');
    renderer.destroy();
  });

  it('FSR+RCAS 档位经中间纹理锐化，1:1 时不启用通道且尺寸不变不重分配', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      'fsr-rcas',
    );
    expect(renderer.detail).toContain('RCAS');
    expect(renderer.upscaleMode).toBe('fsr-rcas');
    const frame = indexedFrame(4, 4);
    renderer.draw(frame, 8, 8);
    // Two calls during construction (bind/unbind) plus two per upscale draw (into the FBO/back to the canvas).
    expect(gl.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(4);
    // Uploads: 1x1 intermediate-texture placeholder, first-frame resize to target dimensions, indexed texture, and palette.
    expect(gl.calls.filter((call) => call === 'texImage2D')).toHaveLength(4);
    renderer.draw(frame, 8, 8);
    expect(gl.calls.filter((call) => call === 'texImage2D')).toHaveLength(4);
    expect(gl.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(6);
    renderer.draw(frame, 4, 4);
    expect(gl.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(6);
    expect(renderer.upscaleStatus).toContain('未启动');
    renderer.destroy();
  });

  it('ScaleFX 档位经 5-pass 链输出，1:1 时不启用', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer(
      { getContext: () => gl } as unknown as HTMLCanvasElement,
      true,
      false,
      null,
      true,
    );
    expect(renderer.detail).toContain('ScaleFX');
    expect(renderer.upscaleMode).toBe('scalefx');
    const frame = indexedFrame(4, 4);
    renderer.draw(frame, 8, 8);
    expect(renderer.upscaleStatus).toContain('ScaleFX');
    // Chain: pass0..3 -> 1x intermediate textures, pass4 -> 3x, final fit -> canvas; six draws total.
    expect(gl.calls.filter((call) => call === 'drawArrays')).toHaveLength(6);
    expect(gl.calls.filter((call) => call.startsWith('uniform:outputSize:'))).toEqual(['uniform:outputSize:12,12']);
    renderer.draw(frame, 4, 4);
    expect(gl.calls.filter((call) => call === 'drawArrays')).toHaveLength(7);
    expect(renderer.upscaleStatus).toContain('未启动');
    renderer.destroy();
  });

  it('空间重建关闭没有额外 uniform，Canvas 回退不启用 GPU 滤镜', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement);
    renderer.draw(indexedFrame(), 100, 100);
    expect(gl.calls.some((call) => call.startsWith('uniform:upscale:'))).toBe(false);
    renderer.destroy();
    const canvas = new FakeCanvas();
    const fallback = createVmFrameRenderer(canvas as unknown as HTMLCanvasElement, false, true);
    expect(fallback.backend).toBe('Canvas 2D');
    expect(fallback.detail).not.toContain('空间重建');
    fallback.destroy();
  });
});

describe('selected native framebuffer RGB interpolation', () => {
  it.each(['indexed', 'rgba', 'rgb565'] as const)(
    'filters only the supplied %s aperture, retains state on backend replacement and releases the program',
    (kind) => {
      const gl = new FakeWebGl();
      const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement, true);
      const base = indexedFrame(4, 2);
      const frame =
        kind === 'rgba'
          ? { ...base, rgba: new Uint8Array(32) }
          : kind === 'rgb565'
            ? { ...base, rgb565: new Uint16Array(8) }
            : base;
      renderer.setSmoothRect({ x: 2, y: 1, width: 2, height: 1 });
      renderer.draw(frame, 8, 4);
      expect(gl.calls.some((call) => call.includes('sampleRect'))).toBe(false);
      renderer.setTransparentKey({ rect: { x: 0, y: 0, width: 1, height: 1 }, rgb565: 0xf81f });
      renderer.draw(frame, 8, 4);
      expect(gl.calls).toContain('uniform4f:sampleRect:2,1,4,2');
      expect(gl.calls).toContain('scissor:4,0,4,2');
      expect(gl.calls.lastIndexOf('drawArrays')).toBeGreaterThan(gl.calls.indexOf('scissor:4,0,4,2'));
      renderer.setUpscaleMode('bicubic');
      gl.calls.length = 0;
      renderer.draw(frame, 8, 4);
      expect(gl.calls).toContain('uniform4f:sampleRect:2,1,4,2');
      const programs = gl.deletedPrograms.length;
      renderer.destroy();
      renderer.destroy();
      // Four ordinary programs, three key formats, and the lazily created region-filter program.
      expect(gl.deletedPrograms.length - programs).toBe(8);
    },
  );
  it('removes filtering on disable and rejects malformed regions before GPU allocation', () => {
    const gl = new FakeWebGl();
    const renderer = createVmFrameRenderer({ getContext: () => gl } as unknown as HTMLCanvasElement, true);
    renderer.setTransparentKey({ rect: { x: 0, y: 0, width: 1, height: 1 }, rgb565: 0xf81f });
    const frame = indexedFrame(4, 2);
    for (const r of [{ x: -1, y: 0, width: 2, height: 2 }, { x: 3, y: 0, width: 2, height: 2 }, null]) {
      renderer.setSmoothRect(r);
      gl.calls.length = 0;
      renderer.draw(frame, 8, 4);
      expect(gl.calls.some((call) => call.includes('sampleRect'))).toBe(false);
    }
    renderer.destroy();
    expect(gl.deletedPrograms).toHaveLength(7);
  });
});
