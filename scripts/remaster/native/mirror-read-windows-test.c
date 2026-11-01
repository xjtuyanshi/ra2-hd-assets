/* Synthetic Windows allocation/protection races for the existing region reader.
 * No game, UI, process injection or external memory is involved. */
#include <windows.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define NH_MAX_MESSAGE (32u * 1024u * 1024u)
#include "mirror-region-read.h"

static unsigned queries, copies;
static int query(uint32_t address, struct nh_read_region *region) {
    MEMORY_BASIC_INFORMATION info;
    ++queries;
    if (!VirtualQuery((const void *)(uintptr_t)address, &info, sizeof(info))) return 0;
    DWORD protection = info.Protect & 0xffu;
    region->base = (uint64_t)(uintptr_t)info.BaseAddress;
    region->end = region->base + info.RegionSize;
    region->readable = info.State == MEM_COMMIT && !(info.Protect & PAGE_GUARD) &&
        protection && protection != PAGE_NOACCESS && protection != PAGE_EXECUTE;
    return 1;
}
static int exact_copy(uint32_t address, void *out, uint32_t length) {
    SIZE_T copied = 0; ++copies;
    return ReadProcessMemory(GetCurrentProcess(), (void *)(uintptr_t)address, out, length, &copied) && copied == length;
}
int main(void) {
    SYSTEM_INFO sys; GetSystemInfo(&sys);
    uint32_t page_size = sys.dwPageSize;
    uint8_t *page = VirtualAlloc(NULL, page_size * 2, MEM_RESERVE, PAGE_NOACCESS);
    assert(page);
    uint8_t out[4096]; DWORD old;
    struct nh_read_region_cursor cursor = {{0, 0, 0}};
    assert(!nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(!copies && !cursor.region.readable);
    assert(VirtualAlloc(page, page_size, MEM_COMMIT, PAGE_READWRITE) == page);
    memset(page, 0x5a, page_size);
    assert(VirtualProtect(page, page_size, PAGE_READWRITE | PAGE_GUARD, &old));
    assert(!nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    MEMORY_BASIC_INFORMATION info;
    assert(VirtualQuery(page, &info, sizeof(info)) && (info.Protect & PAGE_GUARD));
    assert(!copies);
    assert(VirtualProtect(page, page_size, PAGE_READWRITE, &old));
    assert(nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(out[0] == 0x5a && out[4095] == 0x5a);
    assert(VirtualProtect(page, page_size, PAGE_NOACCESS, &old));
    assert(!nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(!cursor.region.readable);
    assert(VirtualProtect(page, page_size, PAGE_READWRITE, &old));
    assert(nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(VirtualProtect(page, page_size, PAGE_READWRITE | PAGE_GUARD, &old));
    assert(!nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(!cursor.region.readable);
    assert(VirtualQuery(page, &info, sizeof(info)));
    /* RPM may consume a guard installed after metadata validation even though
     * the read fails. Record that baseline behavior instead of claiming that
     * failure alone preserves the one-shot alarm. Existing guards above must
     * still be rejected without a read or protection mutation. */
    int guard_after_race = (info.Protect & PAGE_GUARD) != 0;
    assert(VirtualProtect(page, page_size, PAGE_READWRITE, &old));
    assert(nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(VirtualFree(page, 0, MEM_RELEASE));
    assert(!nh_read_region_copy(&cursor, (uint32_t)(uintptr_t)page, out, sizeof(out), query, exact_copy));
    assert(!cursor.region.readable);
    printf("{\"reserved\":true,\"existingGuardUnchanged\":true,\"protectAfterValidationFails\":true,\"guardAfterValidationFails\":true,\"guardBitAfterRace\":%s,\"freeAfterValidationFails\":true,\"queries\":%u,\"copies\":%u}\n", guard_after_race ? "true" : "false", queries, copies);
    return 0;
}
