import { HYPERCALL_THREAD_CURRENT } from '../../vm86/pe';
import type { GuestMemory } from '../../vm86/win32';
import {
  RENDER_PASSTHROUGH,
  RENDER_PASSTHROUGH_ALL,
  RENDER_PASSTHROUGH_KEY_RGB565,
  type RenderPassthroughControl,
} from '../renderPassthrough';
import {
  GATE_DATA,
  GuestGateBuilder,
  readGateCounters,
  writeGateSwitches,
  type GateMismatch,
  type GateSpec,
  type GuestGateOptions,
  type InstalledGates,
} from '../shared/guestGates';
import { le32 } from '../shared/bytes';

/**
 * YR 1.001 (gamemd.exe SHA-256 7b8a0685…94b6) native overlay passthrough; see src/games/renderPassthrough.ts for the
 * contract and docs/remaster/research/tactical-passthrough.md for the draw-pipeline map these addresses come from.
 *
 * Sources: class/vtable/function facts from the community YRpp headers (Phobos-developers/YRpp: TacticalClass,
 * DSurface/Surface virtual order, ObjectClass draw virtuals, AnimClass::IsBuildingAnim, effect arrays), everything else
 * from disassembling the player's gamemd.exe. Each site lists its original bytes; nothing is written unless all match.
 *
 * Frame order (TacticalClass::Render 0x6D3D10, called three times per frame by GScreenClass::Render 0x4F4480 with
 * mode 0 scroll, 1 terrain, 2 objects):
 *   mode 1: terrain passes redraw dirty parts of the cached terrain surface DSurface::Tile (cells, overlays, smudges and
 *           non-moving objects), then 0x6D45C7 copies Tile into the frame surface (DSurface::Composite).
 *           → TERRAIN: skip the passes and fill the frame with the key colour instead of copying.
 *   mode 2: waypoints/placement (overlay), IonBlast/Spotlight/Laser/EBolt/LineTrail/RadBeam DrawAll (effects), layer
 *           render 0x6D8DB0: per object DrawBehind + DrawIfVisible (world), then DrawExtras for every drawn techno
 *           (health bar, pips, brackets: overlay); beacons, band box, action lines, mind-control links, timers.
 *   then GScreenClass::Render draws messages and tooltips over the frame surface.
 * World objects are drawn with their logic intact (selection registration, visibility flags) under a suppression
 * depth; the SHP, voxel and voxel-shadow blitters return early while it is raised, so only their pixels disappear.
 * The EBolt, LineTrail and RadBeam lists are also where those effects age and are removed and freed, so they keep
 * running (suppressed, or with only the per-trail draw skipped); only code that keeps no simulation state is skipped.
 * Some of it still has side effects (ore glint objects and CRT rand(), the detail flag 0xABCD50, the non-critical
 * random generator 0x886B88): see Known limits in docs/remaster/research/tactical-passthrough.md.
 *
 * Switch changes are latched at the start of GScreenClass::Render (redraw:request), together with the full repaint
 * they need, so every gate sees one set of switches for a whole frame. All gates act only on the game's main thread.
 */

const YR_TACTICAL_VIEW_BOUNDS = 0x0088_6fa0; // DSurface::ViewBounds (YRpp Surface.h)
const YR_DSURFACE_VTABLE = 0x007e_85d4;

/** Category of each gate; `always` gates are the blitters, enabled whenever any category is on. */
type Category = 'terrain' | 'objects' | 'effects' | 'always';

interface YrGate extends GateSpec {
  readonly category: Category;
}

/** vtable slots of ObjectClass draw virtuals (YRpp order, offsets confirmed by the layer render at 0x6D8DB0). */
const DRAW_IF_VISIBLE = 0x104;
const DRAW_BEHIND = 0x10c;

const suppressSlot = (
  name: string,
  category: Category,
  vtable: number,
  slot: number,
  target: number,
  alternate?: GateSpec['alternate'],
): YrGate => ({
  name,
  category,
  site: { kind: 'pointer', address: vtable + slot, target },
  action: { kind: 'suppress' },
  ...(alternate ? { alternate } : {}),
});

const skipCall = (name: string, category: Category, address: number, target: number): YrGate => ({
  name,
  category,
  site: { kind: 'call', address, target },
  action: { kind: 'skip', returnBytes: 0 },
});

const suppressCall = (name: string, category: Category, address: number, target: number): YrGate => ({
  name,
  category,
  site: { kind: 'call', address, target },
  action: { kind: 'suppress' },
});

/** AnimClass::IsBuildingAnim (YRpp AnimClass.h; also tested by the layer render at 0x6D91D8). */
const ANIM_IS_BUILDING_ANIM = 0x118;

const skipTerrainPass = (index: number, address: number, target: number, returnBytes: number): YrGate => ({
  name: `terrain:pass${index}`,
  category: 'terrain',
  site: { kind: 'call', address, target },
  action: { kind: 'skip', returnBytes },
});

export const YR_PASSTHROUGH_GATES: readonly YrGate[] = [
  // Terrain passes of TacticalClass::Render mode 1: redraw the dirty parts of DSurface::Tile (cells, overlays, smudges,
  // cached buildings and trees). While terrain passthrough is on the frame never shows that cache, so they are skipped;
  // the dirty list is still consumed by Render itself, and switching off forces a full repaint (redraw:request).
  skipTerrainPass(1, 0x006d_4471, 0x006d_2b60, 0x10),
  skipTerrainPass(2, 0x006d_448b, 0x006d_3660, 0x10),
  skipTerrainPass(3, 0x006d_449d, 0x006d_2de0, 0x0c),
  skipTerrainPass(4, 0x006d_44af, 0x006d_3470, 0x0c),
  skipTerrainPass(5, 0x006d_44c1, 0x006d_3290, 0x0c),
  skipTerrainPass(6, 0x006d_44d3, 0x006d_3ac0, 0x0c),
  skipTerrainPass(7, 0x006d_44e5, 0x006d_3040, 0x0c),
  skipTerrainPass(8, 0x006d_44f7, 0x006d_3870, 0x0c),
  // 0x6D7840, called last in mode 2 (0x6D492B, thiscall with two rectangles, ret 8): ore/gem glints, written straight
  // into the locked frame surface (0x6D7BB4 `mov [edx+esi*2], ax`), so no blitter gate sees them. Not draw-only: it
  // keeps per-cell glint objects (CellClass+0xFC) and calls the CRT rand(), which no simulation code is known to use.
  {
    name: 'terrain:ore-glints',
    category: 'terrain',
    site: { kind: 'call', address: 0x006d_492b, target: 0x006d_7840 },
    action: { kind: 'skip', returnBytes: 0x08 },
  },
  // World objects: DrawIfVisible (draws the body via DrawIt) and DrawBehind, per class vtable.
  suppressSlot('unit:draw', 'objects', 0x007f_5c70, DRAW_IF_VISIBLE, 0x0073_b0b0),
  suppressSlot('unit:behind', 'objects', 0x007f_5c70, DRAW_BEHIND, 0x006f_60d0),
  suppressSlot('infantry:draw', 'objects', 0x007e_b058, DRAW_IF_VISIBLE, 0x005f_4b10),
  suppressSlot('infantry:behind', 'objects', 0x007e_b058, DRAW_BEHIND, 0x006f_60d0),
  suppressSlot('building:draw', 'objects', 0x007e_3ebc, DRAW_IF_VISIBLE, 0x0043_cea0),
  // Pinned 0x6F60D0 draws only selected-building rear brackets (type 6 and +0x83 at 0x6F60D8..0x6F60EC),
  // not world art. Keep the building +0x10C slot untouched so its line primitives stay native overlays.
  suppressSlot('aircraft:draw', 'objects', 0x007e_22a4, DRAW_IF_VISIBLE, 0x005f_4b10),
  suppressSlot('aircraft:behind', 'objects', 0x007e_22a4, DRAW_BEHIND, 0x006f_60d0),
  suppressSlot('terrain-object:draw', 'objects', 0x007f_522c, DRAW_IF_VISIBLE, 0x0071_cc50),
  suppressSlot('veinhole:draw', 'objects', 0x007f_66a8, DRAW_IF_VISIBLE, 0x005f_4b10),
  // Effects in the layers. Building animations (IsBuildingAnim) belong to their building: objects category.
  suppressSlot('anim:draw', 'effects', 0x007e_3354, DRAW_IF_VISIBLE, 0x0042_2c70, {
    thisByteOffset: ANIM_IS_BUILDING_ANIM,
    switch: 'anim:building',
  }),
  suppressSlot('particle:draw', 'effects', 0x007e_f954, DRAW_IF_VISIBLE, 0x005f_4b10),
  suppressSlot('particle-system:draw', 'effects', 0x007e_fb9c, DRAW_IF_VISIBLE, 0x005f_4b10),
  suppressSlot('bullet:draw', 'effects', 0x007e_46e4, DRAW_IF_VISIBLE, 0x005f_4b10),
  suppressSlot('voxel-anim:draw', 'effects', 0x007f_6318, DRAW_IF_VISIBLE, 0x0074_9b20),
  suppressSlot('wave:draw', 'effects', 0x007f_6bf4, DRAW_IF_VISIBLE, 0x005f_4b10),
  suppressSlot('building-light:draw', 'effects', 0x007e_3ad0, DRAW_IF_VISIBLE, 0x005f_4b10),
  // Effect lists drawn directly by TacticalClass::Render (mode 2), each `call rel32` with no arguments. Ion blasts
  // (per blast 0x53D580), spotlights (0x5FF850) and lasers (0x550260) keep no game state and write pixels straight
  // into the locked surface where no blitter gate sees them, so their whole lists are skipped.
  skipCall('ion-blast:draw-all', 'effects', 0x006d_4656, 0x0053_d850),
  skipCall('spotlight:draw-all', 'effects', 0x006d_4664, 0x005f_ffa0),
  skipCall('laser:draw-all', 'effects', 0x006d_4669, 0x0055_0240),
  // EBolt::DrawAll 0x4C2830 is the only code that ages bolts (`sar` Lifetime, 0x4C2940) and removes and frees them
  // (0x4C2951..0x4C29BA). It must run: suppressed, its per-bolt draw 0x4C1F20 reaches the frame only through DSurface
  // vtable +0x34 (gated blitter), so only the pixels disappear.
  suppressCall('ebolt:draw-all', 'effects', 0x006d_466e, 0x004c_2830),
  // LineTrail DrawAll 0x556D40 is the only caller of LineTrail::Update 0x556B70 and the only runtime remover/deleter
  // (0x556D7C..0x556DC6). Its per-trail draw 0x556C00 (thiscall, plain `ret`, only projects points and draws) writes
  // through a direct call to 0x4BEAC0 that no blitter gate covers, so that one call is skipped instead.
  skipCall('line-trail:draw', 'effects', 0x0055_6dd2, 0x0055_6c00),
  // RadBeam DrawAll 0x6591B0 is the only caller of 0x659650/0x659CA0, whose return values decide deletion, and the only
  // remover/freer (0x659383..0x6593CD); both draw through DSurface +0x34 (gated), so the list runs suppressed.
  suppressCall('rad-beam:draw-all', 'effects', 0x006d_4678, 0x0065_91b0),
  // Blitters: return early only while called from inside a suppressed draw.
  {
    name: 'blit:shape',
    category: 'always',
    // CC_Draw_Shape (YRpp Surface.h), __fastcall with 14 stack arguments (ret 0x38).
    site: { kind: 'entry', address: 0x004a_ed70, prologue: [0x81, 0xec, 0x94, 0x00, 0x00, 0x00] },
    action: { kind: 'blit', returnBytes: 0x38 },
  },
  {
    name: 'blit:voxel',
    category: 'always',
    // TechnoClass::DrawVoxel (called by FootClass::Draw_A_VXL 0x4DAF10 and building voxel turrets), ret 0x28.
    site: { kind: 'entry', address: 0x0070_6640, prologue: [0x83, 0xec, 0x40, 0x53, 0x55] },
    action: { kind: 'blit', returnBytes: 0x28 },
  },
  {
    name: 'blit:voxel-shadow',
    category: 'always',
    // TechnoClass::DrawVoxelShadow (YRpp TechnoClass.h 0x706BD0), ret 0x2c.
    site: { kind: 'entry', address: 0x0070_6bd0, prologue: [0x83, 0xec, 0x3c, 0x53, 0x55] },
    action: { kind: 'blit', returnBytes: 0x2c },
  },
  // Surface primitives world code calls directly (spark particles use SetPixel, some effects draw lines): the DSurface
  // vtable 0x7E85D4 (read from the live surfaces), slot order from YRpp Surface.h, argument bytes from each
  // implementation's own `ret`. Only suppressed callers are affected; they report success (eax = 1).
  ...(
    [
      [0x08, 0x004b_b080, 0x14, 'copy-part'],
      [0x0c, 0x004b_b0d0, 0x1c, 'copy'],
      [0x10, 0x004b_b620, 0x0c, 'fill-rect-ex'],
      [0x14, 0x004b_b5f0, 0x08, 'fill-rect'],
      [0x18, 0x007b_bab0, 0x04, 'fill'],
      [0x1c, 0x004b_b830, 0x0c, 'fill-rect-trans'],
      [0x20, 0x007b_b350, 0x24, 'ellipse'],
      [0x24, 0x007b_aeb0, 0x08, 'set-pixel'],
      [0x2c, 0x007b_a610, 0x10, 'line-ex'],
      [0x30, 0x007b_a5e0, 0x0c, 'line'],
      [0x34, 0x004b_fd30, 0x1c, 'line-colour'],
      [0x38, 0x004b_bca0, 0x1c, 'line-multiply'],
      [0x3c, 0x004b_c750, 0x2c, 'line-subtract'],
      [0x40, 0x004b_df00, 0x1c, 'line-rgb-multiply'],
      [0x44, 0x007b_ab90, 0x10, 'plot-line'],
      [0x48, 0x007b_a8c0, 0x14, 'dashed-line'],
      [0x4c, 0x004c_0750, 0x18, 'dashed-line2'],
      [0x50, 0x004c_0e30, 0x10, 'line2'],
      [0x54, 0x007b_adc0, 0x0c, 'rect-ex'],
      [0x58, 0x007b_ad90, 0x08, 'rect'],
      [0x88, 0x007b_af90, 0x0c, 'put-pixel-clip'],
      [0x90, 0x004b_f750, 0x1c, 'gradient-line'],
    ] as const
  ).map(([slot, target, returnBytes, name]): YrGate => ({
    name: `blit:surface-${name}`,
    category: 'always',
    site: { kind: 'pointer', address: YR_DSURFACE_VTABLE + slot, target },
    action: { kind: 'blit', returnBytes, returnValue: 1 },
  })),
];

/**
 * TacticalClass::Render mode 1, 0x6D45C7..0x6D45DA: `push 1; push 0; mov edx,[ecx]; push ViewBounds; push eax;
 * push ViewBounds; call [edx+8]` = Composite->CopyFromPart(&ViewBounds, Tile, &ViewBounds, 0, 1) (Surface vtable
 * order from YRpp). Replaced by `call stub; jmp 0x6D45DB` where the stub either repeats that copy or, while the
 * terrain switch is on, calls FillRect(&ViewBounds, key) (vtable +0x14; DSurface vtable 0x7E85D4 → 0x4BB5F0, which
 * forwards to FillRectEx 0x4BB620 with the whole surface as clip) on the same surface.
 */
const TERRAIN_COPY_SITE = 0x006d_45c7;
const TERRAIN_COPY_ORIGINAL = [
  0x6a,
  0x01,
  0x6a,
  0x00,
  0x8b,
  0x11,
  0x68,
  ...le32(YR_TACTICAL_VIEW_BOUNDS),
  0x50,
  0x68,
  ...le32(YR_TACTICAL_VIEW_BOUNDS),
  0xff,
  0x52,
  0x08,
] as const;
const TERRAIN_COPY_RESUME = 0x006d_45db;

/**
 * GScreenClass::Render 0x4F44A5..0x4F44AE: `mov eax,[esi+0xc]; mov dword [esi+0xc],0` reads and clears the "redraw"
 * request that becomes TacticalClass::Render's full-redraw argument. Replaced by `call stub` + 5 NOPs. When the host
 * changed the categories, the stub copies the pending switches into the live ones and calls the game's own
 * GScreenClass::MarkNeedsRedraw(1) (0x4F42F0, thiscall, ret 4: sets TacticalClass::Redrawing and the request), then
 * performs the original read and clear. The code after the site (0x4F44AF: `test eax,eax; setne cl; ...`) needs only
 * eax, so the stub may clobber ecx, edx and the flags.
 *
 * Why here: YR also caches non-moving objects (buildings, trees) in the terrain surface DSurface::Tile, redrawing only
 * dirty parts, and the terrain passes, the terrain fill and every object gate of one frame must agree. The host can
 * run between any two guest instructions (for example during the DirectDraw Unlock at 0x6D455E, just before the
 * terrain copy), so switches it writes directly could change halfway through a frame: turning terrain off after the
 * passes were skipped would copy the stale Tile into the frame. Latched here, a change takes effect exactly at the
 * start of a frame that also repaints everything, as after a large scroll.
 */
const REDRAW_SITE = 0x004f_44a5;
const REDRAW_ORIGINAL = [0x8b, 0x46, 0x0c, 0xc7, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x00] as const;
const MARK_NEEDS_REDRAW = 0x004f_42f0;

/**
 * User words of the gate data page: `flags` the categories last requested by the host, `applied` the categories the
 * guest latched at its last frame boundary.
 */
const WORD = { flags: 0, key: 1, fills: 2, redrawRequest: 3, redraws: 4, applied: 5 } as const;

/**
 * Gates act only on the game's main thread, which runs all tactical drawing: the VM runs the PE entry point as guest
 * thread 0 (src/vm86/shim/state.ts) and keeps the running thread's id at HYPERCALL_THREAD_CURRENT. YR's WWMouse thread
 * (CreateThread proc 0x7B8610 → 0x7BA090) restores and saves the software cursor background through
 * DSurface::Primary->CopyFromPart (vtable +0x08, 0x7B90AB) and may preempt the main thread inside a suppressed draw.
 */
const YR_GATE_THREAD = { currentAddress: HYPERCALL_THREAD_CURRENT, owner: 0 } as const;

const DATA_BYTES = GATE_DATA.size;
const CODE_BYTES = 0x2000;

export interface YrPassthroughInstall {
  readonly control: RenderPassthroughControl;
  readonly gates: InstalledGates;
}

export type YrPassthroughResult =
  ({ ok: true } & YrPassthroughInstall) | { ok: false; reason: string; mismatches: readonly GateMismatch[] };

/**
 * Build and install every gate into memory handed out by `reserve` (zero-filled, aligned as requested): a 4 KiB data
 * page and a separate code page, so guest writes to the data page never touch a page holding compiled code.
 * All-or-nothing: on any original-byte mismatch nothing is written.
 */
export function installYrTacticalPassthrough(
  memory: GuestMemory,
  reserve: (size: number, alignment?: number) => number,
  thread: GuestGateOptions['thread'] = YR_GATE_THREAD,
): YrPassthroughResult {
  const data = reserve(DATA_BYTES, DATA_BYTES);
  const code = reserve(CODE_BYTES, DATA_BYTES);
  const builder = new GuestGateBuilder(memory, data, code, code + CODE_BYTES, { thread });
  // Custom terrain site first, so its stub sits at the start of the code page.
  const fill = builder.asm.here;
  emitTerrainFill(builder);
  builder.patch('terrain:fill', TERRAIN_COPY_SITE, TERRAIN_COPY_ORIGINAL, [
    0xe8,
    ...le32(fill - (TERRAIN_COPY_SITE + 5)),
    0xeb,
    TERRAIN_COPY_RESUME - (TERRAIN_COPY_SITE + 7),
    ...new Array(TERRAIN_COPY_ORIGINAL.length - 7).fill(0x90),
  ]);
  const redraw = builder.asm.here;
  emitRedrawRequest(builder);
  builder.patch('redraw:request', REDRAW_SITE, REDRAW_ORIGINAL, [
    0xe8,
    ...le32(redraw - (REDRAW_SITE + 5)),
    ...new Array(REDRAW_ORIGINAL.length - 5).fill(0x90),
  ]);
  for (const gate of YR_PASSTHROUGH_GATES) builder.addGate(gate);
  const result = builder.install();
  if (!result.ok) return result;
  const gates = result.gates;
  memory.write_memory(new Uint8Array(le32(RENDER_PASSTHROUGH_KEY_RGB565)), builder.userWord(WORD.key));
  return { ok: true, gates, control: createControl(gates, builder.userWord(0)) };
}

function emitTerrainFill(builder: GuestGateBuilder): void {
  const { asm } = builder;
  builder.emitOwnerThreadCheck('terrain:fill:original');
  const terrain = builder.switchWord('terrain:fill');
  asm.btMem(terrain.address, terrain.bit).jc('terrain:fill:key');
  asm.label('terrain:fill:original');
  // Original copy: Composite->CopyFromPart(&ViewBounds, Tile(eax), &ViewBounds, 0, 1).
  asm.pushImm(1).pushImm(0).pushImm(YR_TACTICAL_VIEW_BOUNDS).raw(0x50).pushImm(YR_TACTICAL_VIEW_BOUNDS);
  asm.raw(0x8b, 0x11, 0xff, 0x52, 0x08).ret(); // mov edx,[ecx]; call [edx+8]
  asm.label('terrain:fill:key');
  asm.incMem(builder.userWord(WORD.fills));
  asm.pushMem(builder.userWord(WORD.key)).pushImm(YR_TACTICAL_VIEW_BOUNDS);
  asm.raw(0x8b, 0x11, 0xff, 0x52, 0x14).ret(); // mov edx,[ecx]; call [edx+0x14] FillRect(&ViewBounds, colour)
}

function emitRedrawRequest(builder: GuestGateBuilder): void {
  const { asm } = builder;
  builder.emitOwnerThreadCheck('redraw:read');
  const request = builder.userWord(WORD.redrawRequest);
  asm.cmpMemImm8(request, 0).je('redraw:read');
  asm.movMemImm(request, 0).incMem(builder.userWord(WORD.redraws));
  builder.emitLatchSwitches();
  asm.movEaxMem(builder.userWord(WORD.flags)).movMemEax(builder.userWord(WORD.applied));
  asm.pushImm(1).raw(0x8b, 0xce).call(MARK_NEEDS_REDRAW); // push 1; mov ecx, esi; call MarkNeedsRedraw
  asm.label('redraw:read');
  asm.raw(0x8b, 0x46, 0x0c, 0xc7, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x00).ret(); // original read and clear
}

/** Switches enabled by a set of category flags. */
export function yrPassthroughSwitches(flags: number): string[] {
  const on = (category: Category) =>
    category === 'always' ? (flags & RENDER_PASSTHROUGH_ALL) !== 0 : (flags & RENDER_PASSTHROUGH[category]) !== 0;
  const switches = YR_PASSTHROUGH_GATES.filter((gate) => on(gate.category)).map((gate) => gate.name);
  if (flags & RENDER_PASSTHROUGH.terrain) switches.push('terrain:fill');
  if (flags & RENDER_PASSTHROUGH.objects) switches.push('anim:building');
  return switches;
}

function readUserWords(memory: GuestMemory, userBase: number): number[] {
  const bytes = memory.read_memory(userBase, 32);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 8 }, (_, index) => view.getUint32(index * 4, true));
}

function createControl(gates: InstalledGates, userBase: number): RenderPassthroughControl {
  return {
    supported: RENDER_PASSTHROUGH_ALL,
    keyRgb565: RENDER_PASSTHROUGH_KEY_RGB565,
    configAddress: gates.data,
    set(memory, flags) {
      if (!Number.isInteger(flags) || flags < 0 || flags & ~RENDER_PASSTHROUGH_ALL) return false;
      const previous = readUserWords(memory, userBase)[WORD.flags];
      // Pending only: the redraw:request stub latches them at the next frame start, with a full repaint. The host runs
      // only between guest instructions, so the bitmap is complete before the request is visible; should the guest be
      // halfway through copying an older bitmap, the new request makes the next frame latch again.
      writeGateSwitches(memory, gates, yrPassthroughSwitches(flags), 'pending');
      memory.write_memory(new Uint8Array(le32(flags)), userBase + WORD.flags * 4);
      if (flags !== previous) memory.write_memory(new Uint8Array(le32(1)), userBase + WORD.redrawRequest * 4);
      return true;
    },
    read(memory) {
      const words = readUserWords(memory, userBase);
      return {
        flags: words[WORD.flags]!,
        applied: words[WORD.applied]!,
        counters: {
          ...readGateCounters(memory, gates),
          'terrain:fill': words[WORD.fills]!,
          'redraw:request': words[WORD.redraws]!,
        },
      };
    },
  };
}

/** GameRuntimeHooks entry: install, or report why not and leave the image untouched. */
export function prepareYrRenderPassthrough(
  memory: GuestMemory,
  reserve: (size: number, alignment?: number) => number,
  thread: GuestGateOptions['thread'] = YR_GATE_THREAD,
): RenderPassthroughControl | null {
  let result: YrPassthroughResult;
  try {
    result = installYrTacticalPassthrough(memory, reserve, thread);
  } catch (error) {
    // No room or unreadable memory: run the game unpatched rather than fail the session.
    console.warn('[passthrough] YR tactical passthrough not installed:', error);
    return null;
  }
  if (result.ok) return result.control;
  console.warn(
    `[passthrough] YR tactical passthrough not installed: ${result.reason}`,
    result.mismatches.map((m) => ({
      site: m.name,
      address: `0x${m.address.toString(16)}`,
      expected: m.expected.map((b) => b.toString(16).padStart(2, '0')).join(' '),
      actual: m.actual.map((b) => b.toString(16).padStart(2, '0')).join(' '),
    })),
  );
  return null;
}

/** Every site the installer verifies, with its original bytes (documentation, tests and image checks). */
export function yrPassthroughOriginalBytes(): { name: string; address: number; bytes: number[] }[] {
  const sites = YR_PASSTHROUGH_GATES.map(({ name, site }) => ({
    name,
    address: site.address,
    bytes:
      site.kind === 'pointer'
        ? le32(site.target)
        : site.kind === 'call'
          ? [0xe8, ...le32(site.target - (site.address + 5))]
          : [...site.prologue],
  }));
  return [
    { name: 'terrain:fill', address: TERRAIN_COPY_SITE, bytes: [...TERRAIN_COPY_ORIGINAL] },
    { name: 'redraw:request', address: REDRAW_SITE, bytes: [...REDRAW_ORIGINAL] },
    ...sites,
  ];
}
