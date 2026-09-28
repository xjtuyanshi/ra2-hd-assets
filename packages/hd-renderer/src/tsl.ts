/**
 * TSL node graphs are typed dynamically at runtime, while @types/three models each node's GLSL type statically.
 * Helper signatures and uniform fields that mix float/vec/color nodes use this alias instead of fighting the
 * declaration overloads; shader correctness is covered by the sandbox render checks, not by these types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ShaderNode = any;
