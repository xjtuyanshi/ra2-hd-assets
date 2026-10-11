# YR 1.001 numbered vehicle turrets

Baseline: the player's `gamemd.exe` 1.001, SHA-256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`, matching
`YR_STARTUP_PAGE_HASH`. The field names below are YRpp facts (`TechnoClass.h`, `TechnoTypeClass.h`,
`ObjectTypeClass.h`); the addresses were independently checked in this executable.

| Field | Offset | Instruction evidence |
| --- | --- | --- |
| `TechnoClass::CurrentTurretNumber` | `+0x124` | Getter `0x70DCF0` reads this signed integer. Stores `0x70DCAB` and `0x70DCC9` assign the native weapon-to-turret mapping result. |
| `TechnoTypeClass::TurretCount` | `+0x808` | `0x717880` reads this integer and tests whether it is positive. |
| `TechnoTypeClass::IsGattling` | `+0xCD5` | `UnitClass::DrawAsVXL` tests this byte at `0x73B8F2` and `0x73BC3B`; gattling units use the ordinary turret path. |

`DrawAsVXL` at `0x73B8E3..0x73B90E` selects the numbered barrel only when the type has multiple turrets
and is not gattling, then calls the current-turret getter and indexes the type's array. The turret path uses
the same gates at `0x73BC28..0x73BC43`. The type owns eighteen charger-turret and charger-barrel entries.
The observer accepts `0 <= index < TurretCount <= 18`; it omits unavailable, invalid and ordinary turret states.
Zero is a valid selection, distinct from a missing read. Neither passenger names nor weapon indices determine
the renderer's choice.

The player's rules set `[FV] TurretCount=4`, with normal index `0`, gun index `1`, repair-arm index `2`, and
high-tech index `3`. `RepairTurretWeapon=1` is a different index: publishing that value as the turret would show
the gun instead of the repair arm. Boarding and unloading remain entirely owned by the original engine.

The render snapshot carries optional `turretIndex` through `YrObjectState`, `GameRenderObject`, and the HD bridge.
Its change key includes the validated selection so a transition within one logic frame invalidates the cached
picture. Native mirror follow rules already cover the unit's first `0x800` bytes and its type's first `0x1000`
bytes; the new fields require no extra memory subscription or native agent changes.

Asset-free regressions cover the sequence `0 -> 2 -> 0 -> 1 -> 3 -> 0`, invalid and unavailable fields,
the gattling exclusion, same-frame publication, and the bridge preserving zero. These establish reader/transport
behavior, not a live match. Real-game visual acceptance must board an engineer using ordinary input, compare the
original and HD repair arm, unload back to the original turret, then board an ordinary infantry gunner. Rotation,
shadows and owner colour must be checked on that same scene. Record browser and native-host results separately;
shared code and passing fixtures do not establish live acceptance on both execution paths.
