#ifndef NATIVE_HOST_MIRROR_PROFILE_H
#define NATIVE_HOST_MIRROR_PROFILE_H
#include <windows.h>
#include <stdint.h>

enum nh_profile_call { NH_PROFILE_QPC, NH_PROFILE_QUERY, NH_PROFILE_READ, NH_PROFILE_CALLS };
extern int nh_profile_active, nh_profile_mode;
extern uint32_t nh_profile_owner, nh_profile_stage;
extern uint64_t nh_profile_calls[4][NH_PROFILE_CALLS], nh_profile_bytes[4][NH_PROFILE_CALLS];
extern uint64_t nh_profile_ticks[4][NH_PROFILE_CALLS];

static inline int nh_profile_on_thread(void) {
    uint32_t thread;
    if (!nh_profile_active) return 0;
    __asm__ __volatile__("movl %%fs:0x24, %0" : "=r"(thread));
    return thread == nh_profile_owner;
}
static inline void nh_profile_count(enum nh_profile_call kind, uint32_t bytes) {
    if (nh_profile_on_thread()) {
        ++nh_profile_calls[nh_profile_stage][kind];
        nh_profile_bytes[nh_profile_stage][kind] += bytes;
    }
}
static inline LONGLONG nh_profile_before(void) {
    LARGE_INTEGER now;
    if (nh_profile_mode != 2 || !nh_profile_on_thread()) return 0;
    QueryPerformanceCounter(&now); return now.QuadPart;
}
static inline void nh_profile_after(enum nh_profile_call kind, uint32_t bytes, LONGLONG before) {
    if (!nh_profile_on_thread()) return;
    nh_profile_count(kind, bytes);
    if (before) {
        DWORD error = GetLastError(); LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        nh_profile_ticks[nh_profile_stage][kind] += (uint64_t)(now.QuadPart - before);
        SetLastError(error);
    }
}
void nh_profile_init(void);
void nh_profile_begin(uint32_t owner);
void nh_profile_phase(uint32_t stage);
void nh_profile_end(int complete);
void nh_profile_json(char *out, uint32_t capacity);
#endif
