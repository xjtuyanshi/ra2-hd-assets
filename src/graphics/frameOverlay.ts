import type { FrameOverlayCommand } from './frameOverlayData';

type Point = { x: number; y: number };

/** Clip native geometry before triangulating; clip edges remain exact at every output scale. */
function clipped(command: FrameOverlayCommand, width: number, height: number): Point[] {
  let points: Point[] =
    command.kind === 'polygon'
      ? [...command.points]
      : [
          { x: command.x, y: command.y },
          { x: command.x + command.width, y: command.y },
          { x: command.x + command.width, y: command.y + command.height },
          { x: command.x, y: command.y + command.height },
        ];
  const clip = command.clip;
  for (const [axis, boundary, lower] of [
    ['x', Math.max(0, clip.x), true],
    ['x', Math.min(width, clip.x + clip.width), false],
    ['y', Math.max(0, clip.y), true],
    ['y', Math.min(height, clip.y + clip.height), false],
  ] as const) {
    const result: Point[] = [];
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!,
        b = points[(index + 1) % points.length]!;
      const insideA = lower ? a[axis] >= boundary : a[axis] <= boundary;
      const insideB = lower ? b[axis] >= boundary : b[axis] <= boundary;
      if (insideA) result.push(a);
      if (insideA !== insideB) {
        const amount = (boundary - a[axis]) / (b[axis] - a[axis]);
        result.push({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount });
      }
    }
    points = result;
    if (!points.length) break;
  }
  return points;
}

/** Ordered triangles with source-space positions and RGB. No sampled overlay bitmap or browser font substitution. */
export function frameOverlayVertices(
  commands: readonly FrameOverlayCommand[],
  width: number,
  height: number,
): Float32Array {
  const values: number[] = [];
  for (const command of commands) {
    const points = clipped(command, width, height);
    const r = (command.colour >>> 11) & 31,
      g = (command.colour >>> 5) & 63,
      b = command.colour & 31;
    const colour = [((r << 3) | (r >>> 2)) / 255, ((g << 2) | (g >>> 4)) / 255, ((b << 3) | (b >>> 2)) / 255];
    for (let index = 1; index + 1 < points.length; index++)
      for (const point of [points[0]!, points[index]!, points[index + 1]!])
        values.push((point.x / width) * 2 - 1, 1 - (point.y / height) * 2, ...colour);
  }
  return new Float32Array(values);
}

/** Session-owned, native-generation overlay pass. Its caller keeps the fallback picture if preparation fails. */
export class FrameOverlayPass {
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertices = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const shaders: WebGLShader[] = [];
    try {
      this.program = gl.createProgram();
      this.buffer = gl.createBuffer();
      this.vao = gl.createVertexArray();
      if (!this.program || !this.buffer || !this.vao) throw new Error('Overlay resources unavailable');
      for (const [kind, source] of [
        [
          gl.VERTEX_SHADER,
          `#version 300 es
          layout(location = 0) in vec2 position;
          layout(location = 1) in vec3 rgb;
          out vec3 colour;
          void main() { gl_Position = vec4(position, 0.0, 1.0); colour = rgb; }`,
        ],
        [
          gl.FRAGMENT_SHADER,
          `#version 300 es
          precision highp float;
          in vec3 colour;
          out vec4 outputColour;
          void main() { outputColour = vec4(colour, 1.0); }`,
        ],
      ] as const) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error('Overlay shader unavailable');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Overlay shader failed');
        gl.attachShader(this.program, shader);
      }
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Overlay program failed');
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  prepare(commands: readonly FrameOverlayCommand[], width: number, height: number): void {
    const { gl } = this;
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      const data = frameOverlayVertices(commands, width, height);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
      this.requireDevice();
      this.vertices = data.length / 5;
    } finally {
      gl.bindVertexArray(previousVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);
    }
  }

  draw(): void {
    const { gl } = this;
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    try {
      gl.bindVertexArray(this.vao);
      gl.useProgram(this.program);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertices);
      this.requireDevice();
    } finally {
      gl.bindVertexArray(previousVao);
      gl.useProgram(previousProgram);
    }
  }

  private requireDevice(): void {
    // WebGL reports allocation and draw failures through its error flag, without throwing a JavaScript exception.
    if (this.gl.isContextLost() || this.gl.getError() !== this.gl.NO_ERROR)
      throw new Error('Overlay device unavailable');
  }

  destroy(): void {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
    this.buffer = null;
    this.vao = null;
    this.program = null;
  }
}
