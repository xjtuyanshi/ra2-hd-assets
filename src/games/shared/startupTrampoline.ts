import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/**
 * Where startup-page stubs may live: the static-stub tail the VM core hands out after the import stubs (from 0x80000).
 * They must end below 0xA0000, because v86 maps 0xA0000..0xBFFFF to the VGA adapter and the guest reads video memory
 * there instead of the bytes the host wrote. The core's allocator enforces the same bound; the installers re-check it
 * so a stub can never land in the VGA window whichever allocator they are given.
 */
export const STARTUP_STUB_REGION = Object.freeze({ start: 0x0008_0000, end: 0x000a_0000 });

/** Direct-page trampoline version parameters: fixed addresses, instruction signatures, and initial registers belong to each game. */
export interface StartupTrampolineSpec {
  /** Human-readable game/page label for errors; not used in code generation. */
  readonly label: string;
  /** SHA-256 of the EXE containing the overwrite point; reject installation on mismatch. */
  readonly expectedHash: string;
  readonly site: number;
  /** Initial original instruction bytes at the overwrite point, used to verify the version and prevent repeated installation. */
  readonly signature: readonly number[];
  /** ModRM byte for mov reg, imm32, identifying the register holding native state. */
  readonly movOperand: number;
  /** Initial state written by the stub: 11 for skirmish, 3 for LAN. */
  readonly target: 3 | 11;
}

/**
 * Redirect menu-state selection to a custom stub that writes the state constant into its own storage, then returns through the overwritten instruction prefix. Replace only initial state selection, retaining native setup initialization, message pumping, and return paths. Install before first execution; the caller allocates the stub exclusively from the static-import-stub tail.
 */
export function installStartupTrampoline(
  memory: GuestMemory,
  reserve: (size: number) => number,
  hash: string,
  spec: StartupTrampolineSpec,
): number {
  const { label, site, signature, movOperand, target } = spec;
  if (hash !== spec.expectedHash) throw new Error(`${label}：EXE 哈希不匹配`);
  const current = memory.read_memory(site, signature.length);
  if (current.length !== signature.length || !current.every((byte, index) => byte === signature[index])) {
    throw new Error(`${label}：EXE 指令签名不匹配或重复安装`);
  }
  const base = reserve(48);
  if (!Number.isInteger(base) || base % 16 || base < STARTUP_STUB_REGION.start || base + 48 > STARTUP_STUB_REGION.end) {
    throw new Error(`${label}：启动桩分配越界`);
  }
  const storage = memory.read_memory(base, 48);
  if (storage.length !== 48 || storage.some((byte) => byte !== 0)) throw new Error(`${label}：启动桩已占用`);
  const state = base + 32;
  // MOV preserves flags/stack and needs no host call; after consumption restore default state 18 so later main-menu returns are not redirected.
  const code = [0x8b, movOperand, ...le32(state), 0xc7, 0x05, ...le32(state), ...le32(18)];
  code.push(0xe9, ...le32(site + 5 - (base + code.length + 5)));
  const bytes = new Uint8Array(48);
  bytes.set(code);
  bytes.set(le32(target), 32);
  memory.write_memory(bytes, base);
  memory.write_memory(new Uint8Array([0xe9, ...le32(base - site - 5)]), site);
  return state;
}
