#ifndef NATIVE_HOST_DRAW_PATCH_H
#define NATIVE_HOST_DRAW_PATCH_H

#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <string.h>

struct nh_draw_patch_range { uint32_t address, length; };
struct nh_draw_suspended_threads {
    HANDLE handles[256];
    uint32_t count, suspended;
};

static void nh_draw_resume(struct nh_draw_suspended_threads *threads)
{
    for (uint32_t i = 0; i < threads->suspended; i++) ResumeThread(threads->handles[i]);
    for (uint32_t i = 0; i < threads->count; i++) CloseHandle(threads->handles[i]);
    threads->count = threads->suspended = 0;
}

/* Prepare executable storage and initialize application locks before calling.
 * Once this succeeds, the caller may only verify/write preallocated patches
 * and resume. No heap work or application locks are safe during suspension. */
static int nh_draw_suspend(struct nh_draw_suspended_threads *threads,
    const struct nh_draw_patch_range *ranges, uint32_t count)
{
    memset(threads, 0, sizeof(*threads));
    if (!ranges || !count) return 0;
    for (uint32_t i = 0; i < count; i++)
        if (!ranges[i].address || !ranges[i].length ||
            (uint64_t)ranges[i].address + ranges[i].length > 0x100000000ull) return 0;

    DWORD process = GetCurrentProcessId(), current = GetCurrentThreadId();
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    THREADENTRY32 entry;
    memset(&entry, 0, sizeof(entry)); entry.dwSize = sizeof(entry);
    if (!Thread32First(snapshot, &entry)) { CloseHandle(snapshot); return 0; }
    do {
        if (entry.th32OwnerProcessID != process || entry.th32ThreadID == current) continue;
        if (threads->count == 256u) { CloseHandle(snapshot); nh_draw_resume(threads); return 0; }
        HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
            FALSE, entry.th32ThreadID);
        if (!thread) {
            /* A completed thread cannot execute a patch; denial remains unknown. */
            if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
            CloseHandle(snapshot); nh_draw_resume(threads); return 0;
        }
        threads->handles[threads->count++] = thread;
    } while (Thread32Next(snapshot, &entry));
    DWORD enumeration_error = GetLastError();
    CloseHandle(snapshot);
    if (enumeration_error != ERROR_NO_MORE_FILES) { nh_draw_resume(threads); return 0; }

    /* Open every handle before stopping any owner that might hold heap or
     * loader locks. Context and range checks below use stack storage only. */
    for (uint32_t i = 0; i < threads->count; i++) {
        if (SuspendThread(threads->handles[i]) == (DWORD)-1) { nh_draw_resume(threads); return 0; }
        threads->suspended++;
        CONTEXT context;
        memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
        if (!GetThreadContext(threads->handles[i], &context)) { nh_draw_resume(threads); return 0; }
        for (uint32_t j = 0; j < count; j++)
            if (context.Eip >= ranges[j].address &&
                (uint64_t)context.Eip < (uint64_t)ranges[j].address + ranges[j].length) {
                nh_draw_resume(threads); return 0;
            }
    }
    return 1;
}

#endif
