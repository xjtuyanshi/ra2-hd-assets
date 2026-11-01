#ifndef NATIVE_HOST_MIRROR_BUDGET_H
#define NATIVE_HOST_MIRROR_BUDGET_H
#include <stdint.h>

/* This schedules clock probes, not a different deadline. Callers still check
 * immediately before protected reads and at stage/publication barriers. One
 * unit is one membership item/page, or one packed 4 KiB page, respectively. */
#define NH_BUDGET_WORK_BATCH 16u
struct nh_budget_probe { uint32_t remaining; };
static inline void nh_budget_probe_reset(struct nh_budget_probe *probe) {
    probe->remaining = 0;
}
static inline int nh_budget_probe_due(struct nh_budget_probe *probe) {
    if (!probe->remaining) {
        probe->remaining = NH_BUDGET_WORK_BATCH - 1;
        return 1;
    }
    --probe->remaining;
    return 0;
}
#endif
