import {
  DataTexture,
  LinearFilter,
  NearestFilter,
  TextureNode,
  type Material,
  type Object3D,
  type Texture,
} from 'three/webgpu';
import { nodeObject } from 'three/tsl';
import type { ShaderNode } from './tsl';

/**
 * Per-material data for materials that share one shader graph.
 *
 * three r186 builds a shader (NodeBuilder: 15 to 100 ms on the thread that presents frames) for every material whose
 * node graph it has not seen in a render pass, and compiles a GPU pipeline for every new shader text. Art that differs
 * only in data (which atlas, which palette, which frame table) therefore must not differ in graph: such materials
 * are clones of one prototype (a clone keeps the prototype's node instances, so three finds the built shader and the
 * compiled pipeline again), and what differs sits in SLOTS, nodes of the shared graph whose values are written just
 * before each object is drawn. three reads uniform and texture values per drawn object, after
 * `Object3D.onBeforeRender`, into bindings of that object's own, so every object keeps its own textures and numbers
 * without any buffer or bind group being rewritten while they stay the same.
 *
 * A material's binder writes its values into the slots of its graph (`setSlotBinder`); a mesh that draws slot
 * materials calls `bindSlots` from `onBeforeRender` (`bindSlotsBeforeRender` is that callback for a mesh that draws
 * its own material). Variants made by cloning a slot material inherit its binder (`inheritSlotBinder`).
 */
const binders = new WeakMap<Material, () => void>();

/** `bind` writes this material's values into the slot nodes of the graph it shares. */
export function setSlotBinder(material: Material, bind: () => void): void {
  binders.set(material, bind);
}

/** A clone of a slot material draws with the same values (three's Material.copy cannot know about them). */
export function inheritSlotBinder(variant: Material, source: Material): void {
  const bind = binders.get(source);
  if (bind) binders.set(variant, bind);
  else binders.delete(variant);
}

/**
 * A slot material of `prototype`'s graph: a clone that writes its values with `bind` before it is drawn.
 *
 * r186's NodeMaterial.copy copies the accessors of the material's own class and the enumerable fields that do not
 * begin with an underscore. `alphaTest` is an accessor of Material over `_alphaTest` and is lost: a clone would
 * discard nothing, and its clear fragments would write depth and hide what is behind them. `userData` is left empty.
 * Both are restored here (userData shallowly: its values may be nodes, which must stay the prototype's).
 */
export function slotMaterial<T extends Material>(prototype: T, bind: () => void): T {
  const material = prototype.clone();
  material.alphaTest = prototype.alphaTest;
  Object.assign(material.userData, prototype.userData);
  binders.set(material, bind);
  return material;
}

/** Whether `material` has slot values of its own (a prototype has none). */
export function hasSlotBinder(material: Material): boolean {
  return binders.has(material);
}

/** Write `material`'s values into its graph's slots; nothing for a material without slots. */
export function bindSlots(material: Material | Material[] | null | undefined): void {
  if (!material) return;
  if (Array.isArray(material)) for (const one of material) binders.get(one)?.();
  else binders.get(material)?.();
}

/** `Object3D.onBeforeRender` of a mesh that draws slot materials: three passes the material being drawn. */
export function bindSlotsBeforeRender(
  this: Object3D,
  _renderer: unknown,
  _scene: unknown,
  _camera: unknown,
  _geometry: unknown,
  material: Material,
): void {
  binders.get(material)?.();
}

/**
 * A texture node whose texture is a slot. three merges texture nodes of one shader by the texture they hold when the
 * shader is built; two slots that happened to hold the same texture then would share one binding for good. A slot
 * is its own binding whatever it holds (its samples, clones that refer back to it, share it as usual).
 */
export class SlotTextureNode extends TextureNode {
  override getUniformHash(): string {
    return `slot-texture-${(this.getBase() as TextureNode).id}`;
  }
}

/**
 * How three reads a texture decides shader text, not only bindings: r186 emits a texel load for a texture whose
 * filters are both nearest and a filtered sample otherwise. Every texture a slot holds must therefore be of one
 * class, and graphs that are shared by layers must be keyed by the class of each slot's textures.
 */
export function samplingClass(texture: Texture): 'nearest' | 'filtered' {
  return texture.minFilter === NearestFilter && texture.magFilter === NearestFilter ? 'nearest' : 'filtered';
}

/** One opaque black texel of each class: what a slot holds before the first object is drawn. */
const placeholders: Partial<Record<'nearest' | 'filtered', DataTexture>> = {};

/**
 * A texture slot for textures of one sampling class (see samplingClass), or of the kind of `initial` (float data
 * for texel-loaded tables, for example): the shader's sampling code and the binding's type are decided from what the
 * slot holds when the shader is built, which is the first drawn object's texture.
 */
export function textureSlot(initial: Texture | 'nearest' | 'filtered' = 'nearest'): ShaderNode {
  if (typeof initial === 'string') {
    let texture = placeholders[initial];
    if (!texture) {
      texture = placeholders[initial] = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      if (initial === 'filtered') texture.magFilter = texture.minFilter = LinearFilter;
      texture.needsUpdate = true;
    }
    initial = texture;
  }
  return nodeObject(new SlotTextureNode(initial)) as ShaderNode;
}
