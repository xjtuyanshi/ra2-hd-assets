#ifndef NATIVE_HOST_WINDOW_TARGET_POLICY_H
#define NATIVE_HOST_WINDOW_TARGET_POLICY_H

enum nh_window_target_purpose { NH_WINDOW_INPUT, NH_WINDOW_PAINT };

/* Disabled dialogs still own their visible pixels and native animation. They
 * are not eligible for new input until the original game enables them. */
static inline int nh_dialog_target_eligible(enum nh_window_target_purpose purpose,
    int owned, int visible, int dialog, int enabled)
{
    return owned && visible && dialog && (purpose == NH_WINDOW_PAINT || enabled);
}
#endif
