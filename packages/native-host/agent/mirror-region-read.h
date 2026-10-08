#ifndef NATIVE_HOST_MIRROR_REGION_READ_H
#define NATIVE_HOST_MIRROR_REGION_READ_H
#include <stdint.h>

/* A region query validates every byte in its returned interval. Reuse only that
 * metadata within one capture boundary, never page contents or read success.
 * Every copy still uses the caller's exact protected kernel read. */
struct nh_read_region { uint64_t base, end; int readable; };
struct nh_read_region_cursor { struct nh_read_region region; };
static inline void nh_read_region_clear(struct nh_read_region_cursor *cursor) {
    cursor->region.base = cursor->region.end = 0;
    cursor->region.readable = 0;
}
static inline int nh_read_region_copy(struct nh_read_region_cursor *cursor,
    uint32_t address, void *out, uint32_t length,
    int (*query)(uint32_t, struct nh_read_region *),
    int (*copy_exact)(uint32_t, void *, uint32_t)) {
    uint64_t at = address, end = at + length;
    if (!length) return 1;
    if (!address || !out || length > NH_MAX_MESSAGE || end > UINT64_C(0x100000000)) {
        nh_read_region_clear(cursor); return 0;
    }
    while (at < end) {
        if (!cursor->region.readable || at < cursor->region.base || at >= cursor->region.end) {
            struct nh_read_region region = {0, 0, 0};
            if (!query((uint32_t)at, &region) || !region.readable || region.base > at ||
                region.end <= at || region.end > UINT64_C(0x100000000)) {
                nh_read_region_clear(cursor); return 0;
            }
            cursor->region = region;
        }
        at = cursor->region.end < end ? cursor->region.end : end;
    }
    if (!copy_exact(address, out, length)) {
        /* Protection or allocation can change after querying. A failed/short
         * kernel read fails the entire capture and cannot validate the cache. */
        nh_read_region_clear(cursor); return 0;
    }
    return 1;
}
#endif
