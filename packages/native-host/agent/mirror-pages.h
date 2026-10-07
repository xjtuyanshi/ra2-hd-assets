#ifndef NATIVE_HOST_MIRROR_PAGES_H
#define NATIVE_HOST_MIRROR_PAGES_H
#include <stdint.h>
#include <string.h>

/* Explicit address ranges are immutable within one subscription revision.
 * Prepare only their page membership off the logic thread; bytes and dynamic
 * follow rules still belong to each fresh frame-boundary capture. */
struct nh_page_seed {
    uint32_t count, flags;
    uint32_t pages[NH_MAX_PAGES], hash[NH_MIRROR_HASH_SIZE];
};

static void nh_page_seed_init(struct nh_page_seed *seed) {
    seed->count = seed->flags = 0;
    memset(seed->hash, 0xff, sizeof(seed->hash));
}

static void nh_page_seed_range(struct nh_page_seed *seed, uint32_t address,
    uint32_t length, uint32_t limit) {
    uint64_t end = (uint64_t)address + length;
    uint32_t page = address & ~(NH_PAGE_SIZE - 1);
    if (seed->flags || !length) return;
    if (end > UINT64_C(0x100000000)) { seed->flags = 4u; return; }
    do {
        uint32_t slot = (page >> 12) * 2654435761u & (NH_MIRROR_HASH_SIZE - 1);
        while (seed->hash[slot] != UINT32_MAX && seed->hash[slot] != page)
            slot = (slot + 1) & (NH_MIRROR_HASH_SIZE - 1);
        if (seed->hash[slot] == UINT32_MAX) {
            if (seed->count == limit) { seed->flags = 1u; return; }
            seed->hash[slot] = page;
            seed->pages[seed->count++] = page;
        }
        if ((uint64_t)page + NH_PAGE_SIZE >= end) break;
        page += NH_PAGE_SIZE;
    } while (1);
}
#endif
