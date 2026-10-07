#ifndef NATIVE_HOST_X86_RELATIVE_H
#define NATIVE_HOST_X86_RELATIVE_H
#include <stdint.h>
#include <string.h>

/* rel32 is relative to the execution address, which can differ from the buffer
 * holding bytes before installation. Unsigned arithmetic preserves x86 wrap. */
static inline void nh_x86_relative(uint8_t *bytes, uint8_t opcode,
        uint32_t origin, uint32_t target) {
    uint32_t displacement = target - (origin + 5u);
    bytes[0] = opcode;
    memcpy(bytes + 1, &displacement, sizeof(displacement));
}
static inline uint32_t nh_x86_relative_target(const uint8_t *bytes, uint32_t origin) {
    uint32_t displacement;
    memcpy(&displacement, bytes + 1, sizeof(displacement));
    return origin + 5u + displacement;
}
#endif
