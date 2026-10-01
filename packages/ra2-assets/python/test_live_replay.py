"""Asset-free regressions for densifying frozen live snapshots into a per-frame sandbox replay."""

import json
from pathlib import Path
import tempfile
import unittest

import live_replay as lr


def snapshot(frame, anims, objects=None, shroud=None):
    snap = {
        "frame": frame,
        "view": {"x": 0, "y": 0},
        "houses": [],
        "objects": objects if objects is not None else [{"uid": 7, "type": "TANK", "health": 1}],
        "effects": {"anims": anims, "bullets": [{"id": 1}], "particleSystems": []},
    }
    if shroud is not None:
        snap["shroud"] = shroud
    return snap


def anim(uid, type_, stage, count, x=2560, y=2560, z=208):
    return {"id": uid, "uid": uid, "type": type_, "x": x, "y": y, "z": z, "frame": stage, "stage": stage,
            "frameCount": count}


class DensifyTest(unittest.TestCase):
    def setUp(self):
        self.states = [
            snapshot(100, [anim(1, "BOOM", 0, 20), anim(2, "FIRE", 3, 8), anim(3, "DEBRIS", 0, 15, z=228)],
                     shroud={"cells": {}}),
            snapshot(110, [anim(1, "BOOM", 9, 20), anim(2, "FIRE", 5, 8),
                           anim(3, "DEBRIS", 9, 15, x=2620, z=440)]),
            snapshot(143, [anim(2, "FIRE", 1, 8), anim(4, "LATE", 2, 10)]),
        ]

    def test_one_shot_anims_follow_their_measured_stage_rate(self):
        snaps = lr.densify(self.states, 95, 150)
        boom = {s["frame"]: a for s in snaps for a in s["effects"]["anims"] if a["uid"] == 1}
        # Seen at stage 0 (frame 100) and 9 (frame 110): 0.9 stages per frame, gone at stage 20.
        self.assertNotIn(99, boom)
        self.assertEqual(boom[100]["stage"], 0)
        self.assertEqual(boom[110]["stage"], 9)
        self.assertEqual(max(boom), 122)
        # Seen once: spawned stage / --rate frames before its observation.
        late = [s["frame"] for s in snaps for a in s["effects"]["anims"] if a["uid"] == 4]
        self.assertEqual((late[0], late[-1]), (141, 150))

    def test_moving_anims_fly_a_ballistic_arc_and_land(self):
        snaps = lr.densify(self.states, 100, 160)
        flight = {s["frame"]: a for s in snaps for a in s["effects"]["anims"] if a["uid"] == 3}
        self.assertEqual(flight[110]["z"], 440)
        self.assertEqual(flight[105]["x"], 2590)
        self.assertGreater(flight[105]["z"], 228)
        self.assertLess(max(flight), 160)
        # Debris anims loop their frames while they fly.
        self.assertEqual(flight[100 + 16]["stage"], 1)

    def test_persistent_anims_objects_and_grids(self):
        pre = snapshot(50, [], objects=[{"uid": 7, "type": "TANK", "health": 1}, {"uid": 9, "type": "DERRICK", "health": 1}])
        states = [dict(s, objects=[{"uid": 7, "type": "TANK", "health": 1}]) for s in self.states]
        snaps = lr.densify(states, 98, 101, pre=pre, restore=[9])
        types = [sorted(o["type"] for o in s["objects"]) for s in snaps]
        self.assertEqual(types, [["DERRICK", "TANK"], ["DERRICK", "TANK"], ["TANK"], ["TANK"]])
        # Fire is listed in every snapshot at one place: copied from the latest snapshot, not re-timed.
        fire = [a["stage"] for s in lr.densify(self.states, 112, 113) for a in s["effects"]["anims"] if a["uid"] == 2]
        self.assertEqual(fire, [5, 5])
        # Large grids are written once and carried forward by the sandbox; frozen projectiles are dropped.
        self.assertIn("shroud", snaps[0])
        self.assertNotIn("shroud", snaps[1])
        self.assertEqual(snaps[0]["effects"]["bullets"], [])

    def test_cli_reads_pair_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for i, s in enumerate(self.states):
                p = Path(tmp) / f"native-{i}.json"
                p.write_text(json.dumps({"state": s, "raw": None}))
                paths.append(str(p))
            out = Path(tmp) / "replay.json"
            self.assertEqual(lr.main(["--states", *paths, "--first", "100", "--last", "104", "--out", str(out)]), 0)
            data = json.loads(out.read_text())
            self.assertEqual(data["fps"], 15)
            self.assertEqual([s["frame"] for s in data["snapshots"]], [100, 101, 102, 103, 104])


if __name__ == "__main__":
    unittest.main()
