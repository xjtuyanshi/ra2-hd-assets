// @vanguard/formats/ai — the typed, bot-consumable AI database (from aimd.ini).
//
// Import via the package subpath, e.g.
//   import { AiDb, resolveTaskForcesFor } from '@vanguard/formats/ai/index.js';
//
// This is a sibling of rules/ (the RulesDb layer): a pure typed projection of a
// Westwood data file, tolerant of dangling references. See aiDb.ts for the v1
// scope (TaskForces/ScriptTypes/TeamTypes; AITriggerTypes deferred).

export * from './types.js';
export * from './aiDb.js';
