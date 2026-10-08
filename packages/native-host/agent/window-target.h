#ifndef NATIVE_HOST_WINDOW_TARGET_H
#define NATIVE_HOST_WINDOW_TARGET_H
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "window-target-policy.h"

int nh_window_owned(HWND window);
HWND nh_window_target(enum nh_window_target_purpose purpose);
#endif
