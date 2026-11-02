#!/usr/bin/env python3
"""Restore the HD farm from downloaded chunks.

Usage:
  restore_farm.py MANIFEST_JSON CHUNK_DIR TARGET_DIR [--dry-run] [--chunks 0,5,31] [--copy]
  restore_farm.py MANIFEST_JSON - TARGET_DIR --finish

Streaming restore (small disk): for each chunk N, download it, run with --chunks N, delete
it; then run once with --finish to create loop links and empty folders and to check that
every farm path exists with the recorded size.

CHUNK_DIR holds the downloaded *.partNN.tar.zst files (and SHA256SUMS, if present,
is checked first). Each chunk is an independent tar; the extraction places every
unique file at its canonical farm path, then every other path that shares the same
content becomes a hard link to it (or a copy with --copy, or when hard links fail).
Loop symlinks inside the farm are recreated as relative symlinks. Every file is
verified against the manifest's sha256.

--dry-run: verify chunk checksums and list what would be written; with --chunks,
only those chunks are extracted into TARGET_DIR (meant for a scratch path), and only
their files are linked and verified.
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tarfile

ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("chunk_dir")
ap.add_argument("target")
ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--chunks", default="")
ap.add_argument("--copy", action="store_true")
ap.add_argument("--finish", action="store_true")
args = ap.parse_args()

m = json.load(open(args.manifest))
name = m["farm_name"]
want = sorted({int(c) for c in args.chunks.split(",") if c}) if args.chunks else list(range(m["chunks"]))


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while c := f.read(8 << 20):
            h.update(c)
    return h.hexdigest()


if args.finish:
    target = os.path.abspath(args.target)
    for d in m["empty_dirs"]:
        os.makedirs(os.path.join(target, d), exist_ok=True)
    for l in m["loop_symlinks"]:
        dst = os.path.join(target, l["path"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.lexists(dst):
            os.symlink(l["target"], dst)
    problems = [p for b in m["blobs"] for p in b["paths"]
                if not os.path.isfile(os.path.join(target, p)) or os.path.getsize(os.path.join(target, p)) != b["size"]]
    for p in problems[:50]:
        print(f"MISSING/SIZE {p}")
    print(f"{m['file_paths']} farm paths checked, {len(problems)} problems")
    sys.exit(1 if problems else 0)

sums = {}
sums_path = os.path.join(args.chunk_dir, "SHA256SUMS")
if os.path.exists(sums_path):
    for line in open(sums_path):
        d, fn = line.split(None, 1)
        sums[fn.strip().lstrip("*")] = d

missing = []
for c in want:
    fn = f"{name}.part{c:02d}.tar.zst"
    p = os.path.join(args.chunk_dir, fn)
    if not os.path.exists(p):
        missing.append(fn)
        continue
    if fn in sums:
        got = sha(p)
        if got != sums[fn]:
            sys.exit(f"checksum mismatch: {fn}")
        print(f"ok  {fn}")
    else:
        print(f"??  {fn} (not in SHA256SUMS)")
if missing:
    sys.exit(f"missing chunks: {missing}")

blobs = [b for b in m["blobs"] if b["chunk"] in want]
print(f"{len(blobs)} unique files, {sum(b['size'] for b in blobs)} bytes, "
      f"{sum(len(b['paths']) for b in blobs)} farm paths from {len(want)} chunk(s)")
if args.dry_run and not args.chunks:
    print("dry run: checksums verified, nothing written")
    sys.exit(0)

target = os.path.abspath(args.target)
os.makedirs(target, exist_ok=True)
for c in want:
    p = os.path.join(args.chunk_dir, f"{name}.part{c:02d}.tar.zst")
    z = subprocess.Popen(["zstd", "-dc", p], stdout=subprocess.PIPE)
    with tarfile.open(fileobj=z.stdout, mode="r|") as tar:
        try:
            tar.extractall(target, filter="data")
        except TypeError:  # Python < 3.12 has no extraction filters; members are plain relative files
            tar.extractall(target)
    if z.wait() != 0:
        sys.exit(f"zstd failed on {p}")
    print(f"extracted chunk {c:02d}")

bad = 0
for b in blobs:
    src = os.path.join(target, b["canonical"])
    if sha(src) != b["sha256"]:
        print(f"BAD {b['canonical']}")
        bad += 1
        continue
    for extra in b["paths"][1:]:
        dst = os.path.join(target, extra)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.lexists(dst):
            os.remove(dst)
        if args.copy:
            shutil.copy2(src, dst)
        else:
            try:
                os.link(src, dst)
            except OSError:
                shutil.copy2(src, dst)
if not args.chunks:
    for d in m["empty_dirs"]:
        os.makedirs(os.path.join(target, d), exist_ok=True)
    for l in m["loop_symlinks"]:
        dst = os.path.join(target, l["path"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.lexists(dst):
            os.symlink(l["target"], dst)
print("verified" if not bad else f"{bad} files failed verification")
sys.exit(1 if bad else 0)
