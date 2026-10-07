#ifndef NATIVE_HOST_MIRROR_INTERNAL_H
#define NATIVE_HOST_MIRROR_INTERNAL_H
#include "agent.h"
/* Bounds are protocol limits, rather than assumptions about a particular match. */
#define NH_MIRROR_MIN_BUDGET_US 100u
#define NH_MIRROR_MAX_BUDGET_US 4000u
#define NH_MIRROR_HASH_SIZE 16384u
#define NH_MIRROR_MAX_THREADS 256u
struct nh_range { uint32_t address, length; };
struct nh_rule { uint32_t kind, source, bytes, max_count, stride; };
struct nh_page { uint32_t address; uint64_t dirty; };
struct nh_subscription {
    uint32_t range_count, rule_count, max_pages, budget_us, sample_count;
    struct nh_range ranges[NH_MAX_RANGES];
    struct nh_rule rules[NH_MAX_RULES];
};
#endif
