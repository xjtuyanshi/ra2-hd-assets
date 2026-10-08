import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('sorted membership deltas preserve page indices and retire only absent pages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-membership-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include <stdint.h>
struct nh_page { uint32_t address; uint64_t dirty; };
#include "mirror-membership.h"
#include <assert.h>
#define P(address) {address, 0}
int main(void) {
    struct nh_page old[] = {P(0x1000), P(0x3000), P(0x5000)};
    struct nh_page next[] = {P(0x1000), P(0x2000), P(0x5000), P(0x9000)};
    uint32_t indices[4096], removed[4096]; int changed;
    uint32_t count = nh_merge_membership(next, 4, old, 3, indices, removed, &changed);
    assert(changed && count == 1 && removed[0] == 0x3000);
    assert(indices[0] == 0 && indices[1] == UINT32_MAX && indices[2] == 2 && indices[3] == UINT32_MAX);
    count = nh_merge_membership(old, 3, old, 3, indices, removed, &changed);
    assert(!changed && !count && indices[0] == 0 && indices[1] == 1 && indices[2] == 2);
    count = nh_merge_membership(next, 4, old, 0, indices, removed, &changed);
    assert(changed && !count);
    for (unsigned i = 0; i < 4; ++i) assert(indices[i] == UINT32_MAX);
    count = nh_merge_membership(next, 0, old, 3, indices, removed, &changed);
    assert(changed && count == 3 && removed[0] == 0x1000 && removed[1] == 0x3000 && removed[2] == 0x5000);
    struct nh_page previous[4096], current[4096];
    for (unsigned i = 0; i < 4096; ++i) { previous[i].address = i * 8192; current[i].address = i * 8192 + 4096; }
    count = nh_merge_membership(current, 4096, previous, 4096, indices, removed, &changed);
    assert(changed && count == 4096);
    for (unsigned i = 0; i < 4096; ++i) { assert(indices[i] == UINT32_MAX); assert(removed[i] == i * 8192); }
    /* Retry a rejected publication against the same acknowledged previous list:
     * all removals survive, until the caller explicitly commits the new image. */
    count = nh_merge_membership(current, 4096, previous, 4096, indices, removed, &changed);
    assert(changed && count == 4096);
    count = nh_merge_membership(current, 4096, current, 4096, indices, removed, &changed);
    assert(!changed && !count);
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
