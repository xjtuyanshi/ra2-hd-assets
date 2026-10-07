#ifndef NATIVE_HOST_AGENT_H
#define NATIVE_HOST_AGENT_H
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
/* All messages use LE: magic u32, version u16, type u16, id u32, payload bytes u32. */
#define NH_MAGIC 0x3142484eu
#define NH_VERSION 1
#define NH_MAX_MESSAGE (32u * 1024u * 1024u)
#define NH_MAX_PAGES 4096u
#define NH_MAX_RULES 256u
#define NH_MAX_RANGES 4096u
#define NH_MAX_SAMPLES 64u
#define NH_PAGE_SIZE 4096u
#define NH_NO_FRAME 0xffffffffu
enum nh_type { NH_HELLO=1, NH_READ=2, NH_WRITE=3, NH_ALLOC=4, NH_FREE=5, NH_SUBSCRIBE=6,
 NH_MIRROR=7, NH_CREDIT=8, NH_PICTURE=9, NH_INPUT=10, NH_DIAGNOSTICS=11, NH_HOOK=12,
 NH_ERROR=13, NH_INPUT_STATE=14, NH_ACK=15, NH_BATCH=16, NH_SAMPLE=17 };
/* READ request addr,len,expectedFrame; reply frame,addr,len,bytes. Error UTF-8.
 WRITE addr,len,bytes; ALLOC size,preferred,executable => addr,size; FREE addr.
 SUBSCRIBE rangeCount,ruleCount,maxPages,budgetUs,sampleCount; ranges addr,len;
 rules kind,source,bytes,maxCount,stride. Kinds: 1 pointer; 2 vector (+4 items,+16 count);
 3 span vector (same descriptor; contiguous count*stride). All fields u32.
 MIRROR frame,flags,pageCount,sampleCount; page addr,4096 bytes; samples addr,len,bytes.
 flags: 1 truncated, 2 reset, 4 invalid pages. Samples direct-read on game thread same frame.
 CREDIT count; PICTURE frame,width,height,rowCount; rows y,encodedBytes,segments;
 segments u16: high bit key run, lower15 count; literal segments followed by RGB565 pixels.
 INPUT kind,a,b,c (1 postMessage,2 key,3 cursor); HOOK enabled; INPUT_STATE reply JSON.
 ACK frame acknowledges the sole in-flight mirror; notification, no reply.
 HELLO / DIAGNOSTICS UTF-8 JSON. Ordinary successful replies are empty unless stated.
 */
int nh_safe_read(uint32_t address, void *out, uint32_t length);
int nh_safe_write(uint32_t address, const void *bytes, uint32_t length);
uint32_t nh_current_frame(void);
uint32_t nh_game_thread_id(void);
void nh_agent_start(void);
void nh_agent_stop(void);
int nh_connected(void);
/* The mirror retains dirty versions until ACK; stream mailboxes never overwrite pending deltas. */
void nh_send(uint16_t type, uint32_t id, const void *payload, uint32_t length);
int nh_publish(uint16_t type, const void *payload, uint32_t length);
/* Swap a caller-owned NH_MAX_MESSAGE allocation into an empty mailbox without copying. */
int nh_publish_move(uint16_t type, uint8_t **payload, uint32_t length);
int nh_identity_verified(void);
int nh_allocation_contains(uint32_t address, uint32_t length);
void nh_allocation_pin(uint32_t address, uint32_t length);
void nh_dispatch_mirror(uint16_t type, uint32_t id, const uint8_t *payload, uint32_t length);
void nh_mirror_disconnect(void);
void nh_mirror_diagnostics(char *out, uint32_t capacity);
void nh_logic_tick(void);
void nh_present(const void *pixels, uint32_t width, uint32_t height, uint32_t pitch, uint32_t bpp);
void nh_dispatch_input(uint16_t type, uint32_t id, const uint8_t *payload, uint32_t length);
void nh_input_disconnect(void);
int nh_input_key(int vk, SHORT *value, int asynchronous);
int nh_input_cursor(LPPOINT point);
int nh_input_set_cursor(int x, int y);
int nh_input_active(void);
HWND WINAPI nh_input_get_focus(void);
HWND WINAPI nh_input_get_active_window(void);
int nh_input_message(HWND window, UINT message, WPARAM wparam, LPARAM lparam, LRESULT *result);
void nh_picture_sent(void);
void nh_picture_disconnect(void);
void nh_surface_info(uint32_t *width, uint32_t *height, uint32_t *bpp);
void nh_picture_credit(uint32_t id, const uint8_t *payload, uint32_t length);
#endif
