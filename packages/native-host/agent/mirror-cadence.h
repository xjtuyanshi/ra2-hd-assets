#ifndef NATIVE_HOST_MIRROR_CADENCE_H
#define NATIVE_HOST_MIRROR_CADENCE_H
#include <stdint.h>

/* Bound full-image work independently of reader speed. Keep every published
 * image coherent instead of reusing old cells alongside new object bytes.
 * At 16 ms logic ticks a 30 ms interval captures every other tick, with 2 ms
 * of jitter tolerance. This does not change the game's clock or hook rate. */
#define NH_CAPTURE_INTERVAL_US 30000u
struct nh_capture_cadence {
    int valid;
    int64_t started;
    uint32_t frame, revision;
};
static inline void nh_capture_cadence_clear(struct nh_capture_cadence *cadence) {
    cadence->valid = 0;
}
static inline int nh_capture_cadence_due(const struct nh_capture_cadence *cadence,
    int64_t now, int64_t frequency, uint32_t frame, uint32_t revision, int reset) {
    /* Subscription/reset/rewind barriers need their first fresh baseline
     * promptly. No deadline or window checks are bypassed by this decision. */
    if (!cadence->valid || reset || revision != cadence->revision || frame < cadence->frame || now < cadence->started)
        return 1;
    return (uint64_t)(now - cadence->started) >=
        ((uint64_t)frequency * NH_CAPTURE_INTERVAL_US + 999999u) / 1000000u;
}
static inline void nh_capture_cadence_published(struct nh_capture_cadence *cadence,
    int64_t started, uint32_t frame, uint32_t revision) {
    cadence->valid = 1; cadence->started = started;
    cadence->frame = frame; cadence->revision = revision;
}
#endif
