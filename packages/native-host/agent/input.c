#include "agent.h"
#include "dd.h"
#include "hook.h"
#include "mouse.h"
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
    return InterlockedCompareExchange(&enabled, 0, 0) && nh_connected();
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

static BOOL CALLBACK find_modal(HWND hwnd, LPARAM context)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId() || hwnd == g_ddraw.hwnd || !IsWindowVisible(hwnd)) return TRUE;
    char class_name[64] = {0};
    GetClassNameA(hwnd, class_name, sizeof(class_name));
    if (strcmp(class_name, "#32770") != 0) return TRUE;
    HWND ancestor = hwnd;
    for (int depth = 0; ancestor && depth < 32; depth++)
    {
        if (ancestor == g_ddraw.hwnd) {*(int *)context = 1;return FALSE;}
        HWND parent = GetParent(ancestor);
        ancestor = parent ? parent : GetWindow(ancestor, GW_OWNER);
    }
    return TRUE;
}

static void input_state(uint32_t id)
{
    char json[2048], held[1024];
    int modal = 0;
    if (g_ddraw.hwnd) EnumWindows(find_modal, (LPARAM)&modal);
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
        "\"lastInjectedKey\":%ld,\"cursorLastReadX\":%ld,\"cursorLastReadY\":%ld,\"modal\":%s,\"directInput\":\"unsupported\"}",
        InterlockedCompareExchange(&cursor_x, 0, 0), InterlockedCompareExchange(&cursor_y, 0, 0), held,
        InterlockedCompareExchange(&cursor_reads, 0, 0), InterlockedCompareExchange(&key_reads, 0, 0),
        InterlockedCompareExchange(&async_key_reads, 0, 0), InterlockedCompareExchange(&cursor_writes, 0, 0),
        accepted, delivered, last_message, last_key_message, last_key,
        InterlockedCompareExchange(&injected_key_reads, 0, 0), InterlockedCompareExchange(&last_injected_key, 0, 0),
        InterlockedCompareExchange(&cursor_last_read_x, 0, 0), InterlockedCompareExchange(&cursor_last_read_y, 0, 0), modal ? "true" : "false");
    LeaveCriticalSection(&input_lock);
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
        *result = CallWindowProcA(g_ddraw.wndproc, hwnd, event.a, event.b, (LPARAM)event.c);
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
    memset(queue, 0, sizeof(queue)); activated = 0;
    memset((void *)key_state, 0, sizeof(key_state)); memset((void *)key_pressed, 0, sizeof(key_pressed));
    LeaveCriticalSection(&input_lock);
}

/* cnc-ddraw deliberately omits its own DLL when patching the game's IAT. */
static HWND virtual_window(HWND physical)
{
    if (!nh_input_active()) return physical;
    HWND ancestor = physical;
    for (int depth = 0; ancestor && depth < 32; depth++)
    {
        if (ancestor == g_ddraw.hwnd) return physical;
        HWND parent = GetParent(ancestor);
        ancestor = parent ? parent : GetWindow(ancestor, GW_OWNER);
    }
    return g_ddraw.hwnd;
}

HWND WINAPI nh_input_get_focus(void) { return virtual_window(GetFocus()); }
HWND WINAPI nh_input_get_active_window(void) { return virtual_window(GetActiveWindow()); }
