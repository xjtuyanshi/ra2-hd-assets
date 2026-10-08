#ifndef NATIVE_HOST_MIRROR_READ_CACHE_H
#define NATIVE_HOST_MIRROR_READ_CACHE_H
#include <stdint.h>
#include <string.h>

/* Scratch pages live for one logic boundary only. All cache fills retain the
 * caller's validated read operation; neither missing nor failed pages survive.
 * The caller can reuse snapshot scratch before the final sorted capture. */
struct nh_read_cache {
    uint32_t addresses[NH_MIRROR_HASH_SIZE], indices[NH_MIRROR_HASH_SIZE], count;
};
static void nh_read_cache_clear(struct nh_read_cache *cache) {
    cache->count = 0;
    memset(cache->addresses, 0xff, sizeof(cache->addresses));
}
static int nh_read_cache_copy(struct nh_read_cache *cache, uint8_t *scratch,
    uint32_t address, void *out, uint32_t length,
    int (*read_page)(uint32_t, void *, uint32_t)) {
    uint32_t offset = 0;
    if ((uint64_t)address + length > UINT64_C(0x100000000)) return 0;
    while (offset < length) {
        uint32_t at = address + offset, page = at & ~(NH_PAGE_SIZE - 1);
        uint32_t within = at - page, amount = NH_PAGE_SIZE - within;
        uint32_t slot = (page >> 12) * 2654435761u & (NH_MIRROR_HASH_SIZE - 1), index;
        while (cache->addresses[slot] != UINT32_MAX && cache->addresses[slot] != page)
            slot = (slot + 1) & (NH_MIRROR_HASH_SIZE - 1);
        if (cache->addresses[slot] == UINT32_MAX) {
            if (cache->count == NH_MAX_PAGES) return 0;
            index = cache->count;
            if (!read_page(page, scratch + index * NH_PAGE_SIZE, NH_PAGE_SIZE)) return 0;
            cache->addresses[slot] = page; cache->indices[slot] = index; ++cache->count;
        } else index = cache->indices[slot];
        if (amount > length - offset) amount = length - offset;
        memcpy((uint8_t *)out + offset, scratch + index * NH_PAGE_SIZE + within, amount);
        offset += amount;
    }
    return 1;
}
#endif
