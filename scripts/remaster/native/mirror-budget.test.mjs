import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('budget probes bound unchecked membership and packing work across resets and long captures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-budget-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include "mirror-budget.h"
#include <assert.h>
static void check(unsigned length, unsigned bytes_per_item) {
    struct nh_budget_probe probe = {999};
    nh_budget_probe_reset(&probe);
    unsigned unchecked = 0, calls = 0;
    for (unsigned i = 0; i < length; ++i) {
        if (nh_budget_probe_due(&probe)) { unchecked = 0; ++calls; }
        ++unchecked;
        assert(unchecked <= 16);
        if (bytes_per_item) assert(unchecked * bytes_per_item <= 65536);
    }
    assert(calls == (length + 15) / 16);
    nh_budget_probe_reset(&probe);
    assert(nh_budget_probe_due(&probe)); /* No unused credit crosses a capture. */
}
int main(void) {
    unsigned sizes[] = {0, 1, 15, 16, 17, 31, 32, 33, 8112, 65536, 1000000};
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(*sizes); ++i) {
        check(sizes[i], 0); check(sizes[i], 4096);
    }
    struct nh_budget_probe membership = {0}, packing = {0};
    for (unsigned i = 0; i < 15; ++i) nh_budget_probe_due(&membership);
    assert(nh_budget_probe_due(&packing)); /* Independent stage starts with a probe. */
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
