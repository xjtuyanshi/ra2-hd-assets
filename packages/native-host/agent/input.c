#include "agent.h"
#include "dd.h"
#include "hook.h"
#include "mouse.h"
#include "hidden.h"
#include "input-capture.h"
#include "window-target.h"
#include <stdio.h>
#include <stdarg.h>
#include <commctrl.h>
#include "yr-menu-text.h"
#include <string.h>

/* Private messages carry a bounded queue ticket, never a client-supplied pointer. */
#define NH_WM_INPUT (WM_APP + 0x148)
#define INPUT_QUEUE_SIZE 256
struct input_event { uint32_t ticket, id, generation, connection_generation, kind, a, b, c; LARGE_INTEGER received_at; };
static struct input_event queue[INPUT_QUEUE_SIZE];
static CRITICAL_SECTION input_lock;
static volatile LONG initialized, enabled;
static uint32_t next_ticket, accepted, delivered, last_message, last_key_message, last_key;
static uint32_t input_generation;
static LARGE_INTEGER input_frequency;
static uint64_t last_delivery_queue_us, max_delivery_queue_us, last_handler_us, max_handler_us;
static volatile LONG key_state[256], key_pressed[256], cursor_x, cursor_y;
static volatile LONG cursor_reads, key_reads, async_key_reads, cursor_writes;
static volatile LONG injected_key_reads, last_injected_key, cursor_last_read_x, cursor_last_read_y;
static int activated;
static HWND virtual_focus;
static struct nh_input_capture virtual_capture;
static int focus_known;
static unsigned focus_depth;
static uint32_t focus_generation;
static uint32_t dialog_messages, last_target, last_target_id;
static uint32_t redirected_captured_releases, consumed_captured_releases;
static HWND wheel_list;
static int wheel_remainder;
static uint32_t owner_drawn_wheels, owner_drawn_wheel_fallbacks, last_wheel_target;
static int last_wheel_delta, last_wheel_top_before = -1, last_wheel_top_after = -1;
nh_bink_open_proc nh_real_bink_open;
nh_bink_close_proc nh_real_bink_close;
struct movie_playback { void *handle; LARGE_INTEGER opened_at; int film; struct movie_playback *next; };
static struct movie_playback *movies;
static uint32_t movie_opens, movie_active, movie_tracking_failures, clip_opens, clip_active;
static uint64_t movie_total_us;

static void initialize(void)
{
    if (InterlockedCompareExchange(&initialized, 1, 0) == 0)
    {
        InitializeCriticalSection(&input_lock);
        QueryPerformanceFrequency(&input_frequency);
        InterlockedExchange(&initialized, 2);
    }
    /* Movie opens can precede the first browser request on another thread. */
    while (InterlockedCompareExchange(&initialized, 0, 0) != 2) Sleep(0);
}

static uint64_t elapsed_us(LARGE_INTEGER start)
{
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return input_frequency.QuadPart > 0 ?
        (uint64_t)((now.QuadPart - start.QuadPart) * 1000000 / input_frequency.QuadPart) : 0;
}

void *WINAPI nh_movie_open(const char *name, uint32_t flags)
{
    nh_bink_open_proc original = nh_real_bink_open;
    if (!original) original = (nh_bink_open_proc)real_GetProcAddress(GetModuleHandleA("BINKW32.DLL"), "_BinkOpen@8");
    if (!original) return NULL;
    void *handle = original(name, flags);
    if (!handle || !nh_agent_configured()) return handle;
    initialize();
    /* A successful open returns Bink's public BINK record, which starts with
     * the frame Width and Height. Only screen-sized decoders count as films. */
    const uint32_t *size = (const uint32_t *)handle;
    int film = size[0] >= NH_FILM_MIN_WIDTH && size[1] >= NH_FILM_MIN_HEIGHT;
    struct movie_playback *entry = HeapAlloc(GetProcessHeap(), 0, sizeof(*entry));
    LARGE_INTEGER opened_at;
    QueryPerformanceCounter(&opened_at);
    EnterCriticalSection(&input_lock);
    if (film) movie_opens++;
    else clip_opens++;
    if (entry)
    {
        entry->handle = handle;
        entry->opened_at = opened_at;
        entry->film = film;
        entry->next = movies;
        movies = entry;
        if (film) movie_active++;
        else clip_active++;
    }
    else if (film) movie_tracking_failures++;
    LeaveCriticalSection(&input_lock);
    return handle;
}

void WINAPI nh_movie_close(void *movie)
{
    nh_bink_close_proc original = nh_real_bink_close;
    if (!original) original = (nh_bink_close_proc)real_GetProcAddress(GetModuleHandleA("BINKW32.DLL"), "_BinkClose@4");
    if (!original) return;
    original(movie);
    if (!movie || !nh_agent_configured()) return;
    initialize();
    struct movie_playback *closed = NULL;
    EnterCriticalSection(&input_lock);
    for (struct movie_playback **link = &movies; *link; link = &(*link)->next)
    {
        if ((*link)->handle != movie) continue;
        closed = *link;
        *link = closed->next;
        if (closed->film)
        {
            movie_active--;
            movie_total_us += elapsed_us(closed->opened_at);
        }
        else clip_active--;
        break;
    }
    LeaveCriticalSection(&input_lock);
    if (closed) HeapFree(GetProcessHeap(), 0, closed);
}

int nh_input_active(void)
{
    if (!NH_ENABLE_INPUT) return 0;
    return nh_hidden_active() || (InterlockedCompareExchange(&enabled, 0, 0) && nh_connected());
}

int nh_input_key(int vk, SHORT *value, int asynchronous)
{
    if (!nh_input_active() || vk < 0 || vk > 255) return 0;
    LONG state = InterlockedCompareExchange(&key_state[vk], 0, 0);
    if (state & 0x8000)
    {
        InterlockedIncrement(&injected_key_reads);
        InterlockedExchange(&last_injected_key, vk);
    }
    if (asynchronous)
    {
        InterlockedIncrement(&async_key_reads);
        *value = (SHORT)((state & 0x8000) | (InterlockedExchange(&key_pressed[vk], 0) ? 1 : 0));
    }
    else
    {
        InterlockedIncrement(&key_reads);
        *value = (SHORT)state;
    }
    return 1;
}

int nh_input_cursor(LPPOINT point)
{
    if (!nh_input_active()) return 0;
    InterlockedIncrement(&cursor_reads);
    if (point)
    {
        point->x = InterlockedCompareExchange(&cursor_x, 0, 0);
        point->y = InterlockedCompareExchange(&cursor_y, 0, 0);
        InterlockedExchange(&cursor_last_read_x, point->x);
        InterlockedExchange(&cursor_last_read_y, point->y);
    }
    return 1;
}

int nh_input_set_cursor(int x, int y)
{
    if (!nh_input_active()) return 0;
    if (g_ddraw.width > 0) x = max(0, min(x, g_ddraw.width - 1));
    if (g_ddraw.height > 0) y = max(0, min(y, g_ddraw.height - 1));
    InterlockedExchange(&cursor_x, x); InterlockedExchange(&cursor_y, y);
    InterlockedExchange((LONG *)&g_ddraw.cursor.x, x);
    InterlockedExchange((LONG *)&g_ddraw.cursor.y, y);
    InterlockedIncrement(&cursor_writes);
    return 1;
}

/* Topmost enabled owned dialogs take input even while their real windows are hidden.
 * Selecting by ownership prevents another process's dialog from receiving input. */
HWND nh_input_target_window(void)
{
    return nh_window_target(NH_WINDOW_INPUT);
}

int nh_input_focus_window(HWND hwnd)
{
    if (!NH_ENABLE_INPUT) return 0;
    DWORD gui = g_ddraw.gui_thread_id;
    if (!gui || GetCurrentThreadId() != gui ||
        (hwnd && (!nh_window_owned(hwnd) || GetWindowThreadProcessId(hwnd, NULL) != gui))) return 0;
    if (focus_known && hwnd == virtual_focus) return 1;
    /* SetFocus callbacks may synchronously select a different owned control.
     * Publish the logical target first, then abandon stale outer notifications.
     * Never hold an agent lock across the original window procedures. */
    if (focus_depth >= 16) return 0;
    HWND previous = focus_known ? virtual_focus : NULL;
    uint32_t generation = ++focus_generation;
    virtual_focus = hwnd;
    focus_known = 1;
    focus_depth++;
    if (previous && nh_window_owned(previous) && GetWindowThreadProcessId(previous, NULL) == gui)
        SendMessageA(previous, WM_KILLFOCUS, (WPARAM)hwnd, 0);
    if (generation == focus_generation && virtual_focus == hwnd && hwnd &&
        g_ddraw.gui_thread_id == gui && nh_window_owned(hwnd) && GetWindowThreadProcessId(hwnd, NULL) == gui)
        SendMessageA(hwnd, WM_SETFOCUS, (WPARAM)previous, 0);
    focus_depth--;
    return 1;
}

static POINT game_to_screen(int x, int y)
{
    RECT client = {0};
    POINT point = {x, y};
    GetClientRect(g_ddraw.hwnd, &client);
    if (g_ddraw.width > 0 && client.right > 0) point.x = MulDiv(x, client.right, g_ddraw.width);
    if (g_ddraw.height > 0 && client.bottom > 0) point.y = MulDiv(y, client.bottom, g_ddraw.height);
    ClientToScreen(g_ddraw.hwnd, &point);
    return point;
}

static POINT screen_to_game(POINT point)
{
    RECT client = {0};
    GetClientRect(g_ddraw.hwnd, &client);
    ScreenToClient(g_ddraw.hwnd, &point);
    if (g_ddraw.width > 0 && client.right > 0) point.x = MulDiv(point.x, g_ddraw.width, client.right);
    if (g_ddraw.height > 0 && client.bottom > 0) point.y = MulDiv(point.y, g_ddraw.height, client.bottom);
    return point;
}

static HWND child_at(HWND root, POINT screen, int depth)
{
    if (depth >= 16) return root;
    /* ChildWindowFromPoint/WindowFromPoint discard descendants of a hidden root.
     * Walk the child z-order using the requested child visibility instead. */
    for (HWND child = GetWindow(root, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT))
    {
        RECT rect;
        if (!nh_hidden_visible(child) || !IsWindowEnabled(child) ||
            !GetWindowRect(child, &rect) || !PtInRect(&rect, screen)) continue;
        return child_at(child, screen, depth + 1);
    }
    return root;
}

/* USER32 hit testing asks the deepest window under the point for WM_NCHITTEST
 * and passes HTTRANSPARENT on to the sibling below it, then to the parent. The
 * hidden root skips that walk, so the GUI thread repeats it for mouse input.
 * Plain Statics are transparent: a dialog drawing pictures in them receives the
 * hit test and the mouse messages itself. Returns NULL when every window under
 * the point is transparent. */
static HWND hit_test_at(HWND window, POINT screen, int depth)
{
    if (depth < 16)
        for (HWND child = GetWindow(window, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT))
        {
            RECT rect;
            if (!nh_hidden_visible(child) || !IsWindowEnabled(child) ||
                !GetWindowRect(child, &rect) || !PtInRect(&rect, screen)) continue;
            HWND hit = hit_test_at(child, screen, depth + 1);
            if (hit) return hit;
        }
    /* Like USER32, only windows of the input thread can be passed over. */
    if (GetWindowThreadProcessId(window, NULL) != g_ddraw.gui_thread_id) return window;
    LRESULT code = SendMessageA(window, WM_NCHITTEST, 0, MAKELPARAM(screen.x, screen.y));
    return code == HTTRANSPARENT ? NULL : window;
}

static HWND window_at(HWND root, POINT screen)
{
    HWND hit = hit_test_at(root, screen, 0);
    return hit ? hit : root;
}

static int popup_for(HWND hwnd, HWND root)
{
    if (!nh_window_owned(hwnd) || !nh_hidden_visible(hwnd) || !IsWindowEnabled(hwnd)) return 0;
    char class_name[64] = {0};
    GetClassNameA(hwnd, class_name, sizeof(class_name));
    if (_stricmp(class_name, "ComboLBox") != 0) return 0;
    HWND ancestor = hwnd;
    for (int depth = 0; ancestor && depth < 32; depth++)
    {
        HWND parent = GetParent(ancestor);
        if (parent == root || (parent && IsChild(root, parent))) return 1;
        HWND next = parent ? parent : GetWindow(ancestor, GW_OWNER);
        if (next == ancestor) return 0;
        ancestor = next;
    }
    return 0;
}

struct popup_context { HWND root, target; POINT screen; };
static BOOL CALLBACK find_popup_at(HWND hwnd, LPARAM context)
{
    struct popup_context *state = (struct popup_context *)context;
    RECT rect;
    if (popup_for(hwnd, state->root) && GetWindowRect(hwnd, &rect) && PtInRect(&rect, state->screen))
    { state->target = child_at(hwnd, state->screen, 0); return FALSE; }
    return TRUE;
}

/* The hidden host receives no physical hit-test/WM_SETCURSOR sequence. Cursor
 * capture uses the same owned popup/control/capture target as virtual input,
 * without moving the OS pointer or invoking a window procedure. */
HWND nh_input_cursor_window(void)
{
    HWND root = nh_input_target_window();
    if (!root || !nh_window_owned(root) || !nh_hidden_visible(root)) return NULL;
    if (root == g_ddraw.hwnd) return root;
    POINT screen = game_to_screen((int)InterlockedCompareExchange(&cursor_x, 0, 0),
        (int)InterlockedCompareExchange(&cursor_y, 0, 0));
    struct popup_context popup = {root, NULL, screen};
    EnumWindows(find_popup_at, (LPARAM)&popup);
    HWND capture = nh_hidden_get_capture();
    if ((capture == root || IsChild(root, capture) || popup_for(capture, root)) &&
        GetWindowThreadProcessId(capture, NULL) == g_ddraw.gui_thread_id &&
        nh_hidden_visible(capture) && IsWindowEnabled(capture)) return capture;
    HWND pressed = (HWND)virtual_capture.target;
    if ((pressed == root || IsChild(root, pressed) || popup_for(pressed, root)) &&
        nh_window_owned(pressed) && nh_hidden_visible(pressed) && IsWindowEnabled(pressed)) return pressed;
    HWND target = popup.target ? popup.target : child_at(root, screen, 0);
    return nh_window_owned(target) && GetWindowThreadProcessId(target, NULL) == g_ddraw.gui_thread_id ? target : NULL;
}

struct controls_context { char *json; uint32_t capacity, used, count, combo_queries; int truncated; HWND root; };

static int query_control(HWND hwnd, UINT message, int32_t *value)
{
    DWORD_PTR result;
    if (!SendMessageTimeoutA(hwnd, message, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 10, &result)) return 0;
    *value = (int32_t)result;
    return 1;
}

static void escaped(char *out, uint32_t capacity, const char *source)
{
    uint32_t used = 0;
    for (; *source && used + 2 < capacity; source++)
    {
        unsigned char c = (unsigned char)*source;
        if (c == '\\' || c == '"') out[used++] = '\\';
        out[used++] = c >= 32 ? (char)c : '?';
    }
    out[used] = 0;
}

static BOOL CALLBACK describe_control(HWND hwnd, LPARAM context)
{
    struct controls_context *state = (struct controls_context *)context;
    if (state->count >= 128 || state->capacity - state->used < 1024) { state->truncated = 1; return FALSE; }
    RECT rect;
    if (!GetWindowRect(hwnd, &rect)) return TRUE;
    POINT first = screen_to_game((POINT){rect.left, rect.top}), last = screen_to_game((POINT){rect.right, rect.bottom});
    char class_name[64] = {0}, title[96] = {0}, class_json[128], title_json[192];
    GetClassNameA(hwnd, class_name, sizeof(class_name));
    typedef int (WINAPI *GETCACHEDTEXT)(HWND, LPWSTR, int);
    GETCACHEDTEXT cached_text = (GETCACHEDTEXT)GetProcAddress(GetModuleHandleA("user32.dll"), "InternalGetWindowText");
    if (cached_text)
    {
        WCHAR wide[96] = {0};
        /* The cached title is what cross-process GetWindowText observes. YR's
         * owner-drawn controls can return an empty WM_GETTEXT, and waiting for
         * their thread here must not hold up transport diagnostics. */
        cached_text(hwnd, wide, sizeof(wide) / sizeof(wide[0]));
        WideCharToMultiByte(CP_UTF8, 0, wide, -1, title, sizeof(title), NULL, NULL);
    }
    else
    {
        DWORD_PTR copied;
        SendMessageTimeoutA(hwnd, WM_GETTEXT, sizeof(title), (LPARAM)title, SMTO_ABORTIFHUNG | SMTO_BLOCK, 10, &copied);
    }
    escaped(class_json, sizeof(class_json), class_name); escaped(title_json, sizeof(title_json), title);
    int visible = nh_hidden_visible(hwnd);
    char combo[192] = "";
    if (_stricmp(class_name, "ComboBox") == 0)
    {
        int32_t count = 0, selection = 0, dropped = 0;
        char count_json[32] = "null", selection_json[32] = "null", dropped_json[32] = "null";
        if (IsWindowEnabled(hwnd) && state->combo_queries++ < 32)
        {
            if (query_control(hwnd, CB_GETCOUNT, &count)) snprintf(count_json, sizeof(count_json), "%ld", (long)count);
            if (query_control(hwnd, CB_GETCURSEL, &selection)) snprintf(selection_json, sizeof(selection_json), "%ld", (long)selection);
            if (query_control(hwnd, CB_GETDROPPEDSTATE, &dropped)) strcpy(dropped_json, dropped ? "true" : "false");
        }
        snprintf(combo, sizeof(combo), ",\"combo\":{\"count\":%s,\"selection\":%s,\"dropped\":%s}",
            count_json, selection_json, dropped_json);
    }
    else if (_stricmp(class_name, "ComboLBox") == 0 || _stricmp(class_name, "ListBox") == 0)
    {
        int32_t count, selection, top, height;
        char count_json[32] = "null", selection_json[32] = "null", top_json[32] = "null", height_json[32] = "null";
        if (IsWindowEnabled(hwnd) && state->combo_queries++ < 32)
        {
            if (query_control(hwnd, LB_GETCOUNT, &count)) snprintf(count_json, sizeof(count_json), "%ld", (long)count);
            if (query_control(hwnd, LB_GETCURSEL, &selection)) snprintf(selection_json, sizeof(selection_json), "%ld", (long)selection);
            if (query_control(hwnd, LB_GETTOPINDEX, &top)) snprintf(top_json, sizeof(top_json), "%ld", (long)top);
            if (query_control(hwnd, LB_GETITEMHEIGHT, &height)) snprintf(height_json, sizeof(height_json), "%ld", (long)height);
        }
        snprintf(combo, sizeof(combo), ",\"list\":{\"count\":%s,\"selection\":%s,\"topIndex\":%s,\"itemHeight\":%s}",
            count_json, selection_json, top_json, height_json);
    }
    state->used += (uint32_t)snprintf(state->json + state->used, state->capacity - state->used,
        "%s{\"hwnd\":%u,\"parentHwnd\":%u,\"style\":%u,\"id\":%d,\"class\":\"%s\",\"text\":\"%s\",\"visible\":%s,\"enabled\":%s,"
        "\"rect\":[%ld,%ld,%ld,%ld]%s}", state->count ? "," : "", (uint32_t)(uintptr_t)hwnd,
        (uint32_t)(uintptr_t)GetParent(hwnd), (uint32_t)GetWindowLongA(hwnd, GWL_STYLE), GetDlgCtrlID(hwnd), class_json, title_json,
        visible ? "true" : "false", IsWindowEnabled(hwnd) ? "true" : "false",
        first.x, first.y, last.x, last.y, combo);
    state->count++;
    return TRUE;
}

static BOOL CALLBACK describe_popup(HWND hwnd, LPARAM context)
{
    struct controls_context *state = (struct controls_context *)context;
    if (popup_for(hwnd, state->root)) return describe_control(hwnd, context);
    return TRUE;
}

struct menu_context {
    char *json;
    uint32_t capacity, used, count;
    int complete;
    HWND root, focus;
    LARGE_INTEGER query_started;
    int button_queries_failed;
};

static int menu_query(struct menu_context *state, HWND hwnd, UINT message, WPARAM wp, LPARAM lp, int32_t *value)
{
    /* Captures run on the GUI owner. Its control calls are synchronous and
     * SendMessageTimeout cannot time-limit them. Do not mistake time spent
     * enumerating/serializing earlier controls for a hung current control. */
    if (GetWindowThreadProcessId(hwnd, NULL) == GetCurrentThreadId())
    {
        *value = (int32_t)SendMessageW(hwnd, message, wp, lp);
        return 1;
    }
    if (state->button_queries_failed) return 0;
    uint64_t used = elapsed_us(state->query_started);
    /* Foreign control owners share one deadline so a hung owner cannot
     * multiply the budget across the snapshot. */
    UINT remaining_ms = used < 10000 ? (UINT)((10000 - used) / 1000) : 0;
    DWORD_PTR result;
    if (!remaining_ms || !SendMessageTimeoutW(hwnd, message, wp, lp,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, remaining_ms, &result))
    { state->button_queries_failed = 1; return 0; }
    *value = (int32_t)result;
    return 1;
}

static int menu_append(struct menu_context *state, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int written = vsnprintf(state->json + state->used, state->capacity - state->used, format, args);
    va_end(args);
    if (written < 0 || (uint32_t)written >= state->capacity - state->used)
    { state->complete = 0; return 0; }
    state->used += (uint32_t)written;
    return 1;
}

static void menu_rect(struct menu_context *state, const char *key, RECT rect, HWND client)
{
    POINT first = {rect.left, rect.top}, last = {rect.right, rect.bottom};
    if (client) { ClientToScreen(client, &first); ClientToScreen(client, &last); }
    first = screen_to_game(first); last = screen_to_game(last);
    menu_append(state, ",\"%s\":{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld}",
        key, first.x, first.y, last.x - first.x, last.y - first.y);
}

static void menu_items(struct menu_context *state, HWND hwnd, int combo)
{
    int32_t count, selection, top, height, result;
    if (!menu_query(state, hwnd, combo ? CB_GETCOUNT : LB_GETCOUNT, 0, 0, &count) || count < 0 || count > 512 ||
        !menu_query(state, hwnd, combo ? CB_GETCURSEL : LB_GETCURSEL, 0, 0, &selection) ||
        !menu_query(state, hwnd, combo ? CB_GETTOPINDEX : LB_GETTOPINDEX, 0, 0, &top) ||
        !menu_query(state, hwnd, combo ? CB_GETITEMHEIGHT : LB_GETITEMHEIGHT, 0, 0, &height) || height <= 0)
    { state->complete = 0; return; }
    RECT client;
    if (!GetClientRect(hwnd, &client)) { state->complete = 0; return; }
    menu_append(state, ",\"selection\":%ld,\"topIndex\":%ld,\"itemHeight\":%ld,\"visibleRows\":%ld,\"itemData\":[",
        (long)selection, (long)top, (long)height, (long)((client.bottom - client.top) / height));
    int complete = 1;
    uint32_t item_data[512];
    WNDPROC item_procedure = yr_menu_items_procedure(hwnd);
    for (int32_t index = 0; index < count; index++)
    {
        if (item_procedure)
            result = (int32_t)CallWindowProcA(item_procedure, hwnd, combo ? CB_GETITEMDATA : LB_GETITEMDATA, index, 0);
        else if (nh_identity_verified() || !menu_query(state, hwnd, combo ? CB_GETITEMDATA : LB_GETITEMDATA, index, 0, &result))
        { complete = 0; break; }
        item_data[index] = (uint32_t)result;
        menu_append(state, "%s%u", index ? "," : "", item_data[index]);
    }
    menu_append(state, "]");
    uint32_t colors[50];
    if (complete && yr_menu_item_colors(hwnd, colors, count))
    {
        menu_append(state, ",\"itemColors\":[");
        for (int32_t index = 0; index < count; index++)
            if (colors[index] == UINT32_MAX) menu_append(state, "%snull", index ? "," : "");
            else menu_append(state, "%s%u", index ? "," : "", colors[index]);
        menu_append(state, "]");
    }
    /* Owner-drawn item data has game-specific meaning. The game policy resolves
     * it; treating that pointer as ANSI text produces plausible-looking garbage. */
    DWORD style = (DWORD)GetWindowLongW(hwnd, GWL_STYLE);
    int strings = combo ? ((style & 0x30) == 0 || (style & CBS_HASSTRINGS)) :
        ((style & 0x30) == 0 || (style & LBS_HASSTRINGS));
    if (complete)
    {
        menu_append(state, ",\"items\":[");
        for (int32_t index = 0; index < count; index++)
        {
            WCHAR wide[1024]; char utf8[4096], json[8192];
            int32_t length;
            if (yr_menu_item_text(item_data[index], utf8, sizeof(utf8))) { /* Exact owner-drawn text. */ }
            else if (strings && (style & 0x30) == 0)
            {
                if (!menu_query(state, hwnd, combo ? CB_GETLBTEXTLEN : LB_GETTEXTLEN, index, 0, &length) ||
                    length < 0 || length >= 1024 ||
                    !menu_query(state, hwnd, combo ? CB_GETLBTEXT : LB_GETTEXT, index, (LPARAM)wide, &result) || result != length)
                { complete = 0; break; }
                wide[length] = 0;
                if (!WideCharToMultiByte(CP_UTF8, 0, wide, -1, utf8, sizeof(utf8), NULL, NULL))
                { complete = 0; break; }
            }
            else { complete = 0; break; }
            escaped(json, sizeof(json), utf8);
            if (state->capacity - state->used < strlen(json) + 2048) { complete = 0; break; }
            menu_append(state, "%s\"%s\"", index ? "," : "", json);
        }
        menu_append(state, "]");
    }
    menu_append(state, ",\"itemsComplete\":%s", complete ? "true" : "false");
    if (!complete) state->complete = 0;
    if (combo)
    {
        HWND popup, scrollbar; int32_t popup_top, popup_selection; RECT popup_rect;
        if (!yr_menu_popup(hwnd, &popup, &scrollbar, &popup_top, &popup_selection) ||
            !GetWindowRect(popup ? popup : hwnd, &popup_rect))
        { state->complete = 0; return; }
        menu_append(state, ",\"popup\":{\"dropped\":%s,\"hwnd\":%u,\"scrollbarHwnd\":%u,\"topIndex\":%ld,\"selection\":%ld",
            popup ? "true" : "false", (uint32_t)(uintptr_t)popup, (uint32_t)(uintptr_t)scrollbar,
            (long)popup_top, (long)popup_selection);
        menu_rect(state, "rect", popup_rect, NULL);
        menu_append(state, "}");
    }
}

static int menu_control_enabled(HWND window, HWND root)
{
    /* A modal can disable its owner while remaining usable itself. Include
     * every child/owned-popup ancestor, but stop at this snapshot's dialog. */
    for (unsigned depth = 0; window && depth < 32; depth++)
    {
        if (!IsWindowEnabled(window)) return 0;
        if (window == root) return 1;
        HWND parent = GetParent(window);
        HWND next = parent ? parent : GetWindow(window, GW_OWNER);
        if (next == window) return 0;
        window = next;
    }
    return 0;
}

static BOOL CALLBACK describe_menu_control(HWND hwnd, LPARAM context)
{
    struct menu_context *state = (struct menu_context *)context;
    if (state->count >= 128 || state->capacity - state->used < 4096)
    { state->complete = 0; return FALSE; }
    RECT rect;
    if (!GetWindowRect(hwnd, &rect)) { state->complete = 0; return TRUE; }
    POINT first = screen_to_game((POINT){rect.left, rect.top});
    POINT last = screen_to_game((POINT){rect.right, rect.bottom});
    char class_name[64] = {0}, class_json[128], title[1024] = {0}, title_json[2048];
    if (!GetClassNameA(hwnd, class_name, sizeof(class_name))) state->complete = 0;
    typedef int (WINAPI *GETCACHEDTEXT)(HWND, LPWSTR, int);
    GETCACHEDTEXT cached_text = (GETCACHEDTEXT)GetProcAddress(GetModuleHandleA("user32.dll"), "InternalGetWindowText");
    int text_complete = 0;
    if (cached_text)
    {
        WCHAR wide[256] = {0};
        int copied = cached_text(hwnd, wide, sizeof(wide) / sizeof(wide[0]));
        text_complete = copied >= 0 && copied < 255 &&
            WideCharToMultiByte(CP_UTF8, 0, wide, -1, title, sizeof(title), NULL, NULL) > 0;
    }
    char source_json[2048] = "";
    int game_text = 0;
    escaped(source_json, sizeof(source_json), title);
    int actual_text = yr_menu_control_text(hwnd, title, sizeof(title));
    uint32_t edit[4];
    int has_edit = GetDlgCtrlID(hwnd) == 1696 && !_stricmp(class_name, "ListBox") &&
        yr_menu_name_edit(hwnd, title, sizeof(title), edit);
    if (has_edit) actual_text = 1;
    if (actual_text > 0) { text_complete = 1; game_text = 1; }
    else if (actual_text < 0) text_complete = 0;
    /* Cached Unicode text avoids calling owner-drawn WM_GETTEXT handlers, which
     * may report no text even though the original control owns a resource key. */
    escaped(class_json, sizeof(class_json), class_name);
    escaped(title_json, sizeof(title_json), title);
    int visible = nh_hidden_visible(hwnd), pressed = 0, checked = -1;
    if (visible && _stricmp(class_name, "Button") == 0)
    {
        int32_t button_state;
        if (menu_query(state, hwnd, BM_GETSTATE, 0, 0, &button_state))
        { pressed = (button_state & BST_PUSHED) != 0; checked = button_state & 3; }
        else state->complete = 0;
        int kind = GetWindowLongW(hwnd, GWL_STYLE) & 0xf;
        if (kind == BS_CHECKBOX || kind == BS_AUTOCHECKBOX || kind == BS_3STATE || kind == BS_AUTO3STATE ||
            kind == BS_RADIOBUTTON || kind == BS_AUTORADIOBUTTON)
        {
            int32_t actual_check;
            if (menu_query(state, hwnd, BM_GETCHECK, 0, 0, &actual_check) && actual_check >= 0 && actual_check <= 2)
                checked = actual_check;
            else state->complete = 0;
        }
    }
    if (!text_complete) state->complete = 0;
    state->used += (uint32_t)snprintf(state->json + state->used, state->capacity - state->used,
        "%s{\"hwnd\":%u,\"parent\":%u,\"id\":%d,\"className\":\"%s\",\"style\":%u,"
        "\"text\":\"%s\",\"textComplete\":%s,\"rect\":{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld},"
        "\"visible\":%s,\"enabled\":%s,\"focused\":%s,\"pressed\":%s",
        state->count ? "," : "", (uint32_t)(uintptr_t)hwnd, (uint32_t)(uintptr_t)GetParent(hwnd),
        GetDlgCtrlID(hwnd), class_json, (uint32_t)GetWindowLongA(hwnd, GWL_STYLE), title_json,
        text_complete ? "true" : "false", first.x, first.y, last.x - first.x, last.y - first.y,
        visible ? "true" : "false", menu_control_enabled(hwnd, state->root) ? "true" : "false",
        hwnd == state->focus ? "true" : "false", pressed ? "true" : "false");
    if (game_text) menu_append(state, ",\"sourceText\":\"%s\"", source_json);
    if (has_edit) menu_append(state, ",\"edit\":{\"caret\":%u,\"firstVisible\":%u,\"caretVisible\":%s,\"caretColor\":%u}",
        edit[0], edit[1], edit[2] ? "true" : "false", edit[3]);
    if (visible && _stricmp(class_name, "ComboDropWin") == 0)
    {
        HWND owner = yr_menu_popup_owner(hwnd);
        if (owner) menu_append(state, ",\"popupOwner\":%u", (uint32_t)(uintptr_t)owner);
        else state->complete = 0;
    }
    if (checked >= 0) menu_append(state, ",\"checked\":%d", checked);
    if (visible && (_stricmp(class_name, "ListBox") == 0 || _stricmp(class_name, "ComboLBox") == 0 ||
        _stricmp(class_name, "ComboBox") == 0)) menu_items(state, hwnd, _stricmp(class_name, "ComboBox") == 0);
    if (visible && _stricmp(class_name, "msctls_trackbar32") == 0)
    {
        int32_t min, max, value; RECT thumb = {0}, groove = {0}; char value_text[64];
        if (yr_menu_slider(hwnd, &thumb, &groove, &min, &max, &value, value_text, sizeof(value_text)))
        {
            menu_append(state, ",\"slider\":{\"min\":%ld,\"max\":%ld,\"value\":%ld,\"valueText\":\"%s\"",
                (long)min, (long)max, (long)value, value_text);
            menu_rect(state, "thumb", thumb, NULL); menu_rect(state, "groove", groove, NULL);
            menu_append(state, "}");
        }
        else state->complete = 0;
    }
    if (visible && _stricmp(class_name, "ScrollBar") == 0)
    {
        int32_t maximum, position; RECT thumb, groove;
        if (yr_menu_scrollbar(hwnd, &thumb, &groove, &maximum, &position))
        {
            menu_append(state, ",\"scroll\":{\"min\":0,\"max\":%ld,\"page\":0,\"pos\":%ld,\"arrowSize\":22",
                (long)maximum, (long)position);
            menu_rect(state, "thumb", thumb, NULL); menu_rect(state, "groove", groove, NULL);
            menu_append(state, "}");
        }
        else state->complete = 0;
    }
    menu_append(state, "}");
    state->count++;
    return TRUE;
}

static BOOL CALLBACK describe_menu_popup(HWND hwnd, LPARAM context)
{
    struct menu_context *state = (struct menu_context *)context;
    if (popup_for(hwnd, state->root)) return describe_menu_control(hwnd, context);
    return TRUE;
}

/* Only the GUI thread enumerates menu controls. The transport returns an
 * immutable copy paired with a completed picture, never a later live tree. */
static char menu_before[65536], menu_current[65536], menu_committed[65536];
static uint32_t menu_generation;
static int menu_before_valid;

static int describe_menu(char *json, uint32_t capacity)
{
    HWND root = nh_window_target(NH_WINDOW_PAINT);
    if (!root || root == g_ddraw.hwnd) { strcpy(json, "null"); return 0; }
    uint32_t width = 0, height = 0, bpp = 0;
    nh_surface_info(&width, &height, &bpp);
    EnterCriticalSection(&input_lock);
    int tracking_failed = movie_tracking_failures != 0, playing = movie_active != 0;
    LeaveCriticalSection(&input_lock);
    snprintf(json, capacity, "{\"width\":%u,\"height\":%u,\"dialogHwnd\":%u,\"moviePlaying\":%s,\"controls\":[",
        width, height, (uint32_t)(uintptr_t)root, tracking_failed ? "null" : playing ? "true" : "false");
    struct menu_context state = {0};
    state.json = json; state.capacity = capacity; state.used = (uint32_t)strlen(json);
    state.complete = 1; state.root = root; state.focus = nh_input_get_focus();
    QueryPerformanceCounter(&state.query_started);
    describe_menu_control(root, (LPARAM)&state);
    EnumChildWindows(root, describe_menu_control, (LPARAM)&state);
    EnumWindows(describe_menu_popup, (LPARAM)&state);
    if (root != nh_window_target(NH_WINDOW_PAINT) || !IsWindow(root)) state.complete = 0;
    snprintf(json + state.used, capacity - state.used, "],\"complete\":%s}", state.complete ? "true" : "false");
    return state.complete;
}

void nh_menu_prepare(void)
{
    initialize();
    menu_before_valid = describe_menu(menu_before, sizeof(menu_before));
}

uint32_t nh_menu_complete(void)
{
    int complete = describe_menu(menu_current, sizeof(menu_current));
    uint32_t result = 0;
    EnterCriticalSection(&input_lock);
    /* A callback may change text or children while painting the same HWND.
     * Such an intermediate picture receives no identity and stays original. */
    if (complete && menu_before_valid && !strcmp(menu_before, menu_current))
    {
        if (strcmp(menu_current, menu_committed))
        {
            if (!++menu_generation) ++menu_generation;
            strcpy(menu_committed, menu_current);
        }
        result = menu_generation;
    }
    LeaveCriticalSection(&input_lock);
    return result;
}

static void menu_snapshot(uint32_t id)
{
    char json[65536 + 192];
    EnterCriticalSection(&input_lock);
    uint32_t length = (uint32_t)strlen(menu_committed);
    if (!length || !menu_generation) strcpy(json, "null");
    else
    {
        memcpy(json, menu_committed, length - 1);
        snprintf(json + length - 1, sizeof(json) - length + 1,
            ",\"generation\":%u,\"pointer\":{\"x\":%ld,\"y\":%ld}}", menu_generation,
            InterlockedCompareExchange(&cursor_x, 0, 0), InterlockedCompareExchange(&cursor_y, 0, 0));
    }
    LeaveCriticalSection(&input_lock);
    nh_send(NH_INPUT_STATE, id, json, (uint32_t)strlen(json));
}

static void input_state(uint32_t id, int skip_controls)
{
    char json[65536], held[1024];
    HWND target = nh_input_target_window();
    HWND paint_target = nh_window_target(NH_WINDOW_PAINT);
    int modal = target && target != g_ddraw.hwnd;
    uint32_t used = 0;
    held[0] = 0;
    for (int vk = 0; vk < 256; vk++)
    {
        if (InterlockedCompareExchange(&key_state[vk], 0, 0) & 0x8000)
            used += (uint32_t)snprintf(held + used, sizeof(held) - used, "%s%d", used ? "," : "", vk);
    }
    EnterCriticalSection(&input_lock);
    snprintf(json, sizeof(json),
        "{\"x\":%ld,\"y\":%ld,\"heldKeys\":[%s],\"cursorReads\":%ld,\"keyReads\":%ld,"
        "\"asyncKeyReads\":%ld,\"cursorWrites\":%ld,\"acceptedInputs\":%u,\"deliveredMessages\":%u,"
        "\"lastMessage\":%u,\"lastKeyMessage\":%u,\"lastKeyVirtualKey\":%u,\"injectedKeyReads\":%ld,"
        "\"lastInjectedKey\":%ld,\"cursorLastReadX\":%ld,\"cursorLastReadY\":%ld,\"modal\":%s,"
        "\"moviePlaying\":%s,\"movieOpens\":%u,\"movieTotalMs\":%llu,\"movieTrackingFailures\":%u,"
        "\"clipOpens\":%u,\"clipActive\":%u,\"dialogMessages\":%u,\"lastTargetHwnd\":%u,\"lastTargetId\":%u,\"dialogHwnd\":%u,"
        "\"focusHwnd\":%u,\"gameCaptureHwnd\":%u,\"redirectedCapturedReleases\":%u,"
        "\"consumedCapturedReleases\":%u,\"lastDeliveryQueueUs\":%llu,\"maxDeliveryQueueUs\":%llu,"
        "\"lastHandlerUs\":%llu,\"maxHandlerUs\":%llu,\"ownerDrawnWheels\":%u,\"ownerDrawnWheelFallbacks\":%u,"
        "\"lastWheelTargetHwnd\":%u,\"lastWheelDelta\":%d,\"lastWheelTopBefore\":%d,\"lastWheelTopAfter\":%d,"
        "\"menuVisible\":%s,\"menuHwnd\":%u,\"directInput\":\"unsupported\",\"controls\":[",
        InterlockedCompareExchange(&cursor_x, 0, 0), InterlockedCompareExchange(&cursor_y, 0, 0), held,
        InterlockedCompareExchange(&cursor_reads, 0, 0), InterlockedCompareExchange(&key_reads, 0, 0),
        InterlockedCompareExchange(&async_key_reads, 0, 0), InterlockedCompareExchange(&cursor_writes, 0, 0),
        accepted, delivered, last_message, last_key_message, last_key,
        InterlockedCompareExchange(&injected_key_reads, 0, 0), InterlockedCompareExchange(&last_injected_key, 0, 0),
        InterlockedCompareExchange(&cursor_last_read_x, 0, 0), InterlockedCompareExchange(&cursor_last_read_y, 0, 0), modal ? "true" : "false",
        movie_tracking_failures ? "null" : movie_active ? "true" : "false", movie_opens,
        (unsigned long long)(movie_total_us / 1000), movie_tracking_failures, clip_opens, clip_active,
        dialog_messages, last_target, last_target_id, (uint32_t)(uintptr_t)(modal ? target : NULL),
        (uint32_t)(uintptr_t)nh_input_get_focus(), (uint32_t)(uintptr_t)nh_hidden_get_capture(),
        redirected_captured_releases, consumed_captured_releases,
        (unsigned long long)last_delivery_queue_us, (unsigned long long)max_delivery_queue_us,
        (unsigned long long)last_handler_us, (unsigned long long)max_handler_us,
        owner_drawn_wheels, owner_drawn_wheel_fallbacks, last_wheel_target,
        last_wheel_delta, last_wheel_top_before, last_wheel_top_after,
        paint_target != g_ddraw.hwnd ? "true" : "false", (uint32_t)(uintptr_t)paint_target);
    LeaveCriticalSection(&input_lock);
    struct controls_context controls = {json, sizeof(json), (uint32_t)strlen(json), 0, 0, 0, target};
    if (target && !skip_controls)
    {
        describe_control(target, (LPARAM)&controls);
        EnumChildWindows(target, describe_control, (LPARAM)&controls);
        EnumWindows(describe_popup, (LPARAM)&controls);
    }
    snprintf(json + controls.used, sizeof(json) - controls.used, "],\"controlsTruncated\":%s}", controls.truncated ? "true" : "false");
    nh_send(NH_INPUT_STATE, id, json, (uint32_t)strlen(json));
}

static void error(uint32_t id, const char *message)
{
    nh_send(NH_ERROR, id, message, (uint32_t)strlen(message));
}

static int allowed_message(uint32_t message)
{
    return (message >= WM_KEYDOWN && message <= WM_SYSDEADCHAR) || message == WM_UNICHAR ||
        (message >= WM_MOUSEMOVE && message <= WM_MOUSEHWHEEL);
}

void nh_dispatch_input(uint16_t type, uint32_t id, const uint8_t *payload, uint32_t length)
{
    if (type == NH_CREDIT) { nh_picture_credit(id, payload, length); return; }
    if (!NH_ENABLE_INPUT)
    {
        const char *error = "input disabled in this diagnostic build";
        nh_send(NH_ERROR, id, error, (uint32_t)strlen(error));
        return;
    }
    initialize();
    if (type == NH_INPUT_STATE)
    {
        uint32_t flags = 0;
        if (length == 4) memcpy(&flags, payload, 4);
        if ((length != 0 && length != 4) || (length == 4 && flags != 1 && flags != 2 && flags != 3))
        { error(id, "input state takes no payload or flags one (minimal), two (cursor), three (menu)"); return; }
        if (flags == 2)
        {
            nh_cursor_snapshot(id, (int)InterlockedCompareExchange(&cursor_x, 0, 0),
                (int)InterlockedCompareExchange(&cursor_y, 0, 0));
            return;
        }
        if (flags == 3) { menu_snapshot(id); return; }
        /* Frequent readers need modal ownership, not GUI control queries.
         * Empty requests retain the complete diagnostic response. */
        input_state(id, flags == 1);
        return;
    }
    if (type != NH_INPUT || length != 16) { error(id, "invalid input request"); return; }
    uint32_t fields[4];
    memcpy(fields, payload, 16);
    uint32_t kind = fields[0], a = fields[1], b = fields[2], c = fields[3];
    LARGE_INTEGER received_at;
    QueryPerformanceCounter(&received_at);
    if (!g_ddraw.hwnd || !g_ddraw.wndproc) { error(id, "game window unavailable"); return; }
    if (kind < 1 || kind > 3 || (kind == 1 && !allowed_message(a)) ||
        (kind == 2 && (a > 255 || b > 1))) { error(id, "unsupported input operation"); return; }
    EnterCriticalSection(&input_lock);
    uint32_t ticket = next_ticket + 1;
    if (!ticket) ticket++;
    struct input_event *slot = &queue[ticket % INPUT_QUEUE_SIZE];
    /* The page waits for GUI consumption before sending another input. Other
     * protocol clients can still fill the bounded ticket ring: stop receiving
     * more work until the genuine GUI thread releases this slot, without
     * dropping the event or turning temporary load into a runtime error. */
    while (slot->ticket)
    {
        LeaveCriticalSection(&input_lock);
        if (!nh_connected()) return;
        Sleep(1);
        EnterCriticalSection(&input_lock);
    }
    next_ticket = ticket;
    slot->ticket = ticket; slot->id = id; slot->generation = input_generation;
    slot->connection_generation = nh_connection_generation();
    slot->kind = kind; slot->a = a; slot->b = b; slot->c = c;
    slot->received_at = received_at;
    while (!PostMessageA(g_ddraw.hwnd, NH_WM_INPUT, ticket, 0))
    {
        DWORD reason = GetLastError();
        LeaveCriticalSection(&input_lock);
        if (!nh_connected()) return;
        if (reason != ERROR_NOT_ENOUGH_QUOTA || !IsWindow(g_ddraw.hwnd))
        {
            EnterCriticalSection(&input_lock); slot->ticket = 0; LeaveCriticalSection(&input_lock);
            error(id, "input queue delivery failed"); return;
        }
        Sleep(1);
        EnterCriticalSection(&input_lock);
    }
    InterlockedExchange(&enabled, 1);
    accepted++;
    LeaveCriticalSection(&input_lock);
}

static void input_consumed(const struct input_event *event)
{
    /* Disconnect retires request IDs. The transport checks connection ownership
     * again when space becomes available, without holding a game input lock. */
    EnterCriticalSection(&input_lock);
    int current = event->generation == input_generation;
    LeaveCriticalSection(&input_lock);
    if (current) nh_send_for_connection(event->connection_generation, NH_INPUT, event->id, NULL, 0);
}

static int belongs_to(HWND hwnd, HWND root)
{
    return hwnd && IsWindow(hwnd) && (hwnd == root || IsChild(root, hwnd));
}

static void focus_control(HWND hwnd)
{
    if (hwnd) nh_input_focus_window(hwnd);
}

static void record_dialog_target(HWND target)
{
    EnterCriticalSection(&input_lock);
    dialog_messages++;
    last_target = (uint32_t)(uintptr_t)target;
    last_target_id = (uint32_t)GetDlgCtrlID(target);
    LeaveCriticalSection(&input_lock);
}

static int route_owner_drawn_wheel(HWND root, HWND target, WPARAM wparam, LPARAM lparam, LRESULT *result)
{
    if (LOWORD(wparam) & (MK_SHIFT | MK_CONTROL)) return 0;
    char class_name[64] = {0};
    GetClassNameA(target, class_name, sizeof(class_name));
    LONG style = GetWindowLongA(target, GWL_STYLE);
    if (_stricmp(class_name, "ListBox") || (style & WS_VSCROLL) ||
        !(style & (LBS_OWNERDRAWFIXED | LBS_OWNERDRAWVARIABLE))) return 0;
    int before = (int)SendMessageA(target, LB_GETTOPINDEX, 0, 0);
    int delta = (SHORT)HIWORD(wparam), after = before, fallback = 0;
    EnterCriticalSection(&input_lock);
    if (wheel_list != target) { wheel_list = target; wheel_remainder = 0; }
    int accumulated = wheel_remainder + delta;
    int notches = accumulated / WHEEL_DELTA;
    wheel_remainder = accumulated % WHEEL_DELTA;
    LeaveCriticalSection(&input_lock);
    *result = SendMessageA(target, WM_MOUSEWHEEL, wparam, lparam);
    int current = nh_input_target_window() == root && IsWindow(target) && nh_window_owned(target) &&
        GetWindowThreadProcessId(target, NULL) == g_ddraw.gui_thread_id;
    if (current)
    {
        after = (int)SendMessageA(target, LB_GETTOPINDEX, 0, 0);
        /* Legacy owner-drawn lists without WS_VSCROLL can keep their displayed
         * top index outside USER32. A stock wheel changes USER32's private index,
         * which their original painter never reads. Keep the real wheel first;
         * only its unchanged published index needs the original list setter. */
        if (before >= 0 && after == before && notches)
        {
            int count = (int)SendMessageA(target, LB_GETCOUNT, 0, 0);
            UINT lines = 3;
            SystemParametersInfoA(SPI_GETWHEELSCROLLLINES, 0, &lines, 0);
            if (lines == WHEEL_PAGESCROLL)
            {
                RECT client = {0};
                int height = (int)SendMessageA(target, LB_GETITEMHEIGHT, before, 0);
                GetClientRect(target, &client);
                lines = height > 0 ? max(1, client.bottom / height) : 1;
            }
            if (count > 0 && lines)
            {
                int64_t next = (int64_t)before - (int64_t)notches * min(lines, (UINT)count);
                next = max(0, min(next, count - 1));
                if (next != before)
                {
                    /* The original procedure owns range clamping, scrollbar
                     * synchronization and invalidation. Selection is untouched. */
                    SendMessageA(target, LB_SETTOPINDEX, (WPARAM)next, 0);
                    after = (int)SendMessageA(target, LB_GETTOPINDEX, 0, 0);
                    fallback = after != before;
                }
            }
        }
    }
    EnterCriticalSection(&input_lock);
    if (!current || after == -1)
    { wheel_list = NULL; wheel_remainder = 0; after = -1; }
    owner_drawn_wheels++; owner_drawn_wheel_fallbacks += fallback;
    last_wheel_target = (uint32_t)(uintptr_t)target;
    last_wheel_delta = delta; last_wheel_top_before = before; last_wheel_top_after = after;
    LeaveCriticalSection(&input_lock);
    return 1;
}

static LRESULT route_message(HWND main, UINT message, WPARAM wparam, LPARAM lparam)
{
    HWND root = nh_input_target_window();
    int release = message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP;
    HWND pressed = (HWND)virtual_capture.target, pressed_root = (HWND)virtual_capture.root;
    HWND native_capture = nh_hidden_get_capture();
    int pressed_valid = pressed && IsWindow(pressed) && IsWindow(pressed_root) &&
        nh_window_owned(pressed) && GetWindowThreadProcessId(pressed, NULL) == g_ddraw.gui_thread_id &&
        (belongs_to(pressed, pressed_root) || popup_for(pressed, pressed_root));
    int native_capture_valid = native_capture &&
        (belongs_to(native_capture, pressed_root) || popup_for(native_capture, pressed_root)) &&
        GetWindowThreadProcessId(native_capture, NULL) == g_ddraw.gui_thread_id &&
        nh_hidden_visible(native_capture) && IsWindowEnabled(native_capture);
    struct nh_input_release captured_release = nh_input_capture_release(&virtual_capture, release,
        (uintptr_t)root, !root || root == main, pressed_valid, (uintptr_t)native_capture, native_capture_valid);
    if (captured_release.route != NH_RELEASE_CURRENT)
    {
        /* Clear before a callback: a nested handler may establish a new press.
         * A destroyed old target must not release onto the newly exposed page. */
        nh_input_capture_clear(&virtual_capture);
        if (captured_release.route == NH_RELEASE_CONSUMED)
        {
            EnterCriticalSection(&input_lock); consumed_captured_releases++; LeaveCriticalSection(&input_lock);
            return 0;
        }
        HWND target = (HWND)captured_release.target;
        POINT local = game_to_screen((SHORT)LOWORD(lparam), (SHORT)HIWORD(lparam));
        ScreenToClient(target, &local);
        EnterCriticalSection(&input_lock); redirected_captured_releases++; LeaveCriticalSection(&input_lock);
        record_dialog_target(target);
        return SendMessageA(target, message, wparam, MAKELPARAM(local.x, local.y));
    }
    /* Preserve the battle path: its original WndProc consumes logical coordinates
     * directly, bypassing cnc-ddraw's physical scaling and cursor locking. */
    if (!root || root == main)
    {
        nh_input_capture_main_route(&virtual_capture, release);
        return CallWindowProcA(g_ddraw.wndproc, main, message, wparam, lparam);
    }
    HWND target = root;
    if (message >= WM_MOUSEMOVE && message <= WM_MOUSEHWHEEL)
    {
        POINT screen = game_to_screen((SHORT)LOWORD(lparam), (SHORT)HIWORD(lparam));
        struct popup_context popup = {root, NULL, screen};
        EnumWindows(find_popup_at, (LPARAM)&popup);
        HWND game_capture = nh_hidden_get_capture();
        int captured = (belongs_to(game_capture, root) || popup_for(game_capture, root)) &&
            GetWindowThreadProcessId(game_capture, NULL) == g_ddraw.gui_thread_id &&
            nh_hidden_visible(game_capture) && IsWindowEnabled(game_capture);
        /* The game can capture a newly created popup while handling the press
         * on its owner. Its real capture takes precedence over the agent's
         * press target, including clicks outside the popup used to dismiss it. */
        target = captured ? game_capture :
            belongs_to((HWND)virtual_capture.target, root) || popup_for((HWND)virtual_capture.target, root) ? (HWND)virtual_capture.target :
            popup.target ? popup.target : window_at(root, screen);
        if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN)
        {
            nh_input_capture_begin(&virtual_capture, (uintptr_t)target, (uintptr_t)root);
            /* Capture does not imply focus. The popup's owner must retain the
             * focus selected by the game's original handlers. */
            if (!captured) focus_control(target);
        }
        POINT local = screen;
        if (message != WM_MOUSEWHEEL && message != WM_MOUSEHWHEEL) ScreenToClient(target, &local);
        lparam = MAKELPARAM(local.x, local.y);
    }
    else
    {
        if ((!belongs_to(virtual_focus, root) && !popup_for(virtual_focus, root)) || !IsWindowEnabled(virtual_focus)) virtual_focus = root;
        target = virtual_focus;
        if (message == WM_KEYDOWN && wparam == VK_TAB)
        {
            HWND next = GetNextDlgTabItem(root, target == root ? NULL : target,
                !!(InterlockedCompareExchange(&key_state[VK_SHIFT], 0, 0) & 0x8000));
            if (next) focus_control(next);
            record_dialog_target(next ? next : root);
            return 0;
        }
        int shortcut = (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_CHAR) &&
            (wparam == VK_RETURN || wparam == VK_ESCAPE);
        MSG msg = {target, message, wparam, lparam, GetTickCount(), {0, 0}};
        int control_wants_all_keys = target != root &&
            (SendMessageA(target, WM_GETDLGCODE, wparam, (LPARAM)&msg) & DLGC_WANTALLKEYS);
        int control_shortcut = shortcut && control_wants_all_keys;
        if (message == WM_KEYDOWN && shortcut && !control_shortcut)
        {
            LRESULT default_id = SendMessageA(root, DM_GETDEFID, 0, 0);
            int id = wparam == VK_ESCAPE ? IDCANCEL : HIWORD(default_id) == DC_HASDEFID ? LOWORD(default_id) : IDOK;
            HWND button = GetDlgItem(root, id);
            if (button && IsWindowEnabled(button) && nh_hidden_visible(button))
            {
                record_dialog_target(button);
                SendMessageA(button, BM_CLICK, 0, 0);
                return 0;
            }
        }
        /* IsDialogMessage consumes Return/Escape even when there is no real
         * default/cancel control and merely sends an unhandled IDOK/IDCANCEL.
         * Leave unmatched shortcuts to the original game/control handlers. */
        /* The page already supplies WM_CHAR. A control claiming all keys
         * owns its key/character handling; IsDialogMessage would translate
         * its keydown again and insert a second character. Tab navigation
         * above and ordinary dialog defaults keep their existing route. */
        if (!shortcut && !control_wants_all_keys && IsDialogMessageA(root, &msg))
        { record_dialog_target(target); return 0; }
        /* An open Combo popup can claim Return/Escape before dialog defaults.
         * Unclaimed shortcuts belong to the original dialog handler, rather
         * than disappearing into a focused ordinary button's default proc. */
        if (shortcut && !control_shortcut) target = root;
    }
    if (release) nh_input_capture_clear(&virtual_capture);
    record_dialog_target(target);
    LRESULT wheel_result;
    if (message == WM_MOUSEWHEEL && route_owner_drawn_wheel(root, target, wparam, lparam, &wheel_result))
        return wheel_result;
    LRESULT result = SendMessageA(target, message, wparam, lparam);
    return result;
}

int nh_input_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam, LRESULT *result)
{
    if (!NH_ENABLE_INPUT) return 0;
    (void)lparam;
    if (message != NH_WM_INPUT) return 0;
    *result = 0;
    if (InterlockedCompareExchange(&initialized, 0, 0) != 2 || !nh_input_active()) return 1;
    EnterCriticalSection(&input_lock);
    struct input_event *slot = &queue[(uint32_t)wparam % INPUT_QUEUE_SIZE];
    if (slot->ticket != (uint32_t)wparam)
    {
        LeaveCriticalSection(&input_lock); return 1;
    }
    struct input_event event = *slot;
    slot->ticket = 0;
    last_delivery_queue_us = elapsed_us(event.received_at);
    if (last_delivery_queue_us > max_delivery_queue_us) max_delivery_queue_us = last_delivery_queue_us;
    LeaveCriticalSection(&input_lock);
    if (event.kind == 2)
    {
        LONG previous = InterlockedCompareExchange(&key_state[event.a], 0, 0);
        LONG toggle = previous & 1;
        if (event.b && !(previous & 0x8000))
        {
            InterlockedExchange(&key_pressed[event.a], 1);
            if (event.a == VK_CAPITAL || event.a == VK_NUMLOCK || event.a == VK_SCROLL) toggle ^= 1;
        }
        InterlockedExchange(&key_state[event.a], (event.b ? 0x8000 : 0) | toggle);
    }
    else if (event.kind == 3) nh_input_set_cursor((int)event.a, (int)event.b);
    else if (event.a >= WM_MOUSEMOVE && event.a <= WM_MOUSEHWHEEL)
        nh_input_set_cursor((SHORT)LOWORD(event.c), (SHORT)HIWORD(event.c));
    /* A native handler can enter a nested modal loop or run its own animation.
     * Consumption and cursor/key state precede ACK; callback return does not.
     * This bounds queued tickets while allowing the next real release to reach
     * the modal loop instead of waiting for that loop to finish. */
    input_consumed(&event);
    if (!activated)
    {
        activated = 1;
        /* Drop a preexisting physical capture without warping the OS pointer. */
        real_ClipCursor(NULL);
        ReleaseCapture();
        g_mouse_locked = FALSE;
        /* Virtual focus belongs to this authenticated client. This notification
         * changes the game's focus state without selecting an OS window. */
        CallWindowProcA(g_ddraw.wndproc, hwnd, WM_ACTIVATEAPP, TRUE, GetCurrentThreadId());
        CallWindowProcA(g_ddraw.wndproc, hwnd, WM_ACTIVATE, WA_ACTIVE, 0);
    }
    if (event.kind == 1)
    {
        LARGE_INTEGER handler_at;
        QueryPerformanceCounter(&handler_at);
        *result = route_message(hwnd, event.a, event.b, (LPARAM)event.c);
        EnterCriticalSection(&input_lock);
        last_handler_us = elapsed_us(handler_at);
        if (last_handler_us > max_handler_us) max_handler_us = last_handler_us;
        delivered++; last_message = event.a;
        if (event.a >= WM_KEYDOWN && event.a <= WM_SYSDEADCHAR)
        { last_key_message = event.a; last_key = event.b & 255; }
        LeaveCriticalSection(&input_lock);
    }
    return 1;
}

void nh_input_disconnect(void)
{
    InterlockedExchange(&enabled, 0);
    if (InterlockedCompareExchange(&initialized, 0, 0) != 2) return;
    EnterCriticalSection(&input_lock);
    input_generation++;
    memset(queue, 0, sizeof(queue)); activated = 0; nh_input_capture_clear(&virtual_capture);
    wheel_list = NULL; wheel_remainder = 0;
    /* Hidden logical focus belongs to the game lifetime, not the client.
     * Clearing it without WM_KILLFOCUS would desynchronize native controls. */
    if (!nh_hidden_active()) { virtual_focus = NULL; focus_known = 0; }
    memset((void *)key_state, 0, sizeof(key_state)); memset((void *)key_pressed, 0, sizeof(key_pressed));
    LeaveCriticalSection(&input_lock);
}

/* cnc-ddraw deliberately omits its own DLL when patching the game's IAT. */
static HWND virtual_window(HWND physical)
{
    if (!nh_input_active()) return physical;
    if (focus_known && !virtual_focus) return NULL;
    HWND root = nh_input_target_window();
    if ((belongs_to(virtual_focus, root) || popup_for(virtual_focus, root)) && IsWindowEnabled(virtual_focus)) return virtual_focus;
    if (focus_known) return NULL;
    return belongs_to(physical, root) || popup_for(physical, root) ? physical : root;
}

HWND WINAPI nh_input_get_focus(void) { return virtual_window(GetFocus()); }
HWND WINAPI nh_input_get_active_window(void) { return nh_input_active() ? nh_input_target_window() : GetActiveWindow(); }
