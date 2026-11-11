#ifndef NATIVE_HOST_MIRROR_BACKOFF_H
#define NATIVE_HOST_MIRROR_BACKOFF_H
#include <stdint.h>

/* A capture that misses its deadline has already spent the whole budget on the
 * game's logic thread and is discarded. Under CPU contention the next attempt
 * usually misses again, so retrying on every logic frame turns one slow capture
 * into a full budget lost per frame. After a deadline miss, skip 1, 2, 4, then at
 * most NH_CAPTURE_BACKOFF_MAX logic frames before the next full attempt; a
 * successful publication clears the backoff. The deadline itself, completeness
 * and the published images are unchanged: skipped frames publish nothing. */
#define NH_CAPTURE_BACKOFF_MAX 8u
struct nh_capture_backoff { uint32_t next, remaining; };
static inline int nh_capture_backoff_skip(struct nh_capture_backoff *backoff) {
    if (!backoff->remaining) return 0;
    --backoff->remaining;
    return 1;
}
static inline void nh_capture_backoff_missed(struct nh_capture_backoff *backoff) {
    backoff->next = !backoff->next ? 1u : backoff->next >= NH_CAPTURE_BACKOFF_MAX / 2 ? NH_CAPTURE_BACKOFF_MAX : backoff->next * 2;
    backoff->remaining = backoff->next;
}
static inline void nh_capture_backoff_clear(struct nh_capture_backoff *backoff) {
    backoff->next = backoff->remaining = 0;
}
#endif
