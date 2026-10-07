#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient, Type, words, Picture } from './wire.mjs';
import { outputDirectory, writePng } from './artifacts.mjs';

const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    out: { type: 'string' },
    step: { type: 'string', default: 'all' },
    control: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'node scripts/remaster/native/menu-smoke.mjs [--step all|state|main-options|main-options-close|single-player|skirmish|allied-six|start|deploy-mcv|options-open|options-close|quit-open|quit-cancel|click|combo-probe|combo-cycle|combo-popup --control id=NNN]\nRun at the main menu after the runner writes XMP26S6 / five Easy AIs. Every action uses INPUT cursor/key/postMessage only; no window handles, BM_CLICK or game-state writes are sent by the client. Step mode permits external ctl windows observations between actions. all exercises main options, starts a six-player match, opens pause/options, cancels quit and resumes. deploy-mcv separately cycles normal unit selection, deploys the selected MCV and observes a real construction yard. Combo steps change an actual selection through keyboard or popup mouse input and restore the observed original selection; use a skirmish country control rather than resolution. combo-probe records native state/pictures after ordinary mouse-down and after its guaranteed release, without selection commands. Optional allied-six selects team index 1 through ordinary input in all six existing Team controls, records the preset and leaves it applied for a crash soak; all never invokes this preset.',
  );
  process.exit(0);
}
if (!o.token) throw new Error('Supply a configured token');
const out = outputDirectory(o.out),
  stamp = new Date().toISOString().replaceAll(':', '-'),
  client = new AgentClient(o.url, o.token, o.origin),
  picture = new Picture(),
  report = { step: o.step, hello: null, observations: [], pictures: [], battle: null, error: null };
let failure = null;
let pictureWaiter = null;
client.on('failure', (e) => (failure = e));
client.on('agent-error', (e) => (failure = e));
client.on('packet', (packet) => {
  if (packet.type !== Type.PICTURE) return;
  try {
    const frame = picture.apply(packet.payload);
    if (report.hello) report.hello.surface = { width: frame.width, height: frame.height, bpp: 16, format: 'RGB565' };
    pictureWaiter?.resolve({ ...frame, pixels: Buffer.from(frame.pixels) });
  } catch (e) {
    failure = e;
    pictureWaiter?.reject(e);
  }
});
async function capture(label) {
  if (pictureWaiter) throw new Error('Native picture credit is already outstanding');
  let timer;
  const frame = new Promise((resolveFrame, reject) => {
    timer = setTimeout(() => reject(new Error(`Native picture timeout for ${label}`)), 8000);
    pictureWaiter = { resolve: resolveFrame, reject };
  });
  try {
    const [, image] = await Promise.all([client.request(Type.CREDIT, words(1)), frame]);
    const path = resolve(out, 'run', 'menu-shots', `${stamp}-${o.step}-${report.pictures.length}-${label}.png`);
    mkdirSync(resolve(out, 'run', 'menu-shots'), { recursive: true });
    writePng(path, image);
    const entry = { label, frame: image.frame, width: image.width, height: image.height, path };
    report.pictures.push(entry);
    console.log('native-picture', JSON.stringify(entry));
    return image;
  } finally {
    clearTimeout(timer);
    pictureWaiter = null;
  }
}
async function state(label, print = true) {
  if (failure) throw failure;
  const s = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
  if (s.controlsTruncated) throw new Error('Dialog control enumeration truncated');
  if (print) {
    report.observations.push({ label, state: s });
    console.log(label, JSON.stringify(s));
    const image = await capture(label);
    if (s.modal) {
      const outside = s.controls.filter(
        (c) =>
          usable(c) &&
          c.class !== 'ComboLBox' &&
          (c.rect[0] < 0 || c.rect[1] < 0 || c.rect[2] > image.width || c.rect[3] > image.height),
      );
      if (outside.length) throw new Error(`Visible dialog controls outside native picture: ${JSON.stringify(outside)}`);
    }
  }
  return s;
}
const usable = (c) => c.visible && c.enabled && c.rect[2] > c.rect[0] && c.rect[3] > c.rect[1];
function find(s, match) {
  return s.controls.find((c) => usable(c) && (typeof match === 'number' ? c.id === match : match.test(c.text)));
}
async function waitFor(label, check, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const s = await state(label, false);
    if (check(s)) return state(label);
    await delay(200);
  }
  await state(`${label}-timeout`);
  throw new Error(`Timed out waiting for ${label}`);
}
async function input(kind, a, b = 0, c = 0) {
  await client.request(Type.INPUT, words(kind, a, b, c));
}
function controlSelector() {
  if (!o.control) throw new Error('This step requires --control id=NNN or text=exact-label');
  const match = /^id=(\d+)$/.exec(o.control);
  return match
    ? +match[1]
    : new RegExp(`^${o.control.replace(/^text=/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}
async function mouseAt(x, y) {
  const point = ((y & 0xffff) << 16) | (x & 0xffff);
  if (x < 0 || y < 0 || x >= report.hello.surface.width || y >= report.hello.surface.height)
    throw new Error(`Mouse point is outside the native picture: ${x},${y}`);
  await input(3, x, y);
  await input(1, 0x200, 0, point);
  await input(2, 1, 1);
  await input(1, 0x201, 1, point);
  await delay(80);
  await input(2, 1, 0);
  await input(1, 0x202, 0, point);
  await delay(250);
}
async function click(match, label) {
  const s = await waitFor(`${label}-ready`, (s) => !!find(s, match)),
    control = find(s, match),
    // Target the visible right-hand arrow in the original Combo skin.
    x =
      control.class === 'ComboBox'
        ? control.rect[2] - Math.min(11, Math.floor((control.rect[2] - control.rect[0]) / 2))
        : Math.floor((control.rect[0] + control.rect[2]) / 2),
    y = Math.floor((control.rect[1] + control.rect[3]) / 2);
  if (x < 0 || y < 0 || x >= report.hello.surface.width || y >= report.hello.surface.height)
    throw new Error(`Control ${control.id} is outside the native picture: ${control.rect}`);
  // YR menu animation exposes its controls before accepting button presses.
  await delay(1200);
  await mouseAt(x, y);
  console.log('protocol-click', JSON.stringify({ label, id: control.id, text: control.text, x, y }));
}
async function key(vk) {
  await input(2, vk, 1);
  await input(1, 0x100, vk, 1);
  await delay(40);
  await input(2, vk, 0);
  await input(1, 0x101, vk, 0xc0000001);
  await delay(250);
}
async function battle() {
  const deadline = performance.now() + 40000;
  let initial = null;
  while (performance.now() < deadline) {
    const frame = (await client.read(0xa8ed84, 4)).bytes.readUInt32LE(),
      objects = (await client.read(0xa8ec88, 4)).bytes.readUInt32LE(),
      s = await state('battle', false);
    if (!s.modal && objects > 0) {
      initial ??= { frame, at: performance.now() };
      if (frame > initial.frame + 40) {
        const vector = (await client.read(0xa80228, 20)).bytes,
          address = vector.readUInt32LE(4),
          count = vector.readInt32LE(16);
        if (count < 6 || count > 32) throw new Error(`Unexpected house vector count ${count}`);
        const pointers = (await client.read(address, count * 4)).bytes,
          houses = [];
        for (let i = 0; i < count; i++) {
          const p = pointers.readUInt32LE(i * 4),
            raw = (await client.read(p + 0x15ff4, 21)).bytes,
            end = raw.indexOf(0),
            name = raw.subarray(0, end < 0 ? raw.length : end).toString('ascii'),
            human = (await client.read(p + 0x1ec, 1)).bytes[0] !== 0;
          houses.push({ index: i, name, human });
        }
        const players = houses.filter((h) => !/^(Neutral|Special)$/i.test(h.name));
        if (players.length !== 6 || players.filter((h) => h.human).length !== 1)
          throw new Error(`Expected six players with one human: ${JSON.stringify(houses)}`);
        report.battle = {
          firstFrame: initial.frame,
          lastFrame: frame,
          logicFps: ((frame - initial.frame) * 1000) / (performance.now() - initial.at),
          objects,
          houses,
          players: players.length,
        };
        console.log('battle-advancing', JSON.stringify(report.battle));
        return state('battle-confirmed');
      }
    }
    await delay(250);
  }
  throw new Error('Match did not advance with six players / nonempty native object vector');
}
async function ownedObjects(vectorAddress, typeOffset) {
  const local = (await client.read(0xa83d4c, 4)).bytes.readUInt32LE(),
    vector = (await client.read(vectorAddress, 20)).bytes,
    address = vector.readUInt32LE(4),
    count = vector.readInt32LE(16);
  if (count < 0 || count > 4096) throw new Error(`Invalid object vector count ${count}`);
  if (!count) return [];
  const pointers = (await client.read(address, count * 4)).bytes,
    objects = [];
  for (let i = 0; i < count; i++) {
    const p = pointers.readUInt32LE(i * 4),
      object = (await client.read(p, typeOffset + 4)).bytes;
    if (object.readUInt32LE(0x21c) !== local || object[0x81]) continue;
    const typePointer = object.readUInt32LE(typeOffset),
      raw = (await client.read(typePointer + 0x24, 24)).bytes,
      end = raw.indexOf(0),
      type = raw.subarray(0, end < 0 ? raw.length : end).toString('ascii');
    objects.push({ pointer: p, type, selected: object[0x83] !== 0 });
  }
  return objects;
}
async function deployMcv() {
  if ((await state('deploy-ready')).modal) throw new Error('Close menus before deploying the MCV');
  const initial = await ownedObjects(0x8b4108, 0x6c4),
    mcv = initial.find((u) => /^(MCV|SMCV|PCV)$/i.test(u.type));
  if (!mcv) throw new Error(`No owned MCV to deploy: ${JSON.stringify(initial)}`);
  let selected = initial.filter((u) => u.selected);
  for (let tries = 0; !selected.some((u) => u.pointer === mcv.pointer) && tries < initial.length + 2; tries++) {
    await key(78); // The original game's N command cycles owned units.
    selected = (await ownedObjects(0x8b4108, 0x6c4)).filter((u) => u.selected);
  }
  if (!selected.some((u) => u.pointer === mcv.pointer))
    throw new Error(`Normal next-unit input did not select the MCV: ${JSON.stringify(selected)}`);
  await key(68); // The original game's D command deploys the selection.
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const yards = (await ownedObjects(0xa8eb40, 0x520)).filter((b) => /^(GACNST|NACNST|YACNST)$/i.test(b.type));
    if (yards.length) {
      report.observations.push({ label: 'mcv-deployed', selected, yards });
      console.log('mcv-deployed', JSON.stringify({ selected, yards }));
      return;
    }
    await delay(250);
  }
  throw new Error('Deploy input did not create an owned construction yard');
}
async function comboProbe() {
  const match = controlSelector(),
    before = await waitFor('combo-probe-ready', (s) => !!find(s, match)),
    control = find(before, match);
  if (control.class !== 'ComboBox') throw new Error('Combo probe requires an observed native ComboBox');
  const x = control.rect[2] - Math.min(11, Math.floor((control.rect[2] - control.rect[0]) / 2)),
    y = Math.floor((control.rect[1] + control.rect[3]) / 2),
    point = ((y & 0xffff) << 16) | (x & 0xffff);
  if (x < 0 || y < 0 || x >= report.hello.surface.width || y >= report.hello.surface.height)
    throw new Error(`Combo arrow is outside the native picture: ${x},${y}`);
  let down = null,
    up = null;
  try {
    await input(3, x, y);
    await input(1, 0x200, 0, point);
    await input(2, 1, 1);
    await input(1, 0x201, 1, point);
    await delay(80);
    down = await state('combo-probe-down');
  } finally {
    await input(2, 1, 0);
    await input(1, 0x202, 0, point);
    await delay(250);
    up = await state('combo-probe-up');
  }
  report.popupProbe = { id: control.id, point: [x, y], before: control, down, up };
  console.log(
    'combo-probe-proof',
    JSON.stringify({
      id: control.id,
      point: [x, y],
      down: { combo: find(down, match)?.combo, target: down.lastTargetId, lastMessage: down.lastMessage },
      up: { combo: find(up, match)?.combo, target: up.lastTargetId, lastMessage: up.lastMessage },
    }),
  );
}
async function comboCycle(mouse) {
  const match = controlSelector(),
    before = await waitFor('combo-cycle-ready', (s) => !!find(s, match)),
    original = find(before, match);
  if (
    original.class !== 'ComboBox' ||
    !Number.isInteger(original.combo?.count) ||
    !Number.isInteger(original.combo?.selection) ||
    original.combo.count < 2 ||
    original.combo.count > 256 ||
    original.combo.selection < 0 ||
    original.combo.selection >= original.combo.count
  )
    throw new Error(`Cannot observe a bounded real Combo selection: ${JSON.stringify(original)}`);
  const direction = original.combo.selection + 1 < original.combo.count ? 40 : 38,
    desired = original.combo.selection + (direction === 40 ? 1 : -1),
    opened = (s) => find(s, match)?.combo?.dropped === true,
    closedOriginal = (s) =>
      find(s, match)?.combo?.dropped === false && find(s, match)?.combo?.selection === original.combo.selection;
  let changed = null,
    popup = null;
  try {
    await click(match, 'combo-focus');
    const open = await waitFor('combo-popup-open', opened);
    popup = open.controls.find((c) => usable(c) && c.class === 'ComboLBox');
    if (mouse) {
      if (
        !Number.isInteger(popup?.list?.topIndex) ||
        !Number.isInteger(popup?.list?.itemHeight) ||
        popup.list.itemHeight <= 0 ||
        desired < popup.list.topIndex
      )
        throw new Error(`Native popup item geometry unavailable: ${JSON.stringify(popup)}`);
      const x = Math.floor((popup.rect[0] + popup.rect[2]) / 2),
        y = Math.floor(popup.rect[1] + 1 + (desired - popup.list.topIndex + 0.5) * popup.list.itemHeight);
      if (y >= popup.rect[3]) throw new Error('Adjacent popup choice is outside the visible list');
      await mouseAt(x, y);
    } else await key(direction);
    changed = await waitFor('combo-selection-changed', (s) => find(s, match)?.combo?.selection === desired);
    if (!mouse) await key(27);
    await waitFor('combo-popup-closed', (s) => find(s, match)?.combo?.dropped === false);
  } finally {
    const current = await state('combo-restore-observation', false);
    if (!closedOriginal(current)) {
      if (!opened(current)) await click(match, 'combo-restore-focus');
      await key(36);
      for (let i = 0; i < original.combo.selection; i++) await key(40);
      await key(13);
      await waitFor('combo-original-restored', closedOriginal);
    }
  }
  const restored = await state('combo-cycle-restored');
  report.observations.push({
    label: 'combo-cycle-proof',
    mouse,
    original,
    desired,
    popup,
    changed,
    restored: find(restored, match),
  });
  console.log(
    'combo-cycle-proof',
    JSON.stringify({
      mouse,
      id: original.id,
      original: original.combo.selection,
      changed: desired,
      restored: find(restored, match)?.combo?.selection,
    }),
  );
}
async function alliedSix() {
  const ids = [1901, 1902, 1903, 1904, 1905, 1906];
  const before = await waitFor('allied-six-ready', (s) => s.modal && ids.every((id) => !!find(s, id)));
  for (const id of ids) {
    const original = find(before, id);
    if (
      original.class !== 'ComboBox' ||
      !Number.isInteger(original.combo?.count) ||
      original.combo.count < 2 ||
      original.combo.count > 256 ||
      !Number.isInteger(original.combo?.selection)
    )
      throw new Error(`Cannot observe a bounded real Team control: ${JSON.stringify(original)}`);
    await click(id, `team-${id}-focus`);
    await waitFor(`team-${id}-popup`, (s) => find(s, id)?.combo?.dropped === true);
    await key(36); // Normal Home/Down selects the requested team index.
    await key(40);
    await key(13);
    await waitFor(
      `team-${id}-applied`,
      (s) => find(s, id)?.combo?.selection === 1 && find(s, id)?.combo?.dropped === false,
    );
  }
  const after = await state('allied-six-applied');
  if (!ids.every((id) => find(after, id)?.combo?.selection === 1))
    throw new Error('Not all six observed Team selections equal the requested preset');
  report.teamPreset = {
    name: 'allied-six',
    selectedIndex: 1,
    controlIds: ids,
    originalSelections: ids.map((id) => find(before, id).combo.selection),
    actualSelections: ids.map((id) => find(after, id).combo.selection),
    appliedThrough: 'protocol cursor and keyboard input',
    acceptanceScope: 'six-player crash soak; does not establish combat reliability',
  };
  console.log('team-preset', JSON.stringify(report.teamPreset));
}
const pauseControl = /save.?game|load.?game|resume|return.*game|abort|surrender/i;
const actions = {
  async state() {
    await state('state');
  },
  async 'main-options'() {
    await click(/options/i, 'main-options');
    await waitFor('main-options-open', (s) => s.modal && !find(s, 1667));
  },
  async 'main-options-close'() {
    await click(/^GUI:MainMenu$/i, 'return-main-menu');
    await waitFor('main-menu-returned', (s) => !!find(s, 1667));
  },
  async 'single-player'() {
    await click(1667, 'single-player');
    await waitFor('single-player-open', (s) => !!find(s, 1401));
  },
  async skirmish() {
    await click(1401, 'skirmish');
    await waitFor('skirmish-setup', (s) => s.modal && !!find(s, 1559));
  },
  async 'allied-six'() {
    await alliedSix();
  },
  async start() {
    await click(1559, 'start-match');
    await battle();
  },
  async 'deploy-mcv'() {
    await deployMcv();
  },
  async 'options-open'() {
    await key(27);
    await waitFor(
      'in-game-options-open',
      (s) => s.modal && s.controls.some((c) => usable(c) && pauseControl.test(c.text)),
    );
  },
  async 'options-close'() {
    const s = await state('resume-ready', false);
    if (!s.modal) {
      await battle();
      return;
    }
    if (find(s, /^(GUI:)?(Resume.*|ReturnToGame|Return.*Game|Continue.*)$/i))
      await click(/^(GUI:)?(Resume.*|ReturnToGame|Return.*Game|Continue.*)$/i, 'resume-match');
    else await key(27);
    await waitFor('in-game-options-closed', (s) => !s.modal);
    await battle();
  },
  async 'quit-open'() {
    await click(/abort|quit|surrender|exit.*game/i, 'quit-confirmation');
    await waitFor('quit-confirmation-open', (s) => s.modal && !!find(s, 1737) && !!find(s, /^GUI:ResumeMission$/i));
  },
  async 'quit-cancel'() {
    await waitFor('quit-cancel-ready', (s) => s.modal && !!find(s, 1737));
    await click(/^GUI:ResumeMission$/i, 'cancel-quit');
    await waitFor('quit-cancelled', (s) => !find(s, 1737) && (!s.modal || !!find(s, 1314)));
    if (!(await state('quit-cancel-status', false)).modal) await battle();
  },
  async 'combo-cycle'() {
    await comboCycle(false);
  },
  async 'combo-popup'() {
    await comboCycle(true);
  },
  async 'combo-probe'() {
    await comboProbe();
  },
  async click() {
    await click(controlSelector(), 'selected-control');
    await state('after-click');
  },
};
try {
  report.hello = await client.connect();
  console.log('hello', JSON.stringify(report.hello));
  if (
    !report.hello.exe?.verified ||
    report.hello.exe.sha256 !== '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6'
  )
    throw new Error('Menu smoke memory observations require the supported YR executable');
  if (o.step === 'all') {
    for (const step of [
      'main-options',
      'main-options-close',
      'single-player',
      'skirmish',
      'start',
      'options-open',
      'options-close',
      'options-open',
      'quit-open',
      'quit-cancel',
      'options-close',
    ])
      await actions[step]();
  } else {
    if (!actions[o.step]) throw new Error(`Unknown step ${o.step}`);
    await actions[o.step]();
  }
} catch (e) {
  report.error = String(e.stack || e);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  client.close();
  mkdirSync(resolve(out, 'run'), { recursive: true });
  const path = resolve(out, 'run', `menu-protocol-${o.step}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log('report', path);
}
