#ifndef NATIVE_HOST_INPUT_CAPTURE_H
#define NATIVE_HOST_INPUT_CAPTURE_H
#include <stdint.h>

/* A release belongs to the accepted press, even if that press changes dialogs.
 * The caller validates window lifetime/ownership on the GUI thread. Native
 * popup capture may take over the same press; it is not an arbitrary new hit. */
struct nh_input_capture { uintptr_t target, root; };
enum nh_input_release_route { NH_RELEASE_CURRENT, NH_RELEASE_CONSUMED, NH_RELEASE_CAPTURED };
struct nh_input_release { enum nh_input_release_route route; uintptr_t target; };

static void nh_input_capture_clear(struct nh_input_capture *capture)
{
    capture->target = capture->root = 0;
}

static void nh_input_capture_begin(struct nh_input_capture *capture, uintptr_t target, uintptr_t root)
{
    capture->target = target;
    capture->root = root;
}

static void nh_input_capture_main_route(struct nh_input_capture *capture, int release)
{
    /* A move/key while the old dialog is disabled does not end its press. */
    if (release) nh_input_capture_clear(capture);
}

static struct nh_input_release nh_input_capture_release(const struct nh_input_capture *capture,
    int release, uintptr_t current_root, int main_route, int pressed_valid,
    uintptr_t native_capture, int native_capture_valid)
{
    if (!release || !capture->target) return (struct nh_input_release){NH_RELEASE_CURRENT, 0};
    if (!pressed_valid) return (struct nh_input_release){NH_RELEASE_CONSUMED, 0};
    if (!main_route && current_root == capture->root)
        return (struct nh_input_release){NH_RELEASE_CURRENT, 0};
    return (struct nh_input_release){NH_RELEASE_CAPTURED,
        native_capture_valid ? native_capture : capture->target};
}
#endif
