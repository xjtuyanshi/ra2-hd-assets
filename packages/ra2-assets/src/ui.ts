import type { Palette, ShpFile } from 'ra2-formats';

export interface UiRaster {
  width: number;
  height: number;
  channels: 4;
  data: Uint8Array;
}

/** Keep crop offsets, optionally clipping/padding to a caller-owned slot without resampling pixels. */
export function rasterizeUiFrame(
  shape: ShpFile,
  palette: Palette,
  index: number,
  size?: { width: number; height: number },
): UiRaster {
  const width = size?.width ?? shape.cx,
    height = size?.height ?? shape.cy;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4096 * 4096)
    throw new Error('Invalid UI shape bounds');
  const frame = shape.frame(index),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < frame.cy; y++) {
    for (let x = 0; x < frame.cx; x++) {
      const color = frame.pixels[y * frame.cx + x];
      const dx = frame.x + x,
        dy = frame.y + y;
      if (!color || dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      data.set(palette.rgba(color), (dy * width + dx) * 4);
    }
  }
  return { width, height, channels: 4, data };
}

export interface CursorIndex {
  version: 1;
  frames: { x: number; y: number; width: number; height: number }[];
  /** Optional caller-supplied cursor type metadata; runtime hotspots need not be baked into the atlas. */
  types?: readonly unknown[];
}

/** Pack every frame, including empty placeholders, without assuming body/shadow pairs. */
export function buildCursorAtlas(
  shape: ShpFile,
  palette: Palette,
  types?: readonly unknown[],
): {
  image: UiRaster;
  index: CursorIndex;
} {
  if (!shape.count) throw new Error('Cursor shape has no frames');
  const columns = Math.ceil(Math.sqrt(shape.count)),
    rows = Math.ceil(shape.count / columns);
  const width = columns * shape.cx,
    height = rows * shape.cy;
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024)
    throw new Error('Cursor atlas exceeds bounds');
  const image: UiRaster = { width, height, channels: 4, data: new Uint8Array(width * height * 4) };
  const frames: CursorIndex['frames'] = [];
  for (let i = 0; i < shape.count; i++) {
    const raster = rasterizeUiFrame(shape, palette, i);
    const x = (i % columns) * shape.cx,
      y = Math.floor(i / columns) * shape.cy;
    for (let row = 0; row < raster.height; row++) {
      image.data.set(
        raster.data.subarray(row * raster.width * 4, (row + 1) * raster.width * 4),
        ((y + row) * width + x) * 4,
      );
    }
    frames.push({ x, y, width: shape.cx, height: shape.cy });
  }
  return { image, index: { version: 1, frames, ...(types ? { types } : {}) } };
}
