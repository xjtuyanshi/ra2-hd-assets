#ifndef NH_YR_MENU_TEXT_H
#define NH_YR_MENU_TEXT_H
#include <math.h>

/* YR 1.001's GUI record table and item painter. This policy is used only after
 * the agent verifies the supplied executable's pinned SHA-256. The generic
 * window enumerator does not interpret these private pointers itself. */
static int yr_menu_read(uint32_t address, void *target, size_t size)
{
    SIZE_T copied = 0;
    return address >= 0x10000 && size <= 4096 && address <= UINT32_MAX - size &&
        ReadProcessMemory(GetCurrentProcess(), (LPCVOID)(uintptr_t)address, target, size, &copied) && copied == size;
}

static int yr_menu_utf8(uint32_t address, char *text, size_t capacity)
{
    if (!address) { text[0] = 0; return 1; }
    if (address & 1) return 0;
    WCHAR value[1024];
    for (unsigned count = 0; count < 1024;)
    {
        unsigned length = (4096 - ((address + count * 2) & 4095)) / 2;
        if (length > 64) length = 64;
        if (length > 1024 - count) length = 1024 - count;
        if (!yr_menu_read(address + count * 2, value + count, length * 2)) return 0;
        for (unsigned end = count + length; count < end; count++)
            if (!value[count])
                return WideCharToMultiByte(CP_UTF8, 0, value, -1, text, (int)capacity, NULL, NULL) > 0;
    }
    return 0;
}

static int yr_menu_control_record(HWND hwnd, uint32_t record[130])
{
    uint32_t table[7], signature = 0, node;
    if (!nh_identity_verified() || !yr_menu_read(0xac1b00, table, sizeof(table)) ||
        !yr_menu_read(0x600660, &signature, 3) || signature != 0xc3018b || table[3] > 16 ||
        !table[1] || table[2] != (1u << table[3]) || table[6] != 0x600660 ||
        !yr_menu_read(table[0] + ((uint32_t)(uintptr_t)hwnd & (table[2] - 1)) * 4, &node, 4)) return 0;
    for (uint32_t depth = 0; node && depth < table[1] && depth < 4096; depth++)
    {
        if ((node & 3) || !yr_menu_read(node, record, 130 * sizeof(uint32_t))) return 0;
        if (record[0] == (uint32_t)(uintptr_t)hwnd) return 1;
        if (node == record[129]) return 0;
        node = record[129];
    }
    return 0;
}

static WNDPROC yr_menu_table_procedure(HWND hwnd, uint32_t address)
{
    uint32_t table[7], node;
    if (!nh_identity_verified() || !yr_menu_read(address, table, sizeof(table)) || table[3] > 16 || !table[1] ||
        table[2] != (1u << table[3]) || table[6] != 0x600660 ||
        !yr_menu_read(table[0] + ((uint32_t)(uintptr_t)hwnd & (table[2] - 1)) * 4, &node, 4)) return NULL;
    for (uint32_t depth = 0; node && depth < table[1] && depth < 4096; depth++)
    {
        uint32_t entry[3];
        if ((node & 3) || !yr_menu_read(node, entry, sizeof(entry))) return NULL;
        if (entry[0] == (uint32_t)(uintptr_t)hwnd) return (WNDPROC)(uintptr_t)entry[1];
        if (node == entry[2]) return NULL;
        node = entry[2];
    }
    return NULL;
}

static int yr_menu_control_text(HWND hwnd, char *text, size_t capacity)
{
    uint32_t record[130];
    if (!yr_menu_control_record(hwnd, record)) return 0;
    return yr_menu_utf8(record[11], text, capacity) ? 1 : -1;
}

/* NewEdit (0x614B30) owns a caret, first visible character and real timer
 * blink, with no text-selection range. 0x623880 inserts IME composition;
 * until represented, that state retains the complete original name field.
 * Offsets below include the hash node's HWND word before the control state. */
static int yr_menu_name_edit(HWND hwnd, char *text, size_t capacity, uint32_t edit[4])
{
    static const BYTE expected[] = {0x8b,0x7e,0x4c,0x6a,0,0x83,0xf7,1,0x6a,0,0x89,0x7e,0x4c};
    BYTE signature[sizeof(expected)]; uint32_t record[130], composition[3], source, color; char current[1024];
    if (GetDlgCtrlID(hwnd) != 1696 || yr_menu_table_procedure(hwnd, 0xac18c0) != (WNDPROC)(uintptr_t)0x614b30 ||
        !yr_menu_control_record(hwnd, record) || record[0x6c / 4] != 1 ||
        !yr_menu_read(0x614e7c, signature, sizeof(signature)) || memcmp(signature, expected, sizeof(expected)) ||
        !yr_menu_read(0xb73564, composition, sizeof(composition)) || composition[0] || composition[2] ||
        !yr_menu_read(0xac184c, &color, sizeof(color)) ||
        !yr_menu_read(record[0x40 / 4], &source, sizeof(source)) || !yr_menu_utf8(source, current, sizeof(current))) return 0;
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, current, -1, NULL, 0) - 1;
    uint32_t caret = record[0x44 / 4], first = record[0x48 / 4], focus = record[0x3c / 4], blink = record[0x50 / 4];
    if (length < 0 || caret > (uint32_t)length || first > caret || focus > 1 || blink > 1 || strlen(current) >= capacity) return 0;
    /* The default is 0x00FFFFFF (0x60FA5D); the 16-bit line painter masks it
     * to 0xFFFF at 0x62010A before writing the surface. */
    color &= 0xffff;
    uint32_t red = color >> 11, green = (color >> 5) & 63, blue = color & 31;
    edit[0] = caret; edit[1] = first; edit[2] = focus && !blink;
    edit[3] = (((red << 3) | (red >> 2)) << 16) | (((green << 2) | (green >> 4)) << 8) | (blue << 3) | (blue >> 2);
    strcpy(text, current);
    return 1;
}

/* Public GETITEMDATA is intercepted by YR and returns the application's value
 * (record+4). Its painter calls the original control procedure saved in this
 * second HWND table to retrieve the private string record. Only the GUI owner
 * may invoke that original procedure while capturing its completed picture. */
static WNDPROC yr_menu_items_procedure(HWND hwnd)
{
    return GetWindowThreadProcessId(hwnd, NULL) == GetCurrentThreadId() ? yr_menu_table_procedure(hwnd, 0xac1b48) : NULL;
}

/* 0x617A5D/0x617A7C: optional COLORREF swatches belong to the control's
 * own state, at +0xCC and +0x110. -1 denotes a text-only item. */
static int yr_menu_item_colors(HWND hwnd, uint32_t *colors, unsigned count)
{
    uint32_t record[130];
    if (count > 50 || !yr_menu_control_record(hwnd, record) || !(((unsigned char *)record)[0xd0])) return 0;
    for (unsigned index = 0; index < count; index++)
    {
        uint32_t color = record[0x114 / 4 + index];
        colors[index] = color == UINT32_MAX ? UINT32_MAX :
            ((color & 0xff) << 16) | (color & 0xff00) | ((color >> 16) & 0xff);
    }
    return 1;
}

/* 0x61848D records the custom popup HWND in its combo's state+0xF4.
 * The popup procedure 0x60D540 uses state+0xF0 for the top row, +0xE8
 * for the current highlight, and +0x0C for its actual scrollbar HWND. */
static int yr_menu_popup(HWND owner, HWND *popup, HWND *scrollbar, int32_t *top, int32_t *selection)
{
    uint32_t record[130], child[130];
    if (!yr_menu_control_record(owner, record)) return 0;
    *popup = (HWND)(uintptr_t)record[0xf8 / 4];
    *scrollbar = NULL; *top = 0; *selection = -1;
    if (!*popup) return 1;
    char class_name[64];
    if (!IsWindow(*popup) || !GetClassNameA(*popup, class_name, sizeof(class_name)) ||
        _stricmp(class_name, "ComboDropWin") || !yr_menu_control_record(*popup, child)) return 0;
    *scrollbar = (HWND)(uintptr_t)child[0x10 / 4];
    *top = (int32_t)child[0xf4 / 4]; *selection = (int32_t)child[0xec / 4];
    return *top >= 0 && *selection >= -1;
}

static HWND yr_menu_popup_owner(HWND popup)
{
    uint32_t owner;
    HWND actual, scrollbar; int32_t top, selection;
    if (!nh_identity_verified() || !yr_menu_read(0xac48d0, &owner, sizeof(owner)) ||
        !yr_menu_popup((HWND)(uintptr_t)owner, &actual, &scrollbar, &top, &selection) || actual != popup) return NULL;
    return (HWND)(uintptr_t)owner;
}

/* 0x61C690's custom scrollbar never forwards SBM_SETSCROLLINFO to Win32.
 * Its skin owns the maximum top row and current top row at state+F0/F4.
 * 0x61C814..0x61C8AE computes the actual thumb, including its logarithmic
 * size, using the supplied game's border width and 22-pixel arrow plates. */
static int yr_menu_scrollbar(HWND hwnd, RECT *thumb, RECT *groove, int32_t *maximum, int32_t *position)
{
    uint32_t record[130]; int32_t border; RECT rect;
    if (!(GetWindowLongW(hwnd, GWL_STYLE) & SBS_VERT) ||
        !yr_menu_control_record(hwnd, record) || !yr_menu_read(0xac1df0, &border, sizeof(border)) ||
        !GetWindowRect(hwnd, &rect) || border < 0 || border > 8) return 0;
    int32_t range = (int32_t)record[0xf4 / 4], pos = (int32_t)record[0xf8 / 4];
    int32_t span = rect.bottom - rect.top - 2 * border - 44;
    if (range <= 0 || range > 1000000 || pos < 0 || pos > range ||
        span < 14 || rect.right - rect.left <= 2 * border || record[0xf0 / 4]) return 0;
    int32_t length = (int32_t)(span * (1.0 - 0.2 * log((double)range + 1.0)));
    if (length < 14) length = 14;
    if (length > span) return 0;
    *maximum = range; *position = pos;
    *groove = rect; groove->left += border; groove->right -= border;
    groove->top += border + 22; groove->bottom -= border + 22;
    *thumb = *groove; thumb->top += (int32_t)(((int64_t)(span - length) * pos) / range);
    thumb->bottom = thumb->top + length;
    return 1;
}

/* 0x61D9F8..0x61DB88 caches the skinned trackbar's range, offset and step.
 * 0x61DBB9/0x61E00C draws its 12-pixel thumb; 0x61E27A formats the actual
 * quantized value. A displayed number reserves the original 50-pixel field. */
static int yr_menu_slider(HWND hwnd, RECT *thumb, RECT *groove, int32_t *min, int32_t *max,
    int32_t *value, char *value_text, size_t capacity)
{
    uint32_t record[130]; RECT rect;
    if (!yr_menu_control_record(hwnd, record) || !GetWindowRect(hwnd, &rect)) return 0;
    int32_t range = (int32_t)record[0xf4 / 4], delta = (int32_t)record[0xf8 / 4];
    int32_t minimum = (int32_t)record[0xfc / 4], offset = (int32_t)record[0x100 / 4];
    int32_t step = (int32_t)record[0x104 / 4], shown = (int32_t)record[0x108 / 4];
    if (range <= 0 || range > 1000000 || delta < 0 || delta > range || step <= 0 ||
        minimum < 0 || minimum > 1000000 || offset < 0 || offset + 13 > rect.right - rect.left - (shown ? 50 : 0)) return 0;
    *min = minimum; *max = minimum + range; *value = minimum + delta;
    *groove = rect; groove->right -= shown ? 50 : 0;
    *thumb = rect; thumb->left += offset + 1; thumb->right = thumb->left + 12;
    if (shown) snprintf(value_text, capacity, "%ld", (long)((*value / step) * step));
    else value_text[0] = 0;
    return 1;
}

/* The original list painter at 0x6193D9 reads LB/CB_GETITEMDATA, then copies
 * the UTF-16 string at record+8 (0x61940D). Missing records stay unknown. */
static int yr_menu_item_text(uint32_t record, char *text, size_t capacity)
{
    uint32_t source;
    return nh_identity_verified() && record && record != UINT32_MAX && !(record & 3) &&
        yr_menu_read(record + 8, &source, sizeof(source)) && yr_menu_utf8(source, text, capacity);
}

#endif
