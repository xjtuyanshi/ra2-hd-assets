/* Native-host transport. Socket work and file hashing stay on this I/O thread. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <wincrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "agent.h"
#include "mirror-internal.h"
#include "hidden.h"

#define NH_REPLY_SLOTS 16u
#define NH_ALLOC_SLOTS 64u
#define NH_ALLOC_LIMIT (16u * 1024u * 1024u)
#define NH_HTTP_LIMIT 8192u
#define NH_SOCKET_TIMEOUT 3000u

typedef struct {
    uint16_t type;
    uint32_t id, length;
    uint8_t *bytes;
    int ready;
} nh_packet;
typedef struct { uint32_t address, size; int pinned; } nh_allocation;

static volatile LONG nh_running, nh_ready, nh_client_present;
static volatile LONG nh_identity_ok;
static LONG nh_configured;
static SOCKET nh_listener = INVALID_SOCKET, nh_client = INVALID_SOCKET;
static HANDLE nh_wake;
static CRITICAL_SECTION nh_queue_lock;
static nh_packet nh_replies[NH_REPLY_SLOTS], nh_streams[2];
static uint32_t nh_reply_head, nh_reply_count, nh_reply_bytes;
static nh_allocation nh_allocations[NH_ALLOC_SLOTS];
static uint32_t nh_allocated;
static char nh_token[129], nh_origin[256], nh_hash[65];
static uint32_t nh_exe_size, nh_pe_timestamp;
static uint16_t nh_port;

static uint32_t nh_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void nh_put32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static int nh_range(uint32_t address, uint32_t length, int write) {
    uint64_t end = (uint64_t)address + length;
    uint64_t cursor = address;
    if (!address || end > 0x100000000ull || length > NH_MAX_MESSAGE) return 0;
    while (cursor < end) {
        MEMORY_BASIC_INFORMATION info;
        DWORD protection;
        uint64_t next;
        if (!VirtualQuery((const void *)(uintptr_t)cursor, &info, sizeof(info))) return 0;
        protection = info.Protect & 0xffu;
        if (info.State != MEM_COMMIT || (info.Protect & PAGE_GUARD) || protection == PAGE_NOACCESS || !protection) return 0;
        if (!write && protection == PAGE_EXECUTE) return 0;
        next = (uint64_t)(uintptr_t)info.BaseAddress + info.RegionSize;
        if (next <= cursor) return 0;
        cursor = next < end ? next : end;
    }
    return 1;
}

int nh_safe_read(uint32_t address, void *out, uint32_t length) {
    SIZE_T copied = 0;
    if (!length) return 1;
    if (!out || !nh_range(address, length, 0)) return 0;
    return ReadProcessMemory(GetCurrentProcess(), (const void *)(uintptr_t)address, out, length, &copied) && copied == length;
}

/* Validate the complete range first, then restore protection for each region even on failure. */
int nh_safe_write(uint32_t address, const void *bytes, uint32_t length) {
    uint32_t offset = 0;
    if (!length) return 1;
    if (!bytes || !nh_range(address, length, 1)) return 0;
    while (offset < length) {
        MEMORY_BASIC_INFORMATION info;
        DWORD old_protection, ignored, protection;
        SIZE_T copied = 0;
        uint32_t amount;
        uintptr_t pointer = (uintptr_t)address + offset;
        int ok;
        if (!VirtualQuery((const void *)pointer, &info, sizeof(info))) return 0;
        amount = (uint32_t)((uintptr_t)info.BaseAddress + info.RegionSize - pointer);
        if (amount > length - offset) amount = length - offset;
        protection = (info.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY))
            ? PAGE_EXECUTE_READWRITE : PAGE_READWRITE;
        if (!VirtualProtect((void *)pointer, amount, protection, &old_protection)) return 0;
        ok = WriteProcessMemory(GetCurrentProcess(), (void *)pointer, (const uint8_t *)bytes + offset, amount, &copied) && copied == amount;
        if (!VirtualProtect((void *)pointer, amount, old_protection, &ignored)) ok = 0;
        if (!ok) return 0;
        offset += amount;
    }
    FlushInstructionCache(GetCurrentProcess(), (const void *)(uintptr_t)address, length);
    return 1;
}

int nh_connected(void) { return InterlockedCompareExchange(&nh_client_present, 0, 0) != 0; }
int nh_identity_verified(void) { return InterlockedCompareExchange(&nh_identity_ok, 0, 0) != 0; }
int nh_allocation_contains(uint32_t address, uint32_t length) {
    uint32_t i;
    uint64_t end = (uint64_t)address + length;
    if (!length || end > 0x100000000ull) return 0;
    for (i = 0; i < NH_ALLOC_SLOTS; i++) {
        if (nh_allocations[i].address && address >= nh_allocations[i].address
            && end <= (uint64_t)nh_allocations[i].address + nh_allocations[i].size) return 1;
    }
    return 0;
}
void nh_allocation_pin(uint32_t address, uint32_t length) {
    uint32_t i;
    uint64_t end = (uint64_t)address + length;
    if (!length || end > 0x100000000ull) return;
    for (i = 0; i < NH_ALLOC_SLOTS; i++) {
        if (nh_allocations[i].address && address >= nh_allocations[i].address
            && end <= (uint64_t)nh_allocations[i].address + nh_allocations[i].size) nh_allocations[i].pinned = 1;
    }
}

static void nh_disconnect_socket(void) {
    SOCKET socket = nh_client;
    InterlockedExchange(&nh_client_present, 0);
    if (socket != INVALID_SOCKET) shutdown(socket, SD_BOTH);
    if (nh_wake) SetEvent(nh_wake);
}

/* Replies are bounded; disconnect instead of silently discarding a mutation result. */
void nh_send(uint16_t type, uint32_t id, const void *payload, uint32_t length) {
    nh_packet *packet;
    uint8_t *copy = NULL;
    if (!nh_ready || !nh_connected() || length > NH_MAX_MESSAGE || (length && !payload)) return;
    if (length) {
        copy = (uint8_t *)malloc(length);
        if (!copy) { nh_disconnect_socket(); return; }
        memcpy(copy, payload, length);
    }
    EnterCriticalSection(&nh_queue_lock);
    if (nh_reply_count >= NH_REPLY_SLOTS || length > NH_MAX_MESSAGE - nh_reply_bytes || !nh_connected()) {
        LeaveCriticalSection(&nh_queue_lock);
        free(copy);
        nh_disconnect_socket();
        return;
    }
    packet = &nh_replies[(nh_reply_head + nh_reply_count) % NH_REPLY_SLOTS];
    packet->type = type; packet->id = id; packet->length = length; packet->bytes = copy; packet->ready = 1;
    nh_reply_count++;
    nh_reply_bytes += length;
    LeaveCriticalSection(&nh_queue_lock);
    SetEvent(nh_wake);
}

int nh_publish(uint16_t type, const void *payload, uint32_t length) {
    nh_packet *packet;
    int result = 0;
    if (!nh_ready || !nh_connected() || length > NH_MAX_MESSAGE || !payload || !length) return 0;
    if (type != NH_MIRROR && type != NH_PICTURE) return 0;
    if (!TryEnterCriticalSection(&nh_queue_lock)) return 0;
    packet = &nh_streams[type == NH_MIRROR ? 0 : 1];
    if (!packet->ready && nh_connected()) {
        memcpy(packet->bytes, payload, length);
        packet->type = type; packet->id = 0; packet->length = length; packet->ready = 1;
        result = 1;
    }
    LeaveCriticalSection(&nh_queue_lock);
    if (result) SetEvent(nh_wake);
    return result;
}

int nh_publish_move(uint16_t type, uint8_t **payload, uint32_t length) {
    nh_packet *packet;
    int result = 0;
    if (!nh_ready || !nh_connected() || length > NH_MAX_MESSAGE || !payload || !*payload || !length) return 0;
    if (type != NH_MIRROR && type != NH_PICTURE) return 0;
    if (!TryEnterCriticalSection(&nh_queue_lock)) return 0;
    packet = &nh_streams[type == NH_MIRROR ? 0 : 1];
    if (!packet->ready && nh_connected()) {
        uint8_t *idle = packet->bytes;
        packet->bytes = *payload; *payload = idle;
        packet->type = type; packet->id = 0; packet->length = length; packet->ready = 1;
        result = 1;
    }
    LeaveCriticalSection(&nh_queue_lock);
    return result;
}

static int nh_crypto(ALG_ID algorithm, const void *bytes, DWORD length, uint8_t *digest, DWORD digest_length) {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    int ok = 0;
    if (!CryptAcquireContextA(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return 0;
    if (CryptCreateHash(provider, algorithm, 0, 0, &hash) && CryptHashData(hash, bytes, length, 0)
        && CryptGetHashParam(hash, HP_HASHVAL, digest, &digest_length, 0)) ok = 1;
    if (hash) CryptDestroyHash(hash);
    CryptReleaseContext(provider, 0);
    return ok;
}

static void nh_executable_identity(void) {
    WCHAR path[32768];
    HANDLE file = INVALID_HANDLE_VALUE;
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    uint8_t block[65536], digest[32];
    DWORD received, path_length, digest_length = sizeof(digest);
    LARGE_INTEGER size;
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS32 pe;
    uint32_t i;
    int headers_verified = 0;
    nh_hash[0] = 0;
    /* Wine paths supplied by the owner can contain characters outside the
     * process ANSI code page. Identity must hash that exact Unicode path. */
    path_length = GetModuleFileNameW(NULL, path, sizeof(path) / sizeof(path[0]));
    if (!path_length || path_length >= sizeof(path) / sizeof(path[0])) return;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    if (!GetFileSizeEx(file, &size) || size.HighPart || size.LowPart == INVALID_FILE_SIZE) goto done;
    nh_exe_size = size.LowPart;
    if (nh_safe_read((uint32_t)(uintptr_t)GetModuleHandleA(NULL), &dos, sizeof(dos)) && dos.e_magic == IMAGE_DOS_SIGNATURE
        && dos.e_lfanew > 0 && (uint32_t)dos.e_lfanew < nh_exe_size
        && nh_safe_read((uint32_t)(uintptr_t)GetModuleHandleA(NULL) + (uint32_t)dos.e_lfanew, &pe, sizeof(pe))
        && pe.Signature == IMAGE_NT_SIGNATURE && pe.OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC) {
        nh_pe_timestamp = pe.FileHeader.TimeDateStamp;
        headers_verified = (uint32_t)(uintptr_t)GetModuleHandleA(NULL) == 0x400000u
            && pe.OptionalHeader.ImageBase == 0x400000u && pe.FileHeader.Machine == IMAGE_FILE_MACHINE_I386
            && nh_exe_size == 4813072u && nh_pe_timestamp == 0x3bdf544eu;
    }
    if (!CryptAcquireContextA(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)
        || !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) goto done;
    for (;;) {
        if (!ReadFile(file, block, sizeof(block), &received, NULL)) goto done;
        if (!received) break;
        if (!CryptHashData(hash, block, received, 0)) goto done;
    }
    if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &digest_length, 0) || digest_length != 32) goto done;
    for (i = 0; i < 32; i++) snprintf(nh_hash + i * 2, 3, "%02x", digest[i]);
    /* The current hook is the YR 1.001 policy; a different supplied executable stays unpatched. */
    if (headers_verified && !strcmp(nh_hash, "7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6"))
        InterlockedExchange(&nh_identity_ok, 1);
done:
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
}

static int nh_environment(const char *name, char *out, DWORD capacity) {
    DWORD length = GetEnvironmentVariableA(name, out, capacity);
    if (!length || length >= capacity) { out[0] = 0; return 0; }
    return 1;
}

static int nh_configuration(void) {
    char path[MAX_PATH], port[16], enabled[16], *slash, *end;
    unsigned long parsed;
    size_t i, origin_length;
    if (!GetModuleFileNameA(NULL, path, sizeof(path))) return 0;
    slash = strrchr(path, '\\');
    if (!slash || (size_t)(slash - path) + sizeof("\\ddraw.ini") > sizeof(path)) return 0;
    strcpy(slash + 1, "ddraw.ini");
    GetPrivateProfileStringA("agent", "enabled", "0", enabled, sizeof(enabled), path);
    GetPrivateProfileStringA("agent", "port", "", port, sizeof(port), path);
    GetPrivateProfileStringA("agent", "token", "", nh_token, sizeof(nh_token), path);
    GetPrivateProfileStringA("agent", "origin", "http://127.0.0.1:5173", nh_origin, sizeof(nh_origin), path);
    if (nh_environment("RA2_NATIVE_AGENT_PORT", port, sizeof(port))) strcpy(enabled, "1");
    nh_environment("RA2_NATIVE_AGENT_TOKEN", nh_token, sizeof(nh_token));
    /* An absent environment value must preserve the INI value. */
    if (!nh_token[0]) GetPrivateProfileStringA("agent", "token", "", nh_token, sizeof(nh_token), path);
    {
        char configured_origin[256];
        if (nh_environment("RA2_NATIVE_AGENT_ORIGIN", configured_origin, sizeof(configured_origin))) strcpy(nh_origin, configured_origin);
    }
    if (strcmp(enabled, "1") || strlen(nh_token) < 32) return 0;
    for (i = 0; nh_token[i]; i++) if (!isxdigit((unsigned char)nh_token[i])) return 0;
    parsed = strtoul(port, &end, 10);
    if (!port[0] || *end || parsed < 15450 || parsed > 15459) return 0;
    nh_port = (uint16_t)parsed;
    if (!strncmp(nh_origin, "http://127.0.0.1:", 17)) i = 17;
    else if (!strncmp(nh_origin, "http://localhost:", 17)) i = 17;
    else return 0;
    origin_length = strlen(nh_origin);
    if (origin_length <= i || origin_length - i > 5) return 0;
    parsed = strtoul(nh_origin + i, &end, 10);
    if (*end || !parsed || parsed > 65535) return 0;
    return 1;
}

/* Read only the configuration before window hooks are installed. Socket and
 * identity work remain on the I/O thread outside the loader lock. */
void nh_agent_configure(void) { nh_configured = nh_configuration(); }
int nh_agent_configured(void) { return nh_configured != 0; }

static void nh_base64(const uint8_t *bytes, uint32_t length, char *out) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    uint32_t i, j = 0;
    for (i = 0; i < length; i += 3) {
        uint32_t n = (uint32_t)bytes[i] << 16;
        if (i + 1 < length) n |= (uint32_t)bytes[i + 1] << 8;
        if (i + 2 < length) n |= bytes[i + 2];
        out[j++] = alphabet[n >> 18]; out[j++] = alphabet[(n >> 12) & 63];
        out[j++] = i + 1 < length ? alphabet[(n >> 6) & 63] : '=';
        out[j++] = i + 2 < length ? alphabet[n & 63] : '=';
    }
    out[j] = 0;
}

static int nh_send_all(SOCKET socket, const void *bytes, uint32_t length) {
    const char *cursor = (const char *)bytes;
    while (length && nh_running) {
        int sent = send(socket, cursor, (int)length, 0);
        if (sent <= 0) return 0;
        cursor += sent; length -= (uint32_t)sent;
    }
    return !length;
}

static int nh_recv_all(SOCKET socket, void *bytes, uint32_t length) {
    char *cursor = (char *)bytes;
    while (length && nh_running) {
        int received = recv(socket, cursor, (int)length, 0);
        if (received <= 0) return 0;
        cursor += received; length -= (uint32_t)received;
    }
    return !length;
}

static int nh_send_ws(SOCKET socket, uint8_t opcode, const void *payload, uint32_t length) {
    uint8_t header[10];
    uint32_t header_length;
    header[0] = (uint8_t)(0x80u | opcode);
    if (length < 126) { header[1] = (uint8_t)length; header_length = 2; }
    else if (length <= 65535) {
        header[1] = 126; header[2] = (uint8_t)(length >> 8); header[3] = (uint8_t)length; header_length = 4;
    } else {
        header[1] = 127; memset(header + 2, 0, 4);
        header[6] = (uint8_t)(length >> 24); header[7] = (uint8_t)(length >> 16);
        header[8] = (uint8_t)(length >> 8); header[9] = (uint8_t)length; header_length = 10;
    }
    return nh_send_all(socket, header, header_length) && (!length || nh_send_all(socket, payload, length));
}

static int nh_send_packet(SOCKET socket, const nh_packet *packet) {
    uint8_t envelope[26], *ws = envelope, *header;
    uint32_t total = packet->length + 16, ws_length;
    ws[0] = 0x82;
    if (total < 126) { ws[1] = (uint8_t)total; ws_length = 2; }
    else if (total <= 65535) { ws[1] = 126; ws[2] = (uint8_t)(total >> 8); ws[3] = (uint8_t)total; ws_length = 4; }
    else {
        ws[1] = 127; memset(ws + 2, 0, 4); ws[6] = (uint8_t)(total >> 24); ws[7] = (uint8_t)(total >> 16);
        ws[8] = (uint8_t)(total >> 8); ws[9] = (uint8_t)total; ws_length = 10;
    }
    header = envelope + ws_length;
    nh_put32(header, NH_MAGIC); header[4] = NH_VERSION; header[5] = 0;
    header[6] = (uint8_t)packet->type; header[7] = (uint8_t)(packet->type >> 8);
    nh_put32(header + 8, packet->id); nh_put32(header + 12, packet->length);
    return nh_send_all(socket, envelope, ws_length + 16)
        && (!packet->length || nh_send_all(socket, packet->bytes, packet->length));
}

static int nh_equal_secret(const char *a, const char *b) {
    size_t i, na = strlen(a), nb = strlen(b);
    unsigned different = (unsigned)(na ^ nb);
    if (na > 128 || nb > 128) return 0;
    for (i = 0; i < 128; i++) different |= (unsigned)((i < na ? a[i] : 0) ^ (i < nb ? b[i] : 0));
    return !different;
}

static int nh_handshake(SOCKET socket) {
    char request[NH_HTTP_LIMIT + 1], response[512], expected_host[64];
    char key[25] = {0}, origin[256] = {0}, token[129] = {0}, joined[128], accept[32];
    char *cursor, *line, *colon, *value, *end;
    uint8_t digest[20];
    uint32_t length = 0, seen = 0;
    int upgrade = 0, connection = 0;
    snprintf(expected_host, sizeof(expected_host), "127.0.0.1:%u", nh_port);
    while (length < NH_HTTP_LIMIT) {
        int received = recv(socket, request + length, (int)(NH_HTTP_LIMIT - length), 0);
        if (received <= 0) return 0;
        length += (uint32_t)received; request[length] = 0;
        if (strstr(request, "\r\n\r\n")) break;
    }
    end = strstr(request, "\r\n\r\n");
    if (!end || (uint32_t)(end - request + 4) != length) return 0;
    cursor = strstr(request, "\r\n");
    if (!cursor) return 0;
    *cursor = 0;
    if (strncmp(request, "GET /?token=", 12)) return 0;
    line = strstr(request + 12, " HTTP/1.1");
    if (!line || line[9] || (size_t)(line - request - 12) > 128) return 0;
    memcpy(token, request + 12, (size_t)(line - request - 12));
    if (!nh_equal_secret(token, nh_token)) return 0;
    cursor += 2;
    while (*cursor && cursor < end) {
        line = cursor; cursor = strstr(cursor, "\r\n");
        if (!cursor) return 0;
        *cursor = 0; cursor += 2;
        colon = strchr(line, ':');
        if (!colon || line[0] == ' ' || line[0] == '\t') return 0;
        *colon = 0; value = colon + 1;
        while (*value == ' ' || *value == '\t') value++;
        if (!_stricmp(line, "Host")) {
            if ((seen & 1) || _stricmp(value, expected_host)) return 0;
            seen |= 1;
        } else if (!_stricmp(line, "Origin")) {
            if ((seen & 2) || strlen(value) >= sizeof(origin)) return 0;
            strcpy(origin, value); seen |= 2;
        } else if (!_stricmp(line, "Sec-WebSocket-Key")) {
            size_t i;
            if ((seen & 4) || strlen(value) != 24 || value[22] != '=' || value[23] != '=') return 0;
            for (i = 0; i < 22; i++) if (!isalnum((unsigned char)value[i]) && value[i] != '+' && value[i] != '/') return 0;
            strcpy(key, value); seen |= 4;
        } else if (!_stricmp(line, "Upgrade")) {
            if ((seen & 8) || _stricmp(value, "websocket")) return 0;
            upgrade = 1; seen |= 8;
        } else if (!_stricmp(line, "Connection")) {
            /* Browsers and ws send this exact upgrade value; ambiguous lists are rejected. */
            if ((seen & 16) || _stricmp(value, "Upgrade")) return 0;
            connection = 1; seen |= 16;
        } else if (!_stricmp(line, "Sec-WebSocket-Version")) {
            if ((seen & 32) || strcmp(value, "13")) return 0;
            seen |= 32;
        } else if (!_stricmp(line, "Content-Length") || !_stricmp(line, "Transfer-Encoding")) return 0;
    }
    if (seen != 63 || !upgrade || !connection || strcmp(origin, nh_origin)) return 0;
    snprintf(joined, sizeof(joined), "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    if (!nh_crypto(CALG_SHA1, joined, (DWORD)strlen(joined), digest, sizeof(digest))) return 0;
    nh_base64(digest, sizeof(digest), accept);
    snprintf(response, sizeof(response), "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept);
    return nh_send_all(socket, response, (uint32_t)strlen(response));
}

static void nh_error(uint32_t id, const char *message) { nh_send(NH_ERROR, id, message, (uint32_t)strlen(message)); }

static void nh_memory_dispatch(uint16_t type, uint32_t id, const uint8_t *payload, uint32_t length) {
    uint32_t address, amount, frame, after, expected, i;
    uint8_t *reply;
    if (type == NH_READ) {
        if (length != 12) { nh_error(id, "READ requires address,length,expectedFrame"); return; }
        address = nh_u32(payload); amount = nh_u32(payload + 4); expected = nh_u32(payload + 8);
        if (amount > NH_MAX_MESSAGE - 12) { nh_error(id, "READ too large"); return; }
        frame = nh_current_frame();
        if (expected != NH_NO_FRAME && expected != frame) { nh_error(id, "READ logic frame changed"); return; }
        reply = (uint8_t *)malloc(amount + 12);
        if (!reply) { nh_error(id, "READ allocation failed"); return; }
        if (!nh_safe_read(address, reply + 12, amount)) { free(reply); nh_error(id, "READ invalid or changing address"); return; }
        after = nh_current_frame();
        if (expected != NH_NO_FRAME && after != expected) { free(reply); nh_error(id, "READ logic frame changed"); return; }
        nh_put32(reply, frame); nh_put32(reply + 4, address); nh_put32(reply + 8, amount);
        nh_send(type, id, reply, amount + 12); free(reply);
    } else if (type == NH_WRITE) {
        if (length < 8 || nh_u32(payload + 4) != length - 8) { nh_error(id, "WRITE length mismatch"); return; }
        if (!nh_safe_write(nh_u32(payload), payload + 8, length - 8)) { nh_error(id, "WRITE invalid address or protection failure"); return; }
        nh_send(type, id, NULL, 0);
    } else if (type == NH_ALLOC) {
        DWORD protection;
        void *memory;
        uint8_t result[8];
        if (length != 12) { nh_error(id, "ALLOC requires size,preferred,executable"); return; }
        amount = nh_u32(payload); address = nh_u32(payload + 4);
        if (!amount || amount > NH_ALLOC_LIMIT - nh_allocated || nh_u32(payload + 8) > 1) { nh_error(id, "ALLOC invalid size or allocation limit"); return; }
        for (i = 0; i < NH_ALLOC_SLOTS; i++) if (!nh_allocations[i].address) break;
        if (i == NH_ALLOC_SLOTS) { nh_error(id, "ALLOC slot limit"); return; }
        protection = nh_u32(payload + 8) ? PAGE_EXECUTE_READWRITE : PAGE_READWRITE;
        memory = VirtualAlloc((void *)(uintptr_t)address, amount, MEM_COMMIT | MEM_RESERVE, protection);
        if (!memory) { nh_error(id, "ALLOC failed at requested address"); return; }
        nh_allocations[i].address = (uint32_t)(uintptr_t)memory; nh_allocations[i].size = amount; nh_allocated += amount;
        nh_put32(result, (uint32_t)(uintptr_t)memory); nh_put32(result + 4, amount); nh_send(type, id, result, sizeof(result));
    } else if (type == NH_FREE) {
        if (length != 4) { nh_error(id, "FREE requires owned base address"); return; }
        address = nh_u32(payload);
        for (i = 0; i < NH_ALLOC_SLOTS; i++) if (nh_allocations[i].address == address && address) break;
        if (i == NH_ALLOC_SLOTS) { nh_error(id, "FREE address not agent owned"); return; }
        if (nh_allocations[i].pinned) { nh_error(id, "FREE allocation retained by installed patch lifecycle"); return; }
        if (!VirtualFree((void *)(uintptr_t)address, 0, MEM_RELEASE)) { nh_error(id, "FREE failed"); return; }
        nh_allocated -= nh_allocations[i].size; memset(&nh_allocations[i], 0, sizeof(nh_allocations[i]));
        nh_send(type, id, NULL, 0);
    }
}

static int nh_receive(SOCKET socket, uint8_t *buffer) {
    uint8_t header[2], extended[8], mask[4];
    uint64_t length;
    uint32_t i, id, payload_length;
    uint16_t type;
    uint8_t opcode;
    if (!nh_recv_all(socket, header, 2)) return 0;
    opcode = header[0] & 15;
    if (!(header[0] & 0x80) || (header[0] & 0x70) || !(header[1] & 0x80)) return 0;
    length = header[1] & 127;
    if (length == 126) {
        if (!nh_recv_all(socket, extended, 2)) return 0;
        length = ((uint32_t)extended[0] << 8) | extended[1];
        if (length < 126) return 0;
    } else if (length == 127) {
        if (!nh_recv_all(socket, extended, 8)) return 0;
        length = 0; for (i = 0; i < 8; i++) length = (length << 8) | extended[i];
        if (length <= 65535) return 0;
    }
    if (length > NH_MAX_MESSAGE + 16 || (opcode >= 8 && length > 125) || !nh_recv_all(socket, mask, 4)
        || !nh_recv_all(socket, buffer, (uint32_t)length)) return 0;
    for (i = 0; i < length; i++) buffer[i] ^= mask[i & 3];
    if (opcode == 8) { nh_send_ws(socket, 8, buffer, (uint32_t)length); return 0; }
    if (opcode == 9) return nh_send_ws(socket, 10, buffer, (uint32_t)length);
    if (opcode == 10) return 1;
    if (opcode != 2 || length < 16 || nh_u32(buffer) != NH_MAGIC || buffer[4] != NH_VERSION || buffer[5]) return 0;
    type = (uint16_t)(buffer[6] | ((uint16_t)buffer[7] << 8)); id = nh_u32(buffer + 8); payload_length = nh_u32(buffer + 12);
    if (payload_length != length - 16 || !id) return 0;
    if (type == NH_READ || type == NH_WRITE || type == NH_ALLOC || type == NH_FREE)
        nh_memory_dispatch(type, id, buffer + 16, payload_length);
    else if (type == NH_HOOK || type == NH_SUBSCRIBE || type == NH_ACK || type == NH_BATCH || type == NH_SAMPLE)
        nh_dispatch_mirror(type, id, buffer + 16, payload_length);
    else if (type == NH_INPUT || type == NH_INPUT_STATE || type == NH_CREDIT)
        nh_dispatch_input(type, id, buffer + 16, payload_length);
    else if (type == NH_DIAGNOSTICS) {
        char fragment[2048], hidden_host[768], diagnostic[3072];
        if (payload_length) nh_error(id, "DIAGNOSTICS takes no payload");
        else {
            nh_mirror_diagnostics(fragment, sizeof(fragment));
            nh_hidden_diagnostics(hidden_host, sizeof(hidden_host));
            snprintf(diagnostic, sizeof(diagnostic), "{%s,\"gameThreadId\":%u,\"allocatedBytes\":%u,\"replyQueue\":%u,\"hidden\":%s,\"hiddenHost\":%s}", fragment, nh_game_thread_id(), nh_allocated, nh_reply_count, nh_hidden_active() ? "true" : "false", hidden_host);
            nh_send(type, id, diagnostic, (uint32_t)strlen(diagnostic));
        }
    } else nh_error(id, "Unsupported request type");
    return 1;
}

static void nh_clear_queue(void) {
    uint32_t i;
    EnterCriticalSection(&nh_queue_lock);
    for (i = 0; i < NH_REPLY_SLOTS; i++) {
        free(nh_replies[i].bytes); memset(&nh_replies[i], 0, sizeof(nh_replies[i]));
    }
    nh_reply_head = nh_reply_count = nh_reply_bytes = 0;
    nh_streams[0].ready = nh_streams[1].ready = 0;
    LeaveCriticalSection(&nh_queue_lock);
}

static int nh_flush(SOCKET socket, uint8_t **staging) {
    nh_packet packet;
    uint32_t index;
    int reply = 0, found = 0, ok;
    memset(&packet, 0, sizeof(packet));
    EnterCriticalSection(&nh_queue_lock);
    if (nh_reply_count) {
        packet = nh_replies[nh_reply_head]; memset(&nh_replies[nh_reply_head], 0, sizeof(packet));
        nh_reply_head = (nh_reply_head + 1) % NH_REPLY_SLOTS; nh_reply_count--; nh_reply_bytes -= packet.length; reply = found = 1;
    } else for (index = 0; index < 2; index++) if (nh_streams[index].ready) {
        packet = nh_streams[index]; nh_streams[index].bytes = *staging; nh_streams[index].ready = 0;
        *staging = packet.bytes; found = 1; break;
    }
    LeaveCriticalSection(&nh_queue_lock);
    if (!found) return 1;
    ok = nh_send_packet(socket, &packet);
    if (ok && packet.type == NH_PICTURE) nh_picture_sent();
    if (reply) free(packet.bytes);
    return ok ? 2 : 0;
}

static void nh_session(SOCKET socket, uint8_t *receive, uint8_t **staging) {
    char hello[1536], hidden_host[768];
    uint32_t width = 0, height = 0, bpp = 0;
    nh_packet packet;
    nh_surface_info(&width, &height, &bpp);
    nh_hidden_diagnostics(hidden_host, sizeof(hidden_host));
    snprintf(hello, sizeof(hello), "{\"protocol\":%u,\"pid\":%lu,\"gameThreadId\":%u,\"hidden\":%s,\"hiddenHost\":%s,\"exe\":{\"size\":%u,\"peTimestamp\":%u,\"sha256\":\"%s\",\"verified\":%s},\"surface\":{\"width\":%u,\"height\":%u,\"bpp\":%u,\"format\":\"RGB565\"},\"limits\":{\"messageBytes\":%u,\"pages\":%u,\"rules\":%u,\"pageRemovals\":true,\"subscribeRevision\":true,\"maxBudgetUs\":%u,\"followRuleKinds\":[1,2,3,4,5,6,7,8]}}",
        NH_VERSION, (unsigned long)GetCurrentProcessId(), nh_game_thread_id(), nh_hidden_active() ? "true" : "false", hidden_host, nh_exe_size, nh_pe_timestamp, nh_hash,
        nh_identity_verified() ? "true" : "false", width, height, bpp, NH_MAX_MESSAGE, NH_MAX_PAGES, NH_MAX_RULES, NH_MIRROR_MAX_BUDGET_US);
    memset(&packet, 0, sizeof(packet)); packet.type = NH_HELLO; packet.length = (uint32_t)strlen(hello); packet.bytes = (uint8_t *)hello;
    if (!nh_send_packet(socket, &packet)) return;
    InterlockedExchange(&nh_client_present, 1);
    while (nh_running && nh_connected()) {
        fd_set readable;
        struct timeval timeout;
        int selected, flushed;
        /* Cap reply draining so incoming ACK/input cannot starve behind stream traffic. */
        uint32_t i;
        for (i = 0; i < NH_REPLY_SLOTS + 2; i++) { flushed = nh_flush(socket, staging); if (!flushed) return; if (flushed == 1) break; }
        FD_ZERO(&readable); FD_SET(socket, &readable); timeout.tv_sec = 0; timeout.tv_usec = 2000;
        selected = select(0, &readable, NULL, NULL, &timeout);
        if (selected == SOCKET_ERROR || (selected > 0 && !nh_receive(socket, receive))) return;
    }
}

static DWORD WINAPI nh_io_thread(void *unused) {
    WSADATA winsock;
    HMODULE agent_module;
    struct sockaddr_in address, peer;
    uint8_t *receive = NULL, *staging = NULL;
    DWORD timeout = NH_SOCKET_TIMEOUT;
    uint32_t i;
    int initialized = 0;
    (void)unused;
    if (!nh_agent_configured()) { InterlockedExchange(&nh_running, 0); return 0; }
    /* A configured agent owns process-lifetime executable reservations and its
     * worker may still be unwinding after nonblocking DllMain teardown. Pin the
     * containing module before any hooks or callbacks become reachable. This is
     * deliberately outside loader lock; the disabled stock path stays unpinned. */
    if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
            (LPCSTR)(uintptr_t)&nh_io_thread, &agent_module)) {
        InterlockedExchange(&nh_running, 0); return 0;
    }
    InitializeCriticalSection(&nh_queue_lock); initialized = 1;
    nh_wake = CreateEventA(NULL, FALSE, FALSE, NULL);
    for (i = 0; i < 2; i++) nh_streams[i].bytes = (uint8_t *)malloc(NH_MAX_MESSAGE);
    receive = (uint8_t *)malloc(NH_MAX_MESSAGE + 16); staging = (uint8_t *)malloc(NH_MAX_MESSAGE);
    if (!nh_wake || !nh_streams[0].bytes || !nh_streams[1].bytes || !receive || !staging) goto done;
    nh_executable_identity();
    if (WSAStartup(MAKEWORD(2, 2), &winsock)) goto done;
    nh_listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (nh_listener == INVALID_SOCKET) { WSACleanup(); goto done; }
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_port = htons(nh_port); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    /* Exclusive bind prevents a second agent from ambiguously accepting this token. */
    { BOOL exclusive = TRUE; setsockopt(nh_listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive, sizeof(exclusive)); }
    if (bind(nh_listener, (const struct sockaddr *)&address, sizeof(address)) || listen(nh_listener, 1)) goto sockets_done;
    InterlockedExchange(&nh_ready, 1);
    while (nh_running) {
        int peer_length = sizeof(peer);
        nh_client = accept(nh_listener, (struct sockaddr *)&peer, &peer_length);
        if (nh_client == INVALID_SOCKET) break;
        setsockopt(nh_client, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
        setsockopt(nh_client, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout, sizeof(timeout));
        { BOOL nodelay = TRUE; setsockopt(nh_client, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay)); }
        if (peer.sin_addr.s_addr == htonl(INADDR_LOOPBACK) && nh_handshake(nh_client)) nh_session(nh_client, receive, &staging);
        InterlockedExchange(&nh_client_present, 0);
        shutdown(nh_client, SD_BOTH); closesocket(nh_client); nh_client = INVALID_SOCKET;
        nh_mirror_disconnect(); nh_input_disconnect(); nh_picture_disconnect(); nh_clear_queue();
    }
sockets_done:
    InterlockedExchange(&nh_ready, 0);
    if (nh_listener != INVALID_SOCKET) { closesocket(nh_listener); nh_listener = INVALID_SOCKET; }
    WSACleanup();
done:
    InterlockedExchange(&nh_ready, 0); InterlockedExchange(&nh_running, 0);
    if (initialized) nh_clear_queue();
    free(receive); free(staging); for (i = 0; i < 2; i++) { free(nh_streams[i].bytes); nh_streams[i].bytes = NULL; }
    if (nh_wake) { CloseHandle(nh_wake); nh_wake = NULL; }
    /* Do not free agent allocations on disconnect: installed guest trampolines may still reference them. */
    return 0;
}

void nh_agent_start(void) {
    HANDLE thread;
    if (!nh_agent_configured()) nh_agent_configure();
    if (!nh_agent_configured()) return;
    if (InterlockedCompareExchange(&nh_running, 1, 0)) return;
    thread = CreateThread(NULL, 0, nh_io_thread, NULL, 0, NULL);
    if (thread) CloseHandle(thread); else InterlockedExchange(&nh_running, 0);
}

/* DllMain must never join the I/O worker or wait for socket shutdown. */
void nh_agent_stop(void) {
    InterlockedExchange(&nh_running, 0); InterlockedExchange(&nh_ready, 0);
    nh_disconnect_socket();
    if (nh_listener != INVALID_SOCKET) { closesocket(nh_listener); nh_listener = INVALID_SOCKET; }
}
