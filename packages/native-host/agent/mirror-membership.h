#ifndef NATIVE_HOST_MIRROR_MEMBERSHIP_H
#define NATIVE_HOST_MIRROR_MEMBERSHIP_H
#include <stdint.h>

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
