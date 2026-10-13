#include "agent.h"
#include "draw-surface.h"
#include "config.h"
#include "ddsurface.h"
#include <string.h>

static int readable_pixels(const void *pixels, uint32_t length)
{
    uint64_t cursor = (uintptr_t)pixels, end = cursor + length;
    if (!cursor || end > 0x100000000ull) return 0;
    while (cursor < end) {
        MEMORY_BASIC_INFORMATION region;
        if (!VirtualQuery((const void *)(uintptr_t)cursor, &region, sizeof(region))) return 0;
        DWORD protection = region.Protect & 0xffu;
        if (region.State != MEM_COMMIT || (region.Protect & PAGE_GUARD) ||
            !protection || protection == PAGE_NOACCESS || protection == PAGE_EXECUTE) return 0;
        uint64_t next = (uint64_t)(uintptr_t)region.BaseAddress + region.RegionSize;
        if (next <= cursor) return 0;
        cursor = next;
    }
    return 1;
}

int nh_draw_surface_view(uint32_t native_surface, struct nh_draw_surface_view *out)
{
    IDirectDrawSurfaceImpl snapshot;
    if (!out) return 0;
    memset(out, 0, sizeof(*out));
    /* Surface lifetimes belong to the game thread. Never resolve a retained
     * game pointer on the transport thread, even if its pages remain mapped. */
    if (!native_surface || (native_surface & 3u) ||
        GetCurrentThreadId() != nh_game_thread_id() ||
        !nh_safe_read(native_surface, &snapshot, sizeof(snapshot)) ||
        snapshot.lpVtbl != &g_dds_vtbl || !snapshot.ref ||
        !snapshot.width || !snapshot.height || snapshot.width > 4096u || snapshot.height > 4096u ||
        (snapshot.bpp != 8u && snapshot.bpp != 16u && snapshot.bpp != 24u && snapshot.bpp != 32u) ||
        snapshot.bytes_pp != snapshot.bpp / 8u ||
        snapshot.pitch < snapshot.width * snapshot.bytes_pp) return 0;

    uint64_t bytes = (uint64_t)snapshot.pitch * snapshot.height;
    if (bytes > NH_MAX_MESSAGE || bytes > snapshot.size) return 0;
    /* dds_GetBuffer only reads the surface pointer (atomically for flipping
     * surfaces); unlike Lock, it cannot dispatch window messages or draw. */
    const uint8_t *pixels = dds_GetBuffer((IDirectDrawSurfaceImpl *)(uintptr_t)native_surface);
    if (pixels != snapshot.surface || !readable_pixels(pixels, (uint32_t)bytes)) return 0;
    out->pixels = pixels;
    out->width = snapshot.width;
    out->height = snapshot.height;
    out->pitch = snapshot.pitch;
    out->bpp = snapshot.bpp == 16u && g_config.rgb555 ? 15u : snapshot.bpp;
    return 1;
}
