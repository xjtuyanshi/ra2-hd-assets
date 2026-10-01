#!/usr/bin/env python3
"""Coherent infantry animation redraws, registered back into the existing HD sprite atlas.

A sheet per (sequence, facing block) lets the image model redraw neighbouring animation frames as the same
character, keeping equipment, materials and lighting coherent through a cycle. Per-row cells share an anchor;
the model sees decoded house colours over flat grey on a native 1536x1024 or 1024x1536 canvas, without shadows.

* registration fits each redraw to its input with axis-aligned scale and translation, then samples the full-size
  output in linear light at 4x and box-downsamples to the atlas's 2x frames;
* colour lock restores low-frequency lightness and chroma in CIE Lab using the existing HD art as reference;
* body alpha comes from the HD atlas, with only an inward edge trim band following the model's silhouette;
  interior gaps fall back to the reference, and the HD antialiased rim keeps its alpha;
* house paint follows the model's house hue near the original paint (a narrow hue/saturation window, so skin and
  brown cloth next to a red house area stay unpainted), re-encoded on the renderer's grey ramp by value so the
  model's highlights and folds survive every house colour;
* an optional mild unsharp mask on the body interior (never the antialiased rim) restores the crispness the 2x
  downsample of the redraw loses;
* ground shadows stay black, with reduced opacity and a soft fringe on shadow or empty texels only.

``prepare`` writes model inputs, jobs and prompts; ``run`` invokes a command-line image agent with at most three
jobs in flight, three attempts per job and a shared usage-limit stop file. ``compose`` writes reviews and metrics;
``build`` rejects low-silhouette-IoU frames and installs variant pages into a symlink farm, merging just the chosen
HD page's colour/remap filenames into its library.json. ``build`` and ``polish`` optionally soften unpainted dark
rims and set per-page house-paint saturation; ``polish`` reads an existing variant and processes all selected
sprite frames on that page. NumPy and Pillow suffice for every stage except ``run``.
``install-pages`` composes finished sheets into staging pages and installs selected HD page entries into a
configurable cache farm, with locked manifest updates and optional donor-filled base pages.
All actual inputs and outputs are derived game art and must remain in gameres/ or another untracked directory.
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

import numpy as np
from PIL import Image

import redetail_sprites as rd
import hybrid_redraw as hr
from rematerialize import gaussian_blur

GREY = 118.0
GREYV = np.array([118, 118, 118], np.float32)
PAD, GAP = 3, 3
MAX_LONG, MAX_SHORT = 1536, 1024

UNITS = {  # type -> sprite; insertion order is the scheduling priority (typical skirmish frequency first)
    "E1": "infantry:GI", "E2": "infantry:CONS", "SHK": "infantry:SHK", "ENGINEER": "infantry:ENGINEER",
    "DOG": "infantry:DOG", "ADOG": "infantry:ADOG",
    "FLAKT": "infantry:FLAKT", "INIT": "infantry:INIT", "GGI": "infantry:GGI", "BRUTE": "infantry:BRUTE",
    "JUMPJET": "infantry:ROCK", "SLAV": "infantry:SLAV", "YURI": "infantry:YURI", "IVAN": "infantry:IVAN",
    "DESO": "infantry:DESO", "TERROR": "infantry:TRST", "SNIPE": "infantry:SNIPE", "SPY": "infantry:SPY",
    "TANY": "infantry:TANY", "VIRUS": "infantry:VIRUS", "BORIS": "infantry:BORIS", "GHOST": "infantry:SEAL",
    "CLEG": "infantry:CLEG", "YURIPR": "infantry:YURIX", "CIV1": "infantry:CIV1", "CIV2": "infantry:CIV2",
    "CIV3": "infantry:CIV3",
}

ALLIED, SOVIET, YURI_SIDE = "DarkBlue", "DarkRed", "Purple"
HOUSE = {"E1": ALLIED, "ENGINEER": ALLIED, "ADOG": ALLIED, "E2": SOVIET, "SHK": SOVIET, "DOG": SOVIET,
         "FLAKT": SOVIET, "IVAN": SOVIET, "DESO": SOVIET, "TERROR": SOVIET, "BORIS": SOVIET,
         "GGI": ALLIED, "JUMPJET": ALLIED, "SNIPE": ALLIED, "SPY": ALLIED, "TANY": ALLIED, "GHOST": ALLIED,
         "CLEG": ALLIED, "CIV1": ALLIED, "CIV2": ALLIED, "CIV3": ALLIED,
         "INIT": YURI_SIDE, "BRUTE": YURI_SIDE, "SLAV": YURI_SIDE, "YURI": YURI_SIDE, "VIRUS": YURI_SIDE,
         "YURIPR": YURI_SIDE}

UNIT_DESC = {
    "E1": ("Allied GI rifleman",
           "a modern-era infantry soldier: grey-blue steel combat helmet, sleeveless tactical vest / shirt in the team "
           "colour (blue), bare tanned forearms, olive-green camouflage combat trousers, black leather boots, a black "
           "assault rifle"),
    "E2": ("Soviet conscript",
           "a Soviet infantry conscript: grey steel helmet (SSh-40 shape), team-colour (red) shoulder boards, chest "
           "harness and ammunition pouches, a long tan/khaki wool greatcoat that reaches below the knees, black boots, "
           "a dark blue-grey steel Kalashnikov-style rifle"),
    "SHK": ("Soviet Tesla trooper",
            "a Soviet heavy infantry trooper in a bulky powered armour suit: polished steel-silver helmet and limb "
            "armour plates, team-colour (red) chest and back armour with an electric coil backpack, dark olive "
            "armoured leg sections, heavy boots, tesla gauntlets that discharge blue-white electric arcs"),
    "ENGINEER": ("combat engineer",
                 "a combat engineer: yellow hard hat, white shirt, team-colour (blue) work vest, khaki work trousers, "
                 "brown boots, carrying a blue metal tool case"),
    "DOG": ("Soviet attack dog",
            "a Soviet attack dog: a big grey-and-white wolf-like husky with thick fur, dark grey back, white legs and "
            "belly, wearing a team-colour (red) collar/harness"),
    "ADOG": ("Allied attack dog",
             "an Allied attack dog: a German shepherd with a black saddle and tan legs/belly, short dense fur, "
             "wearing a team-colour (blue) collar/harness"),
    "FLAKT": ("Soviet flak trooper",
              "a Soviet anti-aircraft infantryman: steel helmet, team-colour (red) chest armour and shoulder pads over a "
              "brown leather tunic, ammunition belts, dark trousers and black boots, carrying a heavy shoulder-mounted "
              "flak cannon (a long grey steel tube with a breech block and sight) that fires bright flak bursts"),
    "INIT": ("Yuri initiate",
             "a Yuri psychic initiate: a shaven-headed young acolyte in a dark grey tunic with team-colour (purple) "
             "robe panels, sash and arm bands, grey trousers with purple bands, black boots; he hurls glowing psychic "
             "energy from his hands"),
    "GGI": ("Allied guardian GI",
            "a heavy Allied anti-tank infantryman: dark steel helmet, team-colour (blue) armour plates on the shoulders "
            "and chest, tactical vest and webbing, dark olive trousers, black boots, carrying a shoulder-fired missile "
            "launcher; when deployed he sits behind sandbags"),
    "BRUTE": ("Yuri brute",
              "a Yuri brute: a hulking grey-skinned mutant giant with enormous muscular arms and fists, a hunched back "
              "and a small head, wearing torn team-colour (purple) trousers and straps; it smashes with its fists"),
    "JUMPJET": ("Allied rocketeer",
                "an Allied rocketeer: a soldier with a twin-nozzle jet pack on his back, a team-colour (blue) flight "
                "suit with white/silver armour plates and a helmet with visor, flying and firing a machine gun"),
    "SLAV": ("Yuri slave",
             "a Yuri slave labourer: a gaunt, bare-armed worker in a ragged yellowish vest and team-colour (purple) "
             "trousers, black boots, carrying a long-handled shovel which he uses to dig and carry ore"),
    "YURI": ("Yuri clone",
             "a Yuri clone: a bald psychic man in a long grey military greatcoat with team-colour (purple) panels and "
             "gold trim, black boots; he projects mind-control energy"),
    "IVAN": ("Crazy Ivan",
             "Crazy Ivan, a Soviet demolitions expert: a wild bearded man in a team-colour (red) fur cap (ushanka) and "
             "jacket with brown leather straps, satchels of dynamite bombs, dark trousers and boots"),
    "DESO": ("Soviet desolator",
             "a Soviet desolator: a soldier in a full black radiation suit with team-colour (red) armour plates and a "
             "sealed gas-mask helmet, carrying a radiation cannon with glowing green canisters; it fires toxic green "
             "radiation"),
    "TERROR": ("Soviet terrorist",
               "a Cuban terrorist: a man in a green shirt with rolled sleeves, khaki trousers and boots, with "
               "explosive charges and wires strapped to his chest"),
    "SNIPE": ("Allied sniper",
              "a British sniper: team-colour (blue) beret, khaki and tan camouflage outfit with a ghillie-style cape, "
              "brown boots, a long scoped sniper rifle"),
    "SPY": ("Allied spy",
            "a spy: a man in a dark charcoal business suit and a dark trilby hat, black shoes, holding a silenced pistol"),
    "TANY": ("Tanya",
             "Tanya, the Allied commando: an athletic woman with a dark brown ponytail, a team-colour (blue) tank top, "
             "olive cargo trousers, black boots, firing two pistols"),
    "VIRUS": ("Yuri virus",
              "a Yuri virus sniper: a slim woman with short dark hair in a dark bodysuit with team-colour (purple) "
              "panels and white details, carrying a long toxin sniper rifle"),
    "BORIS": ("Boris",
              "Boris, the Soviet hero: a big bearded soldier in a brown leather cap and jacket with team-colour (red) "
              "details, a white-grey undershirt, ammunition belts, carrying an assault rifle and a laser designator"),
    "GHOST": ("Allied Navy SEAL",
              "an Allied Navy SEAL commando: tan and olive tactical gear with team-colour (blue) details, a black "
              "balaclava/cap, webbing and pouches, a compact submachine gun"),
    "CLEG": ("Chrono legionnaire",
             "an Allied chrono legionnaire: an infantryman in a bulky futuristic white armoured suit with team-colour "
             "(blue) panels, a full helmet with visor and a chrono backpack, firing a blue-white chrono beam"),
    "YURIPR": ("Yuri Prime",
               "Yuri Prime: the bald psychic leader in long flowing team-colour (purple) and black robes with gold "
               "trim and a high collar, projecting psychic power"),
    "CIV1": ("civilian woman", "a civilian woman in a yellow dress and white shoes"),
    "CIV2": ("civilian man", "a civilian man in a white shirt, dark blue jeans and dark shoes"),
    "CIV3": ("civilian man", "a civilian man in a green jacket, dark trousers and boots, with dark hair"),
}


SEQ_DESC = {
    "Walk": "a walking cycle (the first column is the standing ready pose, then the 6 walk steps)",
    "FireUp": "standing and firing the weapon (muzzle flash / weapon effect in some frames)",
    "Crawl": "lying prone on the ground and crawling forward",
    "FireProne": "lying prone and firing the weapon",
    "DeployedFire": "the soldier deployed behind a circular sandbag emplacement (first column idle, then firing)",
    "DownUp": "dropping to prone (columns 1-2) and getting back up (columns 3-4)",
    "Idle1": "an idle fidget animation (reading order, left to right, top to bottom)",
    "Idle2": "a second idle fidget animation (reading order)",
    "Die1": "a death animation: hit, collapsing and lying dead on the ground (reading order)",
    "Die2": "a second death animation: thrown back, falling and lying dead (reading order)",
    "Deploy": "deploying: kneeling down and building a circular sandbag emplacement around himself (reading order)",
    "Cheer": "cheering animation and other single poses",
    "Misc": "assorted single poses",
    "SecondaryFire": "a second attack (reading order per row)",
    "Shovel": "digging ore with a shovel",
    "Carry": "carrying a load of ore",
    "Fly": "flying with the jet pack (jet flames below)",
    "FireFly": "flying and firing",
    "Tumble": "tumbling through the air after being hit (reading order)",
    "Panic": "running in panic",
    "Tread": "treading water: only the head, shoulders and arms are above the water line",
    "Swim": "swimming: only the head, shoulders and arms are above the water line",
    "WetAttack": "attacking from the water: only the upper body is above the water line",
    "WetIdle1": "idle while treading water (reading order)",
    "WetIdle2": "a second idle while treading water (reading order)",
    "WetDie1": "dying in the water (reading order)",
    "WetDie2": "a second death in the water (reading order)",
    "Idles": "two idle fidget animations, each in reading order (left to right, top to bottom): first the rows of "
             "idle 1, then the rows of idle 2",
    "Dies": "two death animations, each in reading order (left to right, top to bottom): first the rows of death 1 "
            "(hit, collapsing, lying dead), then the rows of death 2 (thrown back, falling, lying dead)",
}

FACING_SEQS = ("Walk", "FireUp", "Crawl", "FireProne", "DeployedFire", "DownUp", "SecondaryFire", "Shovel", "Carry",
               "Fly", "FireFly", "Panic", "Tread", "Swim", "WetAttack")


DOG_SEQ = {"Walk": "a running gallop cycle (the first column is the standing pose, then 6 run frames)",
           "FireUp": "leaping and biting attack",
           "Idle1": "idle: sitting / sniffing (reading order)", "Idle2": "idle: scratching / looking around (reading order)",
           "Die1": "a death animation: yelping, collapsing and lying dead (reading order)",
           "Die2": "a second death animation (reading order)", "Cheer": "a happy jumping / wagging animation"}


FACING_TEXT = {
    0: "facing AWAY from the camera, heading to the top of the image: we see the back (back of the helmet/head, back of "
       "the body); the face is NOT visible",
    1: "facing up-left, away from the camera: we see the back and the left side; the face is hidden (at most a sliver "
       "of the cheek)",
    2: "facing left: left side profile",
    3: "facing down-left, towards the camera: we see the front and the left side, face visible",
    4: "facing the camera, heading to the bottom of the image: front view, face visible",
    5: "facing down-right, towards the camera: we see the front and the right side, face visible",
    6: "facing right: right side profile",
    7: "facing up-right, away from the camera: we see the back and the right side; the face is hidden",
}


class Library:
    """Manifest-driven reads; immutable source arrays are cached within one library path."""

    def __init__(self, root: Path):
        self.root = root
        self.data = json.loads((root / "library.json").read_text(encoding="utf-8"))
        self._images = {}

    def image(self, filename, mode=None):
        key = (filename, mode)
        if key not in self._images:
            with Image.open(self.root / filename) as im:
                array = np.array(im.convert(mode) if mode else im)
            array.setflags(write=False)
            self._images[key] = array
        return self._images[key]

    def page1(self, page):
        return self.image(self.data["spriteAtlases"][page]["file"])

    def page2(self, page):
        return self.image(self.data["spriteAtlasesHd"][page]["file"], "RGBA")

    def remap2(self, page):
        return self.image(self.data["spriteAtlasesHd"][page]["remap"], "L")

    def palette(self, name):
        return self.image(self.data["palettes"][name], "RGB")[0].astype(np.float32)

    def scheme(self, name):
        index = self.data["colorSchemesByName"][name]
        return np.asarray(self.data["colorSchemes"][index]["remap"], np.float32)

    def frames(self, sprite):
        return self.data["sprites"][sprite]["frames"]

    def frame1(self, sprite, index, house="Red"):
        frame = self.frames(sprite)[index]
        x, y, w, h = frame["rect"]
        idx = self.page1(frame["page"])[y:y + h, x:x + w].astype(np.int32)
        pal = self.palette(self.data["sprites"][sprite]["palette"]).copy()
        if house:
            pal[16:32] = self.scheme(house)[:16]
        return pal[idx], idx > 0, (idx >= 16) & (idx <= 31), idx

    def decode_hd(self, rgba, paint, house="Red"):
        """Displayed HD colour, using the renderer's grey ramp without desaturation."""
        rgb = rgba[..., :3].astype(np.float32)
        ramp = self.scheme(house)
        k = np.clip((255 - rgb[..., 1]) / 15, 0, 15)
        k0 = np.floor(k).astype(int)
        k1 = np.minimum(k0 + 1, 15)
        col = ramp[k0] + (ramp[k1] - ramp[k0]) * (k - k0)[..., None]
        p = (paint.astype(np.float32) / 255)[..., None]
        return rgb * (1 - p) + col * p

    def frame2(self, sprite, index, house="Red"):
        frame = self.frames(sprite)[index]
        x, y, w, h = frame["rect"]
        crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
        rgba = self.page2(frame["page"])[crop]
        paint = self.remap2(frame["page"])[crop]
        return self.decode_hd(rgba, paint, house), rgba[..., 3], paint


@functools.lru_cache(None)
def _library(root: Path) -> Library:
    return Library(root)


def library(root: str | Path) -> Library:
    """Canonical paths share caches; different libraries never share pages or palettes."""
    return _library(Path(root).resolve())


def blocks(lib: Library, unit):
    """Unique animation blocks of a unit covering every body frame: [(name, rows)] where rows = list of frame lists."""
    t = lib.data["types"][unit]
    sp = t["sprite"]
    n = len(lib.frames(sp))
    # Empty frames (zero rect, no atlas page) have nothing to redraw; treat them as already covered.
    empty = {i for i, f in enumerate(lib.frames(sp)) if "page" not in f or 0 in f["rect"][2:]}
    seqs = t["infantry"]["sequences"]
    cands = []
    for name, s in seqs.items():
        st, cnt, fm = s["start"], s["count"], s["facingMultiplier"]
        if fm > 0:
            rows = [[st + f * fm + c for c in range(cnt)] for f in range(8)]
        else:
            rows = [[st + c for c in range(cnt)]]
        rows = [[i for i in r if 0 <= i < n and i not in empty] for r in rows]
        if any(rows):
            cands.append((name, rows, fm))
    # Largest first; skip blocks whose frames are all covered already.
    cands.sort(key=lambda c: -sum(len(r) for r in c[1]))
    covered, out = set(), []
    for name, rows, fm in cands:
        fs = {i for r in rows for i in r}
        if fs <= covered:
            continue
        # Aliases and partially overlapping sequences must never process a body frame twice.
        # Keep empty facing rows so later facing prompts retain their original direction.
        unique = []
        for row in rows:
            unseen = []
            for i in row:
                if i not in covered:
                    unseen.append(i)
                    covered.add(i)
            unique.append(unseen)
        out.append((name, unique))
    rest = sorted(set(range(n)) - covered - empty)
    # Uncovered frames: contiguous runs, 8 per row.
    run = []
    for i in rest + [None]:
        if run and (i is None or i != run[-1] + 1):
            rows = [run[k:k + 8] for k in range(0, len(run), 8)]
            out.append((f"Extra{run[0]}", rows))
            run = []
        if i is not None:
            run.append(i)
    return out


def sheet_specs(lib: Library, unit):
    """[(sheet name, sequence key, rows)]; rows are lists of frame indices; one row = one facing when facings apply."""
    bl = dict(blocks(lib, unit))
    specs = []
    used = set()

    def take(name):
        used.add(name)
        return bl[name]

    merges = [("Walk", "Ready"), ("DeployedFire", "Deployed")]
    for main, pre in merges:
        if main in bl:
            rows = take(main)
            if pre in bl and len(bl[pre]) == len(rows):
                rows = [p + r for p, r in zip(take(pre), rows)]
            bl[main] = rows
    if "Down" in bl and "Up" in bl and len(bl["Down"]) == 8 and len(bl["Up"]) == 8:
        rows = [a + b for a, b in zip(take("Down"), take("Up"))]
        specs.append((f"{unit}_DownUp", "DownUp", rows))
    misc = []
    for name, rows in blocks(lib, unit):
        if name in used and name not in ("Walk", "DeployedFire"):
            continue
        rows = bl[name]
        if len(rows) == 8 and max(len(r) for r in rows) >= 3:
            if any(rows[:4]):
                specs.append((f"{unit}_{name}_a", name, rows[:4]))
            if any(rows[4:]):
                specs.append((f"{unit}_{name}_b", name, rows[4:]))
        elif len(rows) == 8:
            specs.append((f"{unit}_{name}", name, rows))
        elif len(rows) == 1 and len(rows[0]) >= 12:
            r = rows[0]
            specs.append((f"{unit}_{name}", name, [r[k:k + 5] for k in range(0, len(r), 5)]))
        else:
            misc.extend(rows)
    if misc:
        specs.append((f"{unit}_Misc", "Cheer", misc))
    return specs


def merge_small(lib: Library, unit, specs, min_scale=3.5):
    """Pair Idle1+Idle2 and Die1+Die2 non-facing sheets into one sheet when the pair still fits at min_scale or more:
    fewer image-model calls, and both animations of a pair share one rendering."""
    by = {name: (seq, rows) for name, seq, rows in specs}
    sp = lib.data["types"][unit]["sprite"]
    out, used = [], set()
    for first, second, merged in (("Idle1", "Idle2", "Idles"), ("Die1", "Die2", "Dies")):
        a, b = by.get(f"{unit}_{first}"), by.get(f"{unit}_{second}")
        if not a or not b or len(a[1]) + len(b[1]) > 8:
            continue
        rows = a[1] + b[1]
        lay = layout(lib, sp, rows)
        try:
            ok = choose_scale(lay["W"], lay["H"]) >= min_scale
        except ValueError:
            ok = False
        if ok:
            out.append((f"{unit}_{merged}", merged, rows))
            used.update({f"{unit}_{first}", f"{unit}_{second}"})
    return [s for s in specs if s[0] not in used] + out


def layout(lib: Library, sprite, rows):
    """Per-row cells (the union box of that row's frames), frames anchored within their row."""
    fr = lib.frames(sprite)
    allf = [fr[i] for row in rows for i in row]
    if not allf:
        raise ValueError("a sheet must contain at least one frame")
    place, y, W = [], GAP, 0
    for ri, r in enumerate(rows):
        fs = [fr[i] for i in r] or allf
        x0 = min(f["offset"][0] for f in fs); y0 = min(f["offset"][1] for f in fs)
        x1 = max(f["offset"][0] + f["rect"][2] for f in fs); y1 = max(f["offset"][1] + f["rect"][3] for f in fs)
        cw, ch = x1 - x0 + 2 * PAD, y1 - y0 + 2 * PAD
        for ci, i in enumerate(r):
            f = fr[i]
            cx = GAP + ci * (cw + GAP)
            place.append({"frame": i, "row": ri, "col": ci,
                          "x": cx + PAD + f["offset"][0] - x0, "y": y + PAD + f["offset"][1] - y0,
                          "w": f["rect"][2], "h": f["rect"][3], "cell": [cx, y, cw, ch]})
        W = max(W, GAP + len(r) * (cw + GAP))
        y += ch + GAP
    return {"W": W, "H": y, "place": place}


def choose_scale(W, H):
    s = max(min(MAX_SHORT / W, MAX_LONG / H), min(MAX_LONG / W, MAX_SHORT / H))
    if s < 2:
        raise ValueError("sheet cannot fit a native model canvas at 2x; split its rows first")
    return min(12.0, math.floor(s * 2) / 2)


def shadow1(idx):
    return idx == 12


def lanczos_premul(rgb, a, size):
    prem = np.concatenate([rgb * a[..., None], a[..., None] * 255], -1).astype(np.float32)
    ch = [np.asarray(Image.fromarray(prem[..., c], "F").resize(size, Image.LANCZOS)) for c in range(4)]
    prem = np.clip(np.stack(ch, -1), 0, None)
    al = np.clip(prem[..., 3] / 255, 0, 1)
    return np.clip(prem[..., :3] / np.maximum(al[..., None], 1e-4), 0, 255), al


def canvas_for(lay, S):
    """Model canvas: exactly 1536x1024 or 1024x1536 (the image tool's native sizes), sheet centred on it."""
    w, h = lay["W"] * S, lay["H"] * S
    cw, ch = (MAX_LONG, MAX_SHORT) if w >= h else (MAX_SHORT, MAX_LONG)
    if w > cw or h > ch:
        cw, ch = (MAX_SHORT, MAX_LONG) if (cw, ch) == (MAX_LONG, MAX_SHORT) else (MAX_LONG, MAX_SHORT)
    if w > cw or h > ch:
        raise ValueError("sheet exceeds both native model canvas orientations")
    ox = int((cw - w) // 2); oy = int((ch - h) // 2)
    return cw, ch, ox, oy


def render_input(lib: Library, sprite, lay, house, S):
    cw, ch, ox0, oy0 = canvas_for(lay, S)
    big = np.full((ch, cw, 3), GREY, np.float32)
    for p in lay["place"]:
        _, _, _, idx = lib.frame1(sprite, p["frame"], house)
        rgb2, a2, _ = lib.frame2(sprite, p["frame"], house)
        body = np.kron((idx > 0) & ~shadow1(idx), np.ones((2, 2), bool))
        a = a2.astype(np.float32) / 255 * body
        tw, th = int(round(p["w"] * S)), int(round(p["h"] * S))
        col, al = lanczos_premul(rgb2, a, (tw, th))
        ox, oy = ox0 + int(round(p["x"] * S)), oy0 + int(round(p["y"] * S))
        reg = big[oy:oy + th, ox:ox + tw]
        big[oy:oy + th, ox:ox + tw] = col * al[..., None] + reg * (1 - al[..., None])
    return np.clip(np.rint(big), 0, 255).astype(np.uint8)


def facing_lines(rows, first_facing, dog):
    who = "the dog" if dog else "the figure"
    out = []
    for k in range(len(rows)):
        f = first_facing + k
        t = FACING_TEXT[f]
        if dog:
            t = t.replace("back of the helmet/head, back of the body", "tail end and back").replace("face", "head")
        out.append(f"  - row {k + 1}: {who} is {t}.")
    return "\n".join(out)


STYLE_TEXT = ("\nstyle.png is a STYLE REFERENCE ONLY: an approved redraw of a DIFFERENT unit from the same remaster. "
              "Match its rendering style, material realism, lighting and density of invented detail. Do NOT copy its "
              "character, equipment, colours, poses or layout - input.png alone defines the design, poses and "
              "positions.\nInvent the fine detail the low-resolution original could never show (stitching, seams, buckles, "
              "straps, pouches, insignia, panel lines, rivets, scuffs and wear) so that each figure reads as a detailed "
              "3D-rendered model at game scale.\n")


def prompt_for(unit, seq, rows, size, extra="", first_facing=None):
    name, desc = UNIT_DESC[unit]
    dog = unit in ("DOG", "ADOG")
    sdesc = (DOG_SEQ if dog else SEQ_DESC).get(seq, SEQ_DESC.get(seq, "an animation"))
    n = sum(len(r) for r in rows)
    facing = ""
    if seq in FACING_SEQS or (dog and seq in ("Walk", "FireUp")):
        facing = (f" Each of the {len(rows)} rows is one facing direction and the columns are consecutive animation "
                  "frames, so neighbouring frames in a row must look like the same character in slightly different "
                  "poses.")
    if facing and first_facing is not None:
        facing += (" The facing direction of each row (this is essential - keep it exactly, the game picks the frame by "
                   "direction):\n" + facing_lines(rows, first_facing, dog) + "\n")
    creature = "animal" if dog else "character"
    materials = ("realistic fur with visible strands and soft sheen, wet dark nose, glinting eyes, a leather collar"
                 if dog else
                 "real fabric with folds, seams and creases, webbing straps, pouches and buckles, worn leather boots, "
                 "matte and glossy metal with small specular highlights, realistic skin shading on the face and hands, "
                 "a detailed weapon with visible receiver, magazine and barrel")
    return f"""Task: image editing only. Do not write any code except what is needed to save and resize the image.

input.png ({size[0]}x{size[1]}) is an animation sprite sheet from the classic real-time strategy game Command & Conquer: Red Alert 2: {n} small frames of the same {creature}, the {name} ({desc}), seen from the game's high isometric camera (about 30 degrees from above). The sheet shows {sdesc}.{facing} It is an upscale of low-resolution pixel art on a flat grey (118,118,118) background; the black ground shadows were removed.

Use your image generation / image editing tool with input.png as the reference image and redraw the whole sheet as the same frames rendered by a modern high-end remaster of the game: a REALISTIC, detailed 3D-rendered look like a current AAA real-time strategy remaster, with physically based materials, soft natural daylight from the upper left, gentle ambient occlusion, crisp clean edges and fine detail. Realistic adult proportions and real materials (cloth, leather, steel, skin - never plastic or toy-like gloss); NOT cartoon, NOT chibi, NOT pixel art, NOT a painting.

Strict rules (this sheet is cut back into the game frame by frame, so geometry must not move):
- exactly the same {n} figures, each at exactly the same position and size in the image, with the same pose, the same facing direction and the same silhouette (head, arms, legs, weapon and tools at the same angles and lengths); do not re-arrange, re-space, align, mirror, add or remove any figure; no extra objects;
- the same colours per part as the input (the team colour areas keep their hue), the same overall brightness, the same design and equipment - the character must stay immediately recognisable as the Red Alert 2 {name};
- add realism only inside each silhouette: {materials};
- keep muzzle flashes, electric arcs, sparks and smoke that are in the input, rendered as realistic glowing effects;
- keep the flat uniform grey (118,118,118) background everywhere else: no ground, no shadows on the ground, no grid lines, no borders, no text, no labels.
{extra}
Save the result as output.png in this directory with exactly the same pixel size as input.png (resize the generated image to {size[0]}x{size[1]} if the tool returns another size; never crop or pad). Also copy the untouched generated image (before any resizing) to full.png in this directory. Then reply with one line saying the tool used and the generated size.
"""


def make_job(lib: Library, unit, name, seq, rows, root, style_ref=None):
    sp = lib.data["types"][unit]["sprite"]
    lay = layout(lib, sp, rows)
    S = choose_scale(lay["W"], lay["H"])
    house = HOUSE[unit]
    img = render_input(lib, sp, lay, house, S)
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img).save(d / "input.png")
    cw, ch, ox0, oy0 = canvas_for(lay, S)
    job = {"unit": unit, "sprite": sp, "name": name, "seq": seq, "rows": rows, "S": S, "house": house,
           "origin": [ox0, oy0],
           "layout": lay, "size": [img.shape[1], img.shape[0]]}
    (d / "job.json").write_text(json.dumps(job))
    first = 4 if name.endswith("_b") else 0
    extra = ""
    if style_ref is not None:
        shutil.copy2(style_ref, d / "style.png")
        extra = STYLE_TEXT
    (d / "prompt.txt").write_text(prompt_for(unit, seq, rows, (img.shape[1], img.shape[0]), extra=extra,
                                             first_facing=first))
    return job


def load_raw(d: Path):
    for name in ("full.png", "output.png"):
        if (d / name).exists():
            with Image.open(d / name) as im:
                return np.asarray(im.convert("RGB")).astype(np.float32), name
    return None, None


def fg_mask(rgb, thr=16.0):
    return np.abs(gaussian_blur(rgb, 1.0) - GREYV).max(-1) > thr


def iou(a, b):
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


def lock_lab(rep, ref, wgt, sigma_l, sigma_ab, lock_l, lock_ab):
    lr, lf = rd.srgb_to_lab(rep), rd.srgb_to_lab(ref)
    out = np.empty_like(lr)
    for c, s, k in ((0, sigma_l, lock_l), (1, sigma_ab, lock_ab), (2, sigma_ab, lock_ab)):
        out[..., c] = lr[..., c] + k * (rd.masked_blur(lf[..., c], wgt, s) - rd.masked_blur(lr[..., c], wgt, s))
    return np.clip(rd.lab_to_srgb(out), 0, 255)


def rgb_hsv(c):
    """Hue (degrees), saturation, value of float RGB 0..255."""
    c = c / 255.0
    mx, mn = c.max(-1), c.min(-1)
    d = mx - mn
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    return h, np.where(mx > 0, d / np.maximum(mx, 1e-6), 0), mx


def model_paint(final, pw0, body2, ramp):
    """New 2x paint mask from the model's colours: texels whose hue is the house hue (saturated, not black), within
    two 2x pixels of the original paint. Returns (paint 0..1, encoded colour)."""
    hc, _, _ = rgb_hsv(ramp[4:10].mean(0))
    h, s, v = rgb_hsv(final)
    dh = np.abs(((h - hc) + 180) % 360 - 180)
    w = np.clip((22 - dh) / 12, 0, 1) * np.clip((s - 0.25) / 0.2, 0, 1) * np.clip((v - 0.05) / 0.08, 0, 1)
    region = hr.dilate(pw0 > 0.1, 2) & body2
    p = np.clip(gaussian_blur(w * region, 0.5), 0, 1) * region
    grey = rd.neutral_to_grey(final, ramp)
    # The non-paint share of a partly painted texel loses its house hue, so other houses get no red/blue fringe.
    lum = (final @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    rest = final + (lum - final) * p[..., None]
    enc = rest * (1 - p[..., None]) + grey * p[..., None]
    return p, enc


def value_to_grey(final, ramp):
    """Encode house paint by value (max channel) on the renderer's grey ramp: the fractional remap index whose house
    colour has this value, then grey = 255 - 15 k (inverted in sprites.ts). The luminance of a saturated team colour
    covers only part of its ramp (a bright red redraw is lighter than the ramp's brightest entry), so a luminance
    encoding clamps the model's highlights and folds to one flat slab; value spans the whole ramp."""
    v = final.max(-1)
    ramp_v = ramp.max(-1)  # brightest first, decreasing
    k = np.interp(-v, -ramp_v, np.arange(len(ramp_v), dtype=np.float32))
    return np.repeat((255 - 15 * k)[..., None], 3, axis=-1).astype(np.float32)


def model_paint_shaded(final, pw0, body2, ramp, hue_full=8.0, hue_zero=16.0, sat0=0.42, sat1=0.62):
    """model_paint with a narrow hue/saturation window and value encoding. Skin (hue about 15-25 degrees, saturation
    below about 0.55) next to a red house area was painted by the wider window, so faces took the house colour."""
    hc, _, _ = rgb_hsv(ramp[4:10].mean(0))
    h, s, v = rgb_hsv(final)
    dh = np.abs(((h - hc) + 180) % 360 - 180)
    w = (np.clip((hue_zero - dh) / (hue_zero - hue_full), 0, 1) * np.clip((s - sat0) / (sat1 - sat0), 0, 1)
         * np.clip((v - 0.05) / 0.08, 0, 1))
    region = hr.dilate(pw0 > 0.1, 2) & body2
    p = np.clip(gaussian_blur(w * region, 0.5), 0, 1) * region
    grey = value_to_grey(final, ramp)
    lum = (final @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    rest = final + (lum - final) * p[..., None]
    enc = rest * (1 - p[..., None]) + grey * p[..., None]
    return p, enc


def sharpen_interior(final, body2, amount, sigma):
    """Unsharp mask on body texels at least two texels inside the silhouette (the rim keeps its antialiasing)."""
    if amount <= 0:
        return final
    inner = rd.erode_distance(body2, 1) == 2
    detail = final - gaussian_blur(final, sigma)
    return np.where(inner[..., None], np.clip(final + amount * detail, 0, 255), final)


def soften_rim(rgba, paint, amount):
    """Lift dark, unpainted silhouette texels towards a 7x7 non-rim opaque mean, in linear light."""
    if not 0 <= amount <= 1:
        raise ValueError("rim-soften must be between 0 and 1")
    if amount == 0:
        return rgba
    opaque = rgba[..., 3] >= 128
    # Erosion pads with transparency: the frame boundary counts even on a fully opaque crop.
    rim = opaque & (rd.erode_distance(opaque, 2) <= 2) & (paint < 128)
    interior = opaque & ~rim
    if not rim.any() or not interior.any():
        return rgba
    linear = rd.srgb_to_linear(rgba[..., :3])
    h, w = opaque.shape
    padded = np.pad(linear * interior[..., None], ((3, 3), (3, 3), (0, 0)))
    padded_count = np.pad(interior, 3)
    total = np.zeros_like(linear)
    count = np.zeros((h, w), np.int32)
    for dy in range(7):
        for dx in range(7):
            total += padded[dy:dy + h, dx:dx + w]
            count += padded_count[dy:dy + h, dx:dx + w]
    reference = total / np.maximum(count[..., None], 1)
    weights = np.array([0.2126, 0.7152, 0.0722], np.float32)
    lum, ref_lum = linear @ weights, reference @ weights
    changed = rim & (count > 0) & (lum < ref_lum)
    if not changed.any():
        return rgba
    blend = np.clip(amount * (1 - lum[changed] / ref_lum[changed]), 0, amount)
    out = rgba.copy()
    rgb = linear[changed] + (reference[changed] - linear[changed]) * blend[:, None]
    out[..., :3][changed] = np.clip(np.rint(rd.linear_to_srgb(rgb)), 0, 255).astype(np.uint8)
    return out


def soften_frame_rects(color, remap, rects, amount):
    """Process each 1x frame rect once; all neighbourhood reads stay within that frame's 2x crop."""
    if amount == 0:
        return
    for x, y, w, h in sorted(set(map(tuple, rects))):
        if min(x, y) < 0 or min(w, h) <= 0 or 2 * (x + w) > color.shape[1] or 2 * (y + h) > color.shape[0]:
            raise ValueError("frame rect lies outside the HD page")
        crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
        color[crop] = soften_rim(color[crop], remap[crop], amount)


def compose_job(lib: Library, d: Path, opts, page=None):
    job = json.loads((d / "job.json").read_text())
    raw, which = load_raw(d)
    if raw is None:
        return None
    sp, S, house = job["sprite"], job["S"], job["house"]
    ox0, oy0 = job["origin"]
    cw, ch = job["size"]
    with Image.open(d / "input.png") as im:
        inp = np.asarray(im.convert("RGB")).astype(np.float32)
    canvas = raw if raw.shape[:2] == (ch, cw) else hr.resize_linear(raw, (cw, ch))
    rx, ry = raw.shape[1] / cw, raw.shape[0] / ch
    ramp = lib.scheme(house)
    results = {}
    skipped = {}
    pad = 64
    rawp = np.pad(raw, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    inpp = np.pad(inp, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    for p in job["layout"]["place"]:
        i = p["frame"]
        if page is not None and lib.frames(sp)[i]["page"] != page:
            skipped[i] = "other-page"
            continue
        _, _, _, idx = lib.frame1(sp, i, house)
        ref2, alpha2, paint2 = lib.frame2(sp, i, house)
        h, w = idx.shape
        shadow2 = np.kron(idx == 12, np.ones((2, 2), bool))
        body2 = np.kron((idx > 0) & (idx != 12), np.ones((2, 2), bool)) & (alpha2 > 0)
        # Patch around the frame (canvas pixels), margin 3 texels.
        m = int(round(3 * S))
        fx0, fy0 = ox0 + p["x"] * S, oy0 + p["y"] * S
        px0, py0 = int(np.floor(fx0)) - m, int(np.floor(fy0)) - m
        px1, py1 = int(np.ceil(fx0 + w * S)) + m, int(np.ceil(fy0 + h * S)) + m
        px0, py0 = max(0, px0), max(0, py0)
        px1, py1 = min(cw, px1), min(ch, py1)
        pin, pout = inp[py0:py1, px0:px1], canvas[py0:py1, px0:px1]
        weight = hr.dilate(fg_mask(pin, 6.0), int(round(1.5 * S)))
        try:
            (sx, tx, sy, ty), diag = hr.register(pin, pout, weight)
        except Exception as e:  # noqa: BLE001
            sx, tx, sy, ty, diag = 1.0, 0.0, 1.0, 0.0, {"error": str(e)}
        # Guard against a runaway fit (a figure the model moved a lot): fall back to identity.
        if not (0.85 < sx < 1.18 and 0.85 < sy < 1.18 and abs(tx) < 2.5 * S + abs(1 - sx) * (px1 - px0)
                and abs(ty) < 2.5 * S + abs(1 - sy) * (py1 - py0)):
            diag["rejected"] = [sx, tx, sy, ty]
            sx, tx, sy, ty = 1.0, 0.0, 1.0, 0.0

        def to_raw_x(X):
            e = fx0 + X * S - px0
            return (px0 + sx * (e - 0.5) + tx + 0.5) * rx

        def to_raw_y(Y):
            e = fy0 + Y * S - py0
            return (py0 + sy * (e - 0.5) + ty + 0.5) * ry

        box = (to_raw_x(0) + pad, to_raw_y(0) + pad, to_raw_x(w) + pad, to_raw_y(h) + pad)
        rep4 = hr.resize_linear(rawp, (4 * w, 4 * h), box=box)
        rep2 = rd.box_down_linear(rep4, 2)
        # Registered model foreground vs the input silhouette (pose check), at 2x.
        inp4 = hr.resize_linear(inpp, (4 * w, 4 * h),
                                box=(fx0 + pad, fy0 + pad, fx0 + w * S + pad, fy0 + h * S + pad))
        fin = hr.box_down(fg_mask(inp4, 16.0).astype(np.float32), 2) > 0.5
        fout = hr.box_down(fg_mask(rep4, 16.0).astype(np.float32), 2) > 0.5
        sil = iou(fin & body2, fout & body2 | (fout & ~body2 & hr.dilate(body2, 1)))
        outside = float((fout & ~hr.dilate(body2 | shadow2, 2)).sum() / max(1, body2.sum()))
        # Model foreground at 4x: anything not flat background grey (the anti-aliased rim of the model's figure counts
        # as foreground, so the soft edge survives the downsample).
        dev4 = np.abs(rep4 - GREYV).max(-1)
        mu = gaussian_blur(rep4.mean(-1), 1.0)
        sd4 = np.sqrt(np.maximum(gaussian_blur(rep4.mean(-1) ** 2, 1.0) - mu ** 2, 0))
        bg4 = np.clip((12 - dev4) / 6, 0, 1) * np.clip((4 - sd4) / 2, 0, 1)
        fg2 = np.clip(hr.box_down(1 - bg4, 2), 0, 1)
        # Near the silhouette edge (band) the model's own outline trims the original alpha (never widens it); deeper
        # inside, background the model left (a limb it drew thinner) is filled from the reference instead.
        dist = rd.erode_distance(body2, opts.band)
        band = (dist >= 1) & (dist <= opts.band)
        trim = np.where(band, np.clip((fg2 - 0.15) / 0.7, 0, 1), 1.0) if opts.band > 0 else np.ones_like(fg2)
        leak = (1 - fg2) * body2 * (~band if opts.band > 0 else 1)
        # Decontaminate partially covered texels from the grey the model drew against (linear light).
        lin = rd.srgb_to_linear(rep2)
        g_lin = rd.srgb_to_linear(GREYV[None, None, :])
        f = np.clip(fg2, 0.25, 1)[..., None]
        dec = rd.linear_to_srgb(np.clip((lin - (1 - f) * g_lin) / f, 0, 1))
        rep2c = np.where((fg2 < 0.98)[..., None] & band[..., None], dec, rep2)
        rep2f = rep2c * (1 - leak[..., None]) + ref2 * leak[..., None]
        wgt = body2.astype(np.float32) * np.clip(fg2 * 1.2, 0, 1)
        final = lock_lab(rep2f, ref2, body2.astype(np.float32), opts.sigma_l, opts.sigma_ab, opts.lock_l,
                         opts.lock_ab)
        final = sharpen_interior(final, body2, getattr(opts, "sharpen", 0.0), getattr(opts, "sharpen_sigma", 0.8))
        if opts.band == 0:
            ring = rd.erode_distance(body2, 1) == 1
            final = np.where(ring[..., None], ref2 + (final - ref2) * opts.edge_mix, final)
        # Metrics (displayed colours).
        lum = lambda x: rd.srgb_to_lab(x)[..., 0]
        gy1, gx1 = np.gradient(gaussian_blur(lum(ref2), 1.0))
        gy2, gx2 = np.gradient(gaussian_blur(lum(final), 1.0))
        m_ = body2
        edge_corr = hr.pearson(np.hypot(gx1, gy1)[m_], np.hypot(gx2, gy2)[m_]) if m_.sum() > 8 else 1.0
        lf = rd.srgb_to_lab(rd.masked_blur(final, wgt, 2.0)) - rd.srgb_to_lab(rd.masked_blur(ref2, wgt, 2.0))
        lf_de = float(np.sqrt((lf ** 2).sum(-1))[m_].mean()) if m_.any() else 0.0
        hf_new = float(np.abs(lum(final) - gaussian_blur(lum(final), 1.0))[m_].mean()) if m_.any() else 0
        hf_old = float(np.abs(lum(ref2) - gaussian_blur(lum(ref2), 1.0))[m_].mean()) if m_.any() else 0
        # Encode: paint on the grey ramp, shadow black, bleed, alpha.
        pw = paint2.astype(np.float32) / 255
        enc = final.copy()
        if opts.paint == "shaded" and pw.any():
            pw, enc = model_paint_shaded(final, pw, body2, ramp)
        elif opts.paint == "model" and pw.any():
            # House paint follows what the model drew: team-colour hue near the original paint area. The original
            # 2x mask is a blocky upscale of the 1x remap indices, which cut flat colour slabs across the new detail.
            pw, enc = model_paint(final, pw, body2, ramp)
        elif pw.any():
            grey = rd.neutral_to_grey(final, ramp)
            enc = enc * (1 - pw[..., None]) + grey * pw[..., None]
        enc[shadow2] = 0
        a = alpha2.astype(np.float32)
        a[shadow2] = a[shadow2] * opts.shadow_alpha
        # Trimmed body texels next to the ground shadow become shadow rather than holes.
        near_sh = hr.dilate(shadow2, 2) & body2
        t = trim.astype(np.float32)
        a_body = np.where(near_sh, t + (1 - t) * opts.shadow_alpha, t) * alpha2
        k = np.where(near_sh, t / np.maximum(t + (1 - t) * opts.shadow_alpha, 1e-3), 1.0)
        enc = enc * k[..., None] + (1 - k[..., None]) * np.where(pw[..., None] > 0.5, 30.0, 0.0)
        a = np.where(body2, a_body, a)
        known = body2 | shadow2
        enc = rd.bleed(enc, known, steps=8)
        if opts.shadow_soft > 0:
            # Soften the stepped 1x ground shadow: blur its alpha by about one 2x pixel, only on non-body texels that
            # are shadow or were empty (the HD rim of the body keeps its alpha); the blurred fringe is black.
            sh_a = np.where(shadow2, a, 0.0).astype(np.float32)
            # Gain after the blur keeps the interior at full shadow strength; only the stepped rim softens.
            bl = np.minimum(gaussian_blur(sh_a, opts.shadow_soft) * 1.4, 255 * opts.shadow_alpha)
            free = shadow2 | (~body2 & (alpha2 == 0))
            a = np.where(free, bl, a)
            enc = np.where((free & (bl > 0.5))[..., None], 0.0, enc)
        out = np.empty((2 * h, 2 * w, 4), np.uint8)
        out[..., :3] = np.clip(np.rint(enc), 0, 255).astype(np.uint8)
        out[..., 3] = np.clip(np.rint(a), 0, 255).astype(np.uint8)
        results[i] = {"rgba": out, "paint": np.clip(np.rint(pw * 255), 0, 255).astype(np.uint8), "rep2": rep2, "final": final, "ref2": ref2,
                      "metrics": {"sil_iou": round(sil, 3), "outside": round(outside, 3),
                                  "edge_corr": round(float(edge_corr), 3), "lf_de": round(lf_de, 2),
                                  "hf_new": round(hf_new, 2), "hf_old": round(hf_old, 2),
                                  "reg": [round(v, 3) for v in (sx, tx, sy, ty)], "rejected": "rejected" in diag, "tried": [round(float(v), 3) for v in diag.get("rejected", [])],
                                  "leak": round(float(leak.sum() / max(1, body2.sum())), 3),
                                  "trim": round(float((1 - trim)[body2].mean()) if body2.any() else 0, 3)}}
    return {"job": job, "frames": results, "skipped": skipped, "raw": which}


def review(lib: Library, res, path, scale=4):
    """Original HD | new, per frame, displayed colours over grey, nearest x scale."""
    job = res["job"]
    tiles = []
    for p in job["layout"]["place"]:
        r = res["frames"][p["frame"]]
        a = r["rgba"][..., 3:4].astype(np.float32) / 255
        new = lib.decode_hd(r["rgba"], r["paint"], job["house"])
        old, oa, _ = lib.frame2(job["sprite"], p["frame"], job["house"])
        oa = oa[..., None].astype(np.float32) / 255
        t1 = old * oa + GREYV * (1 - oa)
        t2 = new * a + GREYV * (1 - a)
        tiles.append((p, np.concatenate([t1, np.full((t1.shape[0], 2, 3), 60.0), t2], 1)))
    lay = job["layout"]
    rows = {}
    for p, t in tiles:
        rows.setdefault(p["row"], []).append(t)
    Hs = [max(t.shape[0] for t in r) for r in rows.values()]
    Ws = [sum(t.shape[1] + 6 for t in r) for r in rows.values()]
    img = np.full((sum(Hs) + 6 * len(Hs), max(Ws), 3), 40.0)
    y = 0
    for (k, r), hh in zip(sorted(rows.items()), Hs):
        x = 0
        for t in r:
            img[y + hh - t.shape[0]:y + hh, x:x + t.shape[1]] = t
            x += t.shape[1] + 6
        y += hh + 6
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    im = im.resize((im.width * scale // 2, im.height * scale // 2), Image.NEAREST)
    im.save(path)


def sheet_dirs(work: Path, names=None):
    """Select prepared sheets, rejecting misspelled names instead of silently doing no work."""
    dirs = sorted(d for d in (work / "sheets").iterdir() if (d / "job.json").is_file())
    if names:
        missing = set(names) - {d.name for d in dirs}
        if missing:
            raise ValueError(f"unknown sheets: {', '.join(sorted(missing))}")
        dirs = [d for d in dirs if d.name in names]
    return dirs


def prepare(lib: Library, work: Path, units=None, style_ref=None, merge=False, skip_seqs=()):
    units = list(UNITS) if units is None else list(units)
    unknown = set(units) - UNITS.keys()
    if unknown:
        raise ValueError(f"unsupported infantry types: {', '.join(sorted(unknown))}")
    jobs = []
    for unit in units:
        specs = sheet_specs(lib, unit)
        if merge:
            specs = merge_small(lib, unit, specs)
        for name, seq, rows in specs:
            if seq in skip_seqs:
                continue
            job = make_job(lib, unit, name, seq, rows, work / "sheets", style_ref)
            jobs.append(job)
            print(name, "frames", sum(map(len, rows)), "size", job["size"], flush=True)
    return jobs


LIMIT_PATTERN = re.compile(r"usage limit|rate limit|\b429\b|quota", re.I)
SEQUENCE_PRIORITY = {"Walk": 0, "FireUp": 1, "DownUp": 2, "Crawl": 3, "FireProne": 4, "Die1": 5,
                     "Die2": 6, "Idle1": 7, "Idle2": 8, "DeployedFire": 9, "Deploy": 10, "Cheer": 11,
                     "Dies": 5, "Idles": 7, "SecondaryFire": 1, "Fly": 1, "FireFly": 1, "Shovel": 2, "Carry": 2}


def done(d: Path):
    return (d / "output.png").is_file() or (d / "full.png").is_file()


def archive_redo(d: Path):
    """Keep the prepared inputs available: run has no library argument to regenerate them."""
    k = 0
    while (d / f"try{k}").exists():
        k += 1
    backup = d / f"try{k}"
    backup.mkdir()
    for path in d.iterdir():
        if not path.is_file():
            continue
        if path.name in ("input.png", "job.json", "prompt.txt"):
            shutil.copy2(path, backup / path.name)
        else:
            shutil.move(str(path), backup / path.name)


def run(work: Path, codex: str, parallel=3, limit_file=None, names=None, redo=(), poll_interval=1.0,
        reasoning=None, order_by="sequence"):
    """Run prepared jobs, drain active children on limits, and retry missing outputs up to three times."""
    if not 1 <= parallel <= 3:
        raise ValueError("parallel must be between 1 and 3")
    work = work.resolve()
    limit_file = Path(limit_file).resolve() if limit_file is not None else work / "LIMIT_HIT.txt"

    def log(message):
        with (work / "sched.log").open("a", encoding="utf-8") as out:
            out.write(time.strftime("%H:%M:%S ") + message + "\n")

    dirs = sheet_dirs(work, names)
    unknown = set(redo) - {d.name for d in dirs}
    if unknown:
        raise ValueError(f"redo sheets are outside the selection: {', '.join(sorted(unknown))}")
    if limit_file.exists():
        log("limit file present; not launching")
        return 2
    binary = shutil.which(codex)
    if binary is None:
        raise ValueError(f"codex executable not found: {codex}")
    binary = str(Path(binary).resolve())
    unit_priority = {unit: i for i, unit in enumerate(UNITS)}

    def order(d):
        job = json.loads((d / "job.json").read_text(encoding="utf-8"))
        seq, unit = SEQUENCE_PRIORITY.get(job["seq"], 20), unit_priority.get(job["unit"], 20)
        # "unit" finishes whole units first (a half-redrawn unit flickers between styles in game).
        return (unit, seq, d.name) if order_by == "unit" else (seq, unit, d.name)

    dirs.sort(key=order)
    for d in dirs:
        if d.name in redo:
            archive_redo(d)
    queue = [d for d in dirs if not done(d)]
    log(f"queue {len(queue)}: {[d.name for d in queue]}")
    running, attempts = {}, {}
    failed = set()
    limited = False
    try:
        while queue or running:
            if limit_file.exists():
                limited = True
                queue.clear()
            for d, (proc, output) in list(running.items()):
                status = proc.poll()
                # Inspect live logs as well as completed ones, including text before the final 4 KB.
                txt = (d / "run.log").read_text(encoding="utf-8", errors="ignore")
                match = LIMIT_PATTERN.search(txt)
                if match and not limited:
                    limited = True
                    limit_file.parent.mkdir(parents=True, exist_ok=True)
                    limit_file.write_text(
                        f"{time.strftime('%Y-%m-%d %H:%M:%S')} infantry track: {d.name}: "
                        f"{txt[max(0, match.start() - 200):match.end() + 200]}\n", encoding="utf-8")
                    log(f"LIMIT HIT in {d.name}")
                    queue.clear()
                if status is None:
                    continue
                output.close()
                del running[d]
                (d / "exit").write_text(f"{status}\n", encoding="utf-8")
                (d / "end").write_text(f"{int(time.time())}\n", encoding="utf-8")
                if done(d):
                    log(f"done {d.name}")
                else:
                    log(f"failed {d.name} (attempt {attempts[d]})")
                    if attempts[d] < 3 and not limited:
                        queue.insert(0, d)
                    else:
                        failed.add(d.name)
            while queue and len(running) < parallel and not limited and not limit_file.exists():
                d = queue.pop(0)
                prompt = (d / "prompt.txt").read_text(encoding="utf-8")
                (d / "start").write_text(f"{int(time.time())}\n", encoding="utf-8")
                output = (d / "run.log").open("w", encoding="utf-8")
                try:
                    effort = ["-c", f'model_reasoning_effort="{reasoning}"'] if reasoning else []
                    proc = subprocess.Popen(
                        [binary, "exec", "-s", "workspace-write", *effort, "--skip-git-repo-check", "-C", str(d),
                         "-o", str(d / "last.txt"), prompt], cwd=d, stdin=subprocess.DEVNULL,
                        stdout=output, stderr=subprocess.STDOUT)
                except BaseException:
                    output.close()
                    raise
                running[d] = (proc, output)
                attempts[d] = attempts.get(d, 0) + 1
                log(f"launched {d.name}")
            if running:
                time.sleep(poll_interval)
    finally:
        # Interruption must not leave image agents or log handles running in the background.
        for proc, output in running.values():
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            output.close()
    log("scheduler finished" + (f"; failed: {sorted(failed)}" if failed else ""))
    return 2 if limited or limit_file.exists() else (1 if failed else 0)


def compose(lib: Library, work: Path, opts, names=None):
    missing = []
    for d in sheet_dirs(work, names):
        res = compose_job(lib, d, opts)
        if res is None:
            print(d.name, "no output", flush=True)
            missing.append(d.name)
            continue
        review(lib, res, d / "review.png")
        metrics = {k: v["metrics"] for k, v in res["frames"].items()}
        (d / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
        print(d.name, res["raw"], "frames", len(metrics), "sil_iou min/med",
              min(m["sil_iou"] for m in metrics.values()),
              np.median([m["sil_iou"] for m in metrics.values()]), flush=True)
    return 1 if missing else 0


def build(lib: Library, work: Path, page: int, opts, names=None, min_sil=0.6):
    color, remap = lib.page2(page).copy(), lib.remap2(page).copy()
    accepted_rects = []
    rim_soften = getattr(opts, "rim_soften", 0.0)
    report = {"page": page, "frames": {}, "sheets": {}, "options": {
        key: getattr(opts, key) for key in COMPOSE_DEFAULTS}, "min_sil": min_sil}
    report["options"].update(rim_soften=rim_soften, paint_saturation=getattr(opts, "paint_saturation", 1.0))
    for d in sheet_dirs(work, names):
        res = compose_job(lib, d, opts, page=page)
        if res is None:
            report["sheets"][d.name] = "missing"
            continue
        sprite = res["job"]["sprite"]
        skipped = dict(res.get("skipped", {}))
        accepted = 0
        for i, result in res["frames"].items():
            frame = lib.frames(sprite)[i]
            # Recheck at the write boundary, even if a composer already filtered the job.
            if frame["page"] != page:
                skipped[i] = "other-page"
                continue
            metrics = dict(result["metrics"])
            ok = metrics["sil_iou"] >= min_sil
            metrics.update(accepted=ok, sheet=d.name)
            report["frames"][f"{sprite}#{i}"] = metrics
            if not ok:
                continue
            x, y, w, h = frame["rect"]
            crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
            color[crop], remap[crop] = result["rgba"], result["paint"]
            accepted_rects.append(frame["rect"])
            accepted += 1
        for i, reason in skipped.items():
            report["frames"][f"{sprite}#{i}"] = {"accepted": False, "skipped": reason, "sheet": d.name}
        report["sheets"][d.name] = {"frames": len(res["frames"]), "accepted": accepted, "raw": res["raw"]}
        print(d.name, accepted, "/", len(res["frames"]), flush=True)
    soften_frame_rects(color, remap, accepted_rects, rim_soften)
    return color, remap, report


@contextlib.contextmanager
def atomic_output(path: Path, suffix=".tmp"):
    """Replace the directory entry, never the destination of a pre-existing symlink."""
    fd, name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=suffix, dir=path.parent)
    os.close(fd)
    tmp = Path(name)
    try:
        yield tmp
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def install_pages(lib: Library, work: Path, out: Path, farm: Path, rel_dir: str, opts,
                  fill_dir=None, units=None, pages=None, min_sil=0.6, suffix="l5inf"):
    """Compose finished sheets and patch only each installed HD page in the farm's latest manifest."""
    # POSIX locking is needed only by this command; existing image stages remain platform-independent.
    import cache_farm

    relative = Path(rel_dir)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("rel-dir must be relative and contain no '..'")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", suffix):
        raise ValueError("suffix must contain only letters, digits, hyphens and underscores")
    if not 0 <= min_sil <= 1:
        raise ValueError("min-sil must be between 0 and 1")
    if out.resolve() == lib.root or (farm / relative).absolute() == lib.root:
        raise ValueError("staging and farm directories must differ from the source library")
    if fill_dir is not None:
        for page, entry in enumerate(lib.data["spriteAtlasesHd"]):
            fill = fill_dir / f"sprites-{page}@2x-fill.png"
            if entry is None and fill.is_file():
                base = lib.data["spriteAtlases"][page]
                lib.data["spriteAtlasesHd"][page] = {
                    "file": str(fill.resolve()),
                    "remap": str((fill_dir / f"sprites-{page}@2x-remap-fill.png").resolve()),
                    "scale": 2, "width": 2 * base["width"], "height": 2 * base["height"]}
    finished = []
    for directory in sheet_dirs(work):
        if not (directory / "output.png").is_file():
            continue
        job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
        if units and job["unit"] not in units:
            continue
        if job["sprite"] not in lib.data["sprites"]:
            continue
        job_pages = {frame.get("page") for frame in lib.frames(job["sprite"])} - {None}
        finished.append((directory.name, job_pages))
    selected = sorted({page for _, job_pages in finished for page in job_pages})
    if pages is not None:
        selected = [page for page in selected if page in pages]
    out.mkdir(parents=True, exist_ok=True)
    for page in selected:
        base = lib.data["spriteAtlasesHd"][page]
        if base is None:
            raise ValueError(f"page {page} has no HD atlas; provide its donor pages with --fill-dir")
        names = [name for name, job_pages in finished if page in job_pages]
        start = time.monotonic()
        color, remap, report = build(lib, work, page, opts, names, min_sil)
        page_path = out / f"sprites-{page}@2x-{suffix}.png"
        remap_path = out / f"sprites-{page}@2x-remap-{suffix}.png"
        # Installed pages may be hard links: never overwrite their served inode while staging a new build.
        for pixels, path in ((color, page_path), (remap, remap_path)):
            with atomic_output(path, suffix=".part") as tmp:
                Image.fromarray(pixels).save(tmp, format="PNG")
        (out / f"report-{page}.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
        cache_farm.install_file(farm, str(relative / page_path.name), page_path)
        cache_farm.install_file(farm, str(relative / remap_path.name), remap_path)

        def patch(data):
            if data["spriteAtlasesHd"][page] is None:
                data["spriteAtlasesHd"][page] = {
                    "scale": 2, "width": base["width"], "height": base["height"]}
            data["spriteAtlasesHd"][page].update(file=page_path.name, remap=remap_path.name,
                                                paintSaturation=opts.paint_saturation)

        cache_farm.patch_json(farm, str(relative / "library.json"), patch)
        accepted = sum(bool(frame.get("accepted")) for frame in report["frames"].values())
        print(f"{lib.data.get('theater', lib.root.name)} page {page}: {len(names)} sheets, "
              f"{accepted}/{len(report['frames'])} frames accepted, {time.monotonic() - start:.0f}s", flush=True)


def install(lib: Library, variant_dir: Path, page: int, page_path: Path, remap_path: Path, sprites,
            paint_saturation=1.0):
    """Install pages while preserving an existing real variant manifest and every unrelated entry."""
    variant_dir = variant_dir.resolve()
    if variant_dir == lib.root:
        raise ValueError("variant directory must differ from the source library")
    variant_dir.mkdir(parents=True, exist_ok=True)
    manifest = variant_dir / "library.json"
    base = manifest if manifest.is_file() and not manifest.is_symlink() else lib.root / "library.json"
    merged = json.loads(base.read_text(encoding="utf-8"))
    merged["spriteAtlasesHd"][page]["file"] = page_path.name
    merged["spriteAtlasesHd"][page]["remap"] = remap_path.name
    entry = {"file": page_path.name, "remap": remap_path.name}
    if paint_saturation < 1:
        entry["paintSaturation"] = paint_saturation
        merged["spriteAtlasesHd"][page]["paintSaturation"] = paint_saturation
    for source in lib.root.iterdir():
        target = variant_dir / source.name
        if source.name == "library.json" or source.resolve() == variant_dir or target.exists() or target.is_symlink():
            continue
        target.symlink_to(source)
    for source in (page_path, remap_path):
        target = variant_dir / source.name
        if target.is_symlink():
            target.unlink()
        if source.resolve() != target.resolve():
            with Image.open(source) as im:
                im.save(target, optimize=False)
    with atomic_output(manifest) as tmp:
        tmp.write_text(json.dumps(merged, separators=(",", ":")), encoding="utf-8")
    note = variant_dir / "library.l3-infantry.json"
    if note.is_symlink():
        note.unlink()
    note.write_text(json.dumps({
        "track": "infantry", "page": page,
        "spriteAtlasesHd": {str(page): entry},
        "sprites": sorted(set(sprites)),
        "note": "Only accepted frames of these sprites differ from the source HD colour and remap pages.",
        "written": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=2), encoding="utf-8")


def polish(lib: Library, variant_dir: Path, page: int, sprites, rim_soften=0.0, paint_saturation=1.0,
           suffix="l4inf"):
    """Polish current variant pixels, then atomically replace only its selected HD page reference."""
    variant_dir = variant_dir.resolve()
    if variant_dir == lib.root:
        raise ValueError("variant directory must differ from the source library")
    # Do not reuse the library cache: repeated polish runs must read the variant's latest manifest and pixels.
    variant = Library(variant_dir)
    color, remap = variant.page2(page).copy(), variant.remap2(page).copy()
    rects = [frame["rect"] for sprite in sprites for frame in lib.frames(sprite) if frame["page"] == page]
    soften_frame_rects(color, remap, rects, rim_soften)
    page_path = variant_dir / f"sprites-{page}@2x-{suffix}.png"
    remap_path = variant_dir / f"sprites-{page}@2x-remap-{suffix}.png"
    for path, pixels in ((page_path, color), (remap_path, remap)):
        with atomic_output(path) as tmp:
            Image.fromarray(pixels).save(tmp, format="PNG")
    variant.data["spriteAtlasesHd"][page].update(file=page_path.name, remap=remap_path.name,
                                               paintSaturation=paint_saturation)
    with atomic_output(variant_dir / "library.json") as tmp:
        tmp.write_text(json.dumps(variant.data, separators=(",", ":")), encoding="utf-8")
    print("frames polished", len(rects), "on page", page, flush=True)


COMPOSE_DEFAULTS = {"sigma_l": 3.0, "sigma_ab": 4.0, "lock_l": 0.2, "lock_ab": 0.25, "band": 3,
                    "edge_mix": 0.6, "shadow_alpha": 0.72, "shadow_soft": 0.8, "paint": "shaded", "sharpen": 0.6,
                    "sharpen_sigma": 0.8}


def add_compose_options(ap):
    for key, default in COMPOSE_DEFAULTS.items():
        kwargs = {"default": default, "type": type(default)}
        if key == "paint":
            kwargs["choices"] = ["base", "model", "shaded"]
        ap.add_argument("--" + key.replace("_", "-"), **kwargs)


def csv_names(text):
    names = list(dict.fromkeys(name.strip() for name in text.split(",") if name.strip()))
    if not names:
        raise argparse.ArgumentTypeError("provide at least one comma-separated name")
    return names


def csv_pages(text):
    try:
        pages = [int(name) for name in csv_names(text)]
    except ValueError:
        raise argparse.ArgumentTypeError("pages must be comma-separated non-negative integers")
    if any(page < 0 for page in pages):
        raise argparse.ArgumentTypeError("pages must be comma-separated non-negative integers")
    return pages


def unit_interval(text):
    value = float(text)
    if not 0 <= value <= 1:
        raise argparse.ArgumentTypeError("value must be between 0 and 1")
    return value


def add_polish_options(ap, rim_soften=0.0, paint_saturation=1.0):
    rim_default = f"{rim_soften:g}" + (", unchanged" if rim_soften == 0 else "")
    ap.add_argument("--rim-soften", type=unit_interval, default=rim_soften,
                    help=f"dark silhouette rim lift, 0..1 (default: {rim_default})")
    ap.add_argument("--paint-saturation", type=unit_interval, default=paint_saturation,
                    help=f"linear-light house-paint saturation, 0..1 (default: {paint_saturation:g})")


def parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = ap.add_subparsers(dest="command", required=True)
    for command in ("prepare", "run", "compose", "build"):
        sub = commands.add_parser(command)
        sub.add_argument("--work", type=Path, required=True)
        if command != "run":
            sub.add_argument("--library", type=Path, required=True)
        if command == "prepare":
            sub.add_argument("--units", type=csv_names)
            sub.add_argument("--style-ref", type=Path,
                             help="approved redraw given to the model as a style-only reference (style.png)")
            sub.add_argument("--merge-small", action="store_true",
                             help="pair Idle1+Idle2 and Die1+Die2 into one sheet when the scale allows")
            sub.add_argument("--skip-seqs", type=csv_names, default=(),
                             help="sequence keys to leave out (e.g. water sequences)")
        else:
            sub.add_argument("--names", type=csv_names)
        if command == "run":
            sub.add_argument("--codex", required=True)
            sub.add_argument("--parallel", type=int, choices=(1, 2, 3), default=3)
            sub.add_argument("--limit-file", type=Path)
            sub.add_argument("--redo", type=csv_names, default=())
            sub.add_argument("--reasoning", choices=("low", "medium", "high", "xhigh", "max"),
                             help="codex model_reasoning_effort override")
            sub.add_argument("--order", choices=("sequence", "unit"), default="sequence")
        if command in ("compose", "build"):
            add_compose_options(sub)
        if command == "build":
            sub.add_argument("--page", type=int, required=True)
            sub.add_argument("--variant-dir", type=Path, required=True)
            sub.add_argument("--suffix", default="l3inf")
            sub.add_argument("--min-sil", type=float, default=0.6)
            add_polish_options(sub)
    sub = commands.add_parser("polish")
    sub.add_argument("--library", type=Path, required=True)
    sub.add_argument("--page", type=int, required=True)
    sub.add_argument("--variant-dir", type=Path, required=True)
    sub.add_argument("--sprites", type=csv_names, required=True)
    sub.add_argument("--suffix", default="l4inf")
    add_polish_options(sub)
    sub = commands.add_parser("install-pages")
    for name in ("library", "work", "out", "farm"):
        sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--rel-dir", required=True)
    sub.add_argument("--fill-dir", type=Path)
    sub.add_argument("--units", type=csv_names)
    sub.add_argument("--pages", type=csv_pages)
    sub.add_argument("--min-sil", type=unit_interval, default=0.6)
    sub.add_argument("--suffix", default="l5inf")
    add_compose_options(sub)
    add_polish_options(sub, rim_soften=0.5, paint_saturation=0.7)
    return ap


def main(argv=None):
    ap = parser()
    opts = ap.parse_args(argv)
    try:
        if opts.command in ("compose", "build", "install-pages"):
            if any(not math.isfinite(getattr(opts, key)) or getattr(opts, key) < 0
                   for key in ("sigma_l", "sigma_ab", "shadow_soft", "band")):
                raise ValueError("blur radii and trim band must be finite and non-negative")
            if any(not 0 <= getattr(opts, key) <= 1 for key in ("lock_l", "lock_ab", "edge_mix", "shadow_alpha")):
                raise ValueError("colour-lock, edge-mix and shadow-alpha weights must be between 0 and 1")
        if opts.command == "run":
            return run(opts.work, opts.codex, opts.parallel, opts.limit_file, opts.names, opts.redo,
                       reasoning=opts.reasoning, order_by=opts.order)
        if opts.command == "install-pages":
            # Donor-page overrides are local to this invocation, never mutations of the shared library cache.
            install_pages(Library(opts.library.resolve()), opts.work, opts.out, opts.farm, opts.rel_dir, opts,
                          opts.fill_dir, opts.units, opts.pages, opts.min_sil, opts.suffix)
            return 0
        lib = library(opts.library)
        if opts.command in ("build", "polish"):
            if opts.page < 0:
                raise ValueError("page must be non-negative")
            if not re.fullmatch(r"[A-Za-z0-9_-]+", opts.suffix):
                raise ValueError("suffix must contain only letters, digits, hyphens and underscores")
            if opts.variant_dir.resolve() == lib.root:
                raise ValueError("variant directory must differ from the source library")
        if opts.command == "prepare":
            if opts.style_ref is not None and not opts.style_ref.is_file():
                raise ValueError(f"style reference not found: {opts.style_ref}")
            prepare(lib, opts.work, opts.units, opts.style_ref, opts.merge_small, tuple(opts.skip_seqs))
        elif opts.command == "compose":
            return compose(lib, opts.work, opts, opts.names)
        elif opts.command == "polish":
            polish(lib, opts.variant_dir, opts.page, opts.sprites, opts.rim_soften, opts.paint_saturation, opts.suffix)
        else:
            if not 0 <= opts.min_sil <= 1:
                raise ValueError("min-sil must be between 0 and 1")
            color, remap, report = build(lib, opts.work, opts.page, opts, opts.names, opts.min_sil)
            pages = opts.work / "pages"
            pages.mkdir(parents=True, exist_ok=True)
            page_path = pages / f"sprites-{opts.page}@2x-{opts.suffix}.png"
            remap_path = pages / f"sprites-{opts.page}@2x-remap-{opts.suffix}.png"
            Image.fromarray(color).save(page_path)
            Image.fromarray(remap).save(remap_path)
            (pages / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            sprites = {key.rsplit("#", 1)[0] for key, value in report["frames"].items() if value["accepted"]}
            install(lib, opts.variant_dir, opts.page, page_path, remap_path, sprites, opts.paint_saturation)
            print("frames accepted", sum(m["accepted"] for m in report["frames"].values()),
                  "of", len(report["frames"]), flush=True)
        return 0
    except (OSError, ValueError, KeyError, IndexError) as error:
        ap.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
