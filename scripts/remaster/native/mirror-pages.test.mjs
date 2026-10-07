import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('explicit page seeds preserve overlap, overflow and the last x86 page', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-pages-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#define NH_MAX_PAGES 4096u
#define NH_PAGE_SIZE 4096u
#define NH_MIRROR_HASH_SIZE 16384u
#include "mirror-pages.h"
#include <assert.h>
static struct nh_page_seed seed;

int main(void) {
    nh_page_seed_init(&seed);
    nh_page_seed_range(&seed, 0x1fffu, 2, 4096);
    nh_page_seed_range(&seed, 0x1000u, 8192, 4096);
    nh_page_seed_range(&seed, 0xffffffffu, 0, 4096);
    assert(!seed.flags && seed.count == 2);
    assert(seed.pages[0] == 0x1000 && seed.pages[1] == 0x2000);
    nh_page_seed_range(&seed, 0xfffff000u, 4096, 4096);
    assert(!seed.flags && seed.count == 3 && seed.pages[2] == 0xfffff000u);
    nh_page_seed_range(&seed, 0xffffffffu, 2, 4096);
    assert(seed.flags == 4 && seed.count == 3);

    nh_page_seed_init(&seed);
    nh_page_seed_range(&seed, 0x1000u, 8192, 2);
    nh_page_seed_range(&seed, 0x1001u, 4096, 2); /* At capacity, overlap remains valid. */
    assert(!seed.flags && seed.count == 2);
    nh_page_seed_range(&seed, 0x3000u, 1, 2);
    assert(seed.flags == 1 && seed.count == 2);

    nh_page_seed_init(&seed);
    /* Hash collisions, shuffled duplicate ranges, and a complete maximum union. */
    for (unsigned i = 0; i < 4096; ++i)
        nh_page_seed_range(&seed, ((i * 4051u) & 4095u) * 4096u, 4096, 4096);
    for (unsigned i = 0; i < 4096; ++i)
        nh_page_seed_range(&seed, i * 4096u + 17, 200, 4096);
    assert(!seed.flags && seed.count == 4096);
    nh_page_seed_range(&seed, 4096u * 4096u, 1, 4096);
    assert(seed.flags == 1 && seed.count == 4096);
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
