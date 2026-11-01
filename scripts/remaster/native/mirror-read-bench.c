/* Asset-free, 32-bit Windows console benchmark. It creates no windows and reads
 * only its own allocations. Batch timing keeps the QPC instrumentation cost out
 * of individual read measurements. Build with the native agent's MinGW flags. */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NH_PAGE_SIZE 4096u
#include "mirror-page-equal.h"

static LARGE_INTEGER frequency;
static volatile unsigned checksum;
static uint8_t *source, *destination;
static const uint32_t allocation_bytes = 4096u * 3072u;
static int sse2;

static double ticks_us(LONGLONG ticks) {
    return (double)ticks * 1000000.0 / (double)frequency.QuadPart;
}

static void measure(const char *label, unsigned kind, uint32_t bytes, uint32_t iterations, int scatter) {
    LARGE_INTEGER start, finish;
    unsigned failures = 0;
    QueryPerformanceCounter(&start);
    for (uint32_t i = 0; i < iterations; ++i) {
        uint8_t *at = source + (scatter ? ((i * 997u) % 2900u) * NH_PAGE_SIZE : 0);
        SIZE_T copied = 0;
        MEMORY_BASIC_INFORMATION info;
        LARGE_INTEGER now;
        switch (kind) {
        case 0: checksum += i & 1; break;
        case 1: if (!QueryPerformanceCounter(&now)) ++failures; checksum += (unsigned)now.QuadPart & 1; break;
        case 2: if (!VirtualQuery(at, &info, sizeof(info))) ++failures; checksum += info.State; break;
        case 3: if (!ReadProcessMemory(GetCurrentProcess(), at, destination, bytes, &copied) || copied != bytes) ++failures;
            checksum += destination[bytes - 1]; break;
        case 4: memcpy(destination, at, bytes); checksum += destination[bytes - 1]; break;
        case 5: checksum += !memcmp(at, destination, bytes); break;
        case 6: checksum += nh_page_bytes_equal(at, destination, sse2); break;
        case 7:
            if (!VirtualQuery(at, &info, sizeof(info)) || info.State != MEM_COMMIT || (info.Protect & PAGE_GUARD) ||
                !ReadProcessMemory(GetCurrentProcess(), at, destination, bytes, &copied) || copied != bytes) ++failures;
            checksum += destination[bytes - 1]; break;
        }
    }
    QueryPerformanceCounter(&finish);
    double elapsed = ticks_us(finish.QuadPart - start.QuadPart);
    printf("{\"kind\":\"%s\",\"bytes\":%lu,\"iterations\":%lu,\"scatter\":%s,\"usPerCall\":%.6f,\"totalMs\":%.3f,\"failures\":%u}\n",
        label, (unsigned long)bytes, (unsigned long)iterations, scatter ? "true" : "false", elapsed / iterations, elapsed / 1000.0, failures);
    fflush(stdout);
    if (failures) exit(2);
}

int main(void) {
    QueryPerformanceFrequency(&frequency);
    source = VirtualAlloc(NULL, allocation_bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    destination = VirtualAlloc(NULL, 65536u, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!source || !destination) return 1;
    memset(source, 0x5a, allocation_bytes); memset(destination, 0x5a, 65536);
    sse2 = IsProcessorFeaturePresent(PF_XMMI64_INSTRUCTIONS_AVAILABLE);
    printf("{\"metadata\":true,\"pointerBytes\":%u,\"qpcFrequency\":%lld,\"sse2\":%s}\n", (unsigned)sizeof(void *), frequency.QuadPart, sse2 ? "true" : "false");
    measure("loop", 0, 0, 1000000, 0);
    measure("qpc", 1, 0, 200000, 0);
    for (unsigned repeat = 0; repeat < 5; ++repeat) {
        printf("{\"repeat\":%u}\n", repeat);
        measure("virtualQuery", 2, 0, 20000, 0);
        measure("virtualQuery", 2, 0, 20000, 1);
        measure("readProcessMemory", 3, 4, 20000, 0);
        measure("readProcessMemory", 3, 4096, 20000, 0);
        measure("readProcessMemory", 3, 4096, 20000, 1);
        measure("readProcessMemory", 3, 65536, 2000, 0);
        measure("validatedRead", 7, 4096, 20000, 1);
        measure("memcpy", 4, 4096, 20000, 1);
        measure("memcpy", 4, 65536, 2000, 0);
        measure("memcmp", 5, 4096, 20000, 1);
        measure("sse2Equal", 6, 4096, 20000, 1);
    }
    VirtualFree(source, 0, MEM_RELEASE); VirtualFree(destination, 0, MEM_RELEASE);
    fprintf(stderr, "checksum=%u\n", checksum);
    return 0;
}
