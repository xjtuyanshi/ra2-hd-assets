/* Generic Win32 cursor extraction. The recorded HCURSOR is the game's actual
 * SetCursor result; capture never moves, shows or replaces the OS cursor. */
#include "agent.h"
#include "dd.h"
#include <stdlib.h>
#include <string.h>

void nh_cursor_snapshot(uint32_t id, int x, int y)
{
    HCURSOR cursor = (HCURSOR)(uintptr_t)(uint32_t)InterlockedCompareExchange((LONG *)&g_ddraw.old_cursor, 0, 0);
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
    memset(&icon, 0, sizeof(icon));
    if (!cursor || InterlockedCompareExchange((LONG *)&g_ddraw.show_cursor_count, 0, 0) < 0 || !GetIconInfo(cursor, &icon)) goto done;
    if (!GetObjectA(icon.hbmColor ? icon.hbmColor : icon.hbmMask, sizeof(bitmap), &bitmap)) goto done;
    width = bitmap.bmWidth; height = icon.hbmColor ? bitmap.bmHeight : bitmap.bmHeight / 2;
    if (width < 1 || width > 256 || height < 1 || height > 256 || icon.xHotspot > (DWORD)width || icon.yHotspot > (DWORD)height) goto done;
    memset(&info, 0, sizeof(info));
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    black_dc = CreateCompatibleDC(NULL); white_dc = CreateCompatibleDC(NULL);
    if (!black_dc || !white_dc) goto done;
    black = CreateDIBSection(black_dc, &info, DIB_RGB_COLORS, (void **)&black_pixels, NULL, 0);
    white = CreateDIBSection(white_dc, &info, DIB_RGB_COLORS, (void **)&white_pixels, NULL, 0);
    if (!black || !white || !black_pixels || !white_pixels) goto done;
    black_old = SelectObject(black_dc, black); white_old = SelectObject(white_dc, white);
    if (!black_old || black_old == HGDI_ERROR || !white_old || white_old == HGDI_ERROR) goto done;
    memset(black_pixels, 0, (size_t)width * height * 4);
    memset(white_pixels, 255, (size_t)width * height * 4);
    if (!DrawIconEx(black_dc, 0, 0, cursor, width, height, 0, NULL, DI_NORMAL) ||
        !DrawIconEx(white_dc, 0, 0, cursor, width, height, 0, NULL, DI_NORMAL)) goto done;
    GdiFlush();
    length = 28u + (uint32_t)width * height * 4;
    packet = malloc(length);
    if (!packet) goto done;
    uint32_t header[7] = {(uint32_t)(uintptr_t)cursor, (uint32_t)width, (uint32_t)height,
        icon.xHotspot, icon.yHotspot, (uint32_t)x, (uint32_t)y};
    memcpy(packet, header, sizeof(header));
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
    valid = cursor == (HCURSOR)(uintptr_t)(uint32_t)InterlockedCompareExchange((LONG *)&g_ddraw.old_cursor, 0, 0) &&
        InterlockedCompareExchange((LONG *)&g_ddraw.show_cursor_count, 0, 0) >= 0;
done:
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
