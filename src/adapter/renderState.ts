// The VM core only sees game contracts through adapter re-exports; the reader and the control come from GameRuntimeHooks.
export type { GameRenderState, GameRenderStateReader } from '../games/renderState';
export type { RenderPassthroughControl } from '../games/renderPassthrough';
