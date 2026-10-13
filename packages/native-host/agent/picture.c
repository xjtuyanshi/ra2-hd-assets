#include "agent.h"
#include "hidden.h"
#include "dd.h"
#include "ddsurface.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

/* A credit grants one picture. Its exact baseline is committed only after the
 * transport sends it; early credits cannot replace a queued delta. */
static CRITICAL_SECTION picture_lock;
static volatile LONG initialized;
static volatile LONG surface_width, surface_height, surface_bpp;
static uint16_t *baseline, *pending_pixels;
static uint8_t *encoded;
static uint32_t capacity_pixels, baseline_width, baseline_height;
static uint32_t pending_width, pending_height;
static int baseline_valid, credit, in_flight;
#define NH_WM_PICTURE (WM_APP + 0x149)
static volatile LONG captures, last_encode_us, maximum_encode_us, last_encoded_bytes, last_changed_rows;

static uint32_t elapsed_us(LARGE_INTEGER start)
{
    LARGE_INTEGER now, frequency;
    if (!QueryPerformanceCounter(&now) || !QueryPerformanceFrequency(&frequency) || !frequency.QuadPart) return 0;
    return (uint32_t)((now.QuadPart - start.QuadPart) * 1000000 / frequency.QuadPart);
}

void nh_picture_diagnostics(char *json, uint32_t capacity)
{
    snprintf(json, capacity, "{\"captures\":%ld,\"lastEncodeUs\":%ld,\"maxEncodeUs\":%ld,\"lastBytes\":%ld,\"lastChangedRows\":%ld}",
        InterlockedCompareExchange(&captures, 0, 0), InterlockedCompareExchange(&last_encode_us, 0, 0),
        InterlockedCompareExchange(&maximum_encode_us, 0, 0), InterlockedCompareExchange(&last_encoded_bytes, 0, 0),
        InterlockedCompareExchange(&last_changed_rows, 0, 0));
}

static void initialize(void)
{
    if (InterlockedCompareExchange(&initialized, 1, 0) == 0)
    {
        InitializeCriticalSection(&picture_lock);
        InterlockedExchange(&initialized, 2);
    }
}

void nh_surface_info(uint32_t *width, uint32_t *height, uint32_t *bpp)
{
    *width = (uint32_t)InterlockedCompareExchange(&surface_width, 0, 0);
    *height = (uint32_t)InterlockedCompareExchange(&surface_height, 0, 0);
    *bpp = (uint32_t)InterlockedCompareExchange(&surface_bpp, 0, 0);
}

void nh_picture_credit(uint32_t id, const uint8_t *payload, uint32_t length)
{
    if (!NH_ENABLE_PICTURE)
    {
        const char *error = "picture export disabled in this diagnostic build";
        nh_send(NH_ERROR, id, error, (uint32_t)strlen(error));
        return;
    }
    uint32_t count = 0;
    if (length == 4) memcpy(&count, payload, 4);
    if (count != 1)
    {
        const char *error = "picture credit must be exactly one";
        nh_send(NH_ERROR, id, error, (uint32_t)strlen(error));
        return;
    }
    LONG bpp = InterlockedCompareExchange(&surface_bpp, 0, 0);
    if (bpp && bpp != 16)
    {
        const char *error = "native picture format unsupported; RGB565 required";
        nh_send(NH_ERROR, id, error, (uint32_t)strlen(error));
        return;
    }
    initialize();
    EnterCriticalSection(&picture_lock);
    /* Permission is coalesced, never an additional picture mailbox. A credit
     * arriving while the preceding packet is being sent requests the next
     * current picture, with its baseline committed by nh_picture_sent first. */
    credit = 1;
    LeaveCriticalSection(&picture_lock);
    /* Static menus do not present again after a credit arrives. Wake their
     * owning GUI thread instead of retaining a surface pointer on the I/O
     * thread; it captures the current primary through the same delta path. */
    if (!g_ddraw.hwnd)
    {
        EnterCriticalSection(&picture_lock);
        credit = 0;
        LeaveCriticalSection(&picture_lock);
        const char *error = "game picture thread unavailable";
        nh_send(NH_ERROR, id, error, (uint32_t)strlen(error));
        return;
    }
    if (!PostMessageA(g_ddraw.hwnd, NH_WM_PICTURE, 0, 0))
        SetTimer(g_ddraw.hwnd, NH_WM_PICTURE, 16, NULL);
    nh_send(NH_CREDIT, id, NULL, 0);
}

int nh_picture_message(HWND window, UINT message, WPARAM wparam)
{
    if (!NH_ENABLE_PICTURE) return 0;
    if (message != NH_WM_PICTURE && !(message == WM_TIMER && wparam == NH_WM_PICTURE)) return 0;
    if (InterlockedCompareExchange(&initialized, 0, 0) != 2) return 1;
    KillTimer(window, NH_WM_PICTURE);
    dds_NativeCapturePrimary();
    int pending;
    EnterCriticalSection(&picture_lock);
    pending = credit && !in_flight && nh_connected();
    LeaveCriticalSection(&picture_lock);
    /* Surface locks can be owned while the game pumps messages. Retry on the
     * GUI timer without blocking that owner or spinning its message pump. */
    if (pending) SetTimer(window, NH_WM_PICTURE, 16, NULL);
    return 1;
}

void nh_picture_sent(void)
{
    if (InterlockedCompareExchange(&initialized, 0, 0) != 2) return;
    EnterCriticalSection(&picture_lock);
    if (in_flight)
    {
        uint16_t *swap = baseline;
        baseline = pending_pixels;
        pending_pixels = swap;
        baseline_width = pending_width;
        baseline_height = pending_height;
        baseline_valid = 1;
        in_flight = 0;
    }
    int pending = credit;
    LeaveCriticalSection(&picture_lock);
    if (pending && g_ddraw.hwnd) PostMessageA(g_ddraw.hwnd, NH_WM_PICTURE, 0, 0);
}

void nh_picture_disconnect(void)
{
    if (InterlockedCompareExchange(&initialized, 0, 0) != 2) return;
    EnterCriticalSection(&picture_lock);
    credit = in_flight = baseline_valid = 0;
    LeaveCriticalSection(&picture_lock);
}

static void put32(uint32_t *offset, uint32_t value)
{
    memcpy(encoded + *offset, &value, 4);
    *offset += 4;
}

static uint32_t encode_row(uint32_t offset, const uint16_t *row, uint32_t width)
{
    uint32_t x = 0;
    while (x < width)
    {
        uint32_t first = x;
        int key = row[x] == 0xf81f;
        while (x < width && x - first < 0x7fff && (row[x] == 0xf81f) == key) x++;
        uint16_t tag = (uint16_t)(x - first) | (key ? 0x8000 : 0);
        memcpy(encoded + offset, &tag, 2);
        offset += 2;
        if (!key)
        {
            memcpy(encoded + offset, row + first, (x - first) * 2);
            offset += (x - first) * 2;
        }
    }
    return offset;
}

void nh_present(const void *pixels, uint32_t width, uint32_t height, uint32_t pitch, uint32_t bpp)
{
    if (!NH_ENABLE_PICTURE) return;
    InterlockedExchange(&surface_width, (LONG)width);
    InterlockedExchange(&surface_height, (LONG)height);
    InterlockedExchange(&surface_bpp, (LONG)bpp);
    /* Forced native paint callbacks may present intermediate background-only
     * primaries before their control pass commits. Publish the completed
     * current primary after that pass, retaining all native dialog controls. */
    if (nh_hidden_painting() || !nh_connected() || !pixels || bpp != 16 || !width || !height || width > 4096 || height > 4096 ||
        pitch < width * 2 || (uint64_t)width * height > NH_MAX_PICTURE_PIXELS ||
        InterlockedCompareExchange(&initialized, 0, 0) != 2 || !TryEnterCriticalSection(&picture_lock)) return;
    if (!credit || in_flight)
    {
        LeaveCriticalSection(&picture_lock);
        return;
    }
    LARGE_INTEGER encoding_start;
    QueryPerformanceCounter(&encoding_start);
    uint32_t pixels_count = width * height;
    /* Worst alternating literal/key pixels cost three bytes per pixel; the
     * conservative four-byte bound also includes segment and row headers. */
    if ((uint64_t)pixels_count * 4 + (uint64_t)height * 8 + 16 > NH_MAX_MESSAGE)
    {
        credit = 0;
        LeaveCriticalSection(&picture_lock);
        const char *error = "native picture exceeds bounded message size";
        nh_send(NH_ERROR, 0, error, (uint32_t)strlen(error));
        return;
    }
    if (capacity_pixels < pixels_count)
    {
        uint16_t *a = malloc(pixels_count * 2), *b = malloc(pixels_count * 2);
        if (!a || !b)
        {
            free(a); free(b);
            LeaveCriticalSection(&picture_lock);
            return;
        }
        free(baseline); free(pending_pixels);
        baseline = a; pending_pixels = b; capacity_pixels = pixels_count; baseline_valid = 0;
    }
    if (!encoded) encoded = malloc(NH_MAX_MESSAGE);
    if (!encoded)
    {
        LeaveCriticalSection(&picture_lock);
        return;
    }
    uint32_t offset = 0, rows = 0;
    put32(&offset, nh_current_frame());
    put32(&offset, width); put32(&offset, height); put32(&offset, 0);
    int full = !baseline_valid || baseline_width != width || baseline_height != height;
    for (uint32_t y = 0; y < height; y++)
    {
        const uint16_t *source = (const uint16_t *)((const uint8_t *)pixels + y * pitch);
        uint16_t *target = pending_pixels + y * width;
        memcpy(target, source, width * 2);
        if (!full && memcmp(target, baseline + y * width, width * 2) == 0) continue;
        put32(&offset, y);
        uint32_t length_at = offset;
        put32(&offset, 0);
        uint32_t row_start = offset;
        offset = encode_row(offset, target, width);
        uint32_t row_length = offset - row_start;
        memcpy(encoded + length_at, &row_length, 4);
        rows++;
    }
    memcpy(encoded + 12, &rows, 4);
    uint32_t duration = elapsed_us(encoding_start);
    InterlockedIncrement(&captures);
    InterlockedExchange(&last_encode_us, (LONG)duration);
    if (duration > (uint32_t)InterlockedCompareExchange(&maximum_encode_us, 0, 0)) InterlockedExchange(&maximum_encode_us, (LONG)duration);
    InterlockedExchange(&last_encoded_bytes, (LONG)offset);
    InterlockedExchange(&last_changed_rows, (LONG)rows);
    /* Publish only accepts an empty mailbox. Setting pending first prevents the
     * send callback from observing half-built baseline metadata. */
    pending_width = width; pending_height = height; in_flight = 1;
    /* Hand off the owned encoded buffer, using the idle mailbox allocation for
     * the next encode. Full menu repaints need no second payload-sized copy. */
    if (nh_publish_move(NH_PICTURE, &encoded, offset)) credit = 0;
    else in_flight = 0;
    LeaveCriticalSection(&picture_lock);
}
