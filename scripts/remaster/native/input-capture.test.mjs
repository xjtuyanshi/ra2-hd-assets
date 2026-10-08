import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('press ownership survives dialog disable/destruction without releasing onto a new page', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-input-capture-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include "input-capture.h"
#include <assert.h>
int main(void) {
    struct nh_input_capture capture = {0};
    const uintptr_t main = 1, old_dialog = 2, old_button = 3, new_dialog = 4, new_button = 5, popup = 6;
    struct nh_input_release route;

    /* A menu press disables its root. Modal lookup now falls back to main,
     * but the real release must finish that same accepted button press. */
    nh_input_capture_begin(&capture, old_button, old_dialog);
    /* Intervening genuine moves route through main while the root is disabled.
     * None may erase press ownership before the following genuine release. */
    for (int move = 0; move < 3; ++move) {
        nh_input_capture_main_route(&capture, 0);
        route = nh_input_capture_release(&capture, 0, main, 1, 1, 0, 0);
        assert(route.route == NH_RELEASE_CURRENT && capture.target == old_button && capture.root == old_dialog);
    }
    route = nh_input_capture_release(&capture, 1, main, 1, 1, 0, 0);
    assert(route.route == NH_RELEASE_CAPTURED && route.target == old_button);

    /* Closing a dialog on down must not activate the new page's button on up,
     * including the early main-window fallback and an intervening popup. */
    route = nh_input_capture_release(&capture, 1, main, 1, 0, popup, 1);
    assert(route.route == NH_RELEASE_CONSUMED && route.target == 0);
    route = nh_input_capture_release(&capture, 1, new_dialog, 0, 0, 0, 0);
    assert(route.route == NH_RELEASE_CONSUMED && route.target != new_button);

    /* A still-live old press also owns release across a different modal root. */
    route = nh_input_capture_release(&capture, 1, new_dialog, 0, 1, 0, 0);
    assert(route.route == NH_RELEASE_CAPTURED && route.target == old_button);

    /* Preserve the original game-owned popup capture, but a foreign or
     * unrelated popup cannot hijack the old press. The GUI owner validates it. */
    route = nh_input_capture_release(&capture, 1, main, 1, 1, popup, 1);
    assert(route.route == NH_RELEASE_CAPTURED && route.target == popup);
    route = nh_input_capture_release(&capture, 1, main, 1, 1, popup, 0);
    assert(route.route == NH_RELEASE_CAPTURED && route.target == old_button);

    /* Ordinary same-root dialog routing, hover/down, and uncaptured battle up
     * keep their existing handlers instead of taking the lifecycle path. */
    route = nh_input_capture_release(&capture, 1, old_dialog, 0, 1, popup, 1);
    assert(route.route == NH_RELEASE_CURRENT);
    route = nh_input_capture_release(&capture, 0, main, 1, 0, 0, 0);
    assert(route.route == NH_RELEASE_CURRENT && capture.target == old_button);
    nh_input_capture_clear(&capture);
    route = nh_input_capture_release(&capture, 1, main, 1, 0, 0, 0);
    assert(route.route == NH_RELEASE_CURRENT);
    nh_input_capture_main_route(&capture, 1);
    assert(capture.target == 0 && capture.root == 0);

    /* Clear release ownership before a synchronous control callback so a
     * nested new press survives; disconnect explicitly retires that press. */
    nh_input_capture_begin(&capture, old_button, old_dialog);
    route = nh_input_capture_release(&capture, 1, main, 1, 1, 0, 0);
    nh_input_capture_clear(&capture);
    nh_input_capture_begin(&capture, new_button, new_dialog);
    assert(route.target == old_button && capture.target == new_button && capture.root == new_dialog);
    nh_input_capture_clear(&capture);
    assert(capture.target == 0 && capture.root == 0);
    return 0;
}
`,
  );
  try {
    const build = spawnSync('cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-I', include, source, '-o', binary], {
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
