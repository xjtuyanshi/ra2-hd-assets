#!/usr/bin/env python3
"""Restore the Build 12 environment backup (free Wine archive, Real-ESRGAN, diffusion models,
licences) from release env-build12-20261102.

Usage:
  restore_env.py MANIFEST_JSON CHUNK_DIR DEST_DIR --chunks N[,N...]   # restore downloaded chunks
  restore_env.py MANIFEST_JSON - DEST_DIR --finish                     # final check of every file

Restore chunks in ascending order (0, 1, 2, ...): files larger than one chunk are split
into numbered segments that are appended in that order. For each chunk the script checks
the archive against CHUNK_DIR/SHA256SUMS (required), extracts it, verifies every
segment's sha256, appends split segments to "<file>.partial" and renames the file once
complete and its whole-file sha256 matches. A chunk can be deleted as soon as its run
succeeds. --finish checks that every manifest file exists in DEST_DIR with the recorded
size, sha256 and executable bit, and prints "<n> files checked, 0 problems".
"""
import argparse, hashlib, json, os, subprocess, sys, tarfile

ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("chunk_dir")
ap.add_argument("dest")
ap.add_argument("--chunks", default="")
ap.add_argument("--finish", action="store_true")
args = ap.parse_args()
m = json.load(open(args.manifest))
dest = os.path.abspath(args.dest)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while c := f.read(8 << 20):
            h.update(c)
    return h.hexdigest()


if args.finish:
    bad = 0
    for r in m["entries"]:
        p = os.path.join(dest, r["path"])
        if not os.path.isfile(p) or os.path.getsize(p) != r["size"] or sha(p) != r["sha256"]:
            print(f"MISSING/BAD {r['path']}")
            bad += 1
        elif r["mode"] & 0o100 and not os.access(p, os.X_OK):
            print(f"NOT EXECUTABLE {r['path']}")
            bad += 1
    print(f"{len(m['entries'])} files checked, {bad} problems")
    sys.exit(1 if bad else 0)

if not args.chunks:
    sys.exit("give --chunks N (ascending order) or --finish")
want = sorted({int(c) for c in args.chunks.split(",") if c})
sums = {}
for line in open(os.path.join(args.chunk_dir, "SHA256SUMS")):
    if line.strip():
        d, fn = line.split(None, 1)
        sums[fn.strip().lstrip("*")] = d

for c in want:
    fn = f"{m['name']}.part{c:02d}.tar.zst"
    p = os.path.join(args.chunk_dir, fn)
    if fn not in sums:
        sys.exit(f"{fn} is not listed in SHA256SUMS (download the current SHA256SUMS)")
    if sha(p) != sums[fn]:
        sys.exit(f"checksum mismatch: {fn}")
    print(f"ok  {fn}")
    segs = {g["member"]: (r, i, g) for r in m["entries"] for i, g in enumerate(r["segments"]) if g["chunk"] == c}
    z = subprocess.Popen(["zstd", "-dc", p], stdout=subprocess.PIPE)
    seen = set()
    with tarfile.open(fileobj=z.stdout, mode="r|") as tar:
        for ti in tar:
            if ti.name not in segs or not ti.isfile():
                sys.exit(f"unexpected member {ti.name!r} in {fn}")
            r, i, g = segs[ti.name]
            final = os.path.join(dest, r["path"])
            os.makedirs(os.path.dirname(final), exist_ok=True)
            split = len(r["segments"]) > 1
            out = final + ".partial" if split else final + ".tmp"
            done_already = split and not os.path.exists(out) and os.path.isfile(final) \
                and os.path.getsize(final) == r["size"]
            if done_already:  # rerun of a chunk whose split file is already assembled: verify, do not rewrite
                out = os.devnull
                mode = "wb"
            elif split and i > 0:
                if not os.path.exists(out) or os.path.getsize(out) < g["offset"]:
                    sys.exit(f"{r['path']}: segment {i} needs the earlier chunks restored first (in order)")
                os.truncate(out, g["offset"])  # a rerun of this chunk replaces its own segment
                mode = "ab"
            else:
                mode = "wb"
            h = hashlib.sha256()
            src = tar.extractfile(ti)
            with open(out, mode) as f:
                while b := src.read(8 << 20):
                    h.update(b)
                    f.write(b)
            if h.hexdigest() != (g.get("sha256") or r["sha256"]):
                sys.exit(f"BAD segment {ti.name}")
            seen.add(ti.name)
            if done_already:
                continue
            if not split or i == len(r["segments"]) - 1:
                if split and sha(out) != r["sha256"]:
                    sys.exit(f"BAD assembled file {r['path']}")
                os.chmod(out, r["mode"])
                os.replace(out, final)
    if z.wait() != 0:
        sys.exit(f"zstd failed on {fn}")
    if seen != set(segs):
        sys.exit(f"{fn}: missing members {sorted(set(segs) - seen)[:5]}")
    print(f"restored chunk {c:02d}: {len(seen)} members verified")
