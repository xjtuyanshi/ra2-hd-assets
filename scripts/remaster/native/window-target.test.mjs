import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('visible disabled dialogs keep painting while remaining ineligible for new input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-window-target-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const include = resolve(fileURLToPath(new URL('../../../packages/native-host/agent/', import.meta.url)));
  writeFileSync(
    source,
    `
#include "window-target-policy.h"
#include <assert.h>
#include <stddef.h>
struct window { int id, owned, visible, dialog, enabled; };
static int select_window(enum nh_window_target_purpose purpose, struct window *windows, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        struct window *w = windows + i;
        if (nh_dialog_target_eligible(purpose, w->owned, w->visible, w->dialog, w->enabled)) return w->id;
    }
    return 1; /* main-window fallback */
}
int main(void) {
    struct window windows[] = {
        {2, 0, 1, 1, 1}, /* a foreign visible modal cannot receive paint or input */
        {3, 1, 0, 1, 1}, /* an old hidden page cannot mask the current one */
        {4, 1, 1, 0, 1}, /* ordinary child controls are not dialog roots */
        {5, 1, 1, 1, 0}, /* the current menu disables itself during native animation */
    };
    size_t count = sizeof(windows) / sizeof(windows[0]);
    assert(select_window(NH_WINDOW_INPUT, windows, count) == 1);
    assert(select_window(NH_WINDOW_PAINT, windows, count) == 5);

    /* Selection stays stable across successive paints while native code owns
     * the disabled phase; the bridge never fabricates enabledness or input. */
    for (int paint = 0; paint < 10; ++paint) {
        assert(select_window(NH_WINDOW_PAINT, windows, count) == 5);
        assert(select_window(NH_WINDOW_INPUT, windows, count) == 1);
        assert(!windows[3].enabled);
    }
    /* When the original handler really enables the page, ordinary input can
     * select it without any cached target/root state to invalidate. */
    windows[3].enabled = 1;
    assert(select_window(NH_WINDOW_INPUT, windows, count) == 5);
    assert(select_window(NH_WINDOW_PAINT, windows, count) == 5);

    /* A topmost temporary disabled dialog owns its pixels; input keeps the
     * existing enabled-dialog lookup. Closing it restores both original roots. */
    windows[2] = (struct window){6, 1, 1, 1, 0};
    assert(select_window(NH_WINDOW_PAINT, windows, count) == 6);
    assert(select_window(NH_WINDOW_INPUT, windows, count) == 5);
    windows[2].visible = 0;
    assert(select_window(NH_WINDOW_PAINT, windows, count) == 5);
    assert(select_window(NH_WINDOW_INPUT, windows, count) == 5);
    windows[3].visible = 0;
    assert(select_window(NH_WINDOW_PAINT, windows, count) == 1);
    assert(select_window(NH_WINDOW_INPUT, windows, count) == 1);
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
