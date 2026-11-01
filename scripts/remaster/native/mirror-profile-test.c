/* Asset-free Windows console regression for diagnostic sampling and ownership. */
#include "mirror-profile.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static DWORD WINAPI other_thread(void *unused) {
    (void)unused;
    for (unsigned i = 0; i < 1000; ++i) {
        nh_profile_count(NH_PROFILE_QUERY, 4096);
        assert(!nh_profile_before());
    }
    return 0;
}
int main(int argc, char **argv) {
    char json[1600];
    int mode = argc > 1 ? atoi(argv[1]) : 0;
    assert(mode >= 0 && mode <= 2);
    SetEnvironmentVariableA("RA2_NATIVE_CAPTURE_PROFILE", mode == 1 ? "1" : mode == 2 ? "2" : "");
    nh_profile_init();
    assert(nh_profile_mode == mode);
    for (unsigned i = 0; i < 130; ++i) {
        nh_profile_begin(GetCurrentThreadId());
        nh_profile_count(NH_PROFILE_QUERY, 0);
        nh_profile_count(NH_PROFILE_QPC, 0);
        if (i == 0 && mode) {
            HANDLE thread = CreateThread(NULL, 0, other_thread, NULL, 0, NULL);
            assert(thread && WaitForSingleObject(thread, 10000) == WAIT_OBJECT_0);
            CloseHandle(thread);
        }
        nh_profile_phase(1);
        LONGLONG before = nh_profile_before();
        SetLastError(12345);
        nh_profile_after(NH_PROFILE_READ, 4096, before);
        assert(GetLastError() == 12345);
        nh_profile_phase(2); nh_profile_phase(3);
        nh_profile_end(i != 64);
        assert(!nh_profile_active);
    }
    unsigned expected = mode ? 3 : 0;
    assert(nh_profile_calls[0][NH_PROFILE_QUERY] == expected);
    assert(nh_profile_calls[0][NH_PROFILE_QPC] == expected);
    assert(nh_profile_calls[1][NH_PROFILE_READ] == expected);
    assert(nh_profile_bytes[1][NH_PROFILE_READ] == expected * 4096u);
    assert(mode == 2 ? nh_profile_ticks[1][NH_PROFILE_READ] > 0 : nh_profile_ticks[1][NH_PROFILE_READ] == 0);
    nh_profile_json(json, sizeof(json));
    assert(strstr(json, mode ? "\"samples\":3" : "\"samples\":0"));
    assert(strstr(json, mode ? "\"nonFaulted\":2" : "\"nonFaulted\":0"));
    assert(json[strlen(json) - 1] == '}');
    puts(json);
    return 0;
}
