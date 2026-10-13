/* YR 1.001 native draw journal. Addresses/signatures stay in game policy.
 * Original drawing is the complete fallback. Validated mobile border/tick
 * leaves can also supply a matched clean plane and semantic page primitives;
 * any unknown later write discards that replacement, never the original. */
#include "agent.h"
#include "x86-relative.h"
#include "draw-surface.h"
#include "draw-patch.h"
#include "ddsurface.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define JOURNAL_CAPACITY 4096u
#define SITE_COUNT 17u
#define CODE_BYTES 4096u

enum { DRAW_BEGIN, DRAW_END, INFANTRY_BORDER, VEHICLE_BORDER, HEALTH_TICK,
    GROUP_FILL, GROUP_OUTLINE, GROUP_TEXT, SURFACE_LOCK, SURFACE_FILL, UNKNOWN_CALLBACK,
    PLANNING_FIRST, PLANNING_LAST, ORE_GLINTS, COPY_TRANSFER, SOFTWARE_TRANSFER, FOREIGN_COPY_DONE, CAPTURE_END, COPY_END };
struct site {
    uint32_t address, bytes, target;
    uint8_t original[10], patch[10];
};
static struct site sites[SITE_COUNT] = {
    {0x4f4480,8,0,{0x83,0xec,0x08,0xa1,0x1c,0x73,0x88,0x00},{0}},
    {0x4f459d,6,0,{0x89,0x2d,0x14,0x73,0x88,0x00},{0}},
    {0x6f68b4,5,0x4aed70,{0xe8,0xb7,0x84,0xdb,0xff},{0}},
    {0x6f6947,5,0x4aed70,{0xe8,0x24,0x84,0xdb,0xff},{0}},
    {0x6f6a4a,5,0x4aed70,{0xe8,0x21,0x83,0xdb,0xff},{0}},
    {0x70a940,9,0,{0xff,0x52,0x14,0x8b,0x0d,0x14,0x73,0x88,0x00},{0}},
    {0x70a951,10,0,{0xff,0x52,0x58,0x8b,0x94,0x24,0x80,0x00,0x00,0x00},{0}},
    {0x70a97b,5,0x4a66d0,{0xe8,0x50,0xbd,0xd9,0xff},{0}},
    {0x4bad80,5,0,{0xa0,0x78,0xf9,0x89,0x00},{0}},
    {0x4bb620,6,0,{0x81,0xec,0xb4,0x00,0x00,0x00},{0}},
    {0x4f4555,8,0,{0xff,0x52,0x2c,0xb9,0x60,0xbc,0xa8,0x00},{0}},
    {0x6d46ea,5,0x63b0a0,{0xe8,0xb1,0x69,0xf6,0xff},{0}},
    {0x6d491a,5,0x63b2f0,{0xe8,0xd1,0x69,0xf6,0xff},{0}},
    {0x6d7840,5,0,{0x83,0xec,0x48,0x56,0x57},{0}},
    {0x4f4b7b,5,0,{0xff,0x50,0x08,0x84,0xdb},{0}},
    {0x4bb293,5,0x7bbb90,{0xe8,0xf8,0x08,0x30,0x00},{0}},
    {0x437985,6,0,{0x8b,0x4c,0x24,0x64,0x8b,0x01},{0}},
};
struct leaf {
    uint32_t kind, object, uid, surface, shape, frame, colour, flags;
    int32_t point[2], clip[4], rect[4];
};
static struct leaf journal[JOURNAL_CAPACITY];
static uint8_t *code;
static volatile LONG requested, installed, install_failed, inside_draw;
static uint32_t draw_depth;
static volatile LONG observed_draws, completed_draws, observed_leaves, invalid_reads, overflow;
static volatile LONG journal_count, completed_count, picture_observations, mid_draw_pictures;
static volatile LONG draw_generation, match_generation, completed_generation, matched_generation;
static volatile LONG completed_frame, matched_frame;
static volatile LONG leaf_counts[6];
static uint32_t prior_frame;
static struct leaf last_leaf;
static CRITICAL_SECTION snapshot_lock;
static LONG snapshot_initialized;
#define MAX_REPLACEMENTS 512u
#define MAX_LEAF_PIXELS 144u
#define MAX_COMMAND_JSON (1024u * 1024u)
struct replacement {
    uint32_t object, kind, width, height;
    int32_t x, y, clip[4];
    uint16_t before[MAX_LEAF_PIXELS], after[MAX_LEAF_PIXELS];
};
static struct replacement replacements[MAX_REPLACEMENTS], pending_leaf;
static uint32_t replacement_count, capture_return, capture_post;
static uint32_t capture_surface, capture_native_surface, capture_object;
static int capture_active, capture_valid;
static volatile LONG completed_ready, unsafe_write, unsupported_kind;
static struct nh_draw_surface_view capture_view;
static uint16_t *complete_native, *complete_clean;
static uint32_t complete_capacity, complete_width, complete_height;
static char command_json[MAX_COMMAND_JSON];
static uint32_t command_json_bytes, command_count;
static volatile LONG captured_elements, rejected_elements, invalidated_elements, paired_pictures, pair_mismatches;
static volatile LONG invalidation_counts[8], last_invalidation_kind, last_invalidation_return;
static volatile LONG last_invalidation_surface, last_invalidation_draw;
static volatile LONG last_invalidation_vtable, last_invalidation_target;
static int sidebar_code_verified;
static volatile LONG sidebar_classified, sidebar_rejected;
static uint32_t rejected_gadget, rejected_gadget_vtable, rejected_gadget_peer;
static volatile LONG append_reasons[9], append_width, append_height;
static uint32_t transfer_surface, transfer_native_surface, transfer_software_count, transfer_hardware_count;
static int transfer_active, transfer_complete;
static int32_t transfer_source[4], transfer_destination[4];
static struct nh_draw_surface_view transfer_view;
static volatile LONG transfer_observations, transfer_accepts, transfer_rejects;
static uint32_t transfer_probe[20];
static uint32_t foreign_write[5];
static volatile LONG hardware_copies;
static volatile LONG writer_epoch, active_writers, known_foreign_writes;
static LONG draw_epoch, complete_epoch;
struct foreign_writer { uint32_t thread, surface, depth; };
static struct foreign_writer foreign_writers[16];

static int verify_sidebar_code(void)
{
    /* Whole method fingerprints supplement the pinned executable and virtual
     * slots. The only drawing leaf below these methods is CC_Draw_Shape,
     * whose actual destination Lock remains subject to the write fence. */
    static const uint32_t signatures[][3] = {
        {0x4e14a0,5,0x8a688aeb}, {0x556620,4,0x6148ce64},
        {0x4e1550,32,0x8fcb02ae}, {0x4e1570,44,0xe68158aa},
        {0x48e620,33,0x65f78044}, {0x69deb0,262,0x6d56c4be},
        {0x411510,36,0x029323a7},
    };
    uint8_t bytes[262];
    for (uint32_t i = 0; i < sizeof(signatures) / sizeof(signatures[0]); i++) {
        if (!nh_safe_read(signatures[i][0],bytes,signatures[i][1])) return 0;
        uint32_t hash = 2166136261u;
        for (uint32_t j = 0; j < signatures[i][1]; j++) hash = (hash ^ bytes[j]) * 16777619u;
        if (hash != signatures[i][2]) return 0;
    }
    return 1;
}
static int known_sidebar_chain(uint32_t node, uint32_t initial_vtable)
{
    if (!sidebar_code_verified) return 0;
    uint32_t visited[256], count = 0, vtable = 0, peer = 0;
    while (node && count < 256) {
        uint32_t head[2], slots[28], draw;
        peer = 0;
        for (uint32_t i = 0; i < count; i++) if (visited[i] == node) goto unknown;
        visited[count++] = node;
        if (!nh_safe_read(node,head,sizeof(head))) goto unknown;
        vtable = head[0];
        if (count == 1 && vtable != initial_vtable) goto unknown;
        if (vtable == 0x7f2f44 || vtable == 0x7e608c || vtable == 0x7e92bc || vtable == 0x7f02bc) draw = 0x4e1550;
        else if (vtable == 0x7f2fcc || vtable == 0x7e528c || vtable == 0x7e8118) draw = 0x48e620;
        else if (vtable == 0x7e8088) draw = 0x69deb0;
        else goto unknown;
        if (!nh_safe_read(vtable,slots,sizeof(slots)) || slots[1] != 0x4e14a0 ||
            slots[11] != 0x4e1570 || slots[27] != draw) goto unknown;
        if (draw != 0x4e1550 && (!nh_safe_read(node+0x28,&peer,4) || peer)) goto unknown;
        if (draw == 0x69deb0) {
            uint8_t side;
            uint32_t surface, surface_vtable, get_rect;
            if (!nh_safe_read(node+0x4c,&side,1) ||
                !nh_safe_read(side ? 0x887300 : 0x887314,&surface,4) ||
                !nh_safe_read(surface,&surface_vtable,4) || surface_vtable != 0x7e85d4 ||
                !nh_safe_read(surface_vtable+0x78,&get_rect,4) || get_rect != 0x411510) goto unknown;
        }
        node = head[1];
    }
    if (node) goto unknown;
    InterlockedIncrement(&sidebar_classified); return 1;
unknown:
    InterlockedIncrement(&sidebar_rejected);
    if (TryEnterCriticalSection(&snapshot_lock)) {
        rejected_gadget = node; rejected_gadget_vtable = vtable; rejected_gadget_peer = peer;
        LeaveCriticalSection(&snapshot_lock);
    }
    return 0;
}

static void record_invalidation(uint32_t kind, uint32_t return_address, uint32_t surface, uint32_t vtable)
{
    if (!replacement_count && !capture_active) return;
    uint32_t index = kind >= SURFACE_LOCK && kind <= ORE_GLINTS ? kind - SURFACE_LOCK : 7;
    InterlockedIncrement(&invalidation_counts[index]);
    uint32_t target = 0;
    if (vtable) nh_safe_read(vtable + 0x2c, &target, 4);
    if (TryEnterCriticalSection(&snapshot_lock)) {
        last_invalidation_kind = (LONG)kind; last_invalidation_return = (LONG)return_address;
        last_invalidation_surface = (LONG)surface; last_invalidation_draw = draw_generation;
        last_invalidation_vtable = (LONG)vtable; last_invalidation_target = (LONG)target;
        LeaveCriticalSection(&snapshot_lock);
    }
}

static void invalidate(void)
{
    if (replacement_count) InterlockedExchangeAdd(&invalidated_elements, (LONG)replacement_count);
    replacement_count = 0; capture_valid = 0; completed_ready = 0; transfer_complete = 0;
}
static void foreign_mutation(uint32_t kind, uint32_t address, uint32_t bytes, uint32_t return_address)
{
    if (!InterlockedExchange(&unsafe_write, 1) && TryEnterCriticalSection(&snapshot_lock)) {
        foreign_write[0] = kind; foreign_write[1] = GetCurrentThreadId();
        foreign_write[2] = address; foreign_write[3] = bytes; foreign_write[4] = return_address;
        LeaveCriticalSection(&snapshot_lock);
    }
    InterlockedExchange(&completed_ready, 0);
}
static void foreign_copy_begin(uint32_t surface)
{
    uint32_t thread = GetCurrentThreadId();
    EnterCriticalSection(&snapshot_lock);
    uint32_t slot = 16;
    for (uint32_t i = 0; i < 16; i++) {
        if (foreign_writers[i].depth && foreign_writers[i].thread == thread && foreign_writers[i].surface == surface) {
            slot = i; break;
        }
        if (!foreign_writers[i].depth) slot = i;
    }
    if (slot < 16) {
        foreign_writers[slot].thread = thread; foreign_writers[slot].surface = surface;
        foreign_writers[slot].depth++;
        InterlockedIncrement(&active_writers); InterlockedIncrement(&writer_epoch);
        InterlockedIncrement(&known_foreign_writes); InterlockedExchange(&completed_ready,0);
    }
    LeaveCriticalSection(&snapshot_lock);
    if (slot == 16) foreign_mutation(NH_DRAW_LOCK,surface,0,0x7bc176);
}
static void foreign_copy_done(uint32_t surface)
{
    uint32_t thread = GetCurrentThreadId();
    EnterCriticalSection(&snapshot_lock);
    for (uint32_t i = 0; i < 16; i++) {
        if (foreign_writers[i].depth && foreign_writers[i].thread == thread && foreign_writers[i].surface == surface) {
            foreign_writers[i].depth--;
            InterlockedIncrement(&writer_epoch); InterlockedDecrement(&active_writers);
            break;
        }
    }
    LeaveCriticalSection(&snapshot_lock);
}
static int unchanged_writers(LONG epoch)
{
    return !unsafe_write && !InterlockedCompareExchange(&active_writers,0,0) &&
        InterlockedCompareExchange(&writer_epoch,0,0) == epoch;
}
static int contained_rect(const int32_t *rect, uint32_t width, uint32_t height)
{
    return rect[0] >= 0 && rect[1] >= 0 && rect[2] > 0 && rect[3] > 0 &&
        (uint64_t)(uint32_t)rect[0] + (uint32_t)rect[2] <= width &&
        (uint64_t)(uint32_t)rect[1] + (uint32_t)rect[3] <= height;
}
static int copy_target(uint32_t entry, uint32_t original, uint8_t return_bytes)
{
    if (entry == original) return 1;
    /* tacticalPassthrough owns these optional wrappers. Accept only the whole
     * native GuestGateBuilder blit template, its bridge-owned code/data pages,
     * original continuation and owner; a zero depth proves normal execution. */
    uint8_t actual[63], expected[63] = {
        0x83,0x3d,0,0,0,0,0,
        0x0f,0x84,0x2d,0,0,0,
        0x0f,0xba,0x25,0,0,0,0,0,
        0x0f,0x83,0x1f,0,0,0,
        0x64,0x81,0x3d,0x24,0,0,0,0,0,0,0,
        0x0f,0x85,0x0e,0,0,0,
        0xff,0x05,0,0,0,0,
        0xb8,1,0,0,0,0xc2,0,0,0xe9,0,0,0,0
    };
    if (!nh_allocation_contains(entry,sizeof(actual)) || !nh_safe_read(entry,actual,sizeof(actual))) return 0;
    uint32_t depth_address, switch_address, counter_address, data[2], owner = nh_game_thread_id();
    memcpy(&depth_address,actual+2,4); memcpy(&switch_address,actual+16,4); memcpy(&counter_address,actual+46,4);
    if ((depth_address & 0xfffu) != 4 || actual[20] >= 32) return 0;
    uint32_t page = depth_address - 4;
    if (!nh_allocation_contains(page,4096) || !nh_safe_read(page,data,sizeof(data)) ||
        data[0] != 0x45544147 || data[1] != 0 || switch_address < page+0x10 || switch_address >= page+0x30 ||
        (switch_address & 3u) || counter_address < page+0x100 || counter_address >= page+0x500 || (counter_address & 3u)) return 0;
    memcpy(expected+2,&depth_address,4); memcpy(expected+16,&switch_address,4); expected[20] = actual[20];
    memcpy(expected+34,&owner,4); memcpy(expected+46,&counter_address,4); expected[56] = return_bytes;
    nh_x86_relative(expected+58,0xe9,entry+58,original);
    return !memcmp(actual,expected,sizeof(actual));
}
static void begin_transfer(const uint32_t *registers)
{
    if (!replacement_count || draw_depth != 1) return;
    InterlockedIncrement(&transfer_observations);
    if (transfer_active) { invalidate(); return; }
    transfer_complete = 0;
    const uint32_t *args = registers + 9;
    uint32_t destination = registers[6], source = args[1], primary, vtable, slots[3], get_rect;
    uint32_t probe[20] = {source,registers[1],capture_surface,registers[4]&0xffu,destination};
    nh_safe_read(0x887308,&probe[5],4);
    if (nh_safe_read(destination,&probe[6],4)) {
        nh_safe_read(probe[6]+8,&probe[7],8);
        nh_safe_read(probe[6]+0x78,&probe[9],4);
    }
    nh_safe_read(destination+0x1c,&probe[10],4); probe[11] = args[4] & 0xffu;
    nh_safe_read(source+4,&probe[12],8); nh_safe_read(source+0x1c,&probe[14],4);
    struct nh_draw_surface_view source_probe;
    if (nh_draw_surface_view(probe[14],&source_probe)) probe[15] = (uint32_t)(uintptr_t)source_probe.pixels;
    probe[16] = capture_view.width; probe[17] = capture_view.height;
    probe[18] = capture_native_surface; probe[19] = (uint32_t)(uintptr_t)capture_view.pixels;
    if (TryEnterCriticalSection(&snapshot_lock)) {
        memcpy(transfer_probe,probe,sizeof(probe)); LeaveCriticalSection(&snapshot_lock);
    }
    if (source != capture_surface || source != registers[1] || (registers[4] & 0xffu) ||
        !nh_safe_read(0x887308,&primary,4) || primary != destination ||
        !nh_safe_read(destination,&vtable,4) || vtable != 0x7e85d4 ||
        !nh_safe_read(vtable+8,slots,8) || !copy_target(slots[0],0x4bb080,0x14) || !copy_target(slots[1],0x4bb0d0,0x1c) ||
        !nh_safe_read(vtable+0x78,&get_rect,4) || get_rect != 0x411510 ||
        !nh_safe_read(destination+0x1c,&transfer_native_surface,4) ||
        !nh_draw_surface_view(transfer_native_surface,&transfer_view) || transfer_view.bpp != 16 ||
        !nh_safe_read(args[0],transfer_destination,sizeof(transfer_destination)) ||
        !nh_safe_read(args[2],transfer_source,sizeof(transfer_source)) ||
        !contained_rect(transfer_source,capture_view.width,capture_view.height) ||
        !contained_rect(transfer_destination,transfer_view.width,transfer_view.height) ||
        transfer_source[2] != transfer_destination[2] || transfer_source[3] != transfer_destination[3]) {
        InterlockedIncrement(&transfer_rejects); invalidate(); return;
    }
    for (uint32_t i = 0; i < replacement_count; i++) {
        const struct replacement *r = replacements + i;
        if (r->x < transfer_source[0] || r->y < transfer_source[1] ||
            (int64_t)r->x + r->width > (int64_t)transfer_source[0] + transfer_source[2] ||
            (int64_t)r->y + r->height > (int64_t)transfer_source[1] + transfer_source[3]) {
            InterlockedIncrement(&transfer_rejects); invalidate(); return;
        }
    }
    transfer_surface = destination; transfer_software_count = transfer_hardware_count = 0; transfer_active = 1;
}
static void end_transfer(const uint32_t *registers)
{
    if (!transfer_active) return;
    transfer_active = 0;
    if (!(registers[7] & 0xffu) || transfer_software_count + transfer_hardware_count != 1 || !replacement_count || unsafe_write) {
        InterlockedIncrement(&transfer_rejects); invalidate(); return;
    }
    transfer_complete = 1; InterlockedIncrement(&transfer_accepts);
}
static int copy_rect(uint16_t *target, const struct replacement *element)
{
    for (uint32_t y = 0; y < element->height; y++)
        if (!nh_safe_read((uint32_t)(uintptr_t)(capture_view.pixels +
                (element->y + y) * capture_view.pitch + element->x * 2),
                target + y * element->width, element->width * 2)) return 0;
    return 1;
}
static int begin_capture(const struct leaf *leaf, uint32_t *registers)
{
    if (!unchanged_writers(draw_epoch)) return 0;
    if (capture_active) { invalidate(); return 0; }
    if (leaf->flags != (leaf->kind == HEALTH_TICK ? 0x600u : 0xe00u)) return 0;
    uint32_t shape = leaf->shape, native_surface;
    uint16_t header[4], frame[4];
    if (!nh_safe_read(shape, header, sizeof(header))) return 0;
    if (header[0] == 0xffff) {
        uint8_t loaded;
        if (!nh_safe_read(shape + 0x10, &loaded, 1) || !loaded ||
            !nh_safe_read(shape + 0x0c, &shape, 4) ||
            !nh_safe_read(shape, header, sizeof(header))) return 0;
    }
    if (leaf->frame >= header[3] || !nh_safe_read(shape + 8 + leaf->frame * 24, frame, sizeof(frame))) return 0;
    if (leaf->kind == HEALTH_TICK) {
        if (header[1] != 16 || header[2] != 16 || frame[0] != 7 || frame[1] != 6 ||
            frame[2] != 2 || frame[3] != 2 || leaf->frame < 16 || leaf->frame > 18 ||
            !replacement_count || capture_object != leaf->object || capture_surface != leaf->surface) return 0;
    } else if (header[1] != 36 || header[2] != 4 || frame[0] || frame[1] ||
        frame[3] != 4 || frame[2] != (leaf->kind == INFANTRY_BORDER ? 18 : 36) ||
        leaf->frame != (leaf->kind == INFANTRY_BORDER ? 1u : 0u)) return 0;
    if (!nh_safe_read(leaf->surface + 0x1c, &native_surface, 4)) return 0;
    struct nh_draw_surface_view view;
    if (!nh_draw_surface_view(native_surface, &view) || view.bpp != 16) return 0;
    if (capture_surface && capture_surface != leaf->surface) invalidate();
    capture_surface = leaf->surface; capture_native_surface = native_surface; capture_view = view;
    memset(&pending_leaf, 0, sizeof(pending_leaf));
    pending_leaf.kind = leaf->kind; pending_leaf.object = leaf->object;
    pending_leaf.x = leaf->point[0] - header[1] / 2 + frame[0];
    pending_leaf.y = leaf->point[1] - header[2] / 2 + frame[1];
    pending_leaf.width = frame[2]; pending_leaf.height = frame[3];
    memcpy(pending_leaf.clip, leaf->clip, sizeof(pending_leaf.clip));
    if (pending_leaf.x < 0 || pending_leaf.y < 0 ||
        pending_leaf.x + pending_leaf.width > view.width || pending_leaf.y + pending_leaf.height > view.height ||
        pending_leaf.x < leaf->clip[0] || pending_leaf.y < leaf->clip[1] ||
        pending_leaf.x + (int32_t)pending_leaf.width > leaf->clip[0] + leaf->clip[2] ||
        pending_leaf.y + (int32_t)pending_leaf.height > leaf->clip[1] + leaf->clip[3] ||
        replacement_count >= MAX_REPLACEMENTS || !copy_rect(pending_leaf.before, &pending_leaf)) return 0;
    /* The HD tactical plane is keyed before native extras. A retained native
     * bar is not a clean background: only start a bar on an entirely keyed
     * footprint, then let its tick leaves restore that captured border. */
    if (leaf->kind != HEALTH_TICK)
        for (uint32_t i = 0; i < pending_leaf.width * pending_leaf.height; i++)
            if (pending_leaf.before[i] != 0xf81f) return 0;
    capture_return = registers[9]; registers[9] = capture_post;
    capture_active = capture_valid = 1;
    capture_object = leaf->object;
    return 1;
}
static int semantic_shape(const struct replacement *r)
{
    if (r->kind == HEALTH_TICK)
        return r->after[1] == r->after[3] && r->after[0] != 0xf81f &&
            r->after[1] != 0xf81f && r->after[2] != 0xf81f;
    uint16_t edge = r->after[0], a = r->after[r->width + 1], b = r->after[r->width + 2];
    if (edge == 0xf81f || a == 0xf81f || b == 0xf81f) return 0;
    for (uint32_t y = 0; y < r->height; y++) for (uint32_t x = 0; x < r->width; x++) {
        uint16_t expected = !y || y == 3 || !x || x == r->width - 1 ? edge : x & 1 ? a : b;
        if (r->after[y * r->width + x] != expected) return 0;
    }
    return 1;
}
static void end_capture(uint32_t *registers)
{
    registers[9] = capture_return;
    int good = capture_active && capture_valid && copy_rect(pending_leaf.after, &pending_leaf) &&
        semantic_shape(&pending_leaf);
    capture_active = 0;
    if (!good) { InterlockedIncrement(&rejected_elements); invalidate(); return; }
    replacements[replacement_count++] = pending_leaf;
    InterlockedIncrement(&captured_elements);
}
static int rect_command(const struct replacement *r, int32_t x, int32_t y, uint32_t w, uint32_t h, uint16_t colour)
{
    if (++command_count > 4096) return 0;
    int count = snprintf(command_json + command_json_bytes, MAX_COMMAND_JSON - command_json_bytes,
        "%s{\"kind\":\"rect\",\"x\":%ld,\"y\":%ld,\"width\":%u,\"height\":%u,\"colour\":%u,"
        "\"clip\":{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld}}",
        command_count > 1 ? "," : "", (long)x, (long)y, w, h, colour,
        (long)r->clip[0], (long)r->clip[1], (long)r->clip[2], (long)r->clip[3]);
    if (count < 0 || (uint32_t)count >= MAX_COMMAND_JSON - command_json_bytes) return 0;
    command_json_bytes += (uint32_t)count; return 1;
}
static void freeze_pair(void)
{
    completed_ready = 0;
    if (!replacement_count || capture_active || !unchanged_writers(draw_epoch) || !transfer_complete) return;
    struct nh_draw_surface_view view;
    if (!nh_draw_surface_view(transfer_native_surface, &view) || view.pixels != transfer_view.pixels ||
        view.width != transfer_view.width || view.height != transfer_view.height ||
        view.pitch != transfer_view.pitch || view.bpp != 16) return;
    struct nh_draw_surface_view source;
    if (!nh_draw_surface_view(capture_native_surface,&source) || source.pixels != capture_view.pixels ||
        source.width != capture_view.width || source.height != capture_view.height ||
        source.pitch != capture_view.pitch || source.bpp != 16) return;
    uint32_t count = view.width * view.height;
    if (count > NH_MAX_PICTURE_PIXELS) return;
    if (complete_capacity < count) {
        uint16_t *native = malloc(count * 2), *clean = malloc(count * 2);
        if (!native || !clean) { free(native); free(clean); return; }
        free(complete_native); free(complete_clean); complete_native = native; complete_clean = clean;
        complete_capacity = count;
    }
    if (view.pitch == view.width * 2) {
        if (!nh_safe_read((uint32_t)(uintptr_t)view.pixels,complete_native,count * 2)) return;
    } else for (uint32_t y = 0; y < view.height; y++)
        if (!nh_safe_read((uint32_t)(uintptr_t)(view.pixels + y * view.pitch),
            complete_native + y * view.width, view.width * 2)) return;
    /* The final real CopyPart supplies the coordinate transform. Both its
     * completed classified copy and its entire copied region must agree. */
    uint16_t source_row[4096];
    for (int32_t y = 0; y < transfer_source[3]; y++) {
        const void *actual = source.pixels + (transfer_source[1]+y) * source.pitch + transfer_source[0]*2;
        const void *copied = complete_native + (transfer_destination[1]+y) * view.width + transfer_destination[0];
        if (!nh_safe_read((uint32_t)(uintptr_t)actual,source_row,(uint32_t)transfer_source[2]*2) ||
            memcmp(source_row,copied,(uint32_t)transfer_source[2]*2)) return;
    }
    memcpy(complete_clean, complete_native, count * 2);
    int32_t dx = transfer_destination[0] - transfer_source[0];
    int32_t dy = transfer_destination[1] - transfer_source[1];
    for (uint32_t i = replacement_count; i > 0; i--) {
        const struct replacement *r = replacements + i - 1;
        for (uint32_t y = 0; y < r->height; y++) {
            uint16_t *row = complete_clean + (r->y + dy + y) * view.width + r->x + dx;
            if (memcmp(row, r->after + y * r->width, r->width * 2)) return;
            memcpy(row, r->before + y * r->width, r->width * 2);
        }
    }
    command_count = 0; command_json[0] = '['; command_json_bytes = 1;
    for (uint32_t i = 0; i < replacement_count; i++) {
        struct replacement mapped = replacements[i];
        mapped.x += dx; mapped.y += dy; mapped.clip[0] += dx; mapped.clip[1] += dy;
        const struct replacement *r = &mapped;
        if (r->kind == HEALTH_TICK) {
            if (!rect_command(r,r->x,r->y,2,2,r->after[1]) ||
                !rect_command(r,r->x,r->y,1,1,r->after[0]) ||
                !rect_command(r,r->x,r->y+1,1,1,r->after[2])) return;
        } else {
            if (!rect_command(r,r->x,r->y,r->width,4,r->after[0]) ||
                !rect_command(r,r->x+1,r->y+1,r->width-2,2,r->after[r->width+1])) return;
            for (uint32_t x = 2; x < r->width - 1; x += 2)
                if (!rect_command(r,r->x+x,r->y+1,1,2,r->after[r->width+2])) return;
        }
    }
    if (command_json_bytes + 1 >= MAX_COMMAND_JSON) return;
    command_json[command_json_bytes++] = ']';
    complete_width = view.width; complete_height = view.height;
    complete_epoch = draw_epoch;
    if (unchanged_writers(complete_epoch)) completed_ready = 1;
}


void nh_draw_journal_request(int enabled)
{
    InterlockedExchange(&requested, !!enabled);
}
void nh_draw_journal_disconnect(void)
{
    /* Installed observers retain executable storage until process exit. They
     * always execute the original instructions; disconnect only closes capture.
     * No I/O thread rewrites code that the draw thread may currently execute. */
    InterlockedExchange(&requested, 0);
    InterlockedExchange(&inside_draw, 0);
    InterlockedExchange(&matched_generation, 0);
    completed_ready = 0;
}

static int read_leaf(uint32_t kind, const uint32_t *r, struct leaf *out)
{
    /* PUSHAD layout: edi,esi,ebp,saved-esp,ebx,edx,ecx,eax; then EFLAGS.
     * CALL sites include their return address; indirect-call sites use JMP. */
    const uint32_t *args = r + (sites[kind].target ? 10 : 9);
    uint32_t vtable, object = kind <= HEALTH_TICK ? r[1] : r[2];
    memset(out, 0, sizeof(*out));
    if (!nh_safe_read(object, &vtable, 4)) return 0;
    if (vtable != 0x7f5c70 && vtable != 0x7eb058) return -1;
    if (!nh_safe_read(object + 0x10, &out->uid, 4)) return 0;
    out->kind = kind; out->object = object;
    if (kind <= HEALTH_TICK) {
        out->surface = r[6]; out->shape = args[0]; out->frame = args[1]; out->flags = args[4];
        if (!nh_safe_read(args[2], out->point, sizeof(out->point)) ||
            !nh_safe_read(args[3], out->clip, sizeof(out->clip))) return 0;
    } else if (kind == GROUP_TEXT) {
        out->surface = args[0]; out->colour = args[3];
        if (!nh_safe_read(args[1], out->clip, sizeof(out->clip)) ||
            !nh_safe_read(args[2], out->point, sizeof(out->point))) return 0;
    } else {
        out->surface = r[6]; out->colour = args[1];
        if (!nh_safe_read(args[0], out->rect, sizeof(out->rect))) return 0;
    }
    if (!nh_safe_read(out->surface, &vtable, 4) || vtable != 0x7e85d4) return 0;
    return 1;
}

/* Common surface entries can run on other threads; only the game thread
 * observes leaves. Stubs preserve FPU/SIMD state independently of optimization. */
static void observe(uint32_t kind, uint32_t *registers)
{
    if (kind == CAPTURE_END) { end_capture(registers); return; }
    if (kind == COPY_END) {
        if (GetCurrentThreadId() == nh_game_thread_id()) end_transfer(registers);
        return;
    }
    if (kind == FOREIGN_COPY_DONE) {
        if (GetCurrentThreadId() != nh_game_thread_id()) foreign_copy_done(registers[0]);
        return;
    }
    if (kind == SURFACE_LOCK && GetCurrentThreadId() != nh_game_thread_id()) {
        /* This exact verified source acquire never exposes a destination,
         * regardless of which thread executes the read-only blit source. */
        if (registers[9] == 0x7bc176) foreign_copy_begin(registers[6]);
        else if (registers[9] != 0x7bc1bf)
            foreign_mutation(NH_DRAW_LOCK,registers[6],0,registers[9]);
        return;
    }
    if (GetCurrentThreadId() != nh_game_thread_id()) return;
    if (!InterlockedCompareExchange(&requested, 0, 0) || !nh_connected()) {
        /* Disconnect can arrive inside a nested Lock/message dispatch. Finish
         * depth bookkeeping even while capture is disabled, retaining a pending
         * leaf return until CAPTURE_END restores it. */
        if (draw_depth && kind == DRAW_BEGIN) { draw_depth++; invalidate(); }
        if (draw_depth && kind == DRAW_END) {
            draw_depth--; invalidate();
            if (!draw_depth) InterlockedExchange(&inside_draw, 0);
        }
        return;
    }
    if (kind == COPY_TRANSFER) { if (inside_draw) begin_transfer(registers); return; }
    if (kind == SOFTWARE_TRANSFER) { if (transfer_active) transfer_software_count++; return; }
    if (kind >= SURFACE_LOCK) {
        if (!inside_draw || !capture_surface) return;
        if (kind == UNKNOWN_CALLBACK && known_sidebar_chain(registers[6],registers[5])) return;
        if (kind == SURFACE_LOCK && (registers[6] == capture_surface || registers[6] == transfer_surface)) {
            /* The verified source-acquire site never writes that surface. */
            if (registers[9] == 0x7bc1bf) return;
            /* Only this exact leaf's SHP destination acquire is classified. */
            if (capture_active && registers[9] == 0x7bc176) return;
            if (transfer_active && registers[6] == transfer_surface && registers[9] == 0x7bc176) return;
            record_invalidation(kind,registers[9],registers[6],0);
            invalidate();
        } else if ((kind == SURFACE_FILL && (registers[6] == capture_surface || registers[6] == transfer_surface)) ||
            kind == UNKNOWN_CALLBACK || kind == PLANNING_FIRST || kind == PLANNING_LAST || kind == ORE_GLINTS) {
            record_invalidation(kind,registers[9],registers[6],kind == UNKNOWN_CALLBACK ? registers[5] : 0);
            invalidate();
        }
        return;
    }
    if (kind == DRAW_BEGIN) {
        if (draw_depth++) { invalidate(); return; }
        uint32_t frame = nh_current_frame();
        if (!match_generation || (prior_frame && frame < prior_frame))
            InterlockedIncrement(&match_generation);
        prior_frame = frame;
        InterlockedIncrement(&draw_generation);
        InterlockedIncrement(&observed_draws);
        InterlockedExchange(&journal_count, 0);
        draw_epoch = InterlockedCompareExchange(&writer_epoch,0,0);
        replacement_count = 0; capture_surface = capture_native_surface = capture_object = 0;
        transfer_surface = transfer_native_surface = transfer_software_count = transfer_hardware_count = 0;
        transfer_active = transfer_complete = 0;
        capture_active = capture_valid = completed_ready = 0;
        InterlockedExchange(&inside_draw, 1);
        InterlockedExchange(&matched_generation, 0);
        return;
    }
    if (kind == DRAW_END) {
        if (draw_depth > 1) { draw_depth--; invalidate(); return; }
        draw_depth = 0;
        if (InterlockedExchange(&inside_draw, 0)) {
            InterlockedExchange(&completed_count, journal_count);
            InterlockedExchange(&completed_generation, draw_generation);
            InterlockedExchange(&completed_frame, (LONG)nh_current_frame());
            InterlockedIncrement(&completed_draws);
            freeze_pair();
            dds_NativeCapturePrimary();
        }
        return;
    }
    if (!inside_draw || draw_depth > 1 || kind < INFANTRY_BORDER || kind > GROUP_TEXT) return;
    InterlockedIncrement(&observed_leaves);
    InterlockedIncrement(&leaf_counts[kind - INFANTRY_BORDER]);
    if ((uint32_t)journal_count >= JOURNAL_CAPACITY) {
        InterlockedIncrement(&overflow); invalidate(); return;
    }
    struct leaf capture;
    int read_result = read_leaf(kind, registers, &capture);
    if (read_result <= 0) {
        if (read_result < 0) InterlockedIncrement(&unsupported_kind);
        else InterlockedIncrement(&invalid_reads);
        invalidate(); return;
    }
    journal[journal_count++] = capture;
    if (TryEnterCriticalSection(&snapshot_lock)) { last_leaf = capture; LeaveCriticalSection(&snapshot_lock); }
    if (kind <= HEALTH_TICK && !begin_capture(&capture, registers)) {
        InterlockedIncrement(&rejected_elements); invalidate();
    }
}

static void emit(uint8_t **at, const uint8_t *bytes, uint32_t count)
{
    memcpy(*at, bytes, count); *at += count;
}
static void relative(uint8_t **at, uint8_t opcode, uint32_t target)
{
    nh_x86_relative(*at, opcode, (uint32_t)(uintptr_t)*at, target); *at += 5;
}
static int make_stubs(void)
{
    /* Save integer and floating state. The C callback receives the immutable
     * register stack, then original instructions run with every register intact. */
    static const uint8_t save[] = {
        0x9c,0x60,0xfc,0x89,0xe0,0x81,0xec,0x20,0x02,0,0,
        0x83,0xe4,0xf0,0x89,0x84,0x24,0,0x02,0,0,0x0f,0xae,0x04,0x24
    };
    static const uint8_t restore[] = {
        0x0f,0xae,0x0c,0x24,0x8b,0xa4,0x24,0,0x02,0,0,0x61,0x9d
    };
    if (!IsProcessorFeaturePresent(PF_XMMI_INSTRUCTIONS_AVAILABLE)) return 0;
    code = VirtualAlloc(NULL, CODE_BYTES, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!code) return 0;
    uint8_t *at = code;
    capture_post = (uint32_t)(uintptr_t)at;
    *at++ = 0x6a; *at++ = 0; /* reserve the preserved original return address */
    emit(&at, save, sizeof(save));
    *at++ = 0x83; *at++ = 0xec; *at++ = 0x08;
    *at++ = 0x50; *at++ = 0x68;
    uint32_t post_kind = CAPTURE_END; memcpy(at, &post_kind, 4); at += 4;
    relative(&at, 0xe8, (uint32_t)(uintptr_t)&observe);
    *at++ = 0x83; *at++ = 0xc4; *at++ = 0x10;
    emit(&at, restore, sizeof(restore)); *at++ = 0xc3;
    for (uint32_t index = 0; index < SITE_COUNT; index++) {
        struct site *site = sites + index;
        uint32_t entry = (uint32_t)(uintptr_t)at;
        emit(&at, save, sizeof(save));
        /* Keep stack 16-byte aligned at the callback CALL. */
        *at++ = 0x83; *at++ = 0xec; *at++ = 0x08;
        *at++ = 0x50; /* push original register frame */
        *at++ = 0x68; memcpy(at, &index, 4); at += 4;
        relative(&at, 0xe8, (uint32_t)(uintptr_t)&observe);
        *at++ = 0x83; *at++ = 0xc4; *at++ = 0x10;
        emit(&at, restore, sizeof(restore));
        if (index == COPY_TRANSFER) {
            /* One patch owns the original CALL and its TEST. Observe the real
             * return in this same stub; no overlapping post-call patch. */
            emit(&at,site->original,3);
            emit(&at,save,sizeof(save));
            *at++ = 0x83; *at++ = 0xec; *at++ = 0x08;
            *at++ = 0x50; *at++ = 0x68;
            uint32_t end_kind = COPY_END; memcpy(at,&end_kind,4); at += 4;
            relative(&at,0xe8,(uint32_t)(uintptr_t)&observe);
            *at++ = 0x83; *at++ = 0xc4; *at++ = 0x10;
            emit(&at,restore,sizeof(restore));
            emit(&at,site->original+3,2);
            relative(&at,0xe9,site->address+site->bytes);
        } else if (site->target) relative(&at, 0xe9, site->target);
        else {
            emit(&at, site->original, site->bytes);
            relative(&at, 0xe9, site->address + site->bytes);
        }
        memset(site->patch, 0x90, site->bytes);
        nh_x86_relative(site->patch, site->target ? 0xe8 : 0xe9, site->address, entry);
    }
    DWORD previous;
    if (!VirtualProtect(code, CODE_BYTES, PAGE_EXECUTE_READ, &previous)) return 0;
    FlushInstructionCache(GetCurrentProcess(), code, (SIZE_T)(at - code));
    return 1;
}

void nh_draw_journal_tick(void)
{
    if (!requested || installed || install_failed || !nh_connected()) return;
    if (!nh_identity_verified() || GetCurrentThreadId() != nh_game_thread_id()) return;
    /* Common surface entries may also run on another thread. Suspend them and
     * reject an instruction pointer inside any overwrite span before writing.
     * The existing tactical redraw latch at 0x4F44A5 is intentionally untouched. */
    uint8_t found[10];
    for (uint32_t i = 0; i < SITE_COUNT; i++) {
        if (!nh_safe_read(sites[i].address, found, sites[i].bytes) ||
            memcmp(found, sites[i].original, sites[i].bytes)) {
            InterlockedExchange(&install_failed, 1); return;
        }
    }
    static const uint8_t source_lock[] = {0xff,0x52,0x5c,0x85,0xc0};
    if (!nh_safe_read(0x7bc1bc, found, sizeof(source_lock)) || memcmp(found, source_lock, sizeof(source_lock))) {
        InterlockedExchange(&install_failed, 5); return;
    }
    if (!snapshot_initialized) { InitializeCriticalSection(&snapshot_lock); snapshot_initialized = 1; }
    sidebar_code_verified = verify_sidebar_code();
    if (!code && !make_stubs()) { InterlockedExchange(&install_failed, 2); return; }
    struct nh_draw_patch_range ranges[SITE_COUNT];
    for (uint32_t i = 0; i < SITE_COUNT; i++) {
        ranges[i].address = sites[i].address; ranges[i].length = sites[i].bytes;
    }
    struct nh_draw_suspended_threads threads;
    if (!nh_draw_suspend(&threads, ranges, SITE_COUNT)) return;
    for (uint32_t i = 0; i < SITE_COUNT; i++) {
        if (!nh_safe_read(sites[i].address, found, sites[i].bytes) ||
            memcmp(found, sites[i].original, sites[i].bytes)) {
            nh_draw_resume(&threads);
            InterlockedExchange(&install_failed, 6); return;
        }
    }
    uint32_t changed = 0;
    for (; changed < SITE_COUNT; changed++) {
        struct site *site = sites + changed;
        if (!nh_safe_write(site->address, site->patch, site->bytes)) break;
    }
    if (changed != SITE_COUNT) {
        /* Include the failed write, which could have changed only a prefix. */
        for (uint32_t i = 0; i <= changed; i++)
            if (!nh_safe_write(sites[i].address, sites[i].original, sites[i].bytes))
                InterlockedExchange(&install_failed, 4);
        if (!install_failed) InterlockedExchange(&install_failed, 3);
        nh_draw_resume(&threads);
        return;
    }
    InterlockedExchange(&installed, 1);
    nh_draw_resume(&threads);
}

void nh_draw_journal_picture(void)
{
    if (!requested || !installed || GetCurrentThreadId() != nh_game_thread_id()) return;
    if (inside_draw) { InterlockedIncrement(&mid_draw_pictures); return; }
    /* A completed draw ID is observation only. The source/present surface copy
     * and every later write still need proof before a clean/native pair exists. */
    InterlockedExchange(&matched_generation, completed_generation);
    InterlockedExchange(&matched_frame, completed_frame);
    InterlockedIncrement(&picture_observations);
}
void nh_draw_journal_diagnostics(char *out, uint32_t capacity)
{
    struct leaf snapshot = {0};
    LONG inv[6] = {0};
    uint32_t gadget[3] = {0};
    uint32_t transfer_snapshot[20] = {0};
    uint32_t foreign_snapshot[5] = {0};
    if (snapshot_initialized) {
        EnterCriticalSection(&snapshot_lock); snapshot = last_leaf;
        inv[0] = last_invalidation_kind; inv[1] = last_invalidation_return;
        inv[2] = last_invalidation_surface; inv[3] = last_invalidation_draw;
        inv[4] = last_invalidation_vtable; inv[5] = last_invalidation_target;
        gadget[0] = rejected_gadget; gadget[1] = rejected_gadget_vtable; gadget[2] = rejected_gadget_peer;
        memcpy(transfer_snapshot,transfer_probe,sizeof(transfer_snapshot));
        memcpy(foreign_snapshot,foreign_write,sizeof(foreign_snapshot));
        LeaveCriticalSection(&snapshot_lock);
    }
    snprintf(out, capacity,
        "{\"requested\":%s,\"installed\":%s,\"installFailure\":%ld,\"replacementReady\":%s,"
        "\"reason\":\"conservative-native-write-fallback\",\"matchGeneration\":%ld,\"drawGeneration\":%ld,"
        "\"completedGeneration\":%ld,\"pictureObservedGeneration\":%ld,\"pictureObservedFrame\":%ld,"
        "\"draws\":%ld,\"completedDraws\":%ld,\"leafCalls\":%ld,\"completedLeafCount\":%ld,"
        "\"invalidReads\":%ld,\"unsupportedKinds\":%ld,\"capacityRejects\":%ld,\"pictureObservations\":%ld,\"midDrawPictures\":%ld,"
        "\"unsafeWrite\":%ld,\"foreignWrite\":[%u,%u,%u,%u,%u],\"foreignWriters\":[%ld,%ld,%ld],\"hardwareCopies\":%ld,\"invalidationCounts\":[%ld,%ld,%ld,%ld,%ld,%ld,%ld,%ld],"
        "\"lastInvalidation\":{\"kind\":%ld,\"return\":%lu,\"surface\":%lu,\"draw\":%ld,\"vtable\":%lu,\"target\":%lu},"
        "\"sidebarCodeVerified\":%s,\"sidebarClassified\":%ld,\"sidebarRejected\":%ld,\"rejectedGadget\":[%u,%u,%u],"
        "\"completeSize\":[%u,%u],\"appendSize\":[%ld,%ld],\"appendReasons\":[%ld,%ld,%ld,%ld,%ld,%ld,%ld,%ld,%ld],"
        "\"transfers\":[%ld,%ld,%ld],\"sourceRect\":[%ld,%ld,%ld,%ld],\"destinationRect\":[%ld,%ld,%ld,%ld],"
        "\"transferProbe\":[%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u],"
        "\"capturedElements\":%ld,\"rejectedElements\":%ld,\"invalidatedElements\":%ld,\"pairedPictures\":%ld,\"pairMismatches\":%ld,\"leafCounts\":[%ld,%ld,%ld,%ld,%ld,%ld],\"lastLeaf\":{\"kind\":%u,\"object\":%u,\"uid\":%u,"
        "\"surface\":%u,\"shape\":%u,\"frame\":%u,\"point\":[%ld,%ld],\"clip\":[%ld,%ld,%ld,%ld]}}",
        requested ? "true" : "false", installed ? "true" : "false", install_failed, completed_ready ? "true" : "false",
        match_generation, draw_generation, completed_generation, matched_generation, matched_frame,
        observed_draws, completed_draws, observed_leaves, completed_count, invalid_reads, unsupported_kind, overflow,
        picture_observations, mid_draw_pictures, unsafe_write,
        foreign_snapshot[0],foreign_snapshot[1],foreign_snapshot[2],foreign_snapshot[3],foreign_snapshot[4],
        active_writers,writer_epoch,known_foreign_writes,hardware_copies,
        invalidation_counts[0],invalidation_counts[1],invalidation_counts[2],invalidation_counts[3],
        invalidation_counts[4],invalidation_counts[5],invalidation_counts[6],invalidation_counts[7],
        inv[0],(unsigned long)inv[1],(unsigned long)inv[2],inv[3],
        (unsigned long)inv[4],(unsigned long)inv[5],
        sidebar_code_verified ? "true" : "false",sidebar_classified,sidebar_rejected,gadget[0],gadget[1],gadget[2],
        complete_width,complete_height,append_width,append_height,
        append_reasons[0],append_reasons[1],append_reasons[2],append_reasons[3],append_reasons[4],
        append_reasons[5],append_reasons[6],append_reasons[7],append_reasons[8],
        transfer_observations,transfer_accepts,transfer_rejects,
        (long)transfer_source[0],(long)transfer_source[1],(long)transfer_source[2],(long)transfer_source[3],
        (long)transfer_destination[0],(long)transfer_destination[1],(long)transfer_destination[2],(long)transfer_destination[3],
        transfer_snapshot[0],transfer_snapshot[1],transfer_snapshot[2],transfer_snapshot[3],
        transfer_snapshot[4],transfer_snapshot[5],transfer_snapshot[6],transfer_snapshot[7],
        transfer_snapshot[8],transfer_snapshot[9],transfer_snapshot[10],transfer_snapshot[11],
        transfer_snapshot[12],transfer_snapshot[13],transfer_snapshot[14],transfer_snapshot[15],
        transfer_snapshot[16],transfer_snapshot[17],transfer_snapshot[18],transfer_snapshot[19],
        captured_elements,rejected_elements,invalidated_elements,paired_pictures,pair_mismatches,leaf_counts[0],leaf_counts[1],leaf_counts[2],
        leaf_counts[3],leaf_counts[4],leaf_counts[5], snapshot.kind,snapshot.object,snapshot.uid,
        snapshot.surface,snapshot.shape,snapshot.frame,(long)snapshot.point[0],(long)snapshot.point[1],
        (long)snapshot.clip[0],(long)snapshot.clip[1],(long)snapshot.clip[2],(long)snapshot.clip[3]);
}

int nh_draw_journal_defer_picture(void)
{
    return requested && installed && inside_draw && GetCurrentThreadId() == nh_game_thread_id();
}
uint32_t nh_draw_journal_append(uint8_t *output, uint32_t offset, uint32_t capacity,
    const void *pixels, uint32_t width, uint32_t height, uint32_t pitch)
{
    uint32_t reason = !requested ? 1 : !installed ? 2 : !completed_ready ? 3 : !unchanged_writers(complete_epoch) ? 4 :
        inside_draw ? 5 : GetCurrentThreadId() != nh_game_thread_id() ? 6 :
        width != complete_width || height != complete_height ? 7 : 0;
    InterlockedExchange(&append_width,(LONG)width); InterlockedExchange(&append_height,(LONG)height);
    InterlockedIncrement(&append_reasons[reason]);
    if (reason) return offset;
    for (uint32_t y = 0; y < height; y++)
        if (memcmp((const uint8_t *)pixels + y * pitch, complete_native + y * width, width * 2)) {
            InterlockedIncrement(&pair_mismatches); return offset;
        }
    uint32_t changed_rows = 0;
    for (uint32_t y = 0; y < height; y++)
        if (memcmp(complete_native + y * width, complete_clean + y * width, width * 2)) changed_rows++;
    uint64_t worst = 32u + command_json_bytes + 4u + (uint64_t)changed_rows * (width * 4u + 8u);
    if (worst > capacity - offset) { InterlockedIncrement(&append_reasons[8]); return offset; }
    uint32_t begin = offset;
    uint32_t header[8] = {0x314a564f,0,(uint32_t)match_generation,(uint32_t)completed_generation,
        width,height,3,command_json_bytes};
    memcpy(output+offset,header,sizeof(header)); offset += sizeof(header);
    memcpy(output+offset,command_json,command_json_bytes); offset += command_json_bytes;
    memcpy(output+offset,&changed_rows,4); offset += 4;
    for (uint32_t y = 0; y < height; y++) {
        if (!memcmp(complete_native+y*width,complete_clean+y*width,width*2)) continue;
        memcpy(output+offset,&y,4); offset += 4;
        uint32_t length_at = offset; offset += 4;
        uint32_t row_begin = offset;
        offset = nh_picture_encode_row(output,offset,complete_clean+y*width,width);
        uint32_t length = offset - row_begin; memcpy(output+length_at,&length,4);
    }
    uint32_t bytes = offset - begin; memcpy(output+begin+4,&bytes,4);
    /* A foreign writer permanently closes replacement for this process.
     * Do not publish a plane copied while that writer may still be active. */
    if (!unchanged_writers(complete_epoch)) return begin;
    InterlockedIncrement(&paired_pictures);
    return offset;
}
int nh_draw_journal_surface_copy(const struct nh_draw_copy *copy)
{
    if (!requested || !installed || !transfer_active || !inside_draw || draw_depth != 1 ||
        !replacement_count || unsafe_write || GetCurrentThreadId() != nh_game_thread_id() ||
        transfer_software_count || transfer_hardware_count ||
        (uintptr_t)copy->source != capture_native_surface || (uintptr_t)copy->destination != transfer_native_surface ||
        copy->source_pixels != capture_view.pixels || copy->destination_pixels != transfer_view.pixels ||
        copy->source_pitch != capture_view.pitch || copy->destination_pitch != transfer_view.pitch ||
        memcmp(copy->source_rect,transfer_source,sizeof(transfer_source)) ||
        memcmp(copy->destination_rect,transfer_destination,sizeof(transfer_destination))) return 0;
    uint64_t source = (uintptr_t)copy->source_pixels, destination = (uintptr_t)copy->destination_pixels;
    if (source < destination + (uint64_t)transfer_view.pitch * transfer_view.height &&
        destination < source + (uint64_t)capture_view.pitch * capture_view.height) return 0;
    transfer_hardware_count++;
    InterlockedIncrement(&hardware_copies);
    return 1;
}
void nh_draw_journal_surface_write(const void *pixels, uint32_t bytes, uint32_t kind)
{
    if (!installed || !pixels || !bytes) return;
    /* A previously unrelated plane can become the next captured surface while
     * a foreign write remains in progress. Unknown writers therefore close
     * replacement before any current-surface or request-state filtering. */
    if (GetCurrentThreadId() != nh_game_thread_id()) {
        foreign_mutation(kind,(uint32_t)(uintptr_t)pixels,bytes,0);
        return;
    }
    if (!requested || !capture_view.pixels) return;
    uint64_t start = (uintptr_t)pixels, end = start + bytes;
    uint64_t target = (uintptr_t)capture_view.pixels, primary = (uintptr_t)transfer_view.pixels;
    int source_overlap = end > target && start < target + (uint64_t)capture_view.pitch * capture_view.height;
    int primary_overlap = transfer_surface && end > primary &&
        start < primary + (uint64_t)transfer_view.pitch * transfer_view.height;
    if (!source_overlap && !primary_overlap) return;
    record_invalidation(99,0,(uint32_t)(uintptr_t)pixels,0); invalidate();
}
