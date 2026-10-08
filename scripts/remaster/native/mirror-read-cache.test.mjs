import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('follow page cache is boundary-scoped and retries actual failed reads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-read-cache-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#define NH_MAX_PAGES 4096u
#define NH_PAGE_SIZE 4096u
#define NH_MIRROR_HASH_SIZE 16384u
#include "mirror-read-cache.h"
#include <assert.h>
#include <stdlib.h>
static struct nh_read_cache cache;
static unsigned reads, epoch, failing;
static int page_read(uint32_t address, void *out, uint32_t bytes) {
    assert(!(address % NH_PAGE_SIZE) && bytes == NH_PAGE_SIZE);
    ++reads;
    if (failing && address == 0x2000) return 0;
    for (unsigned i = 0; i < bytes; ++i)
        ((uint8_t *)out)[i] = (uint8_t)((address >> 12) + i + epoch);
    return 1;
}
int main(void) {
    uint8_t bytes[8], *scratch = malloc(NH_MAX_PAGES * NH_PAGE_SIZE);
    assert(scratch);
    nh_read_cache_clear(&cache);
    assert(nh_read_cache_copy(&cache, scratch, 0x1ffe, bytes, 4, page_read));
    assert(reads == 2 && cache.count == 2);
    assert(bytes[0] == 255 && bytes[1] == 0 && bytes[2] == 2 && bytes[3] == 3);
    epoch = 7;
    assert(nh_read_cache_copy(&cache, scratch, 0x2000, bytes, 4, page_read));
    assert(reads == 2 && bytes[0] == 2); /* Stable within a boundary. */
    nh_read_cache_clear(&cache);
    assert(nh_read_cache_copy(&cache, scratch, 0x2000, bytes, 4, page_read));
    assert(reads == 3 && bytes[0] == 9); /* Fresh validation at the next boundary. */
    nh_read_cache_clear(&cache); failing = 1;
    assert(!nh_read_cache_copy(&cache, scratch, 0x1ffe, bytes, 4, page_read));
    assert(reads == 5 && cache.count == 1);
    failing = 0;
    assert(nh_read_cache_copy(&cache, scratch, 0x2000, bytes, 4, page_read));
    assert(reads == 6 && cache.count == 2 && bytes[0] == 9);
    assert(!nh_read_cache_copy(&cache, scratch, 0xffffffff, bytes, 2, page_read));
    assert(reads == 6);
    assert(nh_read_cache_copy(&cache, scratch, 0xffffffff, bytes, 1, page_read));
    assert(reads == 7);
    nh_read_cache_clear(&cache); reads = 0;
    for (unsigned i = 0; i < NH_MAX_PAGES; ++i) {
        unsigned address = ((i * 4051u) & 4095u) * NH_PAGE_SIZE;
        assert(nh_read_cache_copy(&cache, scratch, address, bytes, 4, page_read));
    }
    for (unsigned i = 0; i < NH_MAX_PAGES; ++i)
        assert(nh_read_cache_copy(&cache, scratch, i * NH_PAGE_SIZE, bytes, 4, page_read));
    assert(reads == NH_MAX_PAGES && cache.count == NH_MAX_PAGES);
    assert(!nh_read_cache_copy(&cache, scratch, NH_MAX_PAGES * NH_PAGE_SIZE, bytes, 4, page_read));
    assert(reads == NH_MAX_PAGES);
    free(scratch);
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
