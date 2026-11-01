/* Optional capture diagnostics. No allocation, I/O or logging on the game
 * thread. The mirror state lock owns mutation and JSON snapshot serialization. */
#include "mirror-profile.h"
#include <stdio.h>
#include <string.h>

int nh_profile_active, nh_profile_mode;
uint32_t nh_profile_owner, nh_profile_stage;
uint64_t nh_profile_calls[4][NH_PROFILE_CALLS], nh_profile_bytes[4][NH_PROFILE_CALLS];
uint64_t nh_profile_ticks[4][NH_PROFILE_CALLS];
static uint64_t attempts, samples, completed, phase_ticks[4];
static LARGE_INTEGER phase_started, profile_frequency;

void nh_profile_init(void) {
    char value[8];
    DWORD length = GetEnvironmentVariableA("RA2_NATIVE_CAPTURE_PROFILE", value, sizeof(value));
    nh_profile_mode = length == 1 && (value[0] == '1' || value[0] == '2') ? value[0] - '0' : 0;
    QueryPerformanceFrequency(&profile_frequency);
}
void nh_profile_begin(uint32_t owner) {
    if (!nh_profile_mode) return;
    if (attempts++ % 64u) return;
    nh_profile_owner = owner; nh_profile_stage = 0; nh_profile_active = 1;
    ++samples; QueryPerformanceCounter(&phase_started);
}
void nh_profile_phase(uint32_t stage) {
    LARGE_INTEGER now;
    if (!nh_profile_active) return;
    QueryPerformanceCounter(&now);
    phase_ticks[nh_profile_stage] += (uint64_t)(now.QuadPart - phase_started.QuadPart);
    nh_profile_stage = stage; phase_started = now;
}
void nh_profile_end(int complete) {
    if (!nh_profile_active) return;
    nh_profile_phase(nh_profile_stage);
    completed += complete != 0;
    nh_profile_active = 0;
}
void nh_profile_json(char *out, uint32_t capacity) {
    uint32_t used;
    int written = snprintf(out, capacity, "{\"mode\":%d,\"stride\":64,\"intrusiveApiTimers\":%s,\"attempts\":%llu,\"samples\":%llu,\"nonFaulted\":%llu,\"stages\":[",
        nh_profile_mode, nh_profile_mode == 2 ? "true" : "false", (unsigned long long)attempts,
        (unsigned long long)samples, (unsigned long long)completed);
    if (written < 0 || (uint32_t)written >= capacity) return;
    used = (uint32_t)written;
    for (uint32_t stage = 0; stage < 4; ++stage) {
        double unit = 1000000.0 / (double)profile_frequency.QuadPart;
        written = snprintf(out + used, capacity - used,
            "%s{\"stage\":%lu,\"us\":%.3f,\"budgetQpcCalls\":%llu,\"queryCalls\":%llu,\"readCalls\":%llu,\"readBytes\":%llu,\"queryUs\":%.3f,\"readUs\":%.3f}",
            stage ? "," : "", (unsigned long)(stage + 1), phase_ticks[stage] * unit,
            (unsigned long long)nh_profile_calls[stage][NH_PROFILE_QPC],
            (unsigned long long)nh_profile_calls[stage][NH_PROFILE_QUERY],
            (unsigned long long)nh_profile_calls[stage][NH_PROFILE_READ],
            (unsigned long long)nh_profile_bytes[stage][NH_PROFILE_READ],
            nh_profile_ticks[stage][NH_PROFILE_QUERY] * unit, nh_profile_ticks[stage][NH_PROFILE_READ] * unit);
        if (written < 0 || (uint32_t)written >= capacity - used) return;
        used += (uint32_t)written;
    }
    snprintf(out + used, capacity - used, "]}");
}
