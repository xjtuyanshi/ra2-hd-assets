#!/usr/bin/env python3
"""Densify a few frozen live snapshots into a per-logic-frame replay for the sandbox (?fx=replay).

Live captures freeze the bridge state (LiveSnapshot) at a handful of moments, for example a building's death, +0.7 s
and +3 s. The sandbox replay pushes one snapshot per logic frame, so this tool fills the frames in between:

- one-shot anims (explosions, smoke puffs) are re-timed from their observed stage: spawn = frame - stage / rate, with
  the rate measured between two observations of the same anim (uid) or ``--rate`` otherwise, and they leave the replay
  when their stage reaches frameCount;
- anims whose position changes between observations (debris anims the engine moves) fly a ballistic arc fitted to the
  observations (straight horizontal motion, constant gravity), loop their frames and leave the replay when they are
  back on the ground;
- anims present in every snapshot (looping fires, burning infantry, map anims) are copied from the latest snapshot;
- objects, houses and the view come from the latest snapshot at or before each frame; ``--restore UID`` keeps an
  object's record from ``--pre`` before the first snapshot (the building as it stood before it died).

Shroud, overlays and smudges are written only when they differ from the previous emitted snapshot; the sandbox
replay carries them forward. Bullets and beams are dropped (a frozen projectile would hang in the air).

Input files are either a LiveSnapshot or a live-pair record holding one under "state". No game art is read.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

CARRIED = ("shroud", "overlays", "smudges", "cells")
DROPPED = ("bullets", "lasers", "radBeams", "waves", "electricBolts", "beams")
# Leptons per logic frame squared, fitted to a debris anim of a live oil-derrick death (DBRIS7LG: launched at z=228,
# z=440 ten frames later, back at z=209 after 43 frames).
GRAVITY = 1.312


def load_state(path: Path) -> dict:
    data = json.loads(path.read_text())
    return data.get("state", data) if isinstance(data, dict) else data


def _one_shot_track(observations: list[tuple[int, dict]], rate: float) -> dict:
    """Spawn frame, stage rate and motion of an anim seen at (frame, record) observations, sorted by frame."""
    (f0, a0) = observations[0]
    moving = any(
        (a["x"], a["y"], a["z"]) != (a0["x"], a0["y"], a0["z"]) for _, a in observations[1:]
    )
    measured = None
    for (fa, a), (fb, b) in zip(observations, observations[1:]):
        ds = (b.get("stage") or 0) - (a.get("stage") or 0)
        if fb > fa and ds > 0:
            measured = ds / (fb - fa)
            break
    r = rate if moving or measured is None else min(1.5, max(0.3, measured))
    track = {"spawn": f0 - (a0.get("stage") or 0) / r, "rate": r, "record": a0, "moving": moving}
    if moving:
        (f1, a1) = observations[1]
        dt = max(1, f1 - f0)
        vx = (a1["x"] - a0["x"]) / dt
        vy = (a1["y"] - a0["y"]) / dt
        # z(t) = z0 + vz t - g t^2 / 2 through the second observation.
        vz = (a1["z"] - a0["z"] + 0.5 * GRAVITY * dt * dt) / dt
        track.update(start=f0, x=a0["x"], y=a0["y"], z=a0["z"], vx=vx, vy=vy, vz=vz)
    return track


def _anim_at(track: dict, frame: int) -> dict | None:
    rec = track["record"]
    count = max(1, rec.get("frameCount") or 1)
    if track["moving"]:
        t = frame - track["start"]
        if t < 0:
            return None
        z = track["z"] + track["vz"] * t - 0.5 * GRAVITY * t * t
        if t > 0 and z < track["z"] - 20:
            return None
        stage = int(t) % count
        out = dict(rec, x=round(track["x"] + track["vx"] * t), y=round(track["y"] + track["vy"] * t), z=round(z))
    else:
        if frame < track["spawn"]:
            return None
        stage = int((frame - track["spawn"]) * track["rate"])
        if stage >= count:
            return None
        out = dict(rec)
    start = (rec.get("frame") or 0) - (rec.get("stage") or 0)
    out["stage"] = stage
    out["frame"] = start + stage
    return out


def densify(states: list[dict], first: int, last: int, rate=1.0, pre: dict | None = None, restore=()) -> list[dict]:
    states = sorted(states, key=lambda s: s["frame"])
    seen: dict[int, list[tuple[int, dict]]] = {}
    for s in states:
        for a in (s.get("effects") or {}).get("anims", []):
            if not a.get("buildingAnim"):
                seen.setdefault(a["uid"], []).append((s["frame"], a))
    persistent = {
        uid
        for uid, obs in seen.items()
        if len(obs) == len(states) > 1 and len({(a["x"], a["y"], a["z"]) for _, a in obs}) == 1
    }
    tracks = {uid: _one_shot_track(obs, rate) for uid, obs in seen.items() if uid not in persistent}
    restored = {o["uid"]: o for o in (pre or {}).get("objects", []) if o["uid"] in set(restore)}
    out: list[dict] = []
    previous: dict = {}
    for frame in range(first, last + 1):
        base = next((s for s in reversed(states) if s["frame"] <= frame), states[0])
        snap = {k: copy.deepcopy(v) for k, v in base.items() if k not in CARRIED and k not in ("effects", "raw", "zf")}
        snap["frame"] = frame
        if frame < states[0]["frame"] and restored:
            kept = [o for o in snap["objects"] if o["uid"] not in restored]
            snap["objects"] = kept + [copy.deepcopy(o) for o in restored.values()]
        for key in CARRIED:
            value = base.get(key)
            if value is not None and previous.get(key) is not value:
                snap[key] = value
                previous[key] = value
        effects = {k: v for k, v in (base.get("effects") or {}).items() if k not in DROPPED and k != "anims"}
        for key in DROPPED:
            effects[key] = []
        anims = [a for a in (base.get("effects") or {}).get("anims", []) if a.get("buildingAnim") or a["uid"] in persistent]
        for uid, track in tracks.items():
            a = _anim_at(track, frame)
            if a is not None:
                anims.append(a)
        effects["anims"] = anims
        snap["effects"] = effects
        out.append(snap)
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--states", nargs="+", type=Path, required=True, help="frozen snapshots (LiveSnapshot or pair JSON)")
    p.add_argument("--pre", type=Path, help="a snapshot from before the first state, for --restore")
    p.add_argument("--restore", type=int, nargs="*", default=[], help="object uids kept from --pre before the first state")
    p.add_argument("--first", type=int, required=True, help="first logic frame of the replay")
    p.add_argument("--last", type=int, required=True, help="last logic frame of the replay")
    p.add_argument("--rate", type=float, default=1.0, help="stages per logic frame when an anim was seen only once")
    p.add_argument("--fps", type=float, default=15)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args(argv)
    states = [load_state(s) for s in a.states]
    pre = load_state(a.pre) if a.pre else None
    snaps = densify(states, a.first, a.last, a.rate, pre, a.restore)
    a.out.write_text(json.dumps({"fps": a.fps, "snapshots": snaps}, separators=(",", ":")))
    print(a.out, len(snaps), "snapshots", a.out.stat().st_size // 1024, "KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
