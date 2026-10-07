import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  words,
  packet,
  decodePacket,
  decodeMirror,
  Mirror,
  Picture,
  subscription,
  Type,
  AgentClient,
} from './wire.mjs';

test('packet preserves binary bytes and rejects invalid lengths/version', () => {
  const bytes = Buffer.from([0, 255, 0, 128]);
  const decoded = decodePacket(packet(Type.READ, 42, bytes));
  assert.equal(decoded.id, 42);
  assert.deepEqual(decoded.payload, bytes);
  const bad = packet(2);
  bad[4] = 2;
  assert.throws(() => decodePacket(bad));
  assert.throws(() => decodePacket(packet(2).subarray(0, 15)));
});
test('cumulative mirror deltas keep older pages and exact independent samples', () => {
  const a = Buffer.alloc(4096, 17),
    b = Buffer.alloc(4096, 33);
  const m = new Mirror();
  m.apply(decodeMirror(Buffer.concat([words(100, 2, 1, 1), words(0x400000), a, words(0x400007, 2), a.subarray(7, 9)])));
  m.apply(decodeMirror(Buffer.concat([words(110, 0, 1, 1), words(0x410000), b, words(0x400007, 2), a.subarray(7, 9)])));
  assert.equal(m.read(0x400007, 2)[0], 17);
  assert.equal(m.read(0x410000, 1)[0], 33);
  assert.throws(() => m.read(0x420000, 1));
  assert.throws(() => decodeMirror(words(1, 0, 4097, 0)));
});
test('picture literal/key runs plus changed rows reconstruct exact RGB565', () => {
  const p = new Picture();
  const row0 = Buffer.from([2, 0, 0xff, 0xff, 0, 0]),
    row1 = Buffer.from([2, 0x80]);
  const full = Buffer.concat([words(1, 2, 2, 2), words(0, row0.length), row0, words(1, row1.length), row1]);
  assert.deepEqual([...p.apply(full).pixels], [255, 255, 0, 0, 31, 248, 31, 248]);
  const changed = Buffer.from([2, 0, 0xe0, 7, 0xe0, 7]);
  assert.deepEqual(
    [...p.apply(Buffer.concat([words(2, 2, 2, 1), words(0, changed.length), changed])).pixels],
    [224, 7, 224, 7, 31, 248, 31, 248],
  );
  assert.throws(() => new Picture().apply(words(1, 2, 2, 0)));
  const invalid = Buffer.concat([words(3, 2, 2, 1), words(0, 2), Buffer.from([3, 0x80])]);
  assert.throws(() => p.apply(invalid));
});
test('subscription wire layout uses bounded vector descriptors', () => {
  const p = subscription(
    [{ address: 0xa8e000, length: 4096 }],
    [{ kind: 2, source: 0xa8ec78, bytes: 0x900, maxCount: 4096, stride: 4 }],
    { sampleCount: 64 },
  );
  assert.equal(p.length, 48);
  assert.equal(p.readUInt32LE(0), 1);
  assert.equal(p.readUInt32LE(4), 1);
  assert.equal(p.readUInt32LE(16), 64);
  assert.throws(() => subscription(Array.from({ length: 4097 }, () => ({ address: 0, length: 4096 }))));
});

test('notifications carry nonzero request IDs required by the native receiver', () => {
  let raw;
  const fake = {
    nextId: 10,
    ws: {
      send: (b) => {
        raw = b;
      },
    },
  };
  AgentClient.prototype.send.call(fake, Type.ACK, words(100));
  assert.equal(decodePacket(raw).id, 10);
  assert.equal(fake.nextId, 11);
});
