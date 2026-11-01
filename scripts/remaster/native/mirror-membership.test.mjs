import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('membership and bounded publication credits preserve removals, generations and barriers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-membership-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#define _DEFAULT_SOURCE
#include <stdint.h>
#define NH_PAGE_SIZE 4096u
struct nh_page {
    uint32_t address, rule, range, object, request_address, request_length;
    uint64_t dirty;
};
#include "mirror-membership.h"
#include "mirror-flight.h"
#include "mirror-page-equal.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>
#define P(page_address) {.address = page_address}
static int compare_pages(const void *a, const void *b) {
    uint32_t x = ((const struct nh_page *)a)->address, y = ((const struct nh_page *)b)->address;
    return (x > y) - (x < y);
}
static void check_equal_modes(const uint8_t *left, const uint8_t *right, int expected) {
    assert(nh_page_bytes_equal(left, right, 0) == expected);
#if defined(__i386__) || defined(__x86_64__)
    if (__builtin_cpu_supports("sse2")) assert(nh_page_bytes_equal(left, right, 1) == expected);
#else
    assert(nh_page_bytes_equal(left, right, 1) == expected);
#endif
}
static void check_page_equal(void) {
    uint8_t left_storage[NH_PAGE_SIZE + 16], right_storage[NH_PAGE_SIZE + 16];
    uint32_t boundaries[] = {0, 15, 16, 63, 64, NH_PAGE_SIZE - 1};
    for (unsigned left_offset = 0; left_offset < 16; ++left_offset) {
        for (unsigned right_offset = 0; right_offset < 16; ++right_offset) {
            uint8_t *left = left_storage + left_offset, *right = right_storage + right_offset;
            for (unsigned i = 0; i < NH_PAGE_SIZE; ++i) left[i] = right[i] = (uint8_t)(i * 137u);
            check_equal_modes(left, right, 1);
            for (unsigned i = 0; i < sizeof(boundaries) / sizeof(*boundaries); ++i) {
                right[boundaries[i]] ^= 0x81;
                check_equal_modes(left, right, 0);
                right[boundaries[i]] ^= 0x81;
            }
        }
    }
    /* Every byte must affect equality, including different unaligned pointers. */
    for (unsigned offset = 0; offset <= 3; offset += 3) {
        uint8_t *left = left_storage + offset, *right = right_storage + offset * 3;
        memset(left, 0x5a, NH_PAGE_SIZE); memset(right, 0x5a, NH_PAGE_SIZE);
        for (unsigned i = 0; i < NH_PAGE_SIZE; ++i) {
            right[i] ^= 0x81;
            check_equal_modes(left, right, 0);
            right[i] ^= 0x81;
        }
        check_equal_modes(left, right, 1);
    }
    /* Guard pages catch reads before/after the owned page on the native host,
     * even when its physical VM page size exceeds the protocol page size. */
    size_t host_page = (size_t)sysconf(_SC_PAGESIZE), allocation = host_page * 3;
    assert(host_page >= NH_PAGE_SIZE);
    uint8_t *a = mmap(NULL, allocation, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    uint8_t *b = mmap(NULL, allocation, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(a != MAP_FAILED && b != MAP_FAILED);
    assert(!mprotect(a + host_page, host_page, PROT_READ | PROT_WRITE));
    assert(!mprotect(b + host_page, host_page, PROT_READ | PROT_WRITE));
    for (unsigned edge = 0; edge < 2; ++edge) {
        uint8_t *left = a + host_page + (edge ? host_page - NH_PAGE_SIZE : 0);
        uint8_t *right = b + host_page + (edge ? host_page - NH_PAGE_SIZE : 0);
        memset(left, 0xc3, NH_PAGE_SIZE); memset(right, 0xc3, NH_PAGE_SIZE);
        check_equal_modes(left, right, 1);
        right[NH_PAGE_SIZE - 1] ^= 1;
        check_equal_modes(left, right, 0);
    }
    assert(!munmap(a, allocation) && !munmap(b, allocation));
}
static void check_sort(void) {
    enum { capacity = 8192 };
    struct nh_page *actual = calloc(capacity + 2, sizeof(*actual));
    struct nh_page *expected = calloc(capacity + 2, sizeof(*expected));
    struct nh_page *scratch = calloc(capacity + 2, sizeof(*scratch));
    uint32_t sizes[] = {0, 1, 2, 1023, 1024, 1025, 3000, capacity};
    assert(actual && expected && scratch);
    for (unsigned n = 0; n < sizeof(sizes) / sizeof(*sizes); ++n) {
        uint32_t count = sizes[n];
        /* Reverse, ascending and permuted addresses exercise both radix digits,
         * zero and the highest page. All owner fields and generations travel
         * with their page, including data at both scratch-array boundaries. */
        for (unsigned pattern = 0; pattern < 3; ++pattern) {
            memset(actual, 0xa5, (capacity + 2) * sizeof(*actual));
            memset(scratch, 0x5a, (capacity + 2) * sizeof(*scratch));
            for (uint32_t i = 0; i < count; ++i) {
                uint32_t page = pattern == 0 ? 0xfffffu - i : pattern == 1 ? i :
                    (i * 0x9e377u) & 0xfffffu;
                actual[i + 1] = (struct nh_page){page << 12, i, UINT32_MAX - i,
                    i ^ 0x12345678u, i * 13u, i * 31u, UINT64_C(0xabcdef0123456789) + i};
            }
            memcpy(expected, actual, (capacity + 2) * sizeof(*actual));
            qsort(expected + 1, count, sizeof(*expected), compare_pages);
            nh_sort_pages(actual + 1, scratch + 1, count);
            assert(!memcmp(actual, expected, (capacity + 2) * sizeof(*actual)));
            for (unsigned byte = 0; byte < sizeof(*scratch); ++byte) {
                assert(((unsigned char *)scratch)[byte] == 0x5a);
                assert(((unsigned char *)(scratch + count + 1))[byte] == 0x5a);
            }
        }
    }
    free(actual); free(expected); free(scratch);
}
int main(void) {
#if defined(__i386__) || defined(__x86_64__)
    puts(__builtin_cpu_supports("sse2") ? "page equality: x86 SSE2 and forced CRT fallback" :
        "page equality: x86 without SSE2, CRT fallback only");
#else
    puts("page equality: non-x86 CRT fallback");
#endif
    check_sort();
    check_page_equal();
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
    /* Two accepted immutable generations may overlap ACK latency. A stale ACK
     * never frees credit or clears a newer page version. */
    struct nh_mirror_flights flights = {0};
    struct nh_mirror_flight acknowledged[2];
    uint64_t acknowledged_generation = 999;
    int matched;
    assert(nh_mirror_flight_available(&flights, 1, 10, 7, 1));
    assert(nh_mirror_flight_publish(&flights, 10, 7, 100, 1000, 1));
    assert(!nh_mirror_flight_available(&flights, 2, 11, 7, 0)); /* reset stays exclusive */
    assert(!nh_mirror_flight_ack(&flights, 9, 2000, acknowledged, &acknowledged_generation, &matched));
    assert(flights.count == 1 && acknowledged_generation == 999);
    assert(nh_mirror_flight_ack(&flights, 10, 2000, acknowledged, &acknowledged_generation, &matched) == 1);
    assert(acknowledged_generation == 100 && acknowledged[0].published_ticks == 1000);
    assert(nh_mirror_flight_publish(&flights, 11, 7, 101, 1100, 0));
    assert(!nh_mirror_flight_available(&flights, 1, 12, 7, 0)); /* legacy */
    assert(nh_mirror_flight_available(&flights, 2, 12, 7, 0));
    assert(!nh_mirror_flight_available(&flights, 2, 12, 8, 0)); /* revision */
    assert(!nh_mirror_flight_available(&flights, 2, 12, 7, 1)); /* pending fault/reset */
    assert(!nh_mirror_flight_available(&flights, 2, 11, 7, 0)); /* duplicate frame */
    assert(!nh_mirror_flight_available(&flights, 2, 0, 7, 0)); /* rewind/wrap */
    assert(nh_mirror_flight_publish(&flights, 12, 7, 102, 1200, 0));
    assert(!nh_mirror_flight_available(&flights, 2, 13, 7, 0));
    assert(!nh_mirror_flight_publish(&flights, 13, 7, 103, 1300, 0));
    assert(flights.count == 2 && flights.entries[1].frame == 12);
    assert(nh_mirror_flight_ack(&flights, 11, 2000, acknowledged, &acknowledged_generation, &matched) == 1);
    assert(acknowledged_generation == 101 && flights.count == 1 && flights.entries[0].generation == 102);
    uint64_t dirty[] = {100, 101, 102, 103};
    for (unsigned i = 0; i < 4; ++i) if (dirty[i] <= acknowledged_generation) dirty[i] = 0;
    assert(!dirty[0] && !dirty[1] && dirty[2] == 102 && dirty[3] == 103);
    assert(!nh_mirror_flight_ack(&flights, 11, 2000, acknowledged, &acknowledged_generation, &matched)); /* duplicate ACK */
    assert(nh_mirror_flight_available(&flights, 2, 13, 7, 0));
    assert(nh_mirror_flight_publish(&flights, 13, 7, 103, 1300, 0));
    assert(!nh_mirror_flight_ack(&flights, 13, 1800, acknowledged, &acknowledged_generation, &matched));
    assert(matched && flights.count == 2 && flights.entries[1].acknowledged);
    /* The old ACK12 is still queued. Even reset/new revision + frame12 cannot
     * reuse it until that exact notification has actually arrived. */
    assert(!nh_mirror_flight_available(&flights, 2, 12, 8, 1));
    assert(!nh_mirror_flight_available(&flights, 2, 14, 7, 0));
    assert(!nh_mirror_flight_ack(&flights, 13, 1900, acknowledged, &acknowledged_generation, &matched));
    assert(!matched && flights.count == 2);
    assert(nh_mirror_flight_ack(&flights, 12, 2000, acknowledged, &acknowledged_generation, &matched) == 2);
    assert(!flights.count && acknowledged_generation == 103 && acknowledged[0].frame == 12);
    assert(acknowledged[0].acknowledged_ticks == 2000 && acknowledged[1].acknowledged_ticks == 1800);
    assert(nh_mirror_flight_available(&flights, 2, 12, 8, 1));
    assert(!nh_mirror_flight_ack(&flights, 12, 2000, acknowledged, &acknowledged_generation, &matched));
    assert(nh_mirror_flight_available(&flights, 2, 0, 8, 1));
    assert(nh_mirror_flight_publish(&flights, 0, 8, 0, 1400, 1)); /* incomplete has no generation */
    assert(!nh_mirror_flight_available(&flights, 2, 1, 8, 0));
    assert(nh_mirror_flight_ack(&flights, 0, 2000, acknowledged, &acknowledged_generation, &matched) == 1);
    assert(!acknowledged_generation && !flights.count);
    return 0;
}
`,
  );
  try {
    const architectures = [[]];
    if (process.env.NATIVE_HOST_TEST_X86_64 === '1') {
      assert.equal(process.platform, 'darwin', 'NATIVE_HOST_TEST_X86_64 requires macOS with Rosetta');
      assert.equal(process.arch, 'arm64', 'NATIVE_HOST_TEST_X86_64 requires a native arm64 Node process');
      architectures.push(['-arch', 'x86_64']);
    }
    for (const architecture of architectures) {
      const build = spawnSync(
        'cc',
        ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', ...architecture, '-I', include, source, '-o', binary],
        {
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(build.status, 0, build.error?.message ?? build.stderr);
      const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
      assert.equal(run.status, 0, run.error?.message ?? run.stderr);
      process.stdout.write(run.stdout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
