import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('capture region metadata covers every page while each run still requires a fresh exact read', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-region-read-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#define NH_MAX_MESSAGE (32u * 1024u * 1024u)
#include "mirror-region-read.h"
#include <assert.h>
#include <string.h>
static struct nh_read_region_cursor cursor;
static unsigned queries, reads, epoch, bad_region, fail_query, short_read;
static int query(uint32_t address, struct nh_read_region *region) {
    ++queries;
    if (fail_query) return 0;
    region->base = address & ~0xffffu;
    region->end = region->base + 0x10000u;
    region->readable = !bad_region || region->base != 0x20000u;
    return 1;
}
static int exact_read(uint32_t address, void *out, uint32_t length) {
    ++reads;
    /* Model the kernel's independent current protection/full-copy check even
     * if a formerly readable region changed after its metadata was queried. */
    if (short_read || (bad_region && address < 0x30000u && (uint64_t)address + length > 0x20000u)) return 0;
    memset(out, ++epoch, length);
    return 1;
}
static int malformed_query(uint32_t address, struct nh_read_region *region) {
    ++queries;
    region->base = address + 1;
    region->end = (uint64_t)address + 4096;
    region->readable = 1;
    return 1;
}
static int empty_query(uint32_t address, struct nh_read_region *region) {
    ++queries;
    region->base = region->end = address;
    region->readable = 1;
    return 1;
}
static int overflow_query(uint32_t address, struct nh_read_region *region) {
    ++queries;
    region->base = address;
    region->end = UINT64_C(0x100000001);
    region->readable = 1;
    return 1;
}
int main(void) {
    uint8_t bytes[65536];
    nh_read_region_clear(&cursor);
    for (unsigned i = 0; i < 4; ++i) {
        assert(nh_read_region_copy(&cursor, 0x10000u + i * 4096, bytes, 4096, query, exact_read));
        assert(bytes[0] == i + 1 && bytes[4095] == i + 1);
    }
    assert(queries == 1 && reads == 4); /* One region query, four actual fresh page reads. */
    nh_read_region_clear(&cursor);
    assert(nh_read_region_copy(&cursor, 0x11000, bytes, 4096, query, exact_read));
    assert(queries == 2 && reads == 5 && bytes[0] == 5); /* No metadata survives a boundary. */
    nh_read_region_clear(&cursor);
    assert(nh_read_region_copy(&cursor, 0x1f000, bytes, 8192, query, exact_read));
    assert(queries == 4 && reads == 6 && bytes[8191] == 6); /* Validate both regions before reading. */
    nh_read_region_clear(&cursor); bad_region = 1;
    assert(!nh_read_region_copy(&cursor, 0x1f000, bytes, 8192, query, exact_read));
    assert(queries == 6 && reads == 6 && !cursor.region.readable);
    bad_region = 0;
    assert(nh_read_region_copy(&cursor, 0x20000, bytes, 4096, query, exact_read));
    assert(queries == 7 && reads == 7);
    bad_region = 1; /* Allocation/protection changed after query: exact read must still fail. */
    assert(!nh_read_region_copy(&cursor, 0x21000, bytes, 4096, query, exact_read));
    assert(queries == 7 && reads == 8 && !cursor.region.readable);
    assert(!nh_read_region_copy(&cursor, 0x21000, bytes, 4096, query, exact_read));
    assert(queries == 8 && reads == 8); /* Failure purged the previously readable metadata. */
    bad_region = 0; short_read = 1;
    assert(!nh_read_region_copy(&cursor, 0x21000, bytes, 4096, query, exact_read));
    assert(queries == 9 && reads == 9 && !cursor.region.readable);
    short_read = 0;
    assert(nh_read_region_copy(&cursor, 0x21000, bytes, 4096, query, exact_read));
    assert(queries == 10 && reads == 10);
    nh_read_region_clear(&cursor); fail_query = 1;
    assert(!nh_read_region_copy(&cursor, 0x10000, bytes, 4096, query, exact_read));
    assert(queries == 11 && reads == 10 && !cursor.region.readable);
    fail_query = 0;
    assert(!nh_read_region_copy(&cursor, 0x10000, bytes, 4096, malformed_query, exact_read));
    assert(!nh_read_region_copy(&cursor, 0x10000, bytes, 4096, empty_query, exact_read));
    assert(!nh_read_region_copy(&cursor, 0x10000, bytes, 4096, overflow_query, exact_read));
    assert(queries == 14 && reads == 10);
    assert(!nh_read_region_copy(&cursor, 0, bytes, 1, query, exact_read));
    assert(!nh_read_region_copy(&cursor, 0xffffffffu, bytes, 2, query, exact_read));
    assert(!nh_read_region_copy(&cursor, 0x10000, bytes, NH_MAX_MESSAGE + 1, query, exact_read));
    assert(!nh_read_region_copy(&cursor, 0x10000, 0, 4096, query, exact_read));
    assert(queries == 14 && reads == 10);
    assert(nh_read_region_copy(&cursor, 0xffffffffu, bytes, 1, query, exact_read));
    assert(queries == 15 && reads == 11);
    assert(nh_read_region_copy(&cursor, 0, 0, 0, query, exact_read));
    assert(queries == 15 && reads == 11);
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
