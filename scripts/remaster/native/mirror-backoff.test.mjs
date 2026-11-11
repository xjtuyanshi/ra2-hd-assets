import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('deadline misses defer the next full capture by 1, 2, 4 and at most 8 logic frames until a publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-backoff-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include "mirror-backoff.h"
#include <assert.h>
/* Simulate logic frames whose every attempted capture misses its deadline. */
static unsigned frames_until_attempt(struct nh_capture_backoff *backoff) {
    unsigned skipped = 0;
    while (nh_capture_backoff_skip(backoff)) ++skipped;
    return skipped;
}
int main(void) {
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
