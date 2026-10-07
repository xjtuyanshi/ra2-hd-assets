# YR 1.001 hotkeys: what the game binds and what reaches it in the page

Research note for the key handling of the remaster fork's play page (`src/ui/pages/game/gameInput.ts`), the cheat sheet
(`src/games/yr/hotkeys.ts`) and the practice lessons. Baseline: gamemd.exe SHA-256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6` and the KEYBOARDMD.INI inside the player's
langmd.mix (1,869 bytes), observed with play build 5 on macOS in the test Chrome. No game text is reproduced here; the
command names are the identifiers the executable itself uses as INI keys.

## Where bindings come from

- Function 0x532150 registers every command object in the vector at 0x87F658: 89 objects, of which two
  (MultiplayerDebug, ExtraSyncChecking) only when the byte at 0xA8B8B4 is set. Each class's vtable getters give the INI
  name (slot 1), the UI name key (slot 2), the category key (slot 3) and the description key (slot 4); slot 8 executes.
- Function 0x533D20 opens KEYBOARDMD.INI (a loose file in the game folder wins, otherwise the copy inside the language
  MIX), walks section `[Hotkey]`, looks for the registered command with each entry's name and stores (key, command) in
  the index at 0x87F680. A key value is the Windows virtual key plus 0x100 for Shift, 0x200 for Ctrl, 0x400 for Alt.
- Nothing else is compiled in, except three keys forced after the file was read (0x533C43..0x533D18): 0x2E (Delete)
  for the Delete command, 0x1B (Esc) for Options and 0x20 (Space) for CenterOnRadarEvent.
- 29 entries of the file name commands this executable does not register (map editor and Tiberian Sun leftovers such as
  RaiseCell, FreeMoney, SidebarPageUp); they do nothing. HealthNav and CursorCheat are registered without a key.
- The Red Alert 2 file (keyboard.ini in ra2.mix/local.mix) and the Yuri's Revenge file differ only in Delete (46 and
  110), ScreenCapture (Ctrl+C and Shift+S), SidebarUp / SidebarDown (2086 / 2088 and Numpad 8 / 2), the added
  VeterancyNav and PreviousObject, and dead entries. The Q / W / E / R tab keys are in both files.
- The player's installation carries a rules change (a rulesmd.ini in expandmd01.mix that differs from the one in
  ra2md.mix/localmd.mix in build times, costs and strengths). It does not touch keys or controls.

## The registered commands, their default key and how it is reached on a MacBook

"As is" = the key reaches the game through the page unchanged. Modifier and mouse operations that are not commands
(force fire, force move, attack-move, escort, add to selection, double click, waypoint mode by holding Z, rally point)
are handled inside the game from the key state and the mouse messages; they were verified live (see below).

| Command | Default key | On a MacBook in this page |
| --- | --- | --- |
| MultiplayerDebug | Ctrl+I | debug only |
| ExtraSyncChecking | (none) | debug only |
| Follow | F | as is |
| View1 | F1 | needs fn |
| View2 | F2 | needs fn |
| View3 | F3 | needs fn |
| View4 | F4 | needs fn |
| SetView1 | Ctrl+F1 | needs fn and ⌘ (macOS takes Control+F2..F4) |
| SetView2 | Ctrl+F2 | needs fn and ⌘ (macOS takes Control+F2..F4) |
| SetView3 | Ctrl+F3 | needs fn and ⌘ (macOS takes Control+F2..F4) |
| SetView4 | Ctrl+F4 | needs fn and ⌘ (macOS takes Control+F2..F4) |
| Options | Esc | as is |
| SidebarUp | Numpad8 | no such key on a MacBook keyboard |
| SidebarDown | Numpad2 | no such key on a MacBook keyboard |
| CenterOnRadarEvent | Space | as is |
| PlaceBeacon | B | as is |
| ToggleSell | L | as is |
| ToggleRepair | K | as is |
| ToggleAlliance | A | as is |
| CenterBase | H | as is |
| CenterView | Numpad5 (NumLock off) | no such key on a MacBook keyboard |
| ScatterObject | X | as is |
| GuardObject | G | as is |
| StopObject | S | as is |
| AllToCheer | C | as is |
| DeployObject | D | as is |
| PreviousObject | M | as is |
| NextObject | N | as is |
| PlanningMode | Z | as is |
| CombatantSelect | P | as is |
| TypeSelect | T | as is |
| HealthNav | (none) | no default key |
| VeterancyNav | Y | as is |
| StructureTab | Q | as is |
| DefenseTab | W | as is |
| UnitTab | R | as is |
| InfantryTab | E | as is |
| ScreenCapture | Shift+S | as is |
| PageUser | U | as is |
| CursorCheat | (none) | no default key |
| Delete | Numpad. | fn+delete (the forced Delete key); Numpad . on an external keyboard |
| TeamCreate_1 … TeamCreate_10 | Ctrl+1 … Ctrl+0 | ⌘ or Control |
| TeamSelect_1 … TeamSelect_10 | 1 … 0 | as is |
| TeamAddSelect_1 … TeamAddSelect_10 | Shift+1 … Shift+0 | as is |
| TeamCenter_1 … TeamCenter_10 | Alt+1 … Alt+0 | as is |
| Taunt_1 … Taunt_8 | F5 … F12 | needs fn; taken by the page (F11 = fullscreen) |

Counts (87 commands outside the debug pair): 55 as is; 14 through ⌘ or Control (ten TeamCreate, four SetView, the latter
also with fn); 11 with fn (View1-4, seven taunts); 1 taken by the page (Taunt_7 on F11); 1 through fn+delete; 3 without
a key on a MacBook keyboard (SidebarUp, SidebarDown, CenterView); 2 without a default key (HealthNav, CursorCheat).

## The page's input path

- Keys: window keydown / keyup in the capture phase, only while the game canvas has focus. `KeyboardEvent.code` maps to
  a Windows virtual key (`input.ts`), posted as WM_KEYDOWN (WM_SYSKEYDOWN with Alt), WM_CHAR when no Ctrl / Alt / Meta
  is held, and mirrored in the key-state table; the browser default is prevented. Not forwarded: the page's own keys
  F11, `[`, `]`, `?`, `\` (HD sessions) and the backquote (unless `?debug-key=0`). VK 0x0C (the CenterView key) has no
  mapping.
- Mouse: pointer events on the canvas; left, right and middle buttons; MK_SHIFT / MK_CONTROL from the event or the held
  keys; wheel as WM_MOUSEWHEEL of ±120 per event; side buttons blocked.
- macOS reports Control + primary button as a secondary click; the page turns it back into a left click with Ctrl
  (three delivery variants).

## Findings and changes

1. Shift + left button was replaced by ten plain clicks 50 ms apart on the whole frame (the page's build-queue
   convenience). Live: with one tank selected, Shift + click on a second tank left only the second selected. Now the
   repeat applies only inside the build bar (`SupportedGame.buildStripWidth`); live after the change: Shift + click
   adds, a second Shift + click removes, Shift + drag adds a box.
2. ⌘ is forwarded as the game's Ctrl on Apple platforms (`GameInputOptions.metaAsControl`, off with
   `?mac-cmd-ctrl=0`). Reasons: macOS itself uses Control + click (secondary click), Control + F2 / F3 / F4 (keyboard
   navigation), Control + arrows and, when enabled, Control + digits (Mission Control), while ⌘ has no meaning in the
   game (it used to arrive as the Windows key). macOS sends no keyup for a key pressed while ⌘ is down, so such keys
   are released by the page 60 ms after the press. Control keeps working.
3. In fullscreen on Apple platforms the Keyboard Lock request covers every key instead of only Esc, so that ⌘
   combinations the browser would take (for example ⌘W) can reach the page where the browser allows it.
4. `?debug-key=0` (used by the practice launcher) gives the backquote key, next to "1", back to the game instead of
   opening the debug panel with call tracing.

## What was tested where

- In the test Chrome through real key and mouse events, with the effect read from the game: Ctrl+1 / 1 / Shift+1 /
  Alt+1 and the same with 2, arrows, H, Space (jump to the newest radar event), T, P, N, M, D, Q, W, E, K, L, S, X, G,
  F (the camera then ignores arrows until F is pressed again), Esc (options page; a second Esc does not resume), F1
  and Ctrl+F1, Ctrl+click, Alt+click, Ctrl+Shift+click, Ctrl+Alt+click on an own unit, double click, Shift+click and
  Shift+drag, right click on a cameo (hold, then cancel with refund), holding Z for waypoints, rally point.
- Not effect-tested: R (needs a war factory), Y (needs veterans), A / B / C / U and the taunts (multiplayer), Shift+S,
  the other digits and bookmarks (same code path as the tested ones).
- By rule, not testable in a test browser (its input bypasses the operating system and the browser's own shortcuts):
  fn for function keys, Control + F2..F4 and Control + digits or arrows taken by macOS, ⌘ + digit against the browser's
  tab switching, ⌘W / ⌘Q / ⌘H / ⌘M / ⌘Tab, Esc leaving fullscreen without the keyboard lock, the secondary-click
  rewrite of Control + click, trackpad gestures.
