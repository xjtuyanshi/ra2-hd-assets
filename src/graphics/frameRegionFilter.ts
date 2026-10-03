/** Bilinear RGB sampling of a caller-selected native framebuffer region; no reconstructed map or palette edits. */
export function frameRegionFilterShader(kind: 'indexed' | 'rgba' | 'rgb565'): string {
  const sampler = kind === 'indexed' ? 'indexedFrame' : kind === 'rgba' ? 'rgbaFrame' : 'packedFrame';
  const uniforms =
    kind === 'indexed'
      ? 'uniform sampler2D indexedFrame; uniform sampler2D palette;'
      : kind === 'rgba'
        ? 'uniform sampler2D rgbaFrame;'
        : 'uniform highp usampler2D packedFrame;';
  const read =
    kind === 'indexed'
      ? `int i = int(texelFetch(indexedFrame, at, 0).r * 255.0 + 0.5);
      return texelFetch(palette, ivec2(i, 0), 0).rgb;`
      : kind === 'rgba'
        ? 'return texelFetch(rgbaFrame, at, 0).rgb;'
        : `uint p = texelFetch(packedFrame, at, 0).r;
      uvec3 rgb = uvec3((p >> 11u) & 31u, (p >> 5u) & 63u, p & 31u);
      rgb = (rgb << uvec3(3u, 2u, 3u)) | (rgb >> uvec3(2u, 4u, 2u));
      return vec3(rgb) / 255.0;`;
  return `#version 300 es
    precision highp float;
    precision highp int;
    ${uniforms}
    uniform vec4 sampleRect;
    in vec2 uv;
    out vec4 color;
    vec3 readRgb(ivec2 at) {
      at = clamp(at, ivec2(sampleRect.xy), ivec2(sampleRect.zw) - ivec2(1));
      ${read}
    }
    void main() {
      vec2 point = uv * vec2(textureSize(${sampler}, 0)) - vec2(0.5);
      ivec2 at = ivec2(floor(point));
      vec2 weight = fract(point);
      vec3 top = mix(readRgb(at), readRgb(at + ivec2(1, 0)), weight.x);
      vec3 bottom = mix(readRgb(at + ivec2(0, 1)), readRgb(at + ivec2(1, 1)), weight.x);
      color = vec4(mix(top, bottom, weight.y), 1.0);
    }`;
}

export function frameRegionScissor(
  rect: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
  target: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  if (
    ![rect.x, rect.y, rect.width, rect.height, frame.width, frame.height, target.width, target.height].every(
      Number.isInteger,
    ) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    frame.width < 1 ||
    frame.height < 1 ||
    target.width < 1 ||
    target.height < 1 ||
    rect.x + rect.width > frame.width ||
    rect.y + rect.height > frame.height
  )
    return null;
  const sx = target.width / frame.width,
    sy = target.height / frame.height;
  const x0 = Math.round(rect.x * sx),
    x1 = Math.round((rect.x + rect.width) * sx);
  const y0 = Math.round(rect.y * sy),
    y1 = Math.round((rect.y + rect.height) * sy);
  return x1 > x0 && y1 > y0 ? { x: x0, y: target.height - y1, width: x1 - x0, height: y1 - y0 } : null;
}
