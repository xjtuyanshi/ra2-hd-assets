import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('capture cadence bounds full images without delaying barriers or changing deadline backoff', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-cadence-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include "mirror-backoff.h"
#include "mirror-cadence.h"
#include <assert.h>
/* Simulate logic frames whose every attempted capture misses its deadline. */
static unsigned frames_until_attempt(struct nh_capture_backoff *backoff) {
    unsigned skipped = 0;
    while (nh_capture_backoff_skip(backoff)) ++skipped;
    return skipped;
}
int main(void) {
    struct nh_capture_cadence cadence = {0};
    const int64_t frequency = 1000000;
    assert(nh_capture_cadence_due(&cadence, 0, frequency, 0, 1, 0));
    nh_capture_cadence_published(&cadence, 0, 0, 1);
    assert(!nh_capture_cadence_due(&cadence, 29999, frequency, 1, 1, 0));
    assert(nh_capture_cadence_due(&cadence, 30000, frequency, 2, 1, 0));
    /* A fast consumer and immediate ACKs still cannot force full-rate copying. */
    unsigned captures = 1;
    for (unsigned frame = 1; frame < 1000; ++frame) {
        int64_t at = (int64_t)frame * 16000;
        if (nh_capture_cadence_due(&cadence, at, frequency, frame, 1, 0)) {
            nh_capture_cadence_published(&cadence, at, frame, 1);
            ++captures;
        }
    }
    assert(captures == 500); /* 3950 -> 1975 pages per logic frame on average. */
    assert(!nh_capture_cadence_due(&cadence, cadence.started + 1, frequency, cadence.frame, 1, 0));
    assert(nh_capture_cadence_due(&cadence, cadence.started + 1, frequency, cadence.frame, 2, 0));
    assert(nh_capture_cadence_due(&cadence, cadence.started + 1, frequency, 0, 1, 0));
    assert(nh_capture_cadence_due(&cadence, cadence.started + 1, frequency, cadence.frame, 1, 1));
    /* Non-integral clock ticks round up, never shorten the configured interval. */
    nh_capture_cadence_published(&cadence, 100, 1, 1);
    assert(!nh_capture_cadence_due(&cadence, 100 + 107386, 3579545, 2, 1, 0));
    assert(nh_capture_cadence_due(&cadence, 100 + 107387, 3579545, 2, 1, 0));
    /* A failed capture/publication must not commit a new cadence timestamp. */
    assert(nh_capture_cadence_due(&cadence, 100000, frequency, 2, 1, 0));
    assert(nh_capture_cadence_due(&cadence, 100001, frequency, 2, 1, 0));
    nh_capture_cadence_clear(&cadence); /* Disconnect/reconnect starts immediately. */
    assert(nh_capture_cadence_due(&cadence, 0, frequency, 1, 1, 0));
    struct nh_capture_backoff backoff = {0, 0};
    assert(!nh_capture_backoff_skip(&backoff)); /* No miss yet: capture on every frame. */
    unsigned expected[] = {1, 2, 4, 8, 8, 8};
    for (unsigned i = 0; i < sizeof(expected) / sizeof(*expected); ++i) {
        nh_capture_backoff_missed(&backoff);
        assert(frames_until_attempt(&backoff) == expected[i]);
    }
    /* Under sustained misses at most one budget is spent per nine logic frames. */
    assert(NH_CAPTURE_BACKOFF_MAX == 8u);
    nh_capture_backoff_clear(&backoff);
    assert(!nh_capture_backoff_skip(&backoff));
    nh_capture_backoff_missed(&backoff);
    assert(frames_until_attempt(&backoff) == 1); /* A publication restarts the sequence. */
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
