#ifndef NATIVE_HOST_DRAW_SURFACE_H
#define NATIVE_HOST_DRAW_SURFACE_H

#include <stdint.h>

struct nh_draw_surface_view {
    const uint8_t *pixels;
    uint32_t width, height, pitch, bpp;
};

/* The game/GUI owner may use this borrowed view only until its next native
 * call. This performs no lock, drawing, message pumping, or lifetime transfer.
 * native_surface is this bridge's DirectDraw surface, not a game DSurface. */
int nh_draw_surface_view(uint32_t native_surface, struct nh_draw_surface_view *out);

#endif
