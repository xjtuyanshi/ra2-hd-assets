// Read-only diagnostics for the player's pinned original YR 1.001 shell.
// Surface checksums are bounded region observations, never a coherent raster claim.
export async function inspect(worker, options = {}) {
  return worker.evaluate(async (options) => {
    const core = globalThis.__auditCore;
    const expectedImage = '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6';
    if (core?.hello?.exe?.sha256?.toLowerCase() !== expectedImage)
      throw new Error('Paint audit requires the pinned player-owned YR 1.001 executable');
    const started = performance.now();
    const report = {
      readOnly: true,
      coherentRaster: false,
      startedAtMs: started,
      limits: { requests: 512, bytes: 1048576, durationMs: 15000, controls: 32, linkedNodes: 32 },
      requests: 0,
      bytes: 0,
      errors: [],
      controls: [],
      surfaces: {},
    };
    const read = async (address, length) => {
      if (!Number.isInteger(address) || address < 0x10000 || address + length > 0x100000000)
        throw new Error('Invalid bounded native address');
      if (report.requests >= report.limits.requests || report.bytes + length > report.limits.bytes)
        throw new Error('Paint audit read budget reached');
      if (performance.now() - started > report.limits.durationMs) throw new Error('Paint audit deadline reached');
      report.requests++;
      report.bytes += length;
      const result = await core.connection.read(address, length);
      return new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    };
    const equal = (a, b) => {
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) if (a.getUint8(i) !== b.getUint8(i)) return false;
      return true;
    };
    const words = (view) => Array.from({ length: view.byteLength / 4 }, (_, i) => view.getUint32(i * 4, true));
    const table = async (address, nextOffset) => {
      const header = await read(address, 0x20);
      const buckets = header.getUint32(0, true),
        count = header.getUint32(4, true),
        bits = header.getUint32(12, true),
        hashProcedure = header.getUint32(24, true);
      if (bits > 12 || !buckets || count > 512) throw new Error('Unbounded native HWND table');
      const code = await read(hashProcedure, 3);
      if (code.getUint8(0) !== 0x8b || code.getUint8(1) !== 0x01 || code.getUint8(2) !== 0xc3)
        throw new Error('Native HWND hash instruction signature differs');
      return {
        address,
        buckets,
        count,
        bits,
        hashProcedure,
        header,
        async find(hwnd) {
          const bucket = (await read(buckets + (hwnd & ((1 << bits) - 1)) * 4, 4)).getUint32(0, true);
          let node = bucket;
          const seen = new Set();
          for (let depth = 0; node && depth < report.limits.linkedNodes; depth++) {
            if (seen.has(node)) throw new Error('Native HWND table cycle');
            seen.add(node);
            const value = await read(node, nextOffset + 4);
            if (value.getUint32(0, true) === hwnd) return { node, value };
            node = value.getUint32(nextOffset, true);
          }
          if (node) throw new Error('Native HWND chain budget reached');
          return null;
        },
      };
    };
    const boundedText = async (pointer) => {
      if (!pointer) return null;
      const text = await read(pointer, 256);
      let result = '';
      for (let i = 0; i < text.byteLength; i += 2) {
        const code = text.getUint16(i, true);
        if (!code) return { text: result, terminated: true, bound: 128 };
        result += String.fromCharCode(code);
      }
      return { text: result, terminated: false, bound: 128 };
    };
    const checksum = (view, rowBytes, pitch, height) => {
      let hash = 0x811c9dc5;
      let nonzero = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < rowBytes; x++) {
          const value = view.getUint8(y * pitch + x);
          hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
          if (value) nonzero++;
        }
      return { fnv1a32: hash.toString(16).padStart(8, '0'), bytesHashed: rowBytes * height, nonzeroBytes: nonzero };
    };
    const selectedIds = Array.isArray(options.ids) ? new Set(options.ids.slice(0, 32)) : null;
    try {
      report.requests++;
      const stateBytes = await core.connection.request(14);
      report.bytes += stateBytes.byteLength;
      const state = JSON.parse(new TextDecoder().decode(stateBytes));
      const controls = (state.controls ?? [])
        .filter(
          (c) => c.visible && (selectedIds ? selectedIds.has(c.id) : /^(?:Static|msctls_trackbar32)$/i.test(c.class)),
        )
        .slice(0, report.limits.controls);
      report.inputRootHwnd = state.targetHwnd ?? state.rootHwnd ?? null;
      report.availableRelevantControls = (state.controls ?? []).filter(
        (c) => c.visible && /^(?:Static|msctls_trackbar32)$/i.test(c.class),
      ).length;
      const active = await read(0xa8ed80, 4),
        paintGlobals = await read(0xac48dc, 16);
      report.commonShell = {
        active: active.getUint8(0),
        paintDepth: paintGlobals.getUint32(0, true),
        regionRight: paintGlobals.getInt32(4, true),
        regionBottom: paintGlobals.getInt32(8, true),
        geometryChanging: paintGlobals.getUint8(12),
      };
      const records = await table(0xac1b00, 0x204),
        nativeCallbacks = await table(0xac18c0, 8),
        stockCallbacks = await table(0xac1b48, 8);
      report.tables = [records, nativeCallbacks, stockCallbacks].map((t) => ({
        address: t.address,
        buckets: t.buckets,
        count: t.count,
        bits: t.bits,
        hashProcedure: t.hashProcedure,
      }));
      for (const control of controls) {
        const entry = { ...control, native: null };
        report.controls.push(entry);
        try {
          const record = await records.find(control.hwnd);
          const native = await nativeCallbacks.find(control.hwnd),
            stock = await stockCallbacks.find(control.hwnd);
          entry.nativeCallback = native?.value.getUint32(4, true) ?? null;
          entry.previousCallback = stock?.value.getUint32(4, true) ?? null;
          if (!record) continue;
          // The node's HWND key precedes the original 0x200-byte control record.
          const value = record.value;
          const u32 = (offset) => value.getUint32(offset + 4, true);
          const u8 = (offset) => value.getUint8(offset + 4);
          entry.native = {
            recordAddress: record.node + 4,
            field00: u32(0),
            window: u32(0x14),
            textPointer: u32(0x28),
            animationObject: u32(0x58),
            mode: u32(0x70),
            substringCount: u32(0x80),
            substringOrigin: u32(0x8c),
            animationEnabled: u8(0xa8),
            paintSuppressed: u8(0xbc),
            commonPaintStage: u32(0x1fc),
          };
          entry.native.resolvedText = await boundedText(entry.native.textPointer);
          const identityAfter = await read(record.node, 4);
          entry.native.keyStillMatches = identityAfter.getUint32(0, true) === control.hwnd;
        } catch (error) {
          entry.error = String(error);
        }
      }
      for (const t of [records, nativeCallbacks, stockCallbacks]) {
        const after = await read(t.address, 0x20);
        report.tables.find((v) => v.address === t.address).headerUnchanged = equal(t.header, after);
      }
      const pointers = await read(0x887308, 12);
      report.gameSurfacePointers = words(pointers);
      const regions = controls.filter((c) => Array.isArray(c.rect)).slice(0, 4);
      for (const [name, slot] of [
        ['primary', 0],
        ['alternate', 2],
      ]) {
        const gameSurface = pointers.getUint32(slot * 4, true);
        const entry = { gameSurface, regions: [] };
        report.surfaces[name] = entry;
        if (!gameSurface) continue;
        try {
          const gameHeader = await read(gameSurface, 0x24);
          const wrappedSurface = gameHeader.getUint32(0x1c, true);
          entry.gameHeader = words(gameHeader);
          entry.wrappedSurface = wrappedSurface;
          if (!wrappedSurface) continue;
          // Offsets come from the bridge's current i686 IDirectDrawSurfaceImpl.
          const wrappedHeader = await read(wrappedSurface, 0x464);
          const bpp = wrappedHeader.getUint32(8, true),
            width = wrappedHeader.getUint32(12, true),
            height = wrappedHeader.getUint32(16, true),
            buffer = wrappedHeader.getUint32(0x444, true),
            pitch = wrappedHeader.getUint32(0x44c, true);
          Object.assign(entry, { bpp, width, height, buffer, pitch, caps: wrappedHeader.getUint32(28, true) });
          if (
            ![16, 32].includes(bpp) ||
            !width ||
            !height ||
            width > 4096 ||
            height > 4096 ||
            pitch < width * (bpp / 8) ||
            pitch > 32768
          )
            throw new Error('Unsupported bounded surface geometry');
          for (const control of regions) {
            const x = Math.max(0, Math.min(width - 1, Math.floor(control.rect[0]))),
              y = Math.max(0, Math.min(height - 1, Math.floor(control.rect[1]))),
              w = Math.max(1, Math.min(256, width - x, Math.floor(control.rect[2]) - x)),
              h = Math.max(1, Math.min(16, height - y, Math.floor(control.rect[3]) - y));
            const rowBytes = w * (bpp / 8),
              length = (h - 1) * pitch + rowBytes;
            const bytes = await read(buffer + y * pitch + x * (bpp / 8), length);
            entry.regions.push({
              id: control.id,
              hwnd: control.hwnd,
              rect: [x, y, x + w, y + h],
              ...checksum(bytes, rowBytes, pitch, h),
            });
          }
          const wrappedAfter = await read(wrappedSurface, 0x464),
            gameAfter = await read(gameSurface, 0x24);
          entry.headersUnchanged = equal(wrappedHeader, wrappedAfter) && equal(gameHeader, gameAfter);
        } catch (error) {
          entry.error = String(error);
        }
      }
      const surfacePointersAfter = await read(0x887308, 12);
      report.surfacePointersUnchanged = equal(pointers, surfacePointersAfter);
    } catch (error) {
      report.errors.push(String(error));
    }
    report.durationMs = performance.now() - started;
    return report;
  }, options);
}
