#include "agent.h"
#include "hidden.h"
#include "hook.h"
#include "config.h"
#include "dllmain.h"
#include "dd.h"
#include "ddsurface.h"
#include <string.h>
#include <stdio.h>

/* Top-level windows keep their requested visibility for game/dialog policy,
 * while their physical WS_VISIBLE bit never becomes set. Child style bits and
 * geometry are untouched, so controls can still paint into native surfaces. */
#define VISIBLE_PROPERTY "NativeHost.LogicalVisible"
#define PROC_PROPERTY "NativeHost.HiddenOriginalProc"
#define EXPLICIT_PROPERTY "NativeHost.ExplicitVisibility"
static volatile LONG hidden;
static __thread HHOOK creation_hook;
static __thread HWND physical_hide_window;
static __thread int painting;
static __thread HDC scratch_dc;
static __thread HWND scratch_root, scratch_window;
static __thread struct { HWND window; int saved, begin_paint; } dc_routes[16];
static __thread unsigned dc_route_count;
static volatile LONG paint_in_progress;
static unsigned last_painted, last_owner_drawn, last_dc_acquires;
static HWND captured;
static char desktop_name[128], desktop_expected[128], desktop_class[64];
static int desktop_hidden;

int nh_hidden_active(void) { return InterlockedCompareExchange(&hidden, 0, 0) != 0; }

int nh_hidden_owned(HWND window)
{
    DWORD pid = 0;
    if (!nh_hidden_active() || !window || !IsWindow(window)) return 0;
    GetWindowThreadProcessId(window, &pid);
    return pid == GetCurrentProcessId();
}

static int top_level(HWND window)
{
    return nh_hidden_owned(window) && !(real_GetWindowLongA(window, GWL_STYLE) & WS_CHILD);
}

void nh_hidden_set_visible(HWND window, int visible)
{
    if (top_level(window))
    {
        HANDLE previous = GetPropA(window, VISIBLE_PROPERTY);
        SetPropA(window, VISIBLE_PROPERTY, (HANDLE)(uintptr_t)(visible ? 2 : 1));
        SetPropA(window, EXPLICIT_PROPERTY, (HANDLE)1);
        /* Physical SW_HIDE must not stand in for the game's requested show.
         * Dialog initialization uses this real notification to reveal native
         * controls and prepare their resources, even without an OS window. */
        if ((uintptr_t)previous != (uintptr_t)(visible ? 2 : 1))
            SendMessageA(window, WM_SHOWWINDOW, visible != 0, 0);
    }
}

void nh_hidden_initial_visibility(HWND window, int visible)
{
    if (top_level(window) && !GetPropA(window, EXPLICIT_PROPERTY))
        SetPropA(window, VISIBLE_PROPERTY, (HANDLE)(uintptr_t)(visible ? 2 : 1));
}

int nh_hidden_visible(HWND window)
{
    if (!nh_hidden_owned(window)) return IsWindowVisible(window);
    HWND root = GetAncestor(window, GA_ROOT);
    HANDLE requested = GetPropA(root, VISIBLE_PROPERTY);
    if (requested && (uintptr_t)requested != 2) return 0;
    for (HWND child = window; child && child != root; child = GetParent(child))
        if (!(real_GetWindowLongA(child, GWL_STYLE) & WS_VISIBLE)) return 0;
    return requested ? 1 : IsWindowVisible(window);
}

int nh_hidden_window_message(HWND window, UINT message, WPARAM wparam, LPARAM lparam, LRESULT *result)
{
    if (!nh_hidden_owned(window)) return 0;
    if (message == WM_SHOWWINDOW && top_level(window) &&
        (physical_hide_window == window || (!!wparam != !!nh_hidden_visible(window))))
    { *result = 0; return 1; }
    if (message == WM_STYLECHANGING && top_level(window) && lparam)
    {
        STYLESTRUCT *style = (STYLESTRUCT *)lparam;
        if ((int)wparam == GWL_STYLE)
        {
            if (style->styleNew & WS_VISIBLE) nh_hidden_set_visible(window, 1);
            style->styleNew &= ~WS_VISIBLE;
        }
        else if ((int)wparam == GWL_EXSTYLE)
            style->styleNew = (style->styleNew & ~WS_EX_TOPMOST) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
    }
    if (message == WM_WINDOWPOSCHANGING && top_level(window) && lparam)
    {
        WINDOWPOS *position = (WINDOWPOS *)lparam;
        if (position->flags & SWP_SHOWWINDOW) nh_hidden_set_visible(window, 1);
        if ((position->flags & SWP_HIDEWINDOW) && physical_hide_window != window) nh_hidden_set_visible(window, 0);
        position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_NOACTIVATE;
        position->hwndInsertAfter = HWND_NOTOPMOST;
        if (window == g_ddraw.hwnd && !(position->flags & SWP_NOMOVE))
            position->x = position->y = 0;
        if (real_GetWindowLongA(window, GWL_STYLE) & WS_VISIBLE) position->flags |= SWP_HIDEWINDOW;
    }
    /* The native game stays logically activated even before a client connects;
     * no physical focus operation is needed to keep the match clock running. */
    if (window == g_ddraw.hwnd && (message == WM_KILLFOCUS ||
        (message == WM_ACTIVATE && LOWORD(wparam) == WA_INACTIVE) ||
        (message == WM_ACTIVATEAPP && !wparam)))
    { *result = 0; return 1; }
    if (message == WM_MOUSEACTIVATE) { *result = MA_NOACTIVATE; return 1; }
    return 0;
}

static LRESULT CALLBACK hidden_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    WNDPROC original = (WNDPROC)GetPropA(window, PROC_PROPERTY);
    LRESULT result = 0;
    if (nh_hidden_window_message(window, message, wparam, lparam, &result)) return result;
    result = original ? CallWindowProcA(original, window, message, wparam, lparam) :
        real_DefWindowProcA(window, message, wparam, lparam);
    if (message == WM_NCDESTROY)
    { RemovePropA(window, PROC_PROPERTY); RemovePropA(window, VISIBLE_PROPERTY); RemovePropA(window, EXPLICIT_PROPERTY); }
    return result;
}

int nh_hidden_set_window_proc(HWND window, LONG procedure, LONG *previous)
{
    WNDPROC original = (WNDPROC)GetPropA(window, PROC_PROPERTY);
    if (!nh_hidden_owned(window) || !original || window == g_ddraw.hwnd) return 0;
    *previous = (LONG)original;
    /* Preserve the physical show guard when a custom game control subclasses
     * its top-level dialog. CallWindowProc still sees the game-owned chain. */
    SetPropA(window, PROC_PROPERTY, (HANDLE)(uintptr_t)(uint32_t)procedure);
    return 1;
}

int nh_hidden_get_window_proc(HWND window, LONG *procedure)
{
    WNDPROC original = (WNDPROC)GetPropA(window, PROC_PROPERTY);
    if (!nh_hidden_owned(window) || !original || window == g_ddraw.hwnd) return 0;
    *procedure = (LONG)original;
    return 1;
}

static LRESULT CALLBACK creation_proc(int code, WPARAM wparam, LPARAM lparam)
{
    if (nh_hidden_active())
    {
        if (code == HCBT_SETFOCUS)
        {
            nh_input_focus_window((HWND)wparam);
            return 1;
        }
        if (code == HCBT_ACTIVATE) return 1;
        if (code == HCBT_CREATEWND && lparam)
        {
            CBT_CREATEWNDA *create = (CBT_CREATEWNDA *)lparam;
            if (!(create->lpcs->style & WS_CHILD))
            {
                HWND window = (HWND)wparam;
                int visible = (create->lpcs->style & WS_VISIBLE) != 0;
                create->lpcs->style &= ~WS_VISIBLE;
                create->lpcs->dwExStyle = (create->lpcs->dwExStyle & ~WS_EX_TOPMOST) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                nh_hidden_initial_visibility(window, visible);
                WNDPROC original = (WNDPROC)real_SetWindowLongA(window, GWL_WNDPROC, (LONG)hidden_window_proc);
                if (original) SetPropA(window, PROC_PROPERTY, (HANDLE)original);
            }
        }
    }
    return CallNextHookEx(creation_hook, code, wparam, lparam);
}

void nh_hidden_install(void)
{
    if (nh_hidden_active() && !creation_hook)
        creation_hook = SetWindowsHookExA(WH_CBT, creation_proc, g_ddraw_module, GetCurrentThreadId());
}

void nh_hidden_configure(void)
{
    char path[MAX_PATH] = {0}, value[16] = "1", *slash;
    if (!nh_agent_configured()) return;
    if (GetModuleFileNameA(NULL, path, sizeof(path)))
    {
        slash = strrchr(path, '\\');
        if (slash && (size_t)(slash - path) + sizeof("\\ddraw.ini") <= sizeof(path))
        {
            strcpy(slash + 1, "ddraw.ini");
            GetPrivateProfileStringA("agent", "hidden", "1", value, sizeof(value), path);
        }
    }
    char environment[16];
    DWORD length = GetEnvironmentVariableA("RA2_NATIVE_AGENT_HIDDEN", environment, sizeof(environment));
    if (length && length < sizeof(environment)) strcpy(value, environment);
    if (!strcmp(value, "0")) return;
    InterlockedExchange(&hidden, 1);
    /* Hidden sessions cannot change the host display mode or persist hidden
     * geometry into the player's normal cnc-ddraw configuration. Native pixels
     * are tapped at the DirectDraw primary, before the presentation renderer. */
    g_config.windowed = TRUE;
    g_config.fullscreen = FALSE;
    /* cnc-ddraw's game-facing screen space starts at the primary origin. A
     * centered physical client would give custom native controls a second
     * origin when they mix those hooks with User32's internal geometry. Hidden
     * sessions have no visible placement, so make both origins exactly zero. */
    g_config.border = FALSE;
    g_config.window_rect.left = g_config.window_rect.top = 0;
    g_config.save_settings = 0;
    strcpy(g_config.renderer, "gdi");
    g_config.fix_alt_key_stuck = FALSE;
    /* Wine's named virtual desktop is an explorer-owned native host window.
     * The private development desktop may otherwise remain visible after every
     * game window is hidden. Never alter Windows' desktop or a differently named
     * Wine desktop; ownership is bounded to this explicitly selected desktop. */
    if (real_GetProcAddress(GetModuleHandleA("ntdll.dll"), "wine_get_version"))
    {
        strcpy(desktop_expected, "ra2dev");
        if (path[0]) GetPrivateProfileStringA("agent", "desktop", "ra2dev", desktop_expected, sizeof(desktop_expected), path);
        char configured_desktop[128];
        length = GetEnvironmentVariableA("RA2_NATIVE_AGENT_DESKTOP", configured_desktop, sizeof(configured_desktop));
        if (length && length < sizeof(configured_desktop)) strcpy(desktop_expected, configured_desktop);
        DWORD required = 0;
        GetUserObjectInformationA(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, desktop_name, sizeof(desktop_name), &required);
        HWND desktop = GetDesktopWindow();
        GetClassNameA(desktop, desktop_class, sizeof(desktop_class));
        if (desktop_expected[0] && !strcmp(desktop_expected, desktop_name) && !strcmp(desktop_class, "#32769"))
        {
            real_ShowWindow(desktop, SW_HIDE);
            desktop_hidden = !IsWindowVisible(desktop);
        }
    }
    nh_hidden_install();
}

BOOL WINAPI nh_hidden_show_window(HWND window, int command)
{
    if (!nh_hidden_owned(window)) return real_ShowWindow(window, command);
    if (!top_level(window))
    {
        /* ShowWindow returns the window's own previous WS_VISIBLE bit, even
         * while its parent is hidden. IsWindowVisible includes ancestors and
         * cannot replace that contract: game initialization uses hide/return/
         * restore to preserve resource-visible controls before a dialog shows. */
        return real_ShowWindow(window, command);
    }
    BOOL previous = nh_hidden_visible(window);
    nh_hidden_set_visible(window, command != SW_HIDE);
    HWND old_hidden = physical_hide_window;
    physical_hide_window = window;
    real_ShowWindow(window, SW_HIDE);
    physical_hide_window = old_hidden;
    return previous;
}

BOOL WINAPI nh_hidden_set_window_pos(HWND window, HWND after, int x, int y, int width, int height, UINT flags)
{
    if (top_level(window))
    {
        if (flags & SWP_SHOWWINDOW) nh_hidden_set_visible(window, 1);
        if (flags & SWP_HIDEWINDOW) nh_hidden_set_visible(window, 0);
        flags = (flags & ~SWP_SHOWWINDOW) | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        after = HWND_NOTOPMOST;
        if (real_GetWindowLongA(window, GWL_STYLE) & WS_VISIBLE) flags |= SWP_HIDEWINDOW;
        if (window == g_ddraw.hwnd && !(flags & SWP_NOMOVE)) x = y = 0;
    }
    HWND old_hidden = physical_hide_window;
    if (top_level(window)) physical_hide_window = window;
    BOOL result = real_SetWindowPos(window, after, x, y, width, height, flags);
    physical_hide_window = old_hidden;
    return result;
}

HWND WINAPI nh_hidden_set_focus(HWND window)
{
    if (!nh_hidden_active() || (window && !nh_hidden_owned(window))) return SetFocus(window);
    HWND previous = nh_input_get_focus();
    return nh_input_focus_window(window) ? previous : NULL;
}

HWND WINAPI nh_hidden_set_active_window(HWND window)
{
    if (!nh_hidden_owned(window)) return SetActiveWindow(window);
    return nh_input_get_active_window();
}

BOOL WINAPI nh_hidden_bring_to_top(HWND window)
{
    return nh_hidden_owned(window) ? TRUE : BringWindowToTop(window);
}

BOOL WINAPI nh_hidden_is_window_visible(HWND window) { return nh_hidden_visible(window); }

void nh_hidden_diagnostics(char *json, uint32_t capacity)
{
    /* Desktop identifiers are included only when made safe for bounded JSON. */
    for (char *p = desktop_name; *p; p++) if (*p == '"' || *p == '\\' || (unsigned char)*p < 32) *p = '?';
    for (char *p = desktop_expected; *p; p++) if (*p == '"' || *p == '\\' || (unsigned char)*p < 32) *p = '?';
    POINT origin = {0};
    if (g_ddraw.hwnd) real_ClientToScreen(g_ddraw.hwnd, &origin);
    snprintf(json, capacity, "{\"enabled\":%s,\"desktopName\":\"%s\",\"desktopExpected\":\"%s\",\"desktopClass\":\"%s\",\"desktopHidden\":%s,\"clientOrigin\":[%ld,%ld],\"paintedControls\":%u,\"ownerDrawnControls\":%u,\"paintDcAcquires\":%u}",
        nh_hidden_active() ? "true" : "false", desktop_name, desktop_expected, desktop_class, desktop_hidden ? "true" : "false", origin.x, origin.y, last_painted, last_owner_drawn, last_dc_acquires);
}

int nh_hidden_painting(void) { return InterlockedCompareExchange(&paint_in_progress, 0, 0) != 0; }

HDC nh_hidden_paint_dc(HWND window, int begin_paint, PAINTSTRUCT *paint)
{
    if (!painting || !scratch_dc || !nh_hidden_owned(window) ||
        GetWindowThreadProcessId(window, NULL) != g_ddraw.gui_thread_id ||
        (window != g_ddraw.hwnd && window != scratch_root && window != scratch_window && !IsChild(scratch_root, window)) ||
        dc_route_count >= sizeof(dc_routes) / sizeof(dc_routes[0])) return NULL;
    RECT client;
    POINT origin = {0};
    if (!GetClientRect(window, &client)) return NULL;
    int saved = SaveDC(scratch_dc);
    if (!saved) return NULL;
    real_MapWindowPoints(window, g_ddraw.hwnd, &origin, 1);
    SetViewportOrgEx(scratch_dc, origin.x, origin.y, NULL);
    IntersectClipRect(scratch_dc, client.left, client.top, client.right, client.bottom);
    dc_routes[dc_route_count].window = window;
    dc_routes[dc_route_count].saved = saved;
    dc_routes[dc_route_count++].begin_paint = begin_paint;
    last_dc_acquires++;
    if (paint)
    {
        memset(paint, 0, sizeof(*paint));
        paint->hdc = scratch_dc;
        paint->rcPaint = client;
        /* The real handler paints its full hidden client, then consumes the
         * actual invalid region without acquiring an invisible window DC. */
        ValidateRect(window, NULL);
    }
    return scratch_dc;
}

int nh_hidden_finish_dc(HWND window, HDC dc, int end_paint)
{
    if (!scratch_dc || dc != scratch_dc) return -1;
    if (!dc_route_count || dc_routes[dc_route_count - 1].window != window ||
        dc_routes[dc_route_count - 1].begin_paint != end_paint) return 0;
    RestoreDC(scratch_dc, dc_routes[--dc_route_count].saved);
    return 1;
}

struct paint_windows { HWND root, windows[128]; unsigned count, visited; };

static BOOL CALLBACK collect_paint_child(HWND window, LPARAM context)
{
    struct paint_windows *state = (struct paint_windows *)context;
    if (state->count >= sizeof(state->windows) / sizeof(state->windows[0])) return FALSE;
    if (GetWindowThreadProcessId(window, NULL) == g_ddraw.gui_thread_id && nh_hidden_visible(window))
        state->windows[state->count++] = window;
    return TRUE;
}

static void collect_paint_tree(HWND parent, struct paint_windows *state, unsigned depth)
{
    if (depth >= 16 || state->count >= sizeof(state->windows) / sizeof(state->windows[0])) return;
    HWND first = GetWindow(parent, GW_CHILD);
    /* Native child enumeration starts at the top of the z-order. Paint each
     * parent before its children, but siblings from bottom to top, so genuine
     * overlapping popup controls remain above the controls they cover. */
    for (HWND child = first ? GetWindow(first, GW_HWNDLAST) : NULL; child; )
    {
        if (++state->visited > 512 || state->count >= sizeof(state->windows) / sizeof(state->windows[0])) return;
        HWND previous = GetWindow(child, GW_HWNDPREV);
        if (GetParent(child) == parent && GetWindowThreadProcessId(child, NULL) == g_ddraw.gui_thread_id &&
            nh_hidden_visible(child))
        {
            state->windows[state->count++] = child;
            collect_paint_tree(child, state, depth + 1);
        }
        if (previous == child) return;
        child = previous;
    }
}

static int system_paint_dc(const char *class_name)
{
    return !_stricmp(class_name, "Button") || !_stricmp(class_name, "Edit") ||
        !_stricmp(class_name, "Static") || !_stricmp(class_name, "ComboBox") ||
        !_stricmp(class_name, "ComboLBox") || !_stricmp(class_name, "ListBox") ||
        !_stricmp(class_name, "ScrollBar") || !_stricmp(class_name, "msctls_trackbar32");
}

static BOOL CALLBACK collect_paint_popup(HWND window, LPARAM context)
{
    struct paint_windows *state = (struct paint_windows *)context;
    char class_name[64] = {0};
    if (!nh_hidden_owned(window) || !nh_hidden_visible(window)) return TRUE;
    GetClassNameA(window, class_name, sizeof(class_name));
    if (_stricmp(class_name, "ComboLBox")) return TRUE;
    HWND ancestor = window;
    for (unsigned depth = 0; ancestor && depth < 32; depth++)
    {
        HWND parent = GetParent(ancestor);
        if (parent == state->root || (parent && IsChild(state->root, parent)))
            return collect_paint_child(window, context);
        HWND next = parent ? parent : GetWindow(ancestor, GW_OWNER);
        if (next == ancestor) break;
        /* Native popup owner chains are shallow; reject a pathological cycle. */
        if (next && GetWindowThreadProcessId(next, NULL) != g_ddraw.gui_thread_id) break;
        ancestor = next;
    }
    return TRUE;
}

void nh_hidden_paint(void)
{
    if (!nh_hidden_active() || painting || !g_ddraw.ref || GetCurrentThreadId() != g_ddraw.gui_thread_id || !g_ddraw.primary)
        return;
    struct paint_windows state = {0};
    state.root = nh_input_target_window();
    if (!state.root || GetWindowThreadProcessId(state.root, NULL) != g_ddraw.gui_thread_id) return;
    /* No control redraw is added to ordinary match pictures. Paused dialogs
     * and menu controls need genuine paint because their ancestors stay hidden. */
    if (state.root != g_ddraw.hwnd)
    {
        state.windows[state.count++] = state.root;
        collect_paint_tree(state.root, &state, 0);
    }
    EnumWindows(collect_paint_popup, (LPARAM)&state);
    if (!state.count) return;
    /* Paint callbacks can enter game code, so no wrapper lock, retained surface
     * dereference or auxiliary COM reference may span them. Surface Release has
     * compatibility behavior even at a nonzero reference count. Copy a genuine
     * primary baseline into a private DIB and commit only changed pixels later. */
    if (!TryEnterCriticalSection(&g_ddraw.cs)) return;
    IDirectDrawSurfaceImpl *initial_primary = g_ddraw.primary;
    if (!initial_primary || (g_config.lock_surfaces && !TryEnterCriticalSection(&initial_primary->cs)))
    { LeaveCriticalSection(&g_ddraw.cs); return; }
    DWORD width = initial_primary->width, height = initial_primary->height, bpp = initial_primary->bpp;
    DWORD source_pitch = initial_primary->pitch;
    HDC initial_dc = initial_primary->hdc;
    HBITMAP initial_bitmap = initial_primary->bitmap;
    HWND initial_main = g_ddraw.hwnd;
    unsigned bytes_pp = bpp / 8;
    void *initial_buffer = dds_GetBuffer(initial_primary);
    DWORD stride = ((width * bytes_pp) + 3) & ~3u;
    size_t size = (size_t)stride * height;
    int format_valid = (bpp == 16 || bpp == 32) && width && height && width <= 4096 && height <= 4096 &&
        source_pitch >= width * bytes_pp && source_pitch <= (32u * 1024u * 1024u) / height &&
        size <= 32u * 1024u * 1024u && initial_buffer;
    struct { BITMAPINFOHEADER header; DWORD masks[3]; } bitmap = {0};
    bitmap.header.biSize = sizeof(BITMAPINFOHEADER);
    bitmap.header.biWidth = width;
    bitmap.header.biHeight = -(LONG)height;
    bitmap.header.biPlanes = 1;
    bitmap.header.biBitCount = bpp;
    bitmap.header.biCompression = bpp == 16 ? BI_BITFIELDS : BI_RGB;
    bitmap.masks[0] = g_config.rgb555 ? 0x7c00 : 0xf800;
    bitmap.masks[1] = g_config.rgb555 ? 0x03e0 : 0x07e0;
    bitmap.masks[2] = 0x001f;
    BYTE *pixels = NULL;
    HBITMAP dib = format_valid ? CreateDIBSection(NULL, (BITMAPINFO *)&bitmap, DIB_RGB_COLORS, (void **)&pixels, NULL, 0) : NULL;
    BYTE *baseline = dib ? HeapAlloc(GetProcessHeap(), 0, size) : NULL;
    if (baseline)
        for (DWORD y = 0; y < height; y++)
        {
            memcpy(pixels + y * stride, (BYTE *)initial_buffer + y * source_pitch, width * bytes_pp);
            memcpy(baseline + y * stride, pixels + y * stride, width * bytes_pp);
        }
    if (g_config.lock_surfaces) LeaveCriticalSection(&initial_primary->cs);
    LeaveCriticalSection(&g_ddraw.cs);
    HDC dc = baseline ? CreateCompatibleDC(NULL) : NULL;
    if (!dc)
    {
        if (baseline) HeapFree(GetProcessHeap(), 0, baseline);
        if (dib) DeleteObject(dib);
        return;
    }
    HGDIOBJ previous_bitmap = SelectObject(dc, dib);
    if (!previous_bitmap || previous_bitmap == HGDI_ERROR)
    {
        DeleteDC(dc);
        DeleteObject(dib);
        HeapFree(GetProcessHeap(), 0, baseline);
        return;
    }
    painting = 1;
    InterlockedExchange(&paint_in_progress, 1);
    scratch_dc = dc;
    scratch_root = state.root;
    dc_route_count = 0;
    last_painted = last_owner_drawn = last_dc_acquires = 0;
    for (unsigned i = 0; i < state.count; i++)
    {
        if (g_ddraw.hwnd != initial_main || nh_input_target_window() != state.root) break;
        HWND window = state.windows[i];
        RECT client;
        POINT origin = {0};
        if (!IsWindow(window) || !nh_hidden_visible(window) || !GetClientRect(window, &client) ||
            client.right <= 0 || client.bottom <= 0) continue;
        real_MapWindowPoints(window, g_ddraw.hwnd, &origin, 1);
        int saved = SaveDC(dc);
        if (!saved) continue;
        SetViewportOrgEx(dc, origin.x, origin.y, NULL);
        IntersectClipRect(dc, client.left, client.top, client.right, client.bottom);
        unsigned route_base = dc_route_count;
        scratch_window = window;
        /* Game controls subclass their native WM_PAINT path. WM_PRINTCLIENT
         * bypasses those handlers and can draw only the generic control skin.
         * Standard controls accept this DC; game BeginPaint/GetDC imports use
         * the bounded scoped override above, retaining their actual assets. */
        char class_name[64] = {0};
        GetClassNameA(window, class_name, sizeof(class_name));
        LONG procedure = real_GetWindowLongA(window, GWL_WNDPROC);
        nh_hidden_get_window_proc(window, &procedure);
        LONG standard = (LONG)GetClassLongA(window, GCL_WNDPROC);
        /* A genuine invalid region and the ordinary zero wParam reach custom
         * game WM_PAINT handlers. Unsubclassed system controls can consume a DC
         * supplied as wParam because their internal APIs bypass the game's IAT. */
        InvalidateRect(window, NULL, FALSE);
        SendMessageA(window, WM_PAINT, procedure == standard && system_paint_dc(class_name) ? (WPARAM)dc : 0, 0);
        scratch_window = NULL;
        if (!_stricmp(class_name, "Button") && (real_GetWindowLongA(window, GWL_STYLE) & BS_TYPEMASK) == BS_OWNERDRAW)
            last_owner_drawn++;
        while (dc_route_count > route_base) RestoreDC(dc, dc_routes[--dc_route_count].saved);
        last_painted++;
        RestoreDC(dc, saved);
    }
    GdiFlush();
    if (g_ddraw.ref && GetCurrentThreadId() == g_ddraw.gui_thread_id && g_ddraw.hwnd == initial_main &&
        TryEnterCriticalSection(&g_ddraw.cs))
    {
        IDirectDrawSurfaceImpl *current = g_ddraw.primary;
        if (current == initial_primary && current && current->width == width && current->height == height &&
            current->bpp == bpp && current->pitch == source_pitch && current->hdc == initial_dc &&
            current->bitmap == initial_bitmap && g_ddraw.hwnd == initial_main &&
            (!g_config.lock_surfaces || TryEnterCriticalSection(&current->cs)))
        {
            BYTE *destination = dds_GetBuffer(current);
            if (destination == initial_buffer && nh_input_target_window() == state.root && nh_hidden_visible(state.root))
                for (DWORD y = 0; y < height; y++)
                {
                    if (bpp == 16)
                    {
                        uint16_t *dst = (uint16_t *)(destination + y * source_pitch);
                        const uint16_t *drawn = (const uint16_t *)(pixels + y * stride);
                        const uint16_t *before = (const uint16_t *)(baseline + y * stride);
                        for (DWORD x = 0; x < width; x++)
                            if (drawn[x] != before[x] && dst[x] == before[x]) dst[x] = drawn[x];
                    }
                    else
                    {
                        uint32_t *dst = (uint32_t *)(destination + y * source_pitch);
                        const uint32_t *drawn = (const uint32_t *)(pixels + y * stride);
                        const uint32_t *before = (const uint32_t *)(baseline + y * stride);
                        for (DWORD x = 0; x < width; x++)
                            if (drawn[x] != before[x] && dst[x] == before[x]) dst[x] = drawn[x];
                    }
                }
            if (g_config.lock_surfaces) LeaveCriticalSection(&current->cs);
        }
        LeaveCriticalSection(&g_ddraw.cs);
    }
    painting = 0;
    InterlockedExchange(&paint_in_progress, 0);
    scratch_dc = NULL;
    scratch_root = NULL;
    scratch_window = NULL;
    dc_route_count = 0;
    SelectObject(dc, previous_bitmap);
    DeleteDC(dc);
    DeleteObject(dib);
    HeapFree(GetProcessHeap(), 0, baseline);
}

HWND WINAPI nh_hidden_set_capture(HWND window)
{
    if (!nh_hidden_owned(window)) return SetCapture(window);
    HWND previous = captured;
    captured = window;
    return previous;
}

HWND WINAPI nh_hidden_get_capture(void) { return nh_hidden_active() ? captured : GetCapture(); }

BOOL WINAPI nh_hidden_release_capture(void)
{
    if (!nh_hidden_active()) return ReleaseCapture();
    captured = NULL;
    return TRUE;
}

BOOL WINAPI nh_hidden_end_dialog(HWND window, INT_PTR result)
{
    /* EndDialog may skip its internal ShowWindow when the physical window is
     * already hidden, so it must clear logical visibility at the API boundary. */
    if (nh_hidden_owned(window)) nh_hidden_set_visible(window, 0);
    return EndDialog(window, result);
}
