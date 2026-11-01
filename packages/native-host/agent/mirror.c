/* Native host frame-boundary mirror. Game policy is restricted to the validated
 * YR 1.001 detour; subscriptions and follow rules are generic memory mechanisms. */
#include "mirror-internal.h"
#include "mirror-pages.h"
#include "mirror-page-equal.h"
#include "mirror-read-cache.h"
#include "mirror-region-read.h"
#include "mirror-membership.h"
#include "mirror-flight.h"
#include "mirror-profile.h"
#include "mirror-budget.h"
#include "x86-relative.h"
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NH_FRAME_ADDRESS 0x00a8ed84u
#define NH_SIGNATURE_ADDRESS 0x0055de73u
#define NH_HOOK_ADDRESS 0x0055de81u
#define NH_HOOK_BYTES 6u
#define NH_MIRROR_TRUNCATED 1u
#define NH_MIRROR_RESET 2u
#define NH_MIRROR_INVALID 4u
#define NH_MIRROR_REMOVED 8u
#define NH_MIRROR_REVISION 16u

static const uint8_t frame_signature[20] = {
    0x8b,0x15,0x84,0xed,0xa8,0x00,0xa1,0x84,0x77,0xb0,
    0x00,0x42,0x3b,0xc7,0x89,0x15,0x84,0xed,0xa8,0x00
};
static CRITICAL_SECTION state_lock, patch_lock;
static LONG initialized, enabled, installed;
static LARGE_INTEGER frequency;
static struct nh_subscription subscription;
static struct nh_page *shadow_pages, *capture_pages, *sort_pages;
static uint8_t *shadow_bytes, *capture_bytes, *packet;
static uint32_t shadow_count, capture_count, page_hash[NH_MIRROR_HASH_SIZE];
static uint32_t old_indices[NH_MAX_PAGES], removed_pages[NH_MAX_PAGES];
static uint32_t capture_indices[NH_MIRROR_HASH_SIZE];
static struct nh_page_seed fixed_seed, next_seed;
static uint32_t rule_items[65536];
static uint32_t rule_parent_items[65536];
static uint32_t subscription_revision, applied_revision, random_state;
static uint64_t generation;
static struct nh_mirror_flights flights;
static int reset_pending;
static int page_equal_sse2;
static uint32_t pending_flags;
static struct nh_range fixed_samples[16];
static uint32_t fixed_sample_count;
struct owned_patch { uint32_t address, length, offset; };
static struct owned_patch owned_patches[256];
static uint8_t owned_original[65536], owned_latest[65536];
static uint32_t owned_count, owned_bytes_used;
static volatile LONG teardown_failures;
/* The executable trampoline deliberately lives until process exit. A thread may
 * already be inside it when the original instruction is restored on disconnect. */
static uint8_t *trampoline;
static uint8_t detour[NH_HOOK_BYTES];
static volatile LONG logic_frames, dropped_updates, truncated_updates, invalid_updates;
static volatile LONG game_thread_id;
static uint64_t mirror_bytes, hook_us_total, hook_us_max, budget_overruns;
static volatile LONG hook_lock_skips;
static uint64_t capture_attempts, captures_produced, mirrors_published, incomplete_published;
static uint64_t in_flight_skips, publish_rejections, empty_subscription_skips, mirror_acks;
static uint64_t mailbox_skips, ack_notifications;
#define NH_TIMING_SAMPLES 32768u
static uint32_t ack_times[NH_TIMING_SAMPLES], ack_time_count, ack_time_cursor;
/* Keep the first actual fault for each incomplete publication. Stage and rule
 * metadata distinguish policy bounds from time budgets and retired heap pages. */
static uint32_t capture_stage, capture_rule = UINT32_MAX, capture_object;
static uint32_t capture_request_address, capture_request_length;
struct mirror_fault {
    uint32_t stage, rule, source, address, value, limit, reason;
    uint32_t frame, revision, range, object, request_address, request_length;
    uint32_t read_address, read_length, memory_base, memory_size;
    uint32_t memory_state, memory_protect, memory_type, read_error, retry_readable;
    uint32_t occurrences, last_frame;
};
#define NH_FAULT_HISTORY 8u
static struct mirror_fault current_fault, last_fault, fault_history[NH_FAULT_HISTORY];
static uint32_t fault_history_count, fault_history_cursor;
static uint64_t fault_count, fault_event_count;
static int previous_capture_failed;
static struct nh_read_cache read_cache;
static struct nh_read_region_cursor capture_region;
static struct nh_budget_probe membership_probe;
static LARGE_INTEGER capture_started;
static int capture_pointer_page(uint32_t address, void *out, uint32_t length);
static uint32_t hook_times[NH_TIMING_SAMPLES], hook_time_count, hook_time_cursor;
static uint64_t hook_calls;
static void fault(uint32_t reason, uint32_t address, uint32_t value, uint32_t limit) {
    if (current_fault.reason) return;
    current_fault.stage = capture_stage; current_fault.rule = capture_rule;
    current_fault.range = UINT32_MAX; current_fault.object = capture_object;
    current_fault.request_address = capture_request_address;
    current_fault.request_length = capture_request_length;
    current_fault.revision = applied_revision;
    current_fault.source = capture_rule < subscription.rule_count ? subscription.rules[capture_rule].source : 0;
    current_fault.address = address; current_fault.value = value; current_fault.limit = limit; current_fault.reason = reason;
}
static int capture_read(uint32_t address, void *out, uint32_t length) {
    SetLastError(ERROR_SUCCESS);
    if (capture_stage == 1 ? nh_read_cache_copy(&read_cache, capture_bytes, address, out, length, capture_pointer_page) :
        capture_stage == 2 ? nh_safe_read_scoped(&capture_region, address, out, length) :
        nh_safe_read(address, out, length)) return 1;
    fault(3, address, length, 0);
    current_fault.read_address = address; current_fault.read_length = length;
    current_fault.read_error = GetLastError();
    return 0;
}

static uint32_t get_u32(const uint8_t *p) {
    uint32_t n; memcpy(&n, p, sizeof(n)); return n;
}
static void put_u32(uint8_t *p, uint32_t n) { memcpy(p, &n, sizeof(n)); }
static int expired(LARGE_INTEGER start, uint32_t budget) {
    LARGE_INTEGER now; QueryPerformanceCounter(&now);
    nh_profile_count(NH_PROFILE_QPC, 0);
    return (uint64_t)(now.QuadPart - start.QuadPart) * 1000000u >=
        (uint64_t)frequency.QuadPart * budget;
}
static int membership_expired(LARGE_INTEGER start) {
    return nh_budget_probe_due(&membership_probe) && expired(start, subscription.budget_us);
}
static int capture_pointer_page(uint32_t address, void *out, uint32_t length) {
    /* Cached pointer reads may resolve many fields without a syscall. Only the
     * actual page fill needs a mandatory clock probe before its protected read. */
    if (expired(capture_started, subscription.budget_us)) {
        fault(1, address, length, subscription.budget_us); return 0;
    }
    return nh_safe_read(address, out, length);
}
static uint32_t random_u32(void) {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    random_state ^= random_state << 5;
    return random_state;
}
static int init_mirror(void) {
    LONG before = InterlockedCompareExchange(&initialized, 1, 0);
    if (before == 2) return 1;
    if (before == -1) return 0;
    if (before == 1) {
        while ((before = InterlockedCompareExchange(&initialized, 1, 1)) == 1) Sleep(0);
        return before == 2;
    }
    InitializeCriticalSection(&state_lock);
    InitializeCriticalSection(&patch_lock);
    QueryPerformanceFrequency(&frequency);
    nh_profile_init();
    page_equal_sse2 = IsProcessorFeaturePresent(PF_XMMI64_INSTRUCTIONS_AVAILABLE);
    shadow_pages = calloc(NH_MAX_PAGES, sizeof(*shadow_pages));
    capture_pages = calloc(NH_MAX_PAGES, sizeof(*capture_pages));
    sort_pages = malloc(NH_MAX_PAGES * sizeof(*sort_pages));
    shadow_bytes = malloc(NH_MAX_PAGES * NH_PAGE_SIZE);
    capture_bytes = malloc(NH_MAX_PAGES * NH_PAGE_SIZE);
    packet = malloc(NH_MAX_MESSAGE);
    random_state = GetCurrentProcessId() ^ GetTickCount() ^ 0x9e3779b9u;
    if (!random_state) random_state = 1;
    if (!frequency.QuadPart || !shadow_pages || !capture_pages || !sort_pages || !shadow_bytes || !capture_bytes || !packet) {
        InterlockedExchange(&initialized, -1);
        return 0;
    }
    reset_pending = 1;
    InterlockedExchange(&initialized, 2);
    return 1;
}
uint32_t nh_current_frame(void) {
    uint32_t frame;
    return nh_safe_read(NH_FRAME_ADDRESS, &frame, 4) ? frame : NH_NO_FRAME;
}
uint32_t nh_game_thread_id(void) { return (uint32_t)game_thread_id; }

struct suspended_threads { HANDLE handles[NH_MIRROR_MAX_THREADS]; uint32_t count, suspended; };
static void resume_threads(struct suspended_threads *threads) {
    uint32_t i;
    for (i = 0; i < threads->suspended; ++i) ResumeThread(threads->handles[i]);
    for (i = 0; i < threads->count; ++i) CloseHandle(threads->handles[i]);
    threads->count = threads->suspended = 0;
}
static int suspend_threads(struct suspended_threads *threads) {
    THREADENTRY32 entry;
    HANDLE snapshot;
    DWORD process = GetCurrentProcessId(), current = GetCurrentThreadId();
    uint32_t i;
    memset(threads, 0, sizeof(*threads));
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    entry.dwSize = sizeof(entry);
    if (Thread32First(snapshot, &entry)) do {
        if (entry.th32OwnerProcessID == process && entry.th32ThreadID != current) {
            HANDLE thread;
            if (threads->count == NH_MIRROR_MAX_THREADS) { CloseHandle(snapshot); resume_threads(threads); return 0; }
            thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID);
            if (!thread) {
                /* A disappearing thread is harmless; access denial is not. */
                if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
                CloseHandle(snapshot); resume_threads(threads); return 0;
            }
            threads->handles[threads->count++] = thread;
        }
    } while (Thread32Next(snapshot, &entry));
    CloseHandle(snapshot);
    /* Handles and all scratch storage exist before suspension. No heap work or
     * application locks are taken while another thread may hold those locks. */
    for (i = 0; i < threads->count; ++i) {
        CONTEXT context;
        if (SuspendThread(threads->handles[i]) == (DWORD)-1) { resume_threads(threads); return 0; }
        ++threads->suspended;
        memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
        if (!GetThreadContext(threads->handles[i], &context) ||
            (context.Eip > NH_HOOK_ADDRESS && context.Eip < NH_HOOK_ADDRESS + NH_HOOK_BYTES)) {
            resume_threads(threads); return 0;
        }
    }
    return 1;
}
static void emit_relative(uint8_t **p, uint8_t opcode, uint32_t origin, uintptr_t target) {
    nh_x86_relative(*p, opcode, origin, (uint32_t)target);
    *p += 5;
}
static int prepare_trampoline(void) {
    uint8_t *p;
    DWORD previous;
    static const uint8_t save[] = {
        0x9c,0x60,0xfc,               /* pushfd; pushad; cld for the C ABI */
        0x89,0xe0,                    /* mov eax,esp */
        0x81,0xec,0x20,0x02,0,0,      /* sub esp,544 */
        0x83,0xe4,0xf0,               /* and esp,-16 */
        0x89,0x84,0x24,0,0x02,0,0,    /* mov [esp+512],eax */
        0x0f,0xae,0x04,0x24           /* fxsave [esp] */
    };
    static const uint8_t restore[] = {
        0x0f,0xae,0x0c,0x24,          /* fxrstor [esp] */
        0x8b,0xa4,0x24,0,0x02,0,0,    /* mov esp,[esp+512] */
        0x61,0x9d                     /* popad; popfd */
    };
    if (trampoline) return 1;
    if (!IsProcessorFeaturePresent(PF_XMMI_INSTRUCTIONS_AVAILABLE)) return 0;
    trampoline = VirtualAlloc(NULL, NH_PAGE_SIZE, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!trampoline) return 0;
    p = trampoline;
    /* The replaced MOV has no control-flow operands. Run it first so the mirror
     * observes the incremented frame; restore CMP flags for the subsequent Jcc. */
    memcpy(p, frame_signature + 14, NH_HOOK_BYTES); p += NH_HOOK_BYTES;
    memcpy(p, save, sizeof(save)); p += sizeof(save);
    emit_relative(&p, 0xe8, (uint32_t)(uintptr_t)p, (uintptr_t)&nh_logic_tick);
    memcpy(p, restore, sizeof(restore)); p += sizeof(restore);
    emit_relative(&p, 0xe9, (uint32_t)(uintptr_t)p, NH_HOOK_ADDRESS + NH_HOOK_BYTES);
    if (!VirtualProtect(trampoline, NH_PAGE_SIZE, PAGE_EXECUTE_READ, &previous)) {
        VirtualFree(trampoline, 0, MEM_RELEASE); trampoline = NULL; return 0;
    }
    FlushInstructionCache(GetCurrentProcess(), trampoline, (SIZE_T)(p - trampoline));
    p = detour; emit_relative(&p, 0xe9, NH_HOOK_ADDRESS, (uintptr_t)trampoline); *p = 0x90;
    if (nh_x86_relative_target(detour, NH_HOOK_ADDRESS) != (uint32_t)(uintptr_t)trampoline)
        return 0;
    return 1;
}
static int switch_hook(int wanted) {
    if (!NH_ENABLE_LOGIC_HOOK) return !wanted;
    struct suspended_threads threads;
    uint8_t found[sizeof(frame_signature)];
    int result = 0;
    DWORD old;
    SIZE_T written = 0;
    const uint8_t *bytes;
    if (!init_mirror()) return 0;
    EnterCriticalSection(&patch_lock);
    if (!!installed == !!wanted) { result = 1; goto done; }
    if (wanted && (!nh_identity_verified() ||
        !nh_safe_read(NH_SIGNATURE_ADDRESS, found, sizeof(found)) ||
        memcmp(found, frame_signature, sizeof(found)) || !prepare_trampoline())) goto done;
    if (!suspend_threads(&threads)) goto done;
    bytes = wanted ? detour : frame_signature + 14;
    /* Recheck after suspension: another writer cannot silently win between
     * identity/signature validation and installation/removal. */
    if (!ReadProcessMemory(GetCurrentProcess(), (const void *)NH_HOOK_ADDRESS, found, NH_HOOK_BYTES, &written) ||
        written != NH_HOOK_BYTES || memcmp(found, wanted ? frame_signature + 14 : detour, NH_HOOK_BYTES)) {
        resume_threads(&threads); goto done;
    }
    if (VirtualProtect((void *)NH_HOOK_ADDRESS, NH_HOOK_BYTES, PAGE_EXECUTE_READWRITE, &old)) {
        written = 0;
        result = WriteProcessMemory(GetCurrentProcess(), (void *)NH_HOOK_ADDRESS, bytes, NH_HOOK_BYTES, &written) && written == NH_HOOK_BYTES;
        if (!result) {
            /* Roll back any partial write before resuming the process. */
            SIZE_T repaired = 0;
            WriteProcessMemory(GetCurrentProcess(), (void *)NH_HOOK_ADDRESS,
                wanted ? frame_signature + 14 : detour, NH_HOOK_BYTES, &repaired);
            written = 0;
        }
        if (!VirtualProtect((void *)NH_HOOK_ADDRESS, NH_HOOK_BYTES, old, &old)) result = 0;
        FlushInstructionCache(GetCurrentProcess(), (void *)NH_HOOK_ADDRESS, NH_HOOK_BYTES);
        /* State reflects the actual bytes even when restoring protection failed. */
        if (written == NH_HOOK_BYTES) InterlockedExchange(&installed, wanted);
    }
    resume_threads(&threads);
done:
    LeaveCriticalSection(&patch_lock);
    return result;
}

static int add_page(uint32_t address, uint32_t *flags) {
    uint32_t slot = (address >> 12) * 2654435761u & (NH_MIRROR_HASH_SIZE - 1);
    while (page_hash[slot] != UINT32_MAX) {
        if (page_hash[slot] == address) {
            struct nh_page *page = capture_pages + capture_indices[slot];
            /* Preserve both explicit ownership and a live follow owner when
             * they overlap. The first live rule is sufficient to locate its
             * requesting object; Core retains the full reader owner set. */
            if (page->rule == UINT32_MAX && capture_rule != UINT32_MAX) {
                page->rule = capture_rule; page->object = capture_object;
                page->request_address = capture_request_address;
                page->request_length = capture_request_length;
            }
            return 1;
        }
        slot = (slot + 1) & (NH_MIRROR_HASH_SIZE - 1);
    }
    if (capture_count == subscription.max_pages) { fault(2, address, capture_count, subscription.max_pages); *flags |= NH_MIRROR_TRUNCATED; return 0; }
    page_hash[slot] = address; capture_indices[slot] = capture_count;
    struct nh_page *page = capture_pages + capture_count++;
    page->address = address; page->rule = capture_rule; page->range = UINT32_MAX;
    page->object = capture_object; page->request_address = capture_request_address;
    page->request_length = capture_request_length;
    return 1;
}
static int add_range(uint32_t address, uint32_t length, uint32_t *flags, LARGE_INTEGER start) {
    uint64_t end = (uint64_t)address + length;
    uint32_t page = address & ~(NH_PAGE_SIZE - 1);
    capture_request_address = address; capture_request_length = length;
    if (!length) return 1;
    if (end > UINT64_C(0x100000000)) { fault(5, address, length, 0); *flags |= NH_MIRROR_INVALID; return 0; }
    do {
        if (membership_expired(start)) { fault(1, address, length, subscription.budget_us); *flags |= NH_MIRROR_TRUNCATED; return 0; }
        if (!add_page(page, flags)) return 0;
        if ((uint64_t)page + NH_PAGE_SIZE >= end) break;
        page += NH_PAGE_SIZE;
    } while (1);
    return 1;
}
static void follow_member_vector(uint32_t member, const struct nh_rule *rule, int capacity_span,
    uint32_t *flags, LARGE_INTEGER start) {
    uint8_t descriptor[20];
    uint32_t descriptor_bytes = capacity_span ? 12 : 20;
    add_range(member, descriptor_bytes, flags, start);
    if (*flags) return;
    if (!capture_read(member, descriptor, descriptor_bytes)) { *flags |= NH_MIRROR_INVALID; return; }
    uint32_t items = get_u32(descriptor + 4), count = get_u32(descriptor + (capacity_span ? 8 : 16));
    if (count > rule->max_count) { fault(4, member, count, rule->max_count); *flags |= NH_MIRROR_TRUNCATED; return; }
    if (!count) return;
    if (!items) { fault(6, member, count, 0); *flags |= NH_MIRROR_INVALID; return; }
    uint64_t span = (uint64_t)count * (capacity_span ? rule->bytes : 4);
    if (span > UINT32_MAX || (uint64_t)items + span > UINT64_C(0x100000000)) { fault(5, items, count, rule->bytes); *flags |= NH_MIRROR_INVALID; return; }
    add_range(items, (uint32_t)span, flags, start);
    if (*flags || capacity_span) return;
    if (!capture_read(items, rule_items, (uint32_t)span)) { *flags |= NH_MIRROR_INVALID; return; }
    for (uint32_t k = 0; k < count && !*flags; ++k) {
        if (membership_expired(start)) { fault(1, 0, capture_count, subscription.budget_us); *flags |= NH_MIRROR_TRUNCATED; break; }
        if (rule_items[k]) add_range(rule_items[k], rule->bytes, flags, start);
    }
}
static uint32_t resolve_union(LARGE_INTEGER start) {
    uint32_t i, flags = fixed_seed.flags;
    capture_stage = 1; capture_rule = UINT32_MAX; capture_object = 0;
    capture_request_address = capture_request_length = 0;
    capture_started = start;
    nh_budget_probe_reset(&membership_probe);
    nh_read_cache_clear(&read_cache);
    if (flags) fault(7, 0, fixed_seed.count, subscription.max_pages);
    capture_count = fixed_seed.count;
    memcpy(page_hash, fixed_seed.hash, sizeof(page_hash));
    for (i = 0; i < capture_count; ++i) {
        struct nh_page *page = capture_pages + i;
        uint32_t slot = (fixed_seed.pages[i] >> 12) * 2654435761u & (NH_MIRROR_HASH_SIZE - 1);
        while (page_hash[slot] != fixed_seed.pages[i]) slot = (slot + 1) & (NH_MIRROR_HASH_SIZE - 1);
        capture_indices[slot] = i;
        page->address = fixed_seed.pages[i]; page->rule = UINT32_MAX;
        page->range = fixed_seed.ranges[i]; page->object = 0;
        page->request_address = subscription.ranges[page->range].address;
        page->request_length = subscription.ranges[page->range].length;
    }
    for (i = 0; i < subscription.rule_count && !flags; ++i) {
        const struct nh_rule *rule = &subscription.rules[i];
        capture_rule = i; capture_object = rule->source;
        uint32_t pointer, count, j;
        if (expired(start, subscription.budget_us)) { fault(1, 0, capture_count, subscription.budget_us); flags |= NH_MIRROR_TRUNCATED; break; }
        add_range(rule->source, rule->kind == 1 ? 4 : 20, &flags, start);
        if (flags) break;
        if (rule->kind == 1) {
            if (!capture_read(rule->source, &pointer, 4)) { flags |= NH_MIRROR_INVALID; break; }
            if (pointer) { capture_object = pointer; add_range(pointer, rule->bytes, &flags, start); }
            continue;
        }
        { uint8_t descriptor[20];
          if (!capture_read(rule->source, descriptor, sizeof(descriptor))) { flags |= NH_MIRROR_INVALID; break; }
          pointer = get_u32(descriptor + 4); count = get_u32(descriptor + 16); }
        /* Negative counts become large unsigned values and fail the same bound. */
        if (count > rule->max_count) { fault(4, rule->source, count, rule->max_count); flags |= NH_MIRROR_TRUNCATED; break; }
        if (!count) continue;
        if (!pointer) { fault(6, rule->source, count, 0); flags |= NH_MIRROR_INVALID; break; }
        if (rule->kind == 3) {
            uint64_t span = (uint64_t)(count - 1) * rule->stride + rule->bytes;
            if (span > UINT32_MAX) { fault(5, pointer, count, rule->stride); flags |= NH_MIRROR_INVALID; }
            else add_range(pointer, (uint32_t)span, &flags, start);
        } else {
            uint64_t span = (uint64_t)count * 4;
            if (span > UINT32_MAX || (uint64_t)pointer + span > UINT64_C(0x100000000)) { fault(5, pointer, count, 4); flags |= NH_MIRROR_INVALID; break; }
            add_range(pointer, (uint32_t)span, &flags, start);
            uint32_t *parents = rule->kind >= 4 ? rule_parent_items : rule_items;
            if (!flags && !capture_read(pointer, parents, (uint32_t)span)) flags |= NH_MIRROR_INVALID;
            for (j = 0; j < count && !flags; ++j) {
                uint32_t item = parents[j];
                if (membership_expired(start)) { fault(1, 0, capture_count, subscription.budget_us); flags |= NH_MIRROR_TRUNCATED; break; }
                if (!item) continue;
                capture_object = item;
                if (rule->kind == 2) { add_range(item, rule->bytes, &flags, start); continue; }
                /* The caller injects a member offset; no game layout belongs
                 * here. Resolve both levels at this same logic boundary. */
                uint64_t member = (uint64_t)item + (rule->kind >= 7 ? rule->stride & 0xffffu : rule->stride);
                uint32_t member_bytes = rule->kind == 6 ? 12 : rule->kind == 4 ? 20 : 4;
                if (member + member_bytes > UINT64_C(0x100000000)) { fault(5, item, rule->stride, member_bytes); flags |= NH_MIRROR_INVALID; break; }
                add_range((uint32_t)member, member_bytes, &flags, start);
                if (flags) break;
                if (rule->kind >= 7) {
                    uint32_t target;
                    if (!capture_read((uint32_t)member, &target, 4)) { flags |= NH_MIRROR_INVALID; break; }
                    if (!target) continue;
                    member = (uint64_t)target + (rule->stride >> 16);
                    member_bytes = rule->kind == 7 ? 20 : 4;
                    if (member + member_bytes > UINT64_C(0x100000000)) { fault(5, item, rule->stride, member_bytes); flags |= NH_MIRROR_INVALID; break; }
                    add_range((uint32_t)member, member_bytes, &flags, start);
                    if (flags) break;
                }
                if (rule->kind == 5 || rule->kind == 8) {
                    uint32_t child;
                    if (!capture_read((uint32_t)member, &child, 4)) { flags |= NH_MIRROR_INVALID; break; }
                    if (child) add_range(child, rule->bytes, &flags, start);
                } else follow_member_vector((uint32_t)member, rule, rule->kind == 6, &flags, start);
            }
        }
    }
    /* A cache-fill deadline failure travels through the same failed-read
     * callers, but remains a truncation rather than an unreadable-page fault. */
    if (current_fault.reason == 1) flags = (flags & ~NH_MIRROR_INVALID) | NH_MIRROR_TRUNCATED;
    if (!flags && expired(start, subscription.budget_us)) {
        fault(1, 0, capture_count, subscription.budget_us); flags |= NH_MIRROR_TRUNCATED;
    }
    return flags;
}
/* A merged kernel copy can span unrelated owners. Diagnose its exact failed
 * page only after failure; this bounded retry never makes the failed snapshot
 * complete, even if a racing allocation is readable again. */
static void diagnose_capture_pages(uint32_t first, uint32_t count) {
    uint32_t failed = first;
    current_fault.retry_readable = 1;
    for (uint32_t i = first; i < first + count; ++i) {
        if (!nh_safe_read(capture_pages[i].address, capture_bytes + i * NH_PAGE_SIZE, NH_PAGE_SIZE)) {
            failed = i; current_fault.retry_readable = 0; break;
        }
    }
    const struct nh_page *page = capture_pages + failed;
    current_fault.address = page->address;
    current_fault.rule = page->rule; current_fault.range = page->range;
    current_fault.object = page->object;
    current_fault.source = page->rule < subscription.rule_count ? subscription.rules[page->rule].source : 0;
    current_fault.request_address = page->request_address;
    current_fault.request_length = page->request_length;
}
static void record_fault(uint32_t frame) {
    struct mirror_fault *prior = fault_history_count ?
        fault_history + (fault_history_cursor + NH_FAULT_HISTORY - 1) % NH_FAULT_HISTORY : NULL;
    MEMORY_BASIC_INFORMATION info;
    current_fault.frame = current_fault.last_frame = frame;
    current_fault.occurrences = 1;
    if (current_fault.reason == 3 && VirtualQuery((const void *)(uintptr_t)current_fault.address, &info, sizeof(info))) {
        current_fault.memory_base = (uint32_t)(uintptr_t)info.BaseAddress;
        current_fault.memory_size = (uint32_t)info.RegionSize;
        current_fault.memory_state = info.State; current_fault.memory_protect = info.Protect;
        current_fault.memory_type = info.Type;
    }
    ++fault_count;
    /* Count every failed capture, but retain one event for a consecutive fault
     * with the same owner, subscription and allocation state. No game-thread
     * logging, allocation, socket work or per-frame JSON occurs here. */
    if (previous_capture_failed && prior && prior->reason == current_fault.reason && prior->stage == current_fault.stage &&
        prior->rule == current_fault.rule && prior->range == current_fault.range &&
        prior->address == current_fault.address && prior->value == current_fault.value &&
        prior->object == current_fault.object && prior->revision == current_fault.revision &&
        prior->memory_state == current_fault.memory_state && prior->memory_protect == current_fault.memory_protect) {
        ++prior->occurrences; prior->last_frame = frame; last_fault = *prior;
    } else {
        ++fault_event_count;
        fault_history[fault_history_cursor] = current_fault;
        fault_history_cursor = (fault_history_cursor + 1) % NH_FAULT_HISTORY;
        if (fault_history_count < NH_FAULT_HISTORY) ++fault_history_count;
        last_fault = current_fault;
    }
    previous_capture_failed = 1;
}
static void publish_incomplete(uint32_t frame, uint32_t flags, LARGE_INTEGER start) {
    if (!pending_flags && current_fault.reason) record_fault(frame);
    /* One capture failure may need a later fresh budget to flush. Count the
     * cause once; repeatedly flushing the same pending flags is not a failure. */
    if (!pending_flags) {
        if (flags & NH_MIRROR_TRUNCATED) InterlockedIncrement(&truncated_updates);
        if (flags & NH_MIRROR_INVALID) InterlockedIncrement(&invalid_updates);
    }
    pending_flags |= flags;
    if (flights.count || !packet || expired(start, subscription.budget_us)) return;
    put_u32(packet, frame); put_u32(packet + 4, pending_flags);
    put_u32(packet + 8, 0); put_u32(packet + 12, 0);
    if (nh_publish_mirror(&packet, 16, start, applied_revision)) {
        LARGE_INTEGER published_at;
        QueryPerformanceCounter(&published_at);
        nh_mirror_flight_publish(&flights, frame, applied_revision, 0, published_at.QuadPart, 1);
        pending_flags = 0;
        ++incomplete_published;
        mirror_bytes += 16;
    }
}
void nh_logic_tick(void) {
    LARGE_INTEGER start, finish;
    uint32_t frame, flags, i, dirty_count = 0, sample_count = 0, length = 16, removed_count;
    int membership_changed;
    uint64_t next_generation;
    QueryPerformanceCounter(&start);
    if (!game_thread_id) {
        uint32_t teb_thread;
        /* Native gates use the x86 TEB ClientId.UniqueThread at FS:[0x24].
         * Verify it against the public API before publishing an owner ID. */
        __asm__ __volatile__("movl %%fs:0x24, %0" : "=r"(teb_thread));
        if (teb_thread == GetCurrentThreadId())
            InterlockedCompareExchange(&game_thread_id, (LONG)teb_thread, 0);
    }
    InterlockedIncrement(&logic_frames);
    nh_draw_journal_tick();
    if (!enabled || !nh_connected() || initialized != 2) return;
    if (!TryEnterCriticalSection(&state_lock)) { InterlockedIncrement(&hook_lock_skips); return; }
    frame = nh_current_frame();
    if (frame == NH_NO_FRAME || (!subscription.range_count && !subscription.rule_count)) { ++empty_subscription_skips; goto done; }
    /* A negotiated second credit overlaps transport/Worker latency, not image
     * ownership. Revision/reset/fault/frame-reuse barriers first drain the
     * exact ordered baseline; every complete publication remains immutable. */
    if (!nh_mirror_flight_available(&flights, subscription.mirror_window, frame,
            subscription_revision, pending_flags || reset_pending)) {
        ++in_flight_skips; InterlockedIncrement(&dropped_updates); goto done;
    }
    if (!nh_mirror_mailbox_available()) { ++mailbox_skips; InterlockedIncrement(&dropped_updates); goto done; }
    if (pending_flags) {
        /* A budget overrun is reported in the next fresh budget after previous
         * complete publications have drained; it never advances the shadow. */
        publish_incomplete(frame, pending_flags, start); goto done;
    }
    if (applied_revision != subscription_revision) {
        if (!subscription.page_removals) { shadow_count = 0; reset_pending = 1; }
        applied_revision = subscription_revision;
    }
    memset(&current_fault, 0, sizeof(current_fault));
    ++capture_attempts;
    nh_profile_begin((uint32_t)game_thread_id);
    flags = resolve_union(start);
    if (flags) { publish_incomplete(frame, flags, start); goto done; }
    capture_stage = 2; capture_rule = UINT32_MAX;
    nh_profile_phase(1);
    nh_read_region_clear(&capture_region);
    nh_sort_pages(capture_pages, sort_pages, capture_count);
    next_generation = generation + 1;
    removed_count = nh_merge_membership(capture_pages, capture_count, shadow_pages, shadow_count,
        old_indices, removed_pages, &membership_changed);
    if (membership_changed && !subscription.page_removals) reset_pending = 1;
    for (i = 0; i < capture_count;) {
        uint32_t run = 1, j;
        if (expired(start, subscription.budget_us)) { fault(1, 0, capture_count, subscription.budget_us); flags |= NH_MIRROR_TRUNCATED; break; }
        /* Read contiguous runs with one validated kernel copy, capped at 64 KiB
         * so both syscall count and unchecked work between budget probes stay bounded. */
        while (run < 16 && i + run < capture_count &&
            (uint64_t)capture_pages[i + run].address == (uint64_t)capture_pages[i].address + run * NH_PAGE_SIZE) ++run;
        if (!capture_read(capture_pages[i].address, capture_bytes + i * NH_PAGE_SIZE, run * NH_PAGE_SIZE)) {
            diagnose_capture_pages(i, run);
            flags |= NH_MIRROR_INVALID; break;
        }
        for (j = i; j < i + run; ++j) {
            uint32_t old = old_indices[j];
            if (reset_pending || old == UINT32_MAX ||
                !nh_page_bytes_equal(capture_bytes + j * NH_PAGE_SIZE, shadow_bytes + old * NH_PAGE_SIZE, page_equal_sse2))
                capture_pages[j].dirty = next_generation;
            else capture_pages[j].dirty = shadow_pages[old].dirty;
        }
        i += run;
    }
    if (flags) { publish_incomplete(frame, flags, start); goto done; }
    /* Legacy membership changes require an exclusive reset. Opted-in window
     * clients use explicit removals, so their ordinary deltas do not reset. */
    if (reset_pending && flights.count) { ++in_flight_skips; InterlockedIncrement(&dropped_updates); goto done; }
    if (expired(start, subscription.budget_us)) {
        fault(1, 0, capture_count, subscription.budget_us);
        publish_incomplete(frame, NH_MIRROR_TRUNCATED, start); goto done;
    }
    capture_stage = 3;
    nh_profile_phase(2);
    struct nh_budget_probe packing_probe = {0};
    for (i = 0; i < capture_count; ++i) {
        if (!capture_pages[i].dirty) continue;
        if (nh_budget_probe_due(&packing_probe) && expired(start, subscription.budget_us)) { fault(1, 0, capture_count, subscription.budget_us); flags |= NH_MIRROR_TRUNCATED; break; }
        put_u32(packet + length, capture_pages[i].address); length += 4;
        memcpy(packet + length, capture_bytes + i * NH_PAGE_SIZE, NH_PAGE_SIZE); length += NH_PAGE_SIZE;
        ++dirty_count;
    }
    if (flags) { publish_incomplete(frame, flags, start); goto done; }
    if (expired(start, subscription.budget_us)) {
        fault(1, 0, capture_count, subscription.budget_us);
        publish_incomplete(frame, NH_MIRROR_TRUNCATED, start); goto done;
    }
    capture_stage = 4;
    nh_profile_phase(3);
    for (i = 0; i < subscription.sample_count && (capture_count || i < fixed_sample_count); ++i) {
        uint32_t address, bytes;
        if (i < fixed_sample_count) {
            address = fixed_samples[i].address; bytes = fixed_samples[i].length;
        } else {
            uint32_t page = random_u32() % capture_count;
            uint32_t offset;
            bytes = 8 + random_u32() % 57;
            offset = random_u32() % (NH_PAGE_SIZE - bytes + 1);
            address = capture_pages[page].address + offset;
        }
        if (expired(start, subscription.budget_us)) { fault(1, 0, capture_count, subscription.budget_us); flags |= NH_MIRROR_TRUNCATED; break; }
        put_u32(packet + length, address); put_u32(packet + length + 4, bytes);
        /* This is an independent direct read, not a copy of the staged bytes. */
        if (!capture_read(address, packet + length + 8, bytes)) { flags |= NH_MIRROR_INVALID; break; }
        length += 8 + bytes; ++sample_count;
    }
    if (flags || expired(start, subscription.budget_us)) {
        if (!flags) fault(1, 0, capture_count, subscription.budget_us);
        publish_incomplete(frame, flags ? flags : NH_MIRROR_TRUNCATED, start); goto done;
    }
    if (subscription.page_removals && !reset_pending && removed_count) {
        put_u32(packet + length, removed_count); length += 4;
        for (i = 0; i < removed_count; ++i) {
            put_u32(packet + length, removed_pages[i]); length += 4;
        }
    }
    if (subscription.page_removals) {
        put_u32(packet + length, applied_revision); length += 4;
    }
    if (expired(start, subscription.budget_us)) {
        fault(1, 0, capture_count, subscription.budget_us);
        publish_incomplete(frame, NH_MIRROR_TRUNCATED, start); goto done;
    }
    previous_capture_failed = 0;
    put_u32(packet, frame);
    put_u32(packet + 4, (reset_pending ? NH_MIRROR_RESET :
        subscription.page_removals && removed_count ? NH_MIRROR_REMOVED : 0) |
        (subscription.page_removals ? NH_MIRROR_REVISION : 0));
    put_u32(packet + 8, dirty_count); put_u32(packet + 12, sample_count);
    ++captures_produced;
    if (nh_publish_mirror(&packet, length, start, applied_revision)) {
        LARGE_INTEGER published_at;
        ++mirrors_published;
        QueryPerformanceCounter(&published_at);
        nh_mirror_flight_publish(&flights, frame, applied_revision, next_generation, published_at.QuadPart, reset_pending);
        /* Only a completely serialized, accepted publication replaces the
         * authoritative image. Failed sends retain removals and dirty changes. */
        { uint8_t *bytes = shadow_bytes; struct nh_page *pages = shadow_pages;
          shadow_bytes = capture_bytes; capture_bytes = bytes;
          shadow_pages = capture_pages; capture_pages = pages; }
        shadow_count = capture_count; generation = next_generation;
        reset_pending = 0; mirror_bytes += length;
    } else { ++publish_rejections; InterlockedIncrement(&dropped_updates); }
done:
    nh_profile_end(!current_fault.reason);
    QueryPerformanceCounter(&finish);
    { uint64_t us = (uint64_t)(finish.QuadPart - start.QuadPart) * 1000000u / (uint64_t)frequency.QuadPart;
      hook_us_total += us; ++hook_calls;
      hook_times[hook_time_cursor++ % NH_TIMING_SAMPLES] = (uint32_t)us;
      if (hook_time_count < NH_TIMING_SAMPLES) ++hook_time_count;
      if (us > hook_us_max) hook_us_max = us;
      if (subscription.budget_us && us > subscription.budget_us) ++budget_overruns; }
    LeaveCriticalSection(&state_lock);
}

static void fail(uint32_t id, const char *reason) { nh_send(NH_ERROR, id, reason, (uint32_t)strlen(reason)); }
static void dispatch_batch(uint32_t id, const uint8_t *payload, uint32_t length) {
    struct entry { uint32_t address, length; const uint8_t *expected, *bytes; } entries[256];
    struct suspended_threads threads;
    uint32_t count, offset = 4, total = 0, i, j, extra_count = 0, extra_bytes = 0;
    int journal[256];
    uint8_t *scratch;
    const char *error = NULL;
    if (length < 4 || (count = get_u32(payload)) == 0 || count > 256) {
        fail(id, "BATCH requires 1..256 entries"); return;
    }
    for (i = 0; i < count; ++i) {
        struct entry *entry = entries + i;
        if (length - offset < 8) { fail(id, "short BATCH entry"); return; }
        entry->address = get_u32(payload + offset); entry->length = get_u32(payload + offset + 4);
        offset += 8;
        if (!entry->length || entry->length > 65536 || total > 65536 - entry->length ||
            (uint64_t)entry->address + entry->length > UINT64_C(0x100000000) ||
            (uint64_t)offset + (uint64_t)entry->length * 2 > length) {
            fail(id, "BATCH exceeds 64 KiB or wraps address space"); return;
        }
        entry->expected = payload + offset; entry->bytes = payload + offset + entry->length;
        offset += entry->length * 2; total += entry->length;
        /* Overlapping writes make validation/rollback order ambiguous. */
        for (j = 0; j < i; ++j)
            if ((uint64_t)entry->address < (uint64_t)entries[j].address + entries[j].length &&
                (uint64_t)entries[j].address < (uint64_t)entry->address + entry->length) {
                fail(id, "BATCH entries overlap"); return;
            }
    }
    if (offset != length) { fail(id, "trailing BATCH bytes"); return; }
    if (!enabled || !installed || !nh_identity_verified()) { fail(id, "BATCH requires the verified active logic hook"); return; }
    scratch = malloc(65536);
    if (!scratch) { fail(id, "BATCH allocation failed"); return; }
    EnterCriticalSection(&patch_lock);
    for (i = 0; i < count; ++i) {
        journal[i] = -1;
        if (nh_allocation_contains(entries[i].address, entries[i].length)) continue;
        for (j = 0; j < owned_count; ++j) {
            uint64_t end = (uint64_t)entries[i].address + entries[i].length;
            uint64_t owned_end = (uint64_t)owned_patches[j].address + owned_patches[j].length;
            if (entries[i].address >= owned_patches[j].address && end <= owned_end) {
                journal[i] = (int)j; break;
            }
            if (entries[i].address < owned_end && owned_patches[j].address < end) {
                error = "BATCH partially overlaps earlier patch ownership"; break;
            }
        }
        if (error) break;
        if (journal[i] < 0) {
            journal[i] = -2; ++extra_count; extra_bytes += entries[i].length;
        }
    }
    if (owned_count + extra_count > 256 || owned_bytes_used + extra_bytes > 65536)
        error = "BATCH external patch journal limit exceeded";
    if (error) { LeaveCriticalSection(&patch_lock); free(scratch); fail(id, error); return; }
    if (!suspend_threads(&threads)) error = "BATCH could not suspend process threads";
    else {
        for (i = 0; i < threads.count && !error; ++i) {
            CONTEXT context;
            memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
            if (!GetThreadContext(threads.handles[i], &context)) { error = "BATCH thread disappeared"; break; }
            for (j = 0; j < count; ++j)
                if ((uint64_t)context.Eip >= entries[j].address &&
                    (uint64_t)context.Eip < (uint64_t)entries[j].address + entries[j].length) {
                    error = "BATCH thread executing a target range; retry transaction"; break;
                }
        }
        for (i = 0; i < count && !error; ++i)
            if (!nh_safe_read(entries[i].address, scratch, entries[i].length) ||
                memcmp(scratch, entries[i].expected, entries[i].length))
                error = "BATCH original bytes changed; no writes applied";
        for (i = 0; i < count && !error; ++i) {
            if (!nh_safe_write(entries[i].address, entries[i].bytes, entries[i].length)) {
                uint32_t rollback;
                error = "BATCH write failed; rolled back";
                /* Include the failed entry: protection failure may follow a
                 * successful byte write, and a kernel write can be partial. */
                for (rollback = 0; rollback <= i; ++rollback)
                    if (!nh_safe_write(entries[rollback].address, entries[rollback].expected, entries[rollback].length))
                        error = "BATCH rollback failed; native patches need manual review";
            }
        }
        if (!error) for (i = 0; i < count; ++i) {
            struct owned_patch *owned;
            if (journal[i] == -1) { nh_allocation_pin(entries[i].address, entries[i].length); continue; }
            if (journal[i] == -2) {
                owned = owned_patches + owned_count++;
                owned->address = entries[i].address; owned->length = entries[i].length;
                owned->offset = owned_bytes_used; owned_bytes_used += owned->length;
                memcpy(owned_original + owned->offset, entries[i].expected, owned->length);
            } else owned = owned_patches + journal[i];
            memcpy(owned_latest + owned->offset + entries[i].address - owned->address, entries[i].bytes, entries[i].length);
        }
        resume_threads(&threads);
    }
    LeaveCriticalSection(&patch_lock);
    free(scratch);
    if (error) fail(id, error); else nh_send(NH_BATCH, id, NULL, 0);
}
void nh_dispatch_mirror(uint16_t type, uint32_t id, const uint8_t *payload, uint32_t length) {
    uint32_t i;
    if (!init_mirror()) { fail(id, "mirror allocation failed"); return; }
    if (type == NH_BATCH) { dispatch_batch(id, payload, length); return; }
    if (type == NH_HOOK) {
        int wanted;
        if (length != 4 || get_u32(payload) > 1) { fail(id, "HOOK requires one boolean u32"); return; }
        wanted = get_u32(payload) != 0;
        if (!wanted) InterlockedExchange(&enabled, 0);
        if (!switch_hook(wanted)) { fail(id, "hook refused: unsupported executable, signature, or thread state"); return; }
        if (wanted) InterlockedExchange(&enabled, 1);
        nh_send(type, id, NULL, 0); return;
    }
    if (type == NH_ACK) {
        if (length != 4) { fail(id, "ACK requires the mirror frame u32"); return; }
        EnterCriticalSection(&state_lock);
        struct nh_mirror_flight acknowledged[2];
        uint64_t acknowledged_generation;
        int matched;
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        uint32_t count = nh_mirror_flight_ack(&flights, get_u32(payload), now.QuadPart,
            acknowledged, &acknowledged_generation, &matched);
        if (matched) { ++ack_notifications; nh_mirror_trace_ack(get_u32(payload), now); }
        if (count) {
            for (uint32_t entry = 0; entry < count; ++entry) {
                ack_times[ack_time_cursor++ % NH_TIMING_SAMPLES] =
                    (uint32_t)((uint64_t)(acknowledged[entry].acknowledged_ticks - acknowledged[entry].published_ticks) * 1000000u / (uint64_t)frequency.QuadPart);
                if (ack_time_count < NH_TIMING_SAMPLES) ++ack_time_count;
                ++mirror_acks;
            }
            for (i = 0; i < shadow_count; ++i)
                if (shadow_pages[i].dirty <= acknowledged_generation) shadow_pages[i].dirty = 0;
        }
        LeaveCriticalSection(&state_lock);
        return; /* ACK is a notification and has no reply. */
    }
    if (type == NH_SAMPLE) {
        struct nh_range next[16];
        uint32_t count;
        if (length < 4 || (count = get_u32(payload)) > 16 || length != 4 + count * 8) {
            fail(id, "SAMPLE requires up to sixteen ranges"); return;
        }
        for (i = 0; i < count; ++i) {
            next[i].address = get_u32(payload + 4 + i * 8); next[i].length = get_u32(payload + 8 + i * 8);
            if (!next[i].length || next[i].length > 64 ||
                (uint64_t)next[i].address + next[i].length > UINT64_C(0x100000000)) {
                fail(id, "SAMPLE range is invalid"); return;
            }
        }
        EnterCriticalSection(&state_lock);
        memcpy(fixed_samples, next, count * sizeof(*next)); fixed_sample_count = count;
        LeaveCriticalSection(&state_lock); nh_send(type, id, NULL, 0); return;
    }
    if (type == NH_SUBSCRIBE) {
        struct nh_subscription next;
        uint32_t offset, revision;
        if (length < 20) { fail(id, "short SUBSCRIBE header"); return; }
        memset(&next, 0, sizeof(next));
        next.range_count = get_u32(payload); next.rule_count = get_u32(payload + 4);
        next.max_pages = get_u32(payload + 8); next.budget_us = get_u32(payload + 12);
        next.page_removals = get_u32(payload + 16) >> 31;
        next.mirror_window = (get_u32(payload + 16) & 0x40000000u) ? 2 : 1;
        next.sample_count = get_u32(payload + 16) & 0x3fffffffu;
        if (next.mirror_window == 2 && !next.page_removals) {
            fail(id, "SUBSCRIBE mirror window requires revisioned page removals"); return;
        }
        if (next.range_count > NH_MAX_RANGES || next.rule_count > NH_MAX_RULES ||
            !next.max_pages || next.max_pages > NH_MAX_PAGES || next.sample_count > NH_MAX_SAMPLES ||
            next.budget_us < NH_MIRROR_MIN_BUDGET_US || next.budget_us > NH_MIRROR_MAX_BUDGET_US ||
            length != 20 + next.range_count * 8 + next.rule_count * 20) { fail(id, "SUBSCRIBE bounds exceeded"); return; }
        offset = 20;
        for (i = 0; i < next.range_count; ++i, offset += 8) {
            next.ranges[i].address = get_u32(payload + offset); next.ranges[i].length = get_u32(payload + offset + 4);
            if ((uint64_t)next.ranges[i].address + next.ranges[i].length > UINT64_C(0x100000000)) {
                fail(id, "SUBSCRIBE range wraps address space"); return;
            }
        }
        for (i = 0; i < next.rule_count; ++i, offset += 20) {
            struct nh_rule *rule = &next.rules[i];
            rule->kind = get_u32(payload + offset); rule->source = get_u32(payload + offset + 4);
            rule->bytes = get_u32(payload + offset + 8); rule->max_count = get_u32(payload + offset + 12);
            rule->stride = get_u32(payload + offset + 16);
            if (rule->kind < 1 || rule->kind > 8 || !rule->bytes || rule->bytes > NH_MAX_PAGES * NH_PAGE_SIZE ||
                (uint64_t)rule->source + (rule->kind == 1 ? 4 : 20) > UINT64_C(0x100000000) ||
                (rule->kind != 1 && (!rule->max_count || rule->max_count > 65536)) ||
                (rule->kind == 3 && !rule->stride)) { fail(id, "invalid follow rule"); return; }
        }
        /* This request path has one I/O owner. Preparing membership does not
         * read game bytes, and cannot consume the game-thread time budget. */
        nh_page_seed_init(&next_seed);
        for (i = 0; i < next.range_count && !next_seed.flags; ++i) {
            uint32_t first = next_seed.count;
            nh_page_seed_range(&next_seed, next.ranges[i].address, next.ranges[i].length, next.max_pages);
            for (uint32_t j = first; j < next_seed.count; ++j) next_seed.ranges[j] = i;
        }
        EnterCriticalSection(&state_lock);
        subscription = next; fixed_seed = next_seed; revision = ++subscription_revision;
        LeaveCriticalSection(&state_lock);
        if (next.page_removals) {
            uint8_t reply[4]; put_u32(reply, revision); nh_send(type, id, reply, sizeof(reply));
        } else nh_send(type, id, NULL, 0);
        return;
    }
    fail(id, "unsupported mirror operation");
}
static int restore_owned_patches(void) {
    struct suspended_threads threads;
    uint32_t i, j, kept = 0;
    uint8_t scratch[65536];
    int result = 1, busy = 0;
    if (!owned_count) return 1;
    if (!suspend_threads(&threads)) return 0;
    for (i = 0; i < threads.count && !busy; ++i) {
        CONTEXT context;
        memset(&context, 0, sizeof(context)); context.ContextFlags = CONTEXT_CONTROL;
        if (!GetThreadContext(threads.handles[i], &context)) { busy = 1; break; }
        for (j = 0; j < owned_count; ++j)
            if (context.Eip >= owned_patches[j].address &&
                (uint64_t)context.Eip < (uint64_t)owned_patches[j].address + owned_patches[j].length) {
                busy = 1; break;
            }
    }
    if (busy) { resume_threads(&threads); return 0; }
    for (i = 0; i < owned_count; ++i) {
        struct owned_patch *owned = owned_patches + i;
        if (!nh_safe_read(owned->address, scratch, owned->length) ||
            memcmp(scratch, owned_latest + owned->offset, owned->length) ||
            !nh_safe_write(owned->address, owned_original + owned->offset, owned->length)) {
            owned_patches[kept++] = *owned; result = 0;
        }
    }
    resume_threads(&threads);
    owned_count = kept;
    if (!owned_count) owned_bytes_used = 0;
    return result;
}
void nh_mirror_disconnect(void) {
    uint32_t attempt;
    InterlockedExchange(&enabled, 0);
    if (initialized != 2) return;
    /* Never erase code/data allocations: an active suppressed call may have a
     * return address in gate:post. Restoring only external entry/vtable sites
     * allows that call to finish through its still-valid private return stack. */
    EnterCriticalSection(&patch_lock);
    for (attempt = 0; attempt < 100 && !restore_owned_patches(); ++attempt) Sleep(1);
    if (owned_count) InterlockedIncrement(&teardown_failures);
    LeaveCriticalSection(&patch_lock);
    switch_hook(0);
    EnterCriticalSection(&state_lock);
    memset(&subscription, 0, sizeof(subscription)); nh_page_seed_init(&fixed_seed);
    ++subscription_revision; shadow_count = 0; flights.count = 0; reset_pending = 1; pending_flags = 0; fixed_sample_count = 0;
    LeaveCriticalSection(&state_lock);
}
static int compare_times(const void *a, const void *b) {
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x > y ? 1 : x < y ? -1 : 0;
}
static void format_fault(char *out, uint32_t capacity, const struct mirror_fault *f) {
    snprintf(out, capacity, "{\"reason\":%lu,\"stage\":%lu,\"rule\":%lu,\"source\":%lu,\"address\":%lu,\"value\":%lu,\"limit\":%lu,\"frame\":%lu,\"revision\":%lu,\"range\":%lu,\"object\":%lu,\"requestAddress\":%lu,\"requestLength\":%lu,\"readAddress\":%lu,\"readLength\":%lu,\"memoryBase\":%lu,\"memorySize\":%lu,\"memoryState\":%lu,\"memoryProtect\":%lu,\"memoryType\":%lu,\"readError\":%lu,\"retryReadable\":%s,\"occurrences\":%lu,\"lastFrame\":%lu}",
        (unsigned long)f->reason, (unsigned long)f->stage, (unsigned long)f->rule,
        (unsigned long)f->source, (unsigned long)f->address, (unsigned long)f->value,
        (unsigned long)f->limit, (unsigned long)f->frame, (unsigned long)f->revision,
        (unsigned long)f->range, (unsigned long)f->object, (unsigned long)f->request_address,
        (unsigned long)f->request_length, (unsigned long)f->read_address, (unsigned long)f->read_length,
        (unsigned long)f->memory_base, (unsigned long)f->memory_size, (unsigned long)f->memory_state,
        (unsigned long)f->memory_protect, (unsigned long)f->memory_type, (unsigned long)f->read_error,
        f->retry_readable ? "true" : "false", (unsigned long)f->occurrences, (unsigned long)f->last_frame);
}
void nh_mirror_fault_diagnostics(char *out, uint32_t capacity) {
    struct mirror_fault snapshot;
    char detail[768];
    if (!capacity) return;
    if (initialized != 2) {
        snprintf(out, capacity, "{\"lastMirrorFault\":null}");
        return;
    }
    /* Capacity recovery needs the actual fault, not percentile sorting and
     * trace formatting on the I/O thread that must also retire mirror ACKs. */
    EnterCriticalSection(&state_lock);
    snapshot = last_fault;
    LeaveCriticalSection(&state_lock);
    format_fault(detail, sizeof(detail), &snapshot);
    snprintf(out, capacity, "{\"lastMirrorFault\":%s}", detail);
}
void nh_mirror_diagnostics(char *out, uint32_t capacity) {
    char hook[256], detail[768], recent[6400], entry[768], profile[1600];
    uint32_t times[NH_TIMING_SAMPLES], ack_samples[NH_TIMING_SAMPLES];
    uint32_t time_count, ack_count, p50, p99, ack_p50, ack_p99, used = 0;
    if (!capacity) return;
    if (initialized != 2) {
        snprintf(out, capacity, "\"logicFrames\":0,\"mirrorBytes\":0,\"hookUs\":0,\"droppedUpdates\":0,\"hookInstalled\":false");
        return;
    }
    EnterCriticalSection(&state_lock);
    time_count = hook_time_count;
    memcpy(times, hook_times, time_count * sizeof(*times));
    ack_count = ack_time_count;
    memcpy(ack_samples, ack_times, ack_count * sizeof(*ack_samples));
    LeaveCriticalSection(&state_lock);
    qsort(times, time_count, sizeof(*times), compare_times);
    p50 = time_count ? times[(time_count + 1) / 2 - 1] : 0;
    p99 = time_count ? times[(time_count * 99 + 99) / 100 - 1] : 0;
    qsort(ack_samples, ack_count, sizeof(*ack_samples), compare_times);
    ack_p50 = ack_count ? ack_samples[(ack_count + 1) / 2 - 1] : 0;
    ack_p99 = ack_count ? ack_samples[(ack_count * 99 + 99) / 100 - 1] : 0;
    EnterCriticalSection(&state_lock);
    format_fault(detail, sizeof(detail), &last_fault);
    recent[used++] = '[';
    for (uint32_t i = 0; i < fault_history_count; ++i) {
        uint32_t index = (fault_history_cursor + NH_FAULT_HISTORY - fault_history_count + i) % NH_FAULT_HISTORY;
        format_fault(entry, sizeof(entry), fault_history + index);
        if (i) recent[used++] = ',';
        uint32_t length = (uint32_t)strlen(entry);
        memcpy(recent + used, entry, length); used += length;
    }
    recent[used++] = ']'; recent[used] = 0;
    if (installed) snprintf(hook, sizeof(hook), "{\"site\":%lu,\"original\":[137,21,132,237,168,0],\"patched\":[%u,%u,%u,%u,%u,%u]}",
        (unsigned long)NH_HOOK_ADDRESS, detour[0],detour[1],detour[2],detour[3],detour[4],detour[5]);
    else strcpy(hook, "null");
    nh_profile_json(profile, sizeof(profile));
    snprintf(out, capacity, "\"logicFrames\":%lu,\"mirrorBytes\":%llu,\"hookUs\":%llu,\"hookMaxUs\":%llu,\"budgetOverruns\":%llu,\"droppedUpdates\":%lu,\"truncatedUpdates\":%lu,\"invalidUpdates\":%lu,\"hookInstalled\":%s,\"mirrorPages\":%lu,\"inFlight\":%s,\"gameThreadId\":%lu,\"frameHook\":%s,\"teardownFailures\":%lu,\"ownedExternalPatches\":%lu,\"hookCalls\":%llu,\"hookP50Us\":%lu,\"hookP99Us\":%lu,\"hookPercentileSamples\":%lu,\"mirrorFaultCount\":%llu,\"mirrorFaultEvents\":%llu,\"recentMirrorFaultsOmitted\":%llu,\"lastMirrorFault\":%s,\"recentMirrorFaults\":%s,\"mirrorCaptureAttempts\":%llu,\"mirrorProduced\":%llu,\"mirrorsPublished\":%llu,\"mirrorIncompletePublished\":%llu,\"mirrorInFlightSkips\":%llu,\"mirrorPublishRejections\":%llu,\"mirrorEmptySubscriptionSkips\":%llu,\"hookLockSkips\":%lu,\"mirrorAcks\":%llu,\"mirrorAckP50Us\":%lu,\"mirrorAckP99Us\":%lu,\"mirrorAckSamples\":%lu,\"mirrorInFlightCount\":%lu,\"mirrorWindow\":%lu,\"mirrorMailboxSkips\":%llu,\"mirrorAckNotifications\":%llu",
        (unsigned long)logic_frames, (unsigned long long)mirror_bytes, (unsigned long long)hook_us_total,
        (unsigned long long)hook_us_max, (unsigned long long)budget_overruns, (unsigned long)dropped_updates,
        (unsigned long)truncated_updates, (unsigned long)invalid_updates, installed ? "true" : "false",
        (unsigned long)shadow_count, flights.count ? "true" : "false", (unsigned long)game_thread_id, hook,
        (unsigned long)teardown_failures, (unsigned long)owned_count, (unsigned long long)hook_calls,
        (unsigned long)p50, (unsigned long)p99, (unsigned long)time_count, (unsigned long long)fault_count,
        (unsigned long long)fault_event_count, (unsigned long long)(fault_event_count - fault_history_count), detail, recent,
        (unsigned long long)capture_attempts, (unsigned long long)captures_produced,
        (unsigned long long)mirrors_published, (unsigned long long)incomplete_published,
        (unsigned long long)in_flight_skips, (unsigned long long)publish_rejections,
        (unsigned long long)empty_subscription_skips, (unsigned long)hook_lock_skips,
        (unsigned long long)mirror_acks, (unsigned long)ack_p50, (unsigned long)ack_p99, (unsigned long)ack_count,
        (unsigned long)flights.count, (unsigned long)(subscription.mirror_window ? subscription.mirror_window : 1),
        (unsigned long long)mailbox_skips, (unsigned long long)ack_notifications);
    used = (uint32_t)strlen(out);
    if (used < capacity) snprintf(out + used, capacity - used, ",\"captureProfile\":%s", profile);
    LeaveCriticalSection(&state_lock);
}
