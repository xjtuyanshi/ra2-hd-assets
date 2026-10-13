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
#include <stdint.h>
struct nh_page { uint32_t address; uint64_t dirty; };
#include "mirror-membership.h"
#include "mirror-flight.h"
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
