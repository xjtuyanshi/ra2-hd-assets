#ifndef NATIVE_HOST_MIRROR_PAGE_EQUAL_H
#define NATIVE_HOST_MIRROR_PAGE_EQUAL_H
#include <stdint.h>
#include <string.h>

#if defined(__i386__) || defined(__x86_64__)
#include <emmintrin.h>
/* These are agent-owned snapshot buffers, never guest pointers. The caller
 * checks CPU support before entering this separately compiled SSE2 function.
 * Unaligned loads cover exactly one page and return on the first changed block. */
__attribute__((target("sse2")))
static int nh_page_bytes_equal_sse2(const uint8_t *left, const uint8_t *right) {
    const __m128i zero = _mm_setzero_si128();
    uint32_t offset = 0;
    for (; offset + 64 <= NH_PAGE_SIZE; offset += 64) {
        __m128i a = _mm_xor_si128(_mm_loadu_si128((const __m128i *)(left + offset)),
            _mm_loadu_si128((const __m128i *)(right + offset)));
        __m128i b = _mm_xor_si128(_mm_loadu_si128((const __m128i *)(left + offset + 16)),
            _mm_loadu_si128((const __m128i *)(right + offset + 16)));
        __m128i c = _mm_xor_si128(_mm_loadu_si128((const __m128i *)(left + offset + 32)),
            _mm_loadu_si128((const __m128i *)(right + offset + 32)));
        __m128i d = _mm_xor_si128(_mm_loadu_si128((const __m128i *)(left + offset + 48)),
            _mm_loadu_si128((const __m128i *)(right + offset + 48)));
        __m128i difference = _mm_or_si128(_mm_or_si128(a, b), _mm_or_si128(c, d));
        if (_mm_movemask_epi8(_mm_cmpeq_epi8(difference, zero)) != 0xffff) return 0;
    }
    return !memcmp(left + offset, right + offset, NH_PAGE_SIZE - offset);
}
#endif

static int nh_page_bytes_equal(const uint8_t *left, const uint8_t *right, int use_sse2) {
#if defined(__i386__) || defined(__x86_64__)
    if (use_sse2) return nh_page_bytes_equal_sse2(left, right);
#else
    (void)use_sse2;
#endif
    return !memcmp(left, right, NH_PAGE_SIZE);
}
#endif
