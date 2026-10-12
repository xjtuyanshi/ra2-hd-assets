import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

test('one menu snapshot bounds all button queries and stops querying after a timeout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-menu-budget-'));
  const source = join(directory, 'test.c');
  const binary = join(directory, 'test');
  const input = readFileSync(new URL('../../../packages/native-host/agent/input.c', import.meta.url), 'utf8');
  const fragment = input.slice(
    input.indexOf('struct menu_context {'),
    input.indexOf('static BOOL CALLBACK describe_menu_popup'),
  );
  writeFileSync(
    source,
    `
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
typedef uintptr_t HWND; typedef uintptr_t LPARAM; typedef unsigned UINT; typedef uintptr_t DWORD_PTR;
typedef uint16_t WCHAR; typedef WCHAR *LPWSTR; typedef int BOOL;
typedef struct { int64_t QuadPart; } LARGE_INTEGER;
typedef struct { long x, y; } POINT;
typedef struct { long left, top, right, bottom; } RECT;
#define CALLBACK
#define WINAPI
#define TRUE 1
#define FALSE 0
#define GW_OWNER 1
#define GWL_STYLE 1
#define CP_UTF8 1
#define BM_GETSTATE 1
#define BST_PUSHED 4
#define SMTO_ABORTIFHUNG 1
#define SMTO_BLOCK 2
#define _stricmp strcasecmp
static uint64_t clock_us; static unsigned calls, fail_at, successful_cost;
static int IsWindowEnabled(HWND window) { return window != 0; }
static HWND GetParent(HWND window) { return window > 1 ? 1 : 0; }
static HWND GetWindow(HWND window, unsigned mode) { (void)window; (void)mode; return 0; }
static int GetWindowRect(HWND window, RECT *rect) { (void)window; *rect=(RECT){0,0,100,20}; return 1; }
static POINT screen_to_game(POINT point) { return point; }
static int GetClassNameA(HWND window, char *name, unsigned capacity) { (void)window; (void)capacity; strcpy(name,"Button"); return 6; }
static int cached_text(HWND window, LPWSTR text, int capacity) { (void)window; (void)capacity; text[0]='X'; text[1]=0; return 1; }
static void *GetModuleHandleA(const char *name) { (void)name; return NULL; }
static void *GetProcAddress(void *module, const char *name) { (void)module; (void)name; return (void *)cached_text; }
static int WideCharToMultiByte(unsigned page, unsigned flags, WCHAR *source, int length, char *title, unsigned capacity, void *a, void *b) {
 (void)page; (void)flags; (void)source; (void)length; (void)capacity; (void)a; (void)b; strcpy(title,"X"); return 2;
}
static void escaped(char *target, unsigned capacity, const char *source) { snprintf(target,capacity,"%s",source); }
static int nh_hidden_visible(HWND window) { return window != 0; }
static unsigned GetWindowLongA(HWND window, unsigned field) { (void)window; (void)field; return 0; }
static int GetDlgCtrlID(HWND window) { return (int)window; }
static void QueryPerformanceCounter(LARGE_INTEGER *counter) { counter->QuadPart=clock_us; }
static uint64_t elapsed_us(LARGE_INTEGER start) { return clock_us-start.QuadPart; }
static int SendMessageTimeoutA(HWND window, UINT message, unsigned a, unsigned b, unsigned flags, UINT timeout, DWORD_PTR *result) {
 (void)window; (void)message; (void)a; (void)b; (void)flags; calls++;
 if (fail_at && calls >= fail_at) { clock_us += timeout * 1000; return 0; }
 clock_us += successful_cost; *result=BST_PUSHED; return 1;
}
static int query_control(HWND window, UINT message, int32_t *value) {
 DWORD_PTR result;
 if (!SendMessageTimeoutA(window,message,0,0,SMTO_ABORTIFHUNG|SMTO_BLOCK,10,&result)) return 0;
 *value=(int32_t)result; return 1;
}
${fragment}
static void run_buttons(struct menu_context *state, unsigned count) {
 for (unsigned i=0;i<count;i++) { state->used=0; state->count=0; describe_menu_control(2+i,(LPARAM)state); }
}
int main(void) {
 char json[65536]; struct menu_context state={0}; state.json=json; state.capacity=sizeof(json); state.root=1; state.complete=1;
 fail_at=1; run_buttons(&state,128);
 assert(calls==1 && clock_us<=10000 && state.complete==0);
 clock_us=0; calls=0; fail_at=0; successful_cost=100; memset(&state,0,sizeof(state));
 state.json=json; state.capacity=sizeof(json); state.root=1; state.complete=1;
 run_buttons(&state,128);
 assert(calls<128 && clock_us<=10000 && state.complete==0);
 clock_us=0; calls=0; successful_cost=100; memset(&state,0,sizeof(state));
 state.json=json; state.capacity=sizeof(json); state.root=1; state.complete=1;
 run_buttons(&state,5);
 assert(calls==5 && state.complete==1);
 return 0;
}
`,
  );
  try {
    const build = spawnSync('cc', ['-std=c99', '-Wall', '-Wextra', '-Wno-unused-function', source, '-o', binary], {
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
