import { Vector4, type Object3D } from 'three/webgpu';
import { If, float, floor, max, min, sRGBTransferEOTF, sRGBTransferOETF, uniform, vec3 } from 'three/tsl';
import type { ShaderNode } from './tsl';

/**
 * Per-object picture tint: how the game changes a whole object picture on one frame (the Iron Curtain's pulse, the
 * Force Shield's blue, a Berserk unit's red). It is DATA of an instance or of a drawn mesh, never a material or a
 * shader variant: the first tinted object on screen builds no shader graph and compiles no pipeline.
 *
 * The engine lights a palette colour with a level (1 = as painted, capped at 2) and then adds a 5/6/5-bit colour, all
 * in the display's own scale. `applyObjectTint` does the same to a finished scene-linear colour: to display scale,
 * times the factor (limited so that level x factor stays within the cap), clipped at white, plus the colour, clipped
 * again, and back.
 */
export interface ObjectTint {
  /** Factor on the object's light level; 1 = unchanged. */
  light: number;
  /** Added colour, 0..1 per channel in sRGB scale. */
  add?: readonly [number, number, number];
}

/** The engine's cap on a light level, in palette brightness (see the YR module's technoTint.ts). */
export const TINT_LEVEL_CAP = 2;

/** Bits of the packed added colour: the engine's own 5/6/5 display format. */
const RED = 31;
const GREEN = 63;
const BLUE = 31;

/** An added colour as one exact float (0..65535): red << 11 | green << 5 | blue of the 5/6/5-bit colour. */
export function packTintColour(add: readonly [number, number, number] | undefined): number {
  if (!add) return 0;
  const level = (value: number, top: number) => Math.max(0, Math.min(top, Math.round(value * top)));
  return (level(add[0], RED) << 11) | (level(add[1], GREEN) << 5) | level(add[2], BLUE);
}

/** Inverse of packTintColour (CPU twin of the shader's decoding). */
export function unpackTintColour(packed: number): [number, number, number] {
  const value = Math.max(0, Math.min(0xffff, Math.round(packed)));
  return [(value >> 11) / RED, ((value >> 5) & GREEN) / GREEN, (value & BLUE) / BLUE];
}

/** A light factor as stored: finite, never negative, at most the cap (a larger factor cannot show). */
export function tintLight(tint: ObjectTint | undefined): number {
  const light = tint?.light;
  return light === undefined || !Number.isFinite(light) ? 1 : Math.max(0, Math.min(TINT_LEVEL_CAP, light));
}

/** CPU twin of applyObjectTint for one sRGB colour (0..1 per channel) drawn at light level `level`. */
export function tintedSrgb(
  srgb: readonly [number, number, number],
  tint: ObjectTint | undefined,
  level = 1,
): [number, number, number] {
  const light = Math.min(tintLight(tint), TINT_LEVEL_CAP / Math.max(level, 1e-3));
  const add = unpackTintColour(packTintColour(tint?.add));
  return [0, 1, 2].map((i) => Math.min(1, Math.min(1, srgb[i]! * light) + add[i]!)) as [number, number, number];
}

/**
 * `colour` (scene-linear RGB) with a tint: `light` the factor, `packed` the added colour of packTintColour, `level`
 * the light level the colour was already drawn with (1 when unknown), `white` the scene-linear value the display
 * shows as white at clear noon (the look's reference for display-referred art). The engine works on the finished
 * display colour, so the colour is taken to display scale against `white`, changed there and brought back; a
 * factor applied to scene-linear light instead would darken half as much on screen (0.2 would show as 0.48).
 * Highlights above white are scaled like everything else and never raised to white. An untinted object pays one
 * comparison.
 */
export function applyObjectTint(
  colour: ShaderNode,
  light: ShaderNode,
  packed: ShaderNode,
  level: ShaderNode | number = 1,
  white: ShaderNode | number = 1,
): ShaderNode {
  const result: ShaderNode = vec3(colour).toVar('objectTinted');
  // The level is evaluated here, before the branch: it may come from a filtered texture sample (the map's light), and
  // WGSL only allows those in uniform control flow.
  const lit: ShaderNode = float(level).toVar('objectTintLevel');
  If(light.sub(1).abs().greaterThan(1e-4).or(packed.greaterThan(0.5)), () => {
    const factor: ShaderNode = min(light, float(TINT_LEVEL_CAP).div(max(lit, 1e-3)));
    // Exact integers: the packed colour is constant over the object.
    const code: ShaderNode = floor(packed.add(0.5));
    const red: ShaderNode = floor(code.div(2048));
    const rest: ShaderNode = code.sub(red.mul(2048));
    const green: ShaderNode = floor(rest.div(32));
    const blue: ShaderNode = rest.sub(green.mul(32));
    const add: ShaderNode = vec3(red.div(RED), green.div(GREEN), blue.div(BLUE));
    const reference: ShaderNode = max(vec3(white), 1e-4);
    const display: ShaderNode = (sRGBTransferOETF(max(result.div(reference), 0)) as ShaderNode).toVar(
      'objectTintDisplay',
    );
    // Clip at white like the engine's palette lighting, but never pull a highlight that was above white down to it.
    const scaled: ShaderNode = min(display.mul(factor), max(display, 1)).toVar('objectTintScaled');
    const coloured: ShaderNode = min(scaled.add(add), max(scaled, 1));
    result.assign((sRGBTransferEOTF(coloured) as ShaderNode).mul(reference));
  });
  return result;
}

const NONE = new Vector4(1, 0, 0, 0);

/**
 * The tint of the mesh being drawn: its `userData.objectTint` (x = light factor, y = packed added colour), none
 * without one. One uniform of the shared graph, written per drawn object like the silhouette code.
 */
export const meshObjectTint: ShaderNode = uniform(new Vector4(1, 0, 0, 0))
  .setName('objectTint')
  .onObjectUpdate(
    ({ object }: { object?: Object3D | null }) => (object?.userData.objectTint as Vector4 | undefined) ?? NONE,
  );

/** Give a mesh its tint (`target` is reused when the mesh already has one); undefined removes it. */
export function setMeshObjectTint(mesh: Object3D, tint: ObjectTint | undefined): void {
  const light = tintLight(tint);
  const packed = packTintColour(tint?.add);
  if (light === 1 && packed === 0) {
    if (mesh.userData.objectTint) delete mesh.userData.objectTint;
    return;
  }
  const value = (mesh.userData.objectTint as Vector4 | undefined) ?? (mesh.userData.objectTint = new Vector4());
  value.set(light, packed, 0, 0);
}
