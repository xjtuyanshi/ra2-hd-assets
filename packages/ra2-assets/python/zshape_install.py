"""Install staged RA2/YR building depth metadata into a copy-on-write cache farm.

The staging directory contains buildngz.bin and zshape-patch.json. Every existing
_library/<theater>/library.json must have a corresponding theater patch. Files
are published before their JSON references; JSON is merged under cache_farm's
per-file lock so unrelated concurrent edits survive.
"""

import argparse
import copy
import json
from pathlib import Path
import re
import sys

import cache_farm


TEMPLATE_FILE = "buildngz.bin"
PATCH_FILE = "zshape-patch.json"


def _object(value, context):
    if not isinstance(value, dict):
        raise ValueError(f"{context} must be an object")
    return value


def _keys(value, allowed, context, *, required=()):
    _object(value, context)
    if set(value) - set(allowed) or set(required) - set(value):
        raise ValueError(f"{context} has unexpected or missing fields")


def _integer(value, context, *, positive=False, nonzero=False):
    if type(value) is not int or (positive and value <= 0) or (nonzero and value == 0):
        raise ValueError(f"{context} must be {'a positive' if positive else 'a nonzero' if nonzero else 'an'} integer")


def _name(value, context):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{context} must be a non-empty string")


def load_patch(staging: Path):
    """Validate the complete staging contract before touching the destination."""
    patches = _object(json.loads((staging / PATCH_FILE).read_text(encoding="utf-8")), PATCH_FILE)
    if not patches:
        raise ValueError("staging has no theater patches")
    shared_template = None
    for theater, patch in patches.items():
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", theater):
            raise ValueError(f"invalid theater path component: {theater!r}")
        _keys(patch, ("depthTemplate", "types", "layers"), theater,
              required=("depthTemplate", "types", "layers"))
        template = patch["depthTemplate"]
        _keys(template, ("file", "width", "height"), f"{theater}.depthTemplate",
              required=("file", "width", "height"))
        if template["file"] != TEMPLATE_FILE:
            raise ValueError(f"{theater}.depthTemplate.file must be {TEMPLATE_FILE}")
        for dimension in ("width", "height"):
            _integer(template[dimension], f"{theater}.depthTemplate.{dimension}", positive=True)
        if shared_template is not None and template != shared_template:
            raise ValueError("theater depthTemplate metadata differs for the shared buildngz.bin")
        shared_template = template
        for type_id, fields in _object(patch["types"], f"{theater}.types").items():
            _name(type_id, "type id")
            context = f"{theater}.types.{type_id}"
            _keys(fields, ("zShape", "harvester", "refinery"), context)
            if not fields:
                raise ValueError(f"{context} must contain at least one field")
            for flag in ("harvester", "refinery"):
                if flag in fields and fields[flag] is not True:
                    raise ValueError(f"{context}.{flag} must be true")
            if "harvester" in fields and ("refinery" in fields or "zShape" in fields):
                raise ValueError(f"{context} combines vehicle and building fields")
            if "zShape" in fields:
                shape = fields["zShape"]
                _keys(shape, ("pointMove", "normalZAdjust"), f"{context}.zShape")
                if not shape:
                    raise ValueError(f"{context}.zShape must contain a non-default field")
                if "pointMove" in shape:
                    point = shape["pointMove"]
                    if not isinstance(point, list) or len(point) != 2:
                        raise ValueError(f"{context}.zShape.pointMove must have two integer coordinates")
                    for coordinate in point:
                        _integer(coordinate, f"{context}.zShape.pointMove coordinate")
                    if point == [0, 0]:
                        raise ValueError(f"{context}.zShape.pointMove must be non-default")
                if "normalZAdjust" in shape:
                    _integer(shape["normalZAdjust"], f"{context}.zShape.normalZAdjust", nonzero=True)
        for type_id, layers in _object(patch["layers"], f"{theater}.layers").items():
            _name(type_id, "layer type id")
            _object(layers, f"{theater}.layers.{type_id}")
            if not layers:
                raise ValueError(f"{theater}.layers.{type_id} must contain at least one layer")
            for key, fields in layers.items():
                _name(key, "layer key")
                context = f"{theater}.layers.{type_id}.{key}"
                _keys(fields, ("yDrawOffset",), context, required=("yDrawOffset",))
                _integer(fields["yDrawOffset"], f"{context}.yDrawOffset", nonzero=True)
    size = (staging / TEMPLATE_FILE).stat().st_size
    expected_size = shared_template["width"] * shared_template["height"]
    if size != expected_size:
        raise ValueError(f"{TEMPLATE_FILE}: expected {expected_size} bytes, found {size}")
    return patches


def apply_patch(data, patch, theater):
    """Merge only owned fields into the latest locked JSON and return matched counts."""
    _object(data, f"{theater} library")
    types = _object(data.get("types"), f"{theater} library types")
    if "theater" in data and data["theater"] != theater:
        raise ValueError(f"{theater} library has inconsistent theater metadata")
    result = dict(depthTemplate=copy.deepcopy(patch["depthTemplate"]), zShape=0,
                  harvester=0, refinery=0, yDrawOffset=0, changedFields=0,
                  skippedTypes=[], skippedLayers=[])

    def set_field(target, key, value):
        if key not in target or target[key] != value:
            target[key] = copy.deepcopy(value)
            result["changedFields"] += 1

    set_field(data, "depthTemplate", patch["depthTemplate"])
    for type_id, fields in patch["types"].items():
        entry = types.get(type_id)
        expected_kind = "vehicle" if "harvester" in fields else "building"
        if not isinstance(entry, dict) or entry.get("kind") != expected_kind:
            result["skippedTypes"].append(type_id)
            continue
        for flag in ("harvester", "refinery"):
            if flag in fields:
                set_field(entry, flag, True)
                result[flag] += 1
        if "zShape" in fields:
            building = entry.get("building")
            if not isinstance(building, dict):
                result["skippedTypes"].append(type_id)
                continue
            shape = _object(building.setdefault("zShape", {}), f"{theater}.{type_id}.building.zShape")
            for key, value in fields["zShape"].items():
                set_field(shape, key, value)
            result["zShape"] += 1
    for type_id, layers in patch["layers"].items():
        entry = types.get(type_id)
        building = entry.get("building") if isinstance(entry, dict) and entry.get("kind") == "building" else None
        targets = building.get("layers", []) if isinstance(building, dict) else []
        if not isinstance(targets, list):
            raise ValueError(f"{theater}.{type_id}.building.layers must be an array")
        for key, fields in layers.items():
            matches = [layer for layer in targets if isinstance(layer, dict) and layer.get("key") == key]
            if not matches:
                result["skippedLayers"].append(f"{type_id}:{key}")
            for layer in matches:
                set_field(layer, "yDrawOffset", fields["yDrawOffset"])
                result["yDrawOffset"] += 1
    return result


def install(staging: Path, farm: Path):
    """Install every existing theater, retaining older cache bytes and unrelated fields."""
    staging, farm = Path(staging), Path(farm)
    patches = load_patch(staging)
    manifests = sorted((farm / "_library").glob("*/library.json"))
    if not manifests:
        raise ValueError("farm has no _library/<theater>/library.json files")
    # Validate every destination up front. The callback still merges freshly read
    # JSON under its lock; none of these preflight snapshots are published.
    for manifest in manifests:
        theater = manifest.parent.name
        if theater not in patches:
            raise ValueError(f"staging has no patch for farm theater {theater}")
        apply_patch(json.loads(manifest.read_text(encoding="utf-8")), patches[theater], theater)
    results = {}
    for manifest in manifests:
        theater = manifest.parent.name
        relative = f"_library/{theater}"
        cache_farm.install_file(farm, f"{relative}/{TEMPLATE_FILE}", staging / TEMPLATE_FILE)

        def update(data):
            results[theater] = apply_patch(data, patches[theater], theater)

        cache_farm.patch_json(farm, f"{relative}/library.json", update)
    return {"theaters": results}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", type=Path, required=True, help="directory produced by the zshape CLI")
    parser.add_argument("--farm", type=Path, required=True, help="copy-on-write cache root containing _library")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(install(args.staging, args.farm), indent=2))
        return 0
    except (OSError, ValueError) as error:
        print(f"zshape_install: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
