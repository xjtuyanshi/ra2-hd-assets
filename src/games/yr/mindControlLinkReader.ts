import type { GameRenderMindControlLink } from '../renderState';
import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import type { YrPoint3 } from './objectCoords';
import { isPlausiblePointer, readFacingRaw, readPointerVector, YR_STATE_VTABLES } from './stateReader';

/**
 * Read-only YR 1.001 CaptureManager observer, called only inside the hash-gated effects reader.
 * YRpp supplied names only; the player's pinned executable establishes the following ABI:
 *
 * - Constructor 0x4717D0 installs primary vtable 0x7E4B40 (0x471807), ControlNodes vector
 *   +0x24, Owner +0x48 (0x471800), and registers in Array 0x89E0F0 (0x471835..884).
 * - CaptureUnit 0x471DCC allocates a 0x14-byte ControlNode: Unit +0, OriginalOwner +4,
 *   LinkDrawTimer start +8 and duration +0x10. 0x471E3A..57 starts it with CurrentFrame
 *   0xA8ED84 and RulesClass::MindControlAttackLineFrames +0x310. No host lifetime is added.
 *   Constructor default is 15 frames (0x665ABE); loader 0x66C914..92E reads the key at
 *   0x83AF88 from CombatDamage (section pointer [0x7F0C84] -> 0x839E8C).
 * - NeedsToDrawLinks 0x472640 accepts controller/transport/controlled-unit selection or any
 *   running timer; DrawLinks 0x472160 still filters EACH node by controller selected +0x83,
 *   node unit selected +0x83, or its timer (0x472196..1E0). Transport selection alone is not
 *   enough to show a node. Timers with start -1 retain their stored positive remaining time.
 * - Tactical 0x6D46DD..6D47F6 suppresses links in PlanningModeActive [0xAC4CF4], iterates
 *   TechnoClass::Array, and invokes managers through healthy controllers or their controlled
 *   units. Both owner branches converge at 0x6D479F: no local-house/shroud predicate here.
 * - Target is RAW Object.Location +0x9C, with Type.LeptonMindControlOffset +0x3DC added to Z
 *   (0x4721E6..20A), not GetCoords/building foundation centre. Colour is controller.Owner
 *   +0x21C -> House.LaserColor RGB +0x56F9 (0x472210..22E), not a fixed purple.
 *   House constructor 0x4F54A0 installs its primary vtable 0x7EA8A0 at 0x4F5DCC.
 * - Source is virtual GetFLH(-1 - (nodeIndex % 5), zero) (0x472254..264). Techno GetFLH
 *   0x6F3AD0 reads AlternateFLH0..4 at Type +0x85C + index*12 (0x6F3AF9..21).
 *   The art loader defaults each absent AlternateFLH to PrimaryFireFLH +0x89C
 *   (0x715F9E..716005). It uses 32-direction rounding, the native trig table, the locomotor
 *   DrawMatrix, TurretOffset +0x720, and barrel parity +0x3B8 (0x6F3B62..6F3D4B).
 * - Walk DrawMatrix 0x55A730 uses primary facing. Drive 0x4AFF60 uses that matrix plus ramp
 *   matrix [0xB45188 + ramp*48] (0x7559B0), or extra slope/rocking transforms. Unimplemented
 *   transforming states are omitted rather than substituted with an approximate endpoint.
 * - DrawALinkTo 0x704E40 draws one 32-segment world-space parabolic arc, Z offset
 *   512*(1-((i-16)/16)^2) (0x70508A..119), then projects each point at 0x705127/144.
 *   It draws 3x3 endpoint squares and a house-colour-to-white moving highlight; its host
 *   tick-based brightness animation does not alter endpoints or timer/selection visibility.
 *
 * No guest calls/writes. Unknown source geometry is counted separately from malformed memory.
 */
export const YR_MIND_CONTROL_GLOBALS = Object.freeze({
  managers: 0x89e0f0,
  frame: 0xa8ed84,
  planning: 0xac4cf4,
  tactical: 0x887324,
  rampMatrices: 0xb45188,
  trig: 0x84f084,
  trigScale: 0x8223b0,
});
export const YR_CAPTURE_MANAGER_VTABLE = 0x7e4b40;
export const YR_MIND_CONTROL_HOUSE_VTABLE = 0x7ea8a0;
export const YR_MIND_CONTROL_OFFSETS = Object.freeze({
  nodes: 0x24,
  controller: 0x48,
  unit: 0,
  timerStart: 8,
  timerDuration: 0x10,
  selected: 0x83,
  location: 0x9c,
  owner: 0x21c,
  manager: 0x2bc,
  controlledBy: 0x2c0,
  houseColor: 0x56f9,
  targetHeight: 0x3dc,
  alternateFlh: 0x85c,
  turretOffset: 0x720,
  barrel: 0x3b8,
  locomotor: 0x674,
});
export const YR_MIND_CONTROL_LIMITS = Object.freeze({ managers: 1024, nodes: 1024, totalNodes: 4096, timer: 100_000 });
export interface YrMindControlLinkStats {
  managers: number;
  nodes: number;
  invalid: number;
  inactive: number;
  unsupported: number;
}

const SPECS = [
  { vtable: YR_STATE_VTABLES.unit, typeOffset: 0x6c4, typeVtable: YR_STATE_VTABLES.unitType, kind: 'unit' },
  { vtable: YR_STATE_VTABLES.infantry, typeOffset: 0x6c0, typeVtable: YR_STATE_VTABLES.infantryType, kind: 'infantry' },
  { vtable: YR_STATE_VTABLES.building, typeOffset: 0x520, typeVtable: YR_STATE_VTABLES.buildingType, kind: 'building' },
  { vtable: YR_STATE_VTABLES.aircraft, typeOffset: 0x6c4, typeVtable: YR_STATE_VTABLES.aircraftType, kind: 'aircraft' },
] as const;
type Techno = { id: number; type: number; kind: (typeof SPECS)[number]['kind'] };
type Matrix = number[];
const F = Math.fround;
const identity = (): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const point = (m: GuestMemoryAccessor, at: number): YrPoint3 => ({ x: m.i32(at), y: m.i32(at + 4), z: m.i32(at + 8) });
const withinWorld = (p: YrPoint3) =>
  Math.abs(p.x) <= 512 * 256 && Math.abs(p.y) <= 512 * 256 && Math.abs(p.z) <= 64 * 104;
const withinOffset = (p: YrPoint3) => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) <= 4096;
const float = (m: GuestMemoryAccessor, at: number) => {
  const b = m.bytes(at, 4);
  return b.length === 4 ? new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true) : NaN;
};
function techno(m: GuestMemoryAccessor, id: number): Techno | null {
  if (!isPlausiblePointer(m, id, 0x524)) return null;
  const spec = SPECS.find((s) => s.vtable === m.u32(id));
  if (!spec || !isPlausiblePointer(m, id, spec.typeOffset + 4)) return null;
  const type = m.u32(id + spec.typeOffset);
  return isPlausiblePointer(m, type, 0xca2) && m.u32(type) === spec.typeVtable && withinWorld(point(m, id + 0x9c))
    ? { id, type, kind: spec.kind }
    : null;
}
function matrix(m: GuestMemoryAccessor, at: number): Matrix | null {
  if (!isPlausiblePointer(m, at, 48)) return null;
  const a = Array.from({ length: 12 }, (_, i) => float(m, at + i * 4));
  if (a.some((v, i) => !Number.isFinite(v) || Math.abs(v) > (i % 4 === 3 ? 4096 : 32))) return null;
  return [0, 4, 8].every((i) => a.slice(i, i + 3).some((v) => v !== 0)) ? a : null;
}
function multiply(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 12 }, (_, i) => {
    const row = Math.floor(i / 4) * 4,
      col = i % 4;
    return F(a[row]! * b[col]! + a[row + 1]! * b[col + 4]! + a[row + 2]! * b[col + 8]! + (col === 3 ? a[row + 3]! : 0));
  });
}
function transform(a: Matrix, p: YrPoint3): YrPoint3 {
  return {
    x: F(a[0]! * p.x + a[1]! * p.y + a[2]! * p.z + a[3]!),
    y: F(a[4]! * p.x + a[5]! * p.y + a[6]! * p.z + a[7]!),
    z: F(a[8]! * p.x + a[9]! * p.y + a[10]! * p.z + a[11]!),
  };
}
/** Reproduce 0x4CACB0/0x4CAD00's table indexes, including negative-angle rounding. */
function rotation(m: GuestMemoryAccessor, angle: number): Matrix | null {
  const scale = float(m, YR_MIND_CONTROL_GLOBALS.trigScale);
  if (scale !== 2607.594482421875) return null;
  const scaled = Math.trunc(F(angle) * scale),
    odd = scaled & 1;
  let sinIndex = Math.trunc(scaled / 2) % 8192;
  if (sinIndex < 0) sinIndex += 8192;
  let cosIndex = sinIndex + 2048;
  if (odd && sinIndex < 8191) sinIndex++;
  if (odd && cosIndex < 10239) cosIndex++;
  const s = float(m, YR_MIND_CONTROL_GLOBALS.trig + sinIndex * 4);
  const c = float(m, YR_MIND_CONTROL_GLOBALS.trig + cosIndex * 4);
  if (![s, c].every(Number.isFinite) || Math.abs(s * s + c * c - 1) > 0.001) return null;
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}
const angle32 = (raw: number) => (((((raw >> 10) + 1) >> 1) & 31) - 8) * (-Math.PI / 16);

/** A validated subset of native GetFLH; returns null for unimplemented virtual/transform branches. */
function source(m: GuestMemoryAccessor, owner: Techno, index: number, frame: number): YrPoint3 | null {
  const { id, type, kind } = owner;
  const flh = point(m, type + 0x85c + (index % 5) * 12);
  const turretOffset = m.i32(type + 0x720),
    turret = m.u8(type + 0xca1);
  if (!withinOffset(flh) || Math.abs(turretOffset) > 4096 || turret > 1) return null;
  // Infantry::GetFLH redirects open-topped passengers through the transport's firing slot
  // (0x523259..2A1); never use the passenger's hidden map location as a fallback.
  if (kind === 'infantry' && m.u8(id + 0x82) && m.u32(id + 0x11c)) return null;
  let base = point(m, id + 0x9c);
  let pixelOffset: YrPoint3 | null = null;
  if (kind === 'building') {
    if (!isPlausiblePointer(m, type, 0x1765)) return null;
    // Building GetRenderCoords 0x459EF0 uses raw Location minus (128,128,0).
    base = { x: base.x - 128, y: base.y - 128, z: base.z };
    // Occupant muzzle and voxel barrel branches are separate GetFLH implementations
    // (0x45384F..8C2 and 0x4539A1..9DD), not AlternateFLH rotation.
    if (m.u8(type + 0x157b) || m.u8(type + 0x16c6)) return null;
    const px = m.i32(type + 0xe44),
      py = m.i32(type + 0xe48);
    if (px !== 65535 || py !== 65535) {
      if (Math.abs(px) > 4096 || Math.abs(py) > 4096) return null;
      const tactical = m.u32(YR_MIND_CONTROL_GLOBALS.tactical);
      const inverse = isPlausiblePointer(m, tactical, 0xe14) ? matrix(m, tactical + 0xde4) : null;
      if (!inverse) return null;
      const p = transform(inverse, { x: px, y: py, z: 0 });
      pixelOffset = { x: Math.trunc(p.x), y: Math.trunc(p.y), z: 0 };
      // 0x453957..995: without firing-coordinate offset, FirePixelOffset replaces FLH entirely.
      if (m.u8(type + 0x1764) === 0) return { x: base.x + pixelOffset.x, y: base.y + pixelOffset.y, z: base.z };
      if (m.u8(type + 0x1764) !== 1) return null;
    }
    // Voxel turret pixel offsets (0x453A12..4C) need their own inverse projection.
    if (m.u8(type + 0x16c5)) return null;
    // Building GetRealFacing may turn towards Target (0x445E62..ED6). A vertical FLH
    // is independent of that angle; otherwise omit this unsupported target-facing branch.
    if ((flh.x !== 0 || flh.y !== 0 || turretOffset !== 0) && m.u32(id + 0x2b4)) return null;
  }
  const bodyAngle = angle32(readFacingRaw(m, id + 0x388, frame));
  // Unit 0x746E30 selects turret/body; Aircraft 0x41C1E0 always uses secondary facing.
  const realAngle = angle32(
    readFacingRaw(m, id + ((kind === 'unit' && turret) || kind === 'aircraft' ? 0x3a0 : 0x388), frame),
  );
  let draw = identity(),
    relative = realAngle;
  if (kind !== 'building' && m.u8(id + 0x14) & 4 && m.u32(id + 0x674)) {
    const loco = m.u32(id + 0x674);
    if (!isPlausiblePointer(m, loco, 0x30) || m.u32(loco + 8) !== id) return null;
    const vt = m.u32(loco);
    if (vt !== 0x7f69f8 && vt !== 0x7e7eb0) return null;
    const body = rotation(m, bodyAngle);
    if (!body) return null;
    draw = body;
    relative = realAngle - bodyAngle;
    if (vt === 0x7e7eb0) {
      const currentRamp = m.i32(loco + 0x18),
        previousRamp = m.i32(loco + 0x1c);
      const duration = m.i32(loco + 0x2c),
        start = m.i32(loco + 0x20),
        time = m.i32(loco + 0x28);
      const left = start === -1 ? time : Math.max(0, time - (frame - start));
      // 0x4AFFBD..4B02B3 adds rocking/translation; 0x4B0301..38E interpolates slope
      // quaternions. Both are intentionally unavailable until their complete transforms are decoded.
      if (
        Math.abs(float(m, id + 0x328)) >= 0.005 ||
        Math.abs(float(m, id + 0x32c)) >= 0.005 ||
        !Number.isFinite(float(m, id + 0x328)) ||
        !Number.isFinite(float(m, id + 0x32c)) ||
        duration < 0 ||
        (duration > 0 && left > 0) ||
        currentRamp < 0 ||
        currentRamp > 20 ||
        previousRamp < 0 ||
        previousRamp > 20
      )
        return null;
      if (currentRamp !== 0) {
        const ramp = matrix(m, YR_MIND_CONTROL_GLOBALS.rampMatrices + currentRamp * 48);
        if (!ramp) return null;
        draw = multiply(ramp, draw);
      }
    }
  }
  const rotate = rotation(m, relative);
  if (!rotate) return null;
  const offset = identity();
  offset[3] = turretOffset;
  draw = multiply(multiply(draw, offset), rotate);
  const p = transform(draw, { x: flh.x, y: m.i32(id + 0x3b8) % 2 ? -flh.y : flh.y, z: flh.z });
  const result = {
    x: base.x + Math.trunc(p.x) + (pixelOffset?.x ?? 0),
    y: base.y + Math.trunc(-p.y) + (pixelOffset?.y ?? 0),
    z: base.z + Math.trunc(p.z),
  };
  return withinWorld(result) ? result : null;
}

export function readYrMindControlLinks(m: GuestMemoryAccessor): {
  mindControlLinks: GameRenderMindControlLink[];
  stats: YrMindControlLinkStats;
} {
  const g = YR_MIND_CONTROL_GLOBALS,
    o = YR_MIND_CONTROL_OFFSETS,
    limits = YR_MIND_CONTROL_LIMITS;
  const stats: YrMindControlLinkStats = { managers: 0, nodes: 0, invalid: 0, inactive: 0, unsupported: 0 };
  const mindControlLinks: GameRenderMindControlLink[] = [];
  const entries = (base: number, limit: number) => {
    const count = m.u32(base + 0x10);
    const pointers = base + 0x18 <= m.size && count <= m.u32(base + 8) ? readPointerVector(m, base, limit) : null;
    if (!pointers) stats.invalid += Math.max(1, Math.min(count, limits.totalNodes));
    return pointers ?? [];
  };
  const managers = entries(g.managers, limits.managers);
  stats.managers = m.u32(g.managers + 0x10);
  const frame = m.i32(g.frame),
    planning = m.u8(g.planning);
  if (g.planning >= m.size || g.frame + 4 > m.size || planning > 1 || frame < 0) {
    stats.invalid++;
    return { mindControlLinks, stats };
  }
  if (planning) {
    stats.inactive += managers.length;
    return { mindControlLinks, stats };
  }
  const seenManagers = new Set<number>(),
    seenNodes = new Set<number>();
  for (const manager of managers) {
    if (
      !isPlausiblePointer(m, manager, 0x50) ||
      m.u32(manager) !== YR_CAPTURE_MANAGER_VTABLE ||
      seenManagers.has(manager)
    ) {
      stats.invalid++;
      continue;
    }
    seenManagers.add(manager);
    const controller = techno(m, m.u32(manager + o.controller));
    if (!controller || m.u32(controller.id + o.manager) !== manager || m.u8(controller.id + o.selected) > 1) {
      stats.invalid++;
      continue;
    }
    const house = m.u32(controller.id + o.owner);
    if (!isPlausiblePointer(m, house, o.houseColor + 3) || m.u32(house) !== YR_MIND_CONTROL_HOUSE_VTABLE) {
      stats.invalid++;
      continue;
    }
    const nodes = entries(manager + o.nodes, limits.nodes);
    // The tactical loop may reach this same manager through ANY living controlled unit.
    // Once reached, DrawLinks does not independently gate each node by that node's health.
    const invoked =
      m.i32(controller.id + 0x6c) !== 0 ||
      nodes.some((node) => {
        if (!isPlausiblePointer(m, node, 0x14)) return false;
        const unit = techno(m, m.u32(node));
        return !!unit && m.u32(unit.id + o.controlledBy) === controller.id && m.i32(unit.id + 0x6c) !== 0;
      });
    for (let index = 0; index < nodes.length; index++) {
      if (stats.nodes >= limits.totalNodes) {
        stats.invalid++;
        return { mindControlLinks, stats };
      }
      stats.nodes++;
      const id = nodes[index]!;
      if (!isPlausiblePointer(m, id, 0x14) || seenNodes.has(id)) {
        stats.invalid++;
        continue;
      }
      seenNodes.add(id);
      const unit = techno(m, m.u32(id));
      const start = m.i32(id + o.timerStart),
        duration = m.i32(id + o.timerDuration);
      if (
        !unit ||
        m.u32(unit.id + o.controlledBy) !== controller.id ||
        m.u8(unit.id + o.selected) > 1 ||
        start < -1 ||
        start > frame ||
        duration < 0 ||
        duration > limits.timer
      ) {
        stats.invalid++;
        continue;
      }
      const remainingFrames = start === -1 ? duration : Math.max(0, duration - (frame - start));
      const selected = !!(m.u8(controller.id + o.selected) || m.u8(unit.id + o.selected));
      if ((!selected && remainingFrames === 0) || !invoked) {
        stats.inactive++;
        continue;
      }
      const target = point(m, unit.id + o.location),
        height = m.i32(unit.type + o.targetHeight);
      target.z += height;
      if (Math.abs(height) > 4096 || !withinWorld(target)) {
        stats.invalid++;
        continue;
      }
      const from = source(m, controller, index, frame);
      if (!from) {
        stats.unsupported++;
        continue;
      }
      mindControlLinks.push({
        id,
        controller: controller.id,
        targetId: unit.id,
        source: from,
        target,
        color: [m.u8(house + o.houseColor), m.u8(house + o.houseColor + 1), m.u8(house + o.houseColor + 2)],
        arcHeight: 512,
        remainingFrames,
        selected,
      });
    }
  }
  return { mindControlLinks, stats };
}
