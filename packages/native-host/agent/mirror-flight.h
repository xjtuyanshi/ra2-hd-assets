#ifndef NATIVE_HOST_MIRROR_FLIGHT_H
#define NATIVE_HOST_MIRROR_FLIGHT_H
#include <stdint.h>
#include <string.h>

/* Ordered, accepted publications only. The wire ACK identifies a frame, so
 * revisions, resets and frame-number reuse cannot overlap older publications. */
struct nh_mirror_flight {
    uint32_t frame, revision, exclusive, acknowledged;
    uint64_t generation;
    int64_t published_ticks, acknowledged_ticks;
};
struct nh_mirror_flights {
    struct nh_mirror_flight entries[2];
    uint32_t count;
};
static inline int nh_mirror_flight_available(const struct nh_mirror_flights *flights,
    uint32_t window, uint32_t frame, uint32_t revision, int barrier) {
    if (!flights->count) return 1;
    const struct nh_mirror_flight *last = flights->entries + flights->count - 1;
    return !barrier && window == 2 && flights->count < 2 && !last->exclusive &&
        last->revision == revision && frame > last->frame;
}
static inline int nh_mirror_flight_publish(struct nh_mirror_flights *flights,
    uint32_t frame, uint32_t revision, uint64_t generation, int64_t published_ticks, int exclusive) {
    if (flights->count == 2) return 0;
    struct nh_mirror_flight *entry = flights->entries + flights->count++;
    entry->frame = frame; entry->revision = revision; entry->generation = generation;
    entry->published_ticks = published_ticks; entry->exclusive = exclusive != 0;
    entry->acknowledged = 0; entry->acknowledged_ticks = 0;
    return 1;
}
static inline uint32_t nh_mirror_flight_ack(struct nh_mirror_flights *flights,
    uint32_t frame, int64_t ack_ticks, struct nh_mirror_flight acknowledged[2],
    uint64_t *generation, int *matched) {
    uint32_t index, through = 0;
    *matched = 0;
    for (index = 0; index < flights->count; ++index)
        if (flights->entries[index].frame == frame) break;
    if (index == flights->count || flights->entries[index].acknowledged) return 0;
    flights->entries[index].acknowledged = 1;
    flights->entries[index].acknowledged_ticks = ack_ticks;
    *matched = 1; *generation = 0;
    /* A later ACK can arrive first under client backpressure. It cannot release
     * the earlier credit: a frame-number rewind could otherwise let that old
     * queued ACK acknowledge a new match's publication with the same number. */
    while (through < flights->count && flights->entries[through].acknowledged) {
        acknowledged[through] = flights->entries[through];
        if (acknowledged[through].generation > *generation) *generation = acknowledged[through].generation;
        ++through;
    }
    flights->count -= through;
    memmove(flights->entries, flights->entries + through, flights->count * sizeof(*flights->entries));
    return through;
}
#endif
