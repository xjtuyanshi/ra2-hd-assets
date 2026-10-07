import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('rel32 uses the execution origin for relocated E8/E9 and unsigned 32-bit wrap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-rel32-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include "x86-relative.h"
#include <assert.h>

static void check(uint8_t opcode, uint32_t origin, uint32_t target) {
    uint8_t staging[5], installed[5];
    uint32_t displacement;
    nh_x86_relative(staging, opcode, origin, target);
    memcpy(installed, staging, sizeof(staging));
    memcpy(&displacement, installed + 1, sizeof(displacement));
    assert(installed[0] == opcode);
    assert(displacement == target - (origin + 5u));
    assert(nh_x86_relative_target(installed, origin) == target);
}

int main(void) {
    const uint8_t opcodes[] = {0xe8, 0xe9};
    for (unsigned i = 0; i < sizeof(opcodes); ++i) {
        /* The staging bytes live on the host stack, not at the guest site. */
        check(opcodes[i], 0x0055de73u, 0x70001000u);
        check(opcodes[i], 0x70001000u, 0x0055de7eu);
        check(opcodes[i], 0x00001000u, 0xf0001000u);
        check(opcodes[i], 0xf0001000u, 0x00001000u);
        check(opcodes[i], 0xfffffffdu, 0x00000010u);
        check(opcodes[i], 0x00000010u, 0xfffffffdu);
    }
    return 0;
}
`,
  );
  try {
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', include, source, '-o', binary], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
