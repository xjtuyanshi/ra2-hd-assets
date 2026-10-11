import type { GameRenderHouse, GameRenderPreparation } from '../renderState';
import type { GuestMemory } from '../../vm86/win32';
import { YR_STATE_GLOBALS as G, YR_STATE_OFFSETS as O, YR_STATE_LIMITS as L, YR_THEATERS } from './stateReader';

type ReadBatch = readonly (readonly [number, number])[];
const word = (bytes: Uint8Array, offset = 0) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const pointer = (value: number, length: number) =>
  Number.isInteger(value) && value >= L.minPointer && value % 4 === 0 && value + length <= 0x100000000;
const equal = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * The existing ScenarioClass/HouseClass fields become useful before a full battlefield snapshot is readable.
 * Sample only these bounded fields, then reread their identity/descriptor. A concurrent load may discard a hint,
 * but can never publish mixed map identities. A retained old scenario is harmless: consumers may prefetch only.
 */
function* preparation(): Generator<ReadBatch, GameRenderPreparation | null, Uint8Array[]> {
  const [root] = yield [[G.scenario, 4]];
  if (root?.length !== 4) return null;
  const scenario = word(root);
  if (!pointer(scenario, O.scenarioFileName + 0x104)) return null;
  const [description] = yield [[scenario + O.scenarioTheater, 0x108]];
  if (description?.length !== 0x108) return null;
  const end = description.indexOf(0, 4);
  if (end <= 4) return null;
  const fileName = String.fromCharCode(...description.subarray(4, end));
  // A cache key must be an actual game filename, never a path or an unfinished buffer.
  if (!/^[A-Za-z0-9_()[\] .-]{1,255}$/.test(fileName) || fileName === '.' || fileName === '..') return null;
  const result: GameRenderPreparation = {
    map: { fileName },
    theater: YR_THEATERS[word(description)] ?? null,
    houses: null,
    localHouse: null,
  };
  const [vector, local] = yield [
    [G.houses, 0x14],
    [G.localHouse, 4],
  ];
  if (vector?.length === 0x14 && local?.length === 4) {
    const count = word(vector, 0x10),
      items = word(vector, 4),
      capacity = word(vector, 8);
    if (count > 0 && count <= L.houses && capacity >= count && pointer(items, count * 4)) {
      const [table] = yield [[items, count * 4]];
      if (table?.length === count * 4) {
        const addresses = Array.from({ length: count }, (_, index) => word(table, index * 4));
        if (addresses.every((address) => pointer(address, O.houseColorScheme + 4))) {
          const fields = yield addresses.flatMap(
            (address) =>
              [
                [address + O.houseArrayIndex, 4],
                [address + O.houseColorScheme, 4],
              ] as const,
          );
          const houses: GameRenderHouse[] = [];
          for (let index = 0; index < count; index++) {
            const identity = fields[index * 2],
              color = fields[index * 2 + 1];
            if (identity?.length !== 4 || color?.length !== 4 || word(identity) !== index || word(color) > 255) break;
            houses.push({ index, colorIndex: word(color) });
          }
          const [latestVector, latestTable, latestLocal] = yield [
            [G.houses, 0x14],
            [items, count * 4],
            [G.localHouse, 4],
          ];
          if (
            houses.length === count &&
            equal(vector, latestVector) &&
            equal(table, latestTable) &&
            equal(local, latestLocal)
          ) {
            result.houses = houses;
            const localIndex = addresses.indexOf(word(local));
            result.localHouse = localIndex >= 0 ? localIndex : null;
          }
        }
      }
    }
  }
  const [latestRoot, latestDescription] = yield [
    [G.scenario, 4],
    [scenario + O.scenarioTheater, 0x108],
  ];
  return equal(root, latestRoot) && equal(description, latestDescription) ? result : null;
}

/** Native direct reads validate each allocation through the agent; never seed the coherent battle mirror. */
export async function readYrNativeRenderPreparation(
  read: (address: number, length: number) => Promise<Uint8Array>,
): Promise<GameRenderPreparation | null> {
  const sample = preparation();
  let step = sample.next();
  while (!step.done) {
    const bytes = await Promise.all(
      step.value.map(async ([address, length]) => {
        try {
          return await read(address, length);
        } catch {
          return new Uint8Array();
        }
      }),
    );
    step = sample.next(bytes);
  }
  return step.value;
}

/** The VM runs the same validation while guest execution is suspended on the host. */
export function readYrVmRenderPreparation(memory: GuestMemory): GameRenderPreparation | null {
  const sample = preparation();
  let step = sample.next();
  while (!step.done)
    step = sample.next(
      step.value.map(([address, length]) => {
        try {
          return memory.read_memory(address, length);
        } catch {
          return new Uint8Array();
        }
      }),
    );
  return step.value;
}
