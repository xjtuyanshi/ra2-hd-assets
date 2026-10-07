# YR 1.001: when units attack on their own

Research note behind the first group of the hotkey cheat sheet (`src/games/yr/hotkeys.ts`) and lesson 3
(`src/games/yr/training/lessons.ts`). Baseline: the pinned gamemd.exe 1.001 with the player's rules, play build 5,
Soviet side on one temperate map, normal game speed. Everything below was read from the game's order state
(`getCommandState`) about once a second; nothing was assumed from other versions.

## Staging

Two scratch scenarios in the symmetric style of the lessons. "Passive": six groups of four idle units of the player
(Rhino tank, conscript, flak track, war miner; never given an order) with one object of the computer player each: an
engineer 3 cells away, a Rhino 4 cells away, a Rhino 9 cells away, a power plant 3 cells away, a sentry gun 4 cells
away, a V3 launcher 11 cells away; observed for 934 logic frames. "Orders": four groups (two Rhinos, a conscript, a
flak track) standing 10 cells from a post of a sentry gun and a power plant, each given one order through real input
and observed for about 690 frames.

## Observations

| Situation | What happened |
| --- | --- |
| Idle, unarmed enemy unit inside range (engineer; Rhino 4.1 cells, conscript 2.2, miner about 3) | Rhino, conscript and miner shot it at once; the flak track did nothing. Their mission stayed Guard; only the target field was set. |
| Idle, enemy Rhino near the edge of range (own Rhino 5.1 cells with range 5.75; conscript 3.2 cells with range 4) | Neither reacted in 934 frames, while the enemy Rhino killed the war miner standing between them. The miner (3.2 cells, range 5.5) fought back alone. |
| Idle, enemy Rhino 9 cells away | It drove up and attacked; every unit it came close to or hit fired back and it was destroyed. |
| Idle, enemy power plant 3 cells away | Nobody fired at it at any time. |
| Idle, enemy sentry gun 4 to 5 cells away | The gun opened fire; the Rhino and the conscript it hit fought back. |
| Idle, enemy V3 11 cells away | The V3 did not fire (its rules entry forbids passive acquisition) and drove off; not a test of being outranged. |
| Plain move order to a spot 3 cells in front of the post | The Rhinos and the flak track fought the gun when they got there and destroyed it; the conscript stopped 5 cells out (beyond its range) and did nothing. The power plant was never attacked. |
| Attack-move (Ctrl+Shift+click) to the same spot | Missions Move with a queued Attack, then Attack: the gun was destroyed. The power plant was never attacked. |
| Guard key (G) 10 cells from the post, no other order | Mission Area_Guard: the Rhinos and the flak track went for the gun from 10 cells away and destroyed it; the conscript stayed. The power plant was never attacked. |
| Escort (Ctrl+Alt+click on a Rhino), then the Rhino moved into the post | The escorting Rhino and conscript (Area_Guard, focus on the escorted unit) followed and fought the gun. A flak track of the same group that was not escorting stayed 12 cells away. |

## Conclusions used in the lessons

- Idle units fight armed units and defences that come well inside their weapon range, and whoever hits them. The last
  cell or so of the range did not trigger them, and they did not help a neighbour.
- No order observed here made units attack a building without weapons. It has to be clicked (with Ctrl when it is
  neutral).
- The guard key widens the area a unit reacts in; escorting ties a unit to another one's fights.
- The player's rules file differs from the one inside ra2md.mix only in costs, strengths, build times and a few weapon
  ranges; no key about passive acquisition, guarding or retaliation differs.

## Limits

One sample per situation; distances between the stated values were not measured, so the exact radius is unknown.
Being shot by an attacker that outranges the unit was not observed. Allied and Yuri units, aircraft and ships were
not tried.
