#include "agent.h"
#include "dd.h"
#include "hidden.h"
#include "window-target.h"
#include <string.h>

int nh_window_owned(HWND window)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid != GetCurrentProcessId()) return 0;
    HWND ancestor = window;
    for (int depth = 0; ancestor && depth < 32; depth++)
    {
        if (ancestor == g_ddraw.hwnd) return 1;
        HWND parent = GetParent(ancestor);
        ancestor = parent ? parent : GetWindow(ancestor, GW_OWNER);
    }
    return 0;
}

struct target_context { HWND window; enum nh_window_target_purpose purpose; };

static BOOL CALLBACK find_dialog(HWND window, LPARAM context)
{
    struct target_context *state = (struct target_context *)context;
    if (window == g_ddraw.hwnd || !nh_window_owned(window) || !nh_hidden_visible(window)) return TRUE;
    char class_name[64] = {0};
    GetClassNameA(window, class_name, sizeof(class_name));
    if (!nh_dialog_target_eligible(state->purpose, 1, 1,
        !strcmp(class_name, "#32770"), IsWindowEnabled(window))) return TRUE;
    state->window = window;
    return FALSE;
}

/* Preserve native z-order/ownership for both consumers. Input and painting
 * differ only in enabledness, never in logical visibility or process scope. */
HWND nh_window_target(enum nh_window_target_purpose purpose)
{
    if (!g_ddraw.hwnd) return NULL;
    struct target_context state = {NULL, purpose};
    EnumWindows(find_dialog, (LPARAM)&state);
    if (!state.window) EnumChildWindows(g_ddraw.hwnd, find_dialog, (LPARAM)&state);
    return state.window ? state.window : g_ddraw.hwnd;
}
