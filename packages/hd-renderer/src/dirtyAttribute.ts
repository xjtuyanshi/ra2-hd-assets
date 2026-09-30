import { InstancedBufferAttribute, InstancedInterleavedBuffer } from 'three/webgpu';

/** Float32 instance data that only uploads changed components, preserving writes pending an earlier render. */
export class DirtyAttribute extends InstancedBufferAttribute {
  private first = Infinity;
  private end = 0;
  private shared: InstancedInterleavedBuffer | null = null;

  constructor(array: Float32Array, itemSize: number) {
    super(array, itemSize);
  }

  private write(offset: number, value: number): void {
    const next = Math.fround(value);
    if (this.array[offset] === next) return;
    this.array[offset] = next;
    if (offset < this.first) this.first = offset;
    if (offset >= this.end) this.end = offset + 1;
  }

  override setX(index: number, x: number): this {
    this.write(index * this.itemSize, x);
    return this;
  }

  override setComponent(index: number, component: number, value: number): this {
    this.write(index * this.itemSize + component, value);
    return this;
  }

  /** Multiple shader attributes can share one vertex buffer and the same dirty/upload lifecycle. */
  interleaved(): InstancedInterleavedBuffer {
    if (!this.shared) {
      this.shared = new InstancedInterleavedBuffer(this.array, this.itemSize, 1);
      this.shared.updateRanges = this.updateRanges;
      this.shared.version = this.version;
    }
    return this.shared;
  }

  override setXYZ(index: number, x: number, y: number, z: number): this {
    const offset = index * this.itemSize;
    this.write(offset, x);
    this.write(offset + 1, y);
    this.write(offset + 2, z);
    return this;
  }

  override setXYZW(index: number, x: number, y: number, z: number, w: number): this {
    const offset = index * this.itemSize;
    this.write(offset, x);
    this.write(offset + 1, y);
    this.write(offset + 2, z);
    this.write(offset + 3, w);
    return this;
  }

  /** Returns whether a new upload was scheduled; unchanged calls leave the attribute version untouched. */
  flush(): boolean {
    if (this.first === Infinity) return false;
    // Three clears these after upload. Merge with an outstanding range if several logic updates precede a render.
    const ranges = this.updateRanges;
    if (ranges.length) {
      const pending = ranges[0]!;
      const start = Math.min(pending.start, this.first);
      const end = Math.max(pending.start + pending.count, this.end);
      pending.start = start;
      pending.count = end - start;
    } else this.addUpdateRange(this.first, this.end - this.first);
    this.needsUpdate = true;
    if (this.shared) this.shared.version = this.version;
    this.first = Infinity;
    this.end = 0;
    return true;
  }
}
