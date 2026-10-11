// The VM core only sees game contracts through adapter re-exports; the reader and the control come from GameRuntimeHooks.
export type { GameRenderPreparation, GameRenderState, GameRenderStateReader } from '../games/renderState';
export type { GameCommandState, GameCommandStateReader } from '../games/commandState';
export type { RenderPassthroughControl } from '../games/renderPassthrough';
