# YR 1.001 order state (selection, control groups, missions, rally point, last alert)

Research note for `src/games/yr/commandState.ts`. Baseline: gamemd.exe SHA-256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6` (the pinned Yuri's Revenge 1.001 build), observed in
play build 5 of the remaster fork. Field names follow the community YRpp headers (Phobos-developers/YRpp), used as
names only; every offset below was confirmed on the player's own executable and in a running skirmish.

## Method

1. A read-only probe in the VM Worker dumped the first 0x700 bytes of every object of the local house before and after
   one real input (a mouse click or key press sent through the page's input path), and the dword-level differences of
   the selected object were compared across eight orders (idle, move, stop, force fire, force move, guard, Ctrl+Shift
   move, stop).
2. The offsets that changed with the order were then looked up in the executable for an instruction that reads or
   writes them in a routine whose purpose is known.
3. The reader validates the executable hash and the instruction bytes below before it reads anything.

## Fields

| Field | Offset | Live observation | Instruction in gamemd.exe |
| --- | --- | --- | --- |
| Current mission | object +0xAC | idle 5 (Guard), move and force move 2 (Move), force fire and attack 1 (Attack), escort 11 (Area_Guard) | getter `8B 81 AC 00 00 00 C3` at 0x46B5B0 |
| Queued mission | object +0xB4 | -1; 11 right after the guard key | getter `8B 81 B4 00 00 00 C3` at 0x4A5950 |
| Control group | techno +0x214 | -1; 0 after Ctrl+1 on the selection | team-creation routine 0x731060 (called by the TeamCreate command, vtable 0x7EB84C slot 8) stores it at 0x7310BF `89 86 14 02 00 00` and clears former members to -1 at 0x7310AB |
| Focus | techno +0x218 | the escorted unit after Ctrl+Alt+click; a map cell for a barracks after its rally point was set | setter `89 81 18 02 00 00` at 0x70C614 |
| Target | techno +0x2B4 | a map cell after Ctrl+click on ground; the building after a click on an enemy building | TechnoClass::SetTarget reads it at 0x6FCDBE `8B 86 B4 02 00 00` |
| Destination | mobile object +0x5A4 | the clicked cell while moving; 0 after the stop key | FootClass::SetDestination stores it at 0x4D9510 `89 B5 A4 05 00 00` |
| Cell of a pointer | CellClass +0x24 (two shorts X, Y) | a destination whose first dword is 0x7E4EEC (the CellClass vtable) held the cell under the click | - |
| Newest radar event | ring of 8 cells at 0xB04D48, newest index at 0xB04D88 (-1 none) | the cell the Space key (CenterOnRadarEvent) jumps to | getter 0x660BB0 `8B C1 8B 0D 88 4D B0 00 83 F9 FF`, called by the command's routine 0x734120 |

Selection (+0x83), owner (+0x21C), type and health come from the offsets `stateReader.ts` already documents.

Mission numbers are the engine's enumeration (Sleep 0, Attack 1, Move 2, QMove 3, Retreat 4, Guard 5, Sticky 6, Enter 7,
Capture 8, Eaten 9, Harvest 10, Area_Guard 11, Return 12, Stop 13, Ambush 14, Hunt 15, Unload 16, Sabotage 17,
Construction 18, Selling 19, Repair 20, Rescue 21, Missile 22, Harmless 23, Open 24, Patrol 25, ParadropApproach 26,
ParadropOverfly 27, Wait 28, AttackMove 29, SpyplaneApproach 30, SpyplaneOverfly 31).

## Observed behaviour worth knowing

- Ctrl+Shift+click (attack-move) shows as mission Move with a destination cell; no separate mission value appeared.
- The stop key leaves mission Move for a moment and clears the destination; the unit returns to Guard afterwards.
- While the planning key (Z) is held, clicked waypoints do not change the unit; the Move order appears when the key is
  released.
- A radar event stays in the ring after the fight is over, so the jump key works long after the alert.
- "Construction complete" did not add a radar event in the observed sessions; an attack on a building of the player did.

## Limits

- Only verified for the Soviet side on one temperate map; the layout is side-independent in the engine, but aircraft
  and naval units were not exercised.
- The reader runs between emulator slices and may see a logic frame half done; every pointer is validated and an
  implausible object is skipped.
- Planning-mode paths, veterancy and the sidebar's placement state are not read.
