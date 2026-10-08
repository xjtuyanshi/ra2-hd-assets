#include "agent.h"
#include "dd.h"
#include "hook.h"
#include "mouse.h"
#include "hidden.h"
#include <stdio.h>
#include <string.h>

/* Private messages carry a bounded queue ticket, never a client-supplied pointer. */
#define NH_WM_INPUT (WM_APP + 0x148)
#define INPUT_QUEUE_SIZE 256
struct input_event { uint32_t ticket, kind, a, b, c; };
static struct input_event queue[INPUT_QUEUE_SIZE];
static CRITICAL_SECTION input_lock;
static volatile LONG initialized, enabled;
static uint32_t next_ticket, accepted, delivered, last_message, last_key_message, last_key;
static volatile LONG key_state[256], key_pressed[256], cursor_x, cursor_y;
static volatile LONG cursor_reads, key_reads, async_key_reads, cursor_writes;
static volatile LONG injected_key_reads, last_injected_key, cursor_last_read_x, cursor_last_read_y;
static int activated;
static HWND virtual_focus, virtual_capture;
static int focus_known;
static unsigned focus_depth;
static uint32_t focus_generation;
static uint32_t dialog_messages, last_target, last_target_id;

static void initialize(void)
{
    if (InterlockedCompareExchange(&initialized, 1, 0) == 0)
    {
        InitializeCriticalSection(&input_lock);
        InterlockedExchange(&initialized, 2);
    }
}

int nh_input_active(void)
{
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

static int owned_window(HWND hwnd)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return 0;
    HWND ancestor = hwnd;
    for (int depth = 0; ancestor && depth < 32; depth++)
    {
        if (ancestor == g_ddraw.hwnd) return 1;
        HWND parent = GetParent(ancestor);
        ancestor = parent ? parent : GetWindow(ancestor, GW_OWNER);
    }
    return 0;
}

static BOOL CALLBACK find_modal(HWND hwnd, LPARAM context)
{
    if (hwnd == g_ddraw.hwnd || !owned_window(hwnd) || !nh_hidden_visible(hwnd) || !IsWindowEnabled(hwnd)) return TRUE;
    char class_name[64] = {0};
    GetClassNameA(hwnd, class_name, sizeof(class_name));
    if (strcmp(class_name, "#32770") != 0) return TRUE;
    *(HWND *)context = hwnd;
    return FALSE;
}

/* Topmost enabled owned dialogs take input even while their real windows are hidden.
 * Selecting by ownership prevents another process's dialog from receiving input. */
HWND nh_input_target_window(void)
{
    HWND dialog = NULL;
    if (!g_ddraw.hwnd) return NULL;
    EnumWindows(find_modal, (LPARAM)&dialog);
    if (!dialog) EnumChildWindows(g_ddraw.hwnd, find_modal, (LPARAM)&dialog);
    return dialog ? dialog : g_ddraw.hwnd;
}

int nh_input_focus_window(HWND hwnd)
{
    DWORD gui = g_ddraw.gui_thread_id;
    if (!gui || GetCurrentThreadId() != gui ||
        (hwnd && (!owned_window(hwnd) || GetWindowThreadProcessId(hwnd, NULL) != gui))) return 0;
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
    if (previous && owned_window(previous) && GetWindowThreadProcessId(previous, NULL) == gui)
        SendMessageA(previous, WM_KILLFOCUS, (WPARAM)hwnd, 0);
    if (generation == focus_generation && virtual_focus == hwnd && hwnd &&
        g_ddraw.gui_thread_id == gui && owned_window(hwnd) && GetWindowThreadProcessId(hwnd, NULL) == gui)
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

static int popup_for(HWND hwnd, HWND root)
{
    if (!owned_window(hwnd) || !nh_hidden_visible(hwnd) || !IsWindowEnabled(hwnd)) return 0;
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
    else if (_stricmp(class_name, "ComboLBox") == 0)
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

static void input_state(uint32_t id)
{
    char json[65536], held[1024];
    HWND target = nh_input_target_window();
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
        "\"dialogMessages\":%u,\"lastTargetHwnd\":%u,\"lastTargetId\":%u,\"dialogHwnd\":%u,"
        "\"focusHwnd\":%u,\"gameCaptureHwnd\":%u,\"directInput\":\"unsupported\",\"controls\":[",
        InterlockedCompareExchange(&cursor_x, 0, 0), InterlockedCompareExchange(&cursor_y, 0, 0), held,
        InterlockedCompareExchange(&cursor_reads, 0, 0), InterlockedCompareExchange(&key_reads, 0, 0),
        InterlockedCompareExchange(&async_key_reads, 0, 0), InterlockedCompareExchange(&cursor_writes, 0, 0),
        accepted, delivered, last_message, last_key_message, last_key,
        InterlockedCompareExchange(&injected_key_reads, 0, 0), InterlockedCompareExchange(&last_injected_key, 0, 0),
        InterlockedCompareExchange(&cursor_last_read_x, 0, 0), InterlockedCompareExchange(&cursor_last_read_y, 0, 0), modal ? "true" : "false",
        dialog_messages, last_target, last_target_id, (uint32_t)(uintptr_t)(modal ? target : NULL),
        (uint32_t)(uintptr_t)nh_input_get_focus(), (uint32_t)(uintptr_t)nh_hidden_get_capture());
    LeaveCriticalSection(&input_lock);
    struct controls_context controls = {json, sizeof(json), (uint32_t)strlen(json), 0, 0, 0, target};
    if (target)
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
    initialize();
    if (type == NH_INPUT_STATE) { input_state(id); return; }
    if (type != NH_INPUT || length != 16) { error(id, "invalid input request"); return; }
    uint32_t fields[4];
    memcpy(fields, payload, 16);
    uint32_t kind = fields[0], a = fields[1], b = fields[2], c = fields[3];
    if (!g_ddraw.hwnd || !g_ddraw.wndproc) { error(id, "game window unavailable"); return; }
    if (kind < 1 || kind > 3 || (kind == 1 && !allowed_message(a)) ||
        (kind == 2 && (a > 255 || b > 1))) { error(id, "unsupported input operation"); return; }
    EnterCriticalSection(&input_lock);
    uint32_t ticket = ++next_ticket;
    if (!ticket) ticket = ++next_ticket;
    struct input_event *slot = &queue[ticket % INPUT_QUEUE_SIZE];
    if (slot->ticket)
    {
        LeaveCriticalSection(&input_lock);
        error(id, "input queue full"); return;
    }
    slot->ticket = ticket; slot->kind = kind; slot->a = a; slot->b = b; slot->c = c;
    if (!PostMessageA(g_ddraw.hwnd, NH_WM_INPUT, ticket, 0))
    {
        slot->ticket = 0;
        LeaveCriticalSection(&input_lock);
        error(id, "input queue delivery failed"); return;
    }
    InterlockedExchange(&enabled, 1);
    accepted++;
    LeaveCriticalSection(&input_lock);
    nh_send(NH_INPUT, id, NULL, 0);
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

static LRESULT route_message(HWND main, UINT message, WPARAM wparam, LPARAM lparam)
{
    HWND root = nh_input_target_window();
    /* Preserve the battle path: its original WndProc consumes logical coordinates
     * directly, bypassing cnc-ddraw's physical scaling and cursor locking. */
    if (!root || root == main)
    {
        virtual_capture = NULL;
        return CallWindowProcA(g_ddraw.wndproc, main, message, wparam, lparam);
    }
    HWND target = root;
    if (message >= WM_MOUSEMOVE && message <= WM_MOUSEHWHEEL)
    {
        int release = message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP;
        /* A captured popup may destroy itself during button-down. Delivering
         * that press's release to a newly exposed control would activate a
         * different control without a corresponding press. */
        if (release && virtual_capture && !IsWindow(virtual_capture))
        { virtual_capture = NULL; return 0; }
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
            belongs_to(virtual_capture, root) || popup_for(virtual_capture, root) ? virtual_capture :
            popup.target ? popup.target : child_at(root, screen, 0);
        if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN)
        {
            virtual_capture = target;
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
        int control_shortcut = shortcut && target != root &&
            (SendMessageA(target, WM_GETDLGCODE, wparam, (LPARAM)&msg) & DLGC_WANTALLKEYS);
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
        if (!shortcut && IsDialogMessageA(root, &msg))
        { record_dialog_target(target); return 0; }
        /* An open Combo popup can claim Return/Escape before dialog defaults.
         * Unclaimed shortcuts belong to the original dialog handler, rather
         * than disappearing into a focused ordinary button's default proc. */
        if (shortcut && !control_shortcut) target = root;
    }
    record_dialog_target(target);
    LRESULT result = SendMessageA(target, message, wparam, lparam);
    if (message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP)
        virtual_capture = NULL;
    return result;
}

int nh_input_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam, LRESULT *result)
{
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
    if (!activated)
    {
        activated = 1;
        LeaveCriticalSection(&input_lock);
        /* Drop a preexisting physical capture without warping the OS pointer. */
        real_ClipCursor(NULL);
        ReleaseCapture();
        g_mouse_locked = FALSE;
        /* Virtual focus belongs to this authenticated client. This notification
         * changes the game's focus state without selecting an OS window. */
        CallWindowProcA(g_ddraw.wndproc, hwnd, WM_ACTIVATEAPP, TRUE, GetCurrentThreadId());
        CallWindowProcA(g_ddraw.wndproc, hwnd, WM_ACTIVATE, WA_ACTIVE, 0);
    }
    else LeaveCriticalSection(&input_lock);
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
    else
    {
        if (event.a >= WM_MOUSEMOVE && event.a <= WM_MOUSEHWHEEL)
            nh_input_set_cursor((SHORT)LOWORD(event.c), (SHORT)HIWORD(event.c));
        *result = route_message(hwnd, event.a, event.b, (LPARAM)event.c);
        EnterCriticalSection(&input_lock);
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
    memset(queue, 0, sizeof(queue)); activated = 0; virtual_capture = NULL;
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
