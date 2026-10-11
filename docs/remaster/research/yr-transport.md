# YR 1.001: transports and engineers

Research note behind lesson 5 (`yr-engineer` in `src/games/yr/training/lessons.ts`), the transport rows of the cheat
sheet and the `facing` / `passengers` fields of `src/games/yr/commandState.ts`. Baseline: the pinned gamemd.exe 1.001
with the player's rules, play build 5, Soviet side on one temperate map, normal game speed. Everything was done with
real mouse and key input and read from the game's order state.

## Reader fields

The IFV's engine-selected turret art is documented separately in [Numbered vehicle turrets](yr-unit-turrets.md).

- Passengers: count at techno +0x114, newest passenger at +0x118. At 0x41532E the address of that pair is taken and
  the getter 0x473450 (`mov eax,[ecx+4]; ret`) is called; the routine around 0x473400 stores the new passenger there
  and increments the count. Live, the count of a flak track went 0, 1, 3 as three infantry entered. A unit inside a
  transport is in limbo and absent from the object list.
- Facing: the body `FacingClass` at +0x388 (as in `stateReader.ts`), reduced to 0..255: 0 is the map's north (-Y), 64
  is +X, 128 +Y, 192 -X.

## Observations (flak track unless stated)

| Question | Observed |
| --- | --- |
| Boarding | With infantry selected, a left click on the vehicle makes it walk there and enter; the vehicle's count rises. |
| Team number | An engineer given team 3 before boarding: the team key selects nothing while he is inside; after unloading his team field is unchanged and the key selects him again. So no order can be given to a passenger before he is out. |
| Unloading | The deploy key (D) on the selected vehicle. The first passenger appeared 10 to 12 frames after the key in four runs. |
| Order | Last in, first out. Three passengers came out 12, 25 and 52 frames after the key (earlier run: 10, 27, 47). |
| Side | Always behind the vehicle: 0.8 to 1.5 cells from its centre, opposite its facing, in four unloads with facings north, east and west. Each passenger then walks a step away on its own (mission Move). |
| Final facing | The direction of the vehicle's last step: it faced north after arriving from the south, west after a one-cell step west, east after driving east up to a building. |
| Putting the rear toward a building | Drive to the cell next to the building, then order one cell directly away from it: the vehicle then faces away and its rear cell is the one beside the building. |
| Capture | With the rear toward a power plant, D, team key, click on the building: captured 114 frames after D and 166 frames after the vehicle stopped (the driver's own pauses included). The building changes owner when the engineer enters. With the engineer let out on the far side of the vehicle, the walk alone took 144 frames. |
| Allied IFV | One Allied engineer: out 12 frames after D, behind the vehicle, like the flak track. |

## Not measured

What happens when the rear cell is blocked; amphibious transports, the Nighthawk and the Battle Fortress; other game
speeds (frame counts should hold, seconds scale with the speed); whether a vehicle under fire unloads differently.
