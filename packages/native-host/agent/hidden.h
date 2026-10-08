#ifndef NATIVE_HOST_HIDDEN_H
#define NATIVE_HOST_HIDDEN_H
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>

/* Hidden mode is process configuration, independent of client lifetime. */
void nh_hidden_configure(void);
void nh_hidden_install(void);
int nh_hidden_active(void);
int nh_hidden_owned(HWND window);
int nh_hidden_visible(HWND window);
/* Genuine control painting runs only on the GUI owner, before primary capture. */
void nh_hidden_paint(void);
int nh_hidden_painting(void);
HDC nh_hidden_paint_dc(HWND window, int begin_paint, PAINTSTRUCT *paint);
/* -1 preserves real User32; scoped forced paint exposes its actual full client. */
int nh_hidden_update_rect(HWND window, RECT *rect, BOOL erase);
/* -1 means a real DC; 0/1 are scoped failure/success and must not fall through. */
int nh_hidden_finish_dc(HWND window, HDC dc, int end_paint);
void nh_hidden_set_visible(HWND window, int visible);
void nh_hidden_initial_visibility(HWND window, int visible);
void nh_hidden_diagnostics(char *json, uint32_t capacity);
BOOL WINAPI nh_hidden_show_window(HWND window, int command);
BOOL WINAPI nh_hidden_set_window_pos(HWND window, HWND after, int x, int y, int width, int height, UINT flags);
HWND WINAPI nh_hidden_set_focus(HWND window);
HWND WINAPI nh_hidden_set_active_window(HWND window);
BOOL WINAPI nh_hidden_bring_to_top(HWND window);
BOOL WINAPI nh_hidden_is_window_visible(HWND window);
int nh_hidden_window_message(HWND window, UINT message, WPARAM wparam, LPARAM lparam, LRESULT *result);
int nh_hidden_set_window_proc(HWND window, LONG procedure, LONG *previous);
int nh_hidden_get_window_proc(HWND window, LONG *procedure);
HWND WINAPI nh_hidden_set_capture(HWND window);
HWND WINAPI nh_hidden_get_capture(void);
BOOL WINAPI nh_hidden_release_capture(void);
BOOL WINAPI nh_hidden_end_dialog(HWND window, INT_PTR result);

#endif
