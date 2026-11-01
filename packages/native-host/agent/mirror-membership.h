#ifndef NATIVE_HOST_MIRROR_MEMBERSHIP_H
#define NATIVE_HOST_MIRROR_MEMBERSHIP_H
#include <stdint.h>
#include <string.h>

/* Page addresses have twenty significant bits. Two stable radix passes avoid
 * a CRT comparator call for every ordering decision at each logic boundary.
 * Scratch is owned by the mirror and allocated before capture; copying whole
 * records preserves the requesting owner and pending dirty generation. */
static void nh_sort_pages(struct nh_page *pages, struct nh_page *scratch, uint32_t count) {
    uint32_t offsets[1024];
    if (count < 2) return;
    for (uint32_t shift = 12; shift <= 22; shift += 10) {
        struct nh_page *source = shift == 12 ? pages : scratch;
        struct nh_page *target = shift == 12 ? scratch : pages;
        uint32_t total = 0;
        memset(offsets, 0, sizeof(offsets));
        for (uint32_t i = 0; i < count; ++i)
            ++offsets[(source[i].address >> shift) & 1023u];
        for (uint32_t i = 0; i < 1024; ++i) {
            uint32_t size = offsets[i];
            offsets[i] = total; total += size;
        }
        for (uint32_t i = 0; i < count; ++i)
            target[offsets[(source[i].address >> shift) & 1023u]++] = source[i];
    }
}

/* Both page lists are sorted and unique. Return removed membership separately
 * from new-page indices, so one short-lived allocation cannot force a full map
 * reset. The original comparison image remains authoritative until publish. */
static uint32_t nh_merge_membership(const struct nh_page *next, uint32_t next_count,
    const struct nh_page *previous, uint32_t previous_count,
    uint32_t *old_indices, uint32_t *removed, int *changed) {
    uint32_t old = 0, gone = 0;
    *changed = 0;
    for (uint32_t i = 0; i < next_count; ++i) {
        while (old < previous_count && previous[old].address < next[i].address) {
            removed[gone++] = previous[old++].address; *changed = 1;
        }
        if (old < previous_count && previous[old].address == next[i].address)
            old_indices[i] = old++;
        else { old_indices[i] = UINT32_MAX; *changed = 1; }
    }
    while (old < previous_count) { removed[gone++] = previous[old++].address; *changed = 1; }
    return gone;
}
#endif
