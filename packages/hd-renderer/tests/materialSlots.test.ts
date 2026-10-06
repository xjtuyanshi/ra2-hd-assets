import { describe, expect, it } from 'vitest';
import { DataTexture, LinearFilter, Mesh, MeshBasicNodeMaterial, NearestFilter, PlaneGeometry } from 'three/webgpu';
import { float } from 'three/tsl';
import {
  bindSlots,
  bindSlotsBeforeRender,
  hasSlotBinder,
  inheritSlotBinder,
  samplingClass,
  setSlotBinder,
  slotMaterial,
  SlotTextureNode,
  textureSlot,
} from '../src/materialSlots';

type TextureSlot = { value: DataTexture; getUniformHash(): string; isTextureNode: boolean };

describe('material slots', () => {
  it('makes a slot material that keeps what r186 drops from a cloned node material', () => {
    const prototype = new MeshBasicNodeMaterial();
    prototype.transparent = true;
    prototype.depthWrite = false;
    // Lost by NodeMaterial.copy in r186: the clone would discard nothing and write depth with its clear fragments.
    prototype.alphaTest = 0.04;
    const node = float(1);
    prototype.colorNode = node;
    prototype.userData.code = node;
    let bound = 0;
    const material = slotMaterial(prototype, () => bound++);
    expect(material).not.toBe(prototype);
    expect(material.alphaTest).toBe(0.04);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    // The prototype's node instances: three then finds the built shader again.
    expect(material.colorNode).toBe(node);
    expect(material.userData.code).toBe(node);
    expect(material.userData).not.toBe(prototype.userData);
    expect(hasSlotBinder(material)).toBe(true);
    expect(hasSlotBinder(prototype)).toBe(false);
    bindSlots(material);
    bindSlots(prototype);
    bindSlots(null);
    expect(bound).toBe(1);
  });

  it('binds the material three is about to draw, and lets variants inherit a binder', () => {
    const order: string[] = [];
    const a = new MeshBasicNodeMaterial();
    const b = new MeshBasicNodeMaterial();
    setSlotBinder(a, () => order.push('a'));
    setSlotBinder(b, () => order.push('b'));
    const mesh = new Mesh(new PlaneGeometry(1, 1), a);
    mesh.onBeforeRender = bindSlotsBeforeRender;
    // three passes (renderer, scene, camera, geometry, material, group): the material drawn, not mesh.material.
    (mesh.onBeforeRender as (...args: unknown[]) => void).call(mesh, null, null, null, mesh.geometry, b, null);
    (mesh.onBeforeRender as (...args: unknown[]) => void).call(mesh, null, null, null, mesh.geometry, a, null);
    bindSlots([a, b]);
    expect(order).toEqual(['b', 'a', 'a', 'b']);
    const variant = new MeshBasicNodeMaterial();
    inheritSlotBinder(variant, a);
    bindSlots(variant);
    expect(order.at(-1)).toBe('a');
    inheritSlotBinder(variant, new MeshBasicNodeMaterial());
    expect(hasSlotBinder(variant)).toBe(false);
  });

  it('keeps every slot a binding of its own, of the sampling class it was made for', () => {
    const nearest = textureSlot('nearest') as unknown as TextureSlot;
    const again = textureSlot('nearest') as unknown as TextureSlot;
    const filtered = textureSlot('filtered') as unknown as TextureSlot;
    expect(nearest.isTextureNode).toBe(true);
    // Two slots holding the same placeholder must not be merged into one binding by three.
    expect(nearest.value).toBe(again.value);
    expect(nearest.getUniformHash()).not.toBe(again.getUniformHash());
    expect(samplingClass(nearest.value)).toBe('nearest');
    expect(samplingClass(filtered.value)).toBe('filtered');
    const page = new DataTexture(new Uint8Array(4), 1, 1);
    expect(samplingClass(page)).toBe('nearest');
    page.magFilter = LinearFilter;
    expect(samplingClass(page)).toBe('filtered');
    page.magFilter = NearestFilter;
    page.minFilter = LinearFilter;
    expect(samplingClass(page)).toBe('filtered');
    const own = textureSlot(page) as unknown as TextureSlot;
    expect(own.value).toBe(page);
    expect(own).toBeInstanceOf(SlotTextureNode);
  });
});
