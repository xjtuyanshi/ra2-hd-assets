/* Generic Win32 cursor extraction. The recorded HCURSOR is the game's actual
 * SetCursor result; capture never moves, shows or replaces the OS cursor. */
#include "agent.h"
#include "dd.h"
#include "hidden.h"
#include "window-target.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

enum cursor_failure {
    CURSOR_UNATTEMPTED, CURSOR_OK, CURSOR_NO_HANDLE, CURSOR_HIDDEN,
    CURSOR_ICON_INFO, CURSOR_BITMAP_INFO, CURSOR_DIMENSIONS, CURSOR_CREATE_DC,
    CURSOR_CREATE_BITMAP, CURSOR_SELECT_BITMAP, CURSOR_DRAW, CURSOR_ALLOCATE,
    CURSOR_BACKGROUND_DEPENDENT, CURSOR_CHANGED
};
static volatile LONG snapshot_failure, snapshot_attempts, snapshot_recorded_handle,
    snapshot_registered_window, snapshot_registered_handle;

/* Default control procedures can select a registered class cursor inside
 * user32 without calling the game's intercepted SetCursor import. A hidden
 * owned window never receives that physical sequence. Only when no actual
 * SetCursor call was recorded, read the cursor resource on the real virtual
 * input target's owned class chain. No system/default art is substituted. */
static HCURSOR registered_cursor(HWND *selected_window)
{
    HWND window = nh_input_cursor_window();
    for (int depth = 0; window && depth < 32; depth++)
    {
        if (!nh_window_owned(window) || !nh_hidden_visible(window) ||
            GetWindowThreadProcessId(window, NULL) != g_ddraw.gui_thread_id) return NULL;
        HCURSOR cursor = (HCURSOR)(uintptr_t)(uint32_t)GetClassLongA(window, GCL_HCURSOR);
        if (cursor) { *selected_window = window; return cursor; }
        HWND parent = GetParent(window);
        if (parent == window) return NULL;
        window = parent;
    }
    return NULL;
}

void nh_cursor_diagnostics(char *out, uint32_t capacity)
{
    static const char *failures[] = {"unattempted", "none", "noCursorHandle", "hiddenByShowCounter",
        "getIconInfoFailed", "getObjectFailed", "invalidDimensions", "createDcFailed",
        "createBitmapFailed", "selectBitmapFailed", "drawIconFailed", "allocationFailed",
        "backgroundDependentXor", "selectionChanged"};
    HWND registered_window = NULL;
    HCURSOR registered = registered_cursor(&registered_window);
    LONG failure = InterlockedCompareExchange(&snapshot_failure, 0, 0);
    snprintf(out, capacity, "{\"recordedHandle\":%u,\"recordedSelection\":%ld,\"showCount\":%ld,\"inputTarget\":%u,"
        "\"registeredTarget\":%u,\"registeredHandle\":%u,\"snapshotAttempts\":%ld,"
        "\"snapshotRecordedHandle\":%u,\"snapshotRegisteredTarget\":%u,\"snapshotRegisteredHandle\":%u,"
        "\"snapshotFailureReason\":\"%s\"}",
        (uint32_t)InterlockedCompareExchange((LONG *)&g_ddraw.old_cursor, 0, 0),
        InterlockedCompareExchange(&g_ddraw.cursor_selection_recorded, 0, 0),
        InterlockedCompareExchange((LONG *)&g_ddraw.show_cursor_count, 0, 0),
        (uint32_t)(uintptr_t)nh_input_cursor_window(), (uint32_t)(uintptr_t)registered_window,
        (uint32_t)(uintptr_t)registered, InterlockedCompareExchange(&snapshot_attempts, 0, 0),
        (uint32_t)InterlockedCompareExchange(&snapshot_recorded_handle, 0, 0),
        (uint32_t)InterlockedCompareExchange(&snapshot_registered_window, 0, 0),
        (uint32_t)InterlockedCompareExchange(&snapshot_registered_handle, 0, 0),
        failure >= CURSOR_UNATTEMPTED && failure <= CURSOR_CHANGED ? failures[failure] : "invalidDiagnostic");
}

void nh_cursor_snapshot(uint32_t id, int x, int y)
{
    HCURSOR cursor = (HCURSOR)(uintptr_t)(uint32_t)InterlockedCompareExchange((LONG *)&g_ddraw.old_cursor, 0, 0);
    InterlockedIncrement(&snapshot_attempts);
    InterlockedExchange(&snapshot_recorded_handle, (LONG)(uintptr_t)cursor);
    HWND registered_window = NULL;
    if (!cursor && !InterlockedCompareExchange(&g_ddraw.cursor_selection_recorded, 0, 0))
        cursor = registered_cursor(&registered_window);
    InterlockedExchange(&snapshot_registered_window, (LONG)(uintptr_t)registered_window);
    InterlockedExchange(&snapshot_registered_handle, registered_window ? (LONG)(uintptr_t)cursor : 0);
    uint32_t empty[7] = {0}, length = sizeof(empty);
    uint8_t *packet = NULL;
    ICONINFO icon;
    BITMAP bitmap;
    BITMAPINFO info;
    HDC black_dc = NULL, white_dc = NULL;
    HBITMAP black = NULL, white = NULL;
    HGDIOBJ black_old = NULL, white_old = NULL;
    uint8_t *black_pixels = NULL, *white_pixels = NULL;
    int width = 0, height = 0, valid = 0;
    enum cursor_failure failure = CURSOR_NO_HANDLE;
    memset(&icon, 0, sizeof(icon));
    if (!cursor) goto done;
    failure = CURSOR_HIDDEN;
    if (InterlockedCompareExchange((LONG *)&g_ddraw.show_cursor_count, 0, 0) < 0) goto done;
    failure = CURSOR_ICON_INFO;
    if (!GetIconInfo(cursor, &icon)) goto done;
    failure = CURSOR_BITMAP_INFO;
    if (!GetObjectA(icon.hbmColor ? icon.hbmColor : icon.hbmMask, sizeof(bitmap), &bitmap)) goto done;
    width = bitmap.bmWidth; height = icon.hbmColor ? bitmap.bmHeight : bitmap.bmHeight / 2;
    failure = CURSOR_DIMENSIONS;
    if (width < 1 || width > 256 || height < 1 || height > 256 || icon.xHotspot > (DWORD)width || icon.yHotspot > (DWORD)height) goto done;
    memset(&info, 0, sizeof(info));
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    black_dc = CreateCompatibleDC(NULL); white_dc = CreateCompatibleDC(NULL);
    failure = CURSOR_CREATE_DC;
    if (!black_dc || !white_dc) goto done;
    black = CreateDIBSection(black_dc, &info, DIB_RGB_COLORS, (void **)&black_pixels, NULL, 0);
    white = CreateDIBSection(white_dc, &info, DIB_RGB_COLORS, (void **)&white_pixels, NULL, 0);
    failure = CURSOR_CREATE_BITMAP;
    if (!black || !white || !black_pixels || !white_pixels) goto done;
    black_old = SelectObject(black_dc, black); white_old = SelectObject(white_dc, white);
    failure = CURSOR_SELECT_BITMAP;
    if (!black_old || black_old == HGDI_ERROR || !white_old || white_old == HGDI_ERROR) goto done;
    memset(black_pixels, 0, (size_t)width * height * 4);
    memset(white_pixels, 255, (size_t)width * height * 4);
    failure = CURSOR_DRAW;
    if (!DrawIconEx(black_dc, 0, 0, cursor, width, height, 0, NULL, DI_NORMAL) ||
        !DrawIconEx(white_dc, 0, 0, cursor, width, height, 0, NULL, DI_NORMAL)) goto done;
    GdiFlush();
    length = 28u + (uint32_t)width * height * 4;
    packet = malloc(length);
    failure = CURSOR_ALLOCATE;
    if (!packet) goto done;
    uint32_t header[7] = {(uint32_t)(uintptr_t)cursor, (uint32_t)width, (uint32_t)height,
        icon.xHotspot, icon.yHotspot, (uint32_t)x, (uint32_t)y};
    memcpy(packet, header, sizeof(header));
    failure = CURSOR_BACKGROUND_DEPENDENT;
    for (int pixel = 0; pixel < width * height; pixel++)
    {
        int maximum_difference = 0;
        for (int channel = 0; channel < 3; channel++)
        {
            int difference = (int)white_pixels[pixel * 4 + channel] - black_pixels[pixel * 4 + channel];
            /* XOR inversion depends on background and cannot be represented by RGBA. */
            if (difference < 0) goto done;
            if (difference > maximum_difference) maximum_difference = difference;
        }
        int alpha = 255 - maximum_difference;
        uint8_t *rgba = packet + 28 + pixel * 4;
        for (int channel = 0; channel < 3; channel++)
        {
            int color = alpha ? ((int)black_pixels[pixel * 4 + 2 - channel] * 255 + alpha / 2) / alpha : 0;
            rgba[channel] = (uint8_t)(color > 255 ? 255 : color);
        }
        rgba[3] = (uint8_t)alpha;
    }
    HCURSOR latest = (HCURSOR)(uintptr_t)(uint32_t)InterlockedCompareExchange((LONG *)&g_ddraw.old_cursor, 0, 0);
    HWND latest_registered_window = NULL;
    valid = (registered_window ? !latest && cursor == registered_cursor(&latest_registered_window) &&
        registered_window == latest_registered_window &&
        !InterlockedCompareExchange(&g_ddraw.cursor_selection_recorded, 0, 0) : cursor == latest) &&
        InterlockedCompareExchange((LONG *)&g_ddraw.show_cursor_count, 0, 0) >= 0;
    failure = valid ? CURSOR_OK : CURSOR_CHANGED;
done:
    InterlockedExchange(&snapshot_failure, failure);
    if (black_old && black_old != HGDI_ERROR) SelectObject(black_dc, black_old);
    if (white_old && white_old != HGDI_ERROR) SelectObject(white_dc, white_old);
    if (black) DeleteObject(black);
    if (white) DeleteObject(white);
    if (black_dc) DeleteDC(black_dc);
    if (white_dc) DeleteDC(white_dc);
    if (icon.hbmColor) DeleteObject(icon.hbmColor);
    if (icon.hbmMask) DeleteObject(icon.hbmMask);
    nh_send(NH_INPUT_STATE, id, valid ? (const void *)packet : (const void *)empty, valid ? length : sizeof(empty));
    free(packet);
}
