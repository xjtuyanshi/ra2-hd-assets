#!/usr/bin/env python3
"""Hash the Build 12 environment files (free Wine, Real-ESRGAN, diffusion models, licences)
and assign them to release chunks.

Usage: build_env_manifest.py REPO_ROOT OUT_JSON

Every file is stored as one or more byte segments. A chunk holds at most CHUNK_RAW bytes
of file data, so its tar.zst stays below the 1.9 GiB per-asset limit used by this backup;
files larger than the free space of the current chunk (the 5.1 GB SDXL UNet) continue in
the next chunk. Segments are numbered in chunk order, so restoring chunks in ascending
order rebuilds each split file by appending.
"""
import hashlib, json, os, stat, sys, time

repo, out = sys.argv[1:3]
CHUNK_RAW = 1_850 * 2**20  # bytes of file data per chunk; zstd overhead on incompressible data is far below 50 MiB
NAME = "env-build12"

# (source relative to REPO_ROOT, path inside the bundle). Directories are walked.
SOURCES = [
    ("gameres/s2x/backup/env/LICENSES", "LICENSES"),
    ("gameres/wine-free/SOURCE.txt", "wine/SOURCE.txt"),
    ("gameres/wine-free/wine-stable-11.0_1-osx64.tar.xz", "wine/wine-stable-11.0_1-osx64.tar.xz"),
    ("gameres/tools/realesrgan/README_macos.md", "gameres/tools/realesrgan/README_macos.md"),
    ("gameres/tools/realesrgan/realesrgan-ncnn-vulkan", "gameres/tools/realesrgan/realesrgan-ncnn-vulkan"),
    ("gameres/tools/realesrgan/models", "gameres/tools/realesrgan/models"),
    ("gameres/tools/diffusion/download.py", "gameres/tools/diffusion/download.py"),
    ("gameres/tools/diffusion/models", "gameres/tools/diffusion/models"),
]
SKIP_DIRS = {".cache", "__pycache__", ".venv"}
SKIP_FILES = {".DS_Store"}


def walk(src, dst):
    full = os.path.join(repo, src)
    if os.path.isfile(full):
        yield src, dst
        return
    for d, dirs, files in os.walk(full):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if f in SKIP_FILES:
                continue
            rel = os.path.relpath(os.path.join(d, f), full)
            yield os.path.join(src, rel), os.path.join(dst, rel)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while c := f.read(8 << 20):
            h.update(c)
    return h.hexdigest()


files, chunk, used = [], 0, 0
for src, dst in SOURCES:
    for s, d in walk(src, dst):
        p = os.path.join(repo, s)
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode):
            raise SystemExit(f"not a regular file: {s}")
        rec = {"path": d, "src": s, "size": st.st_size, "sha256": sha(p),
               "mode": 0o755 if st.st_mode & 0o111 else 0o644, "segments": []}
        off = 0
        while True:
            take = min(rec["size"] - off, CHUNK_RAW - used)
            if take == 0 and rec["size"] > 0:
                chunk, used = chunk + 1, 0
                continue
            rec["segments"].append({"chunk": chunk, "offset": off, "length": take})
            off += take
            used += take
            if off >= rec["size"]:
                break
        if len(rec["segments"]) > 1:
            with open(p, "rb") as f:
                for i, g in enumerate(rec["segments"]):
                    f.seek(g["offset"])
                    h, left = hashlib.sha256(), g["length"]
                    while left:
                        c = f.read(min(left, 8 << 20))
                        h.update(c)
                        left -= len(c)
                    g["sha256"] = h.hexdigest()
                    g["member"] = f"{d}.seg{i:03d}"
        else:
            rec["segments"][0]["member"] = d
        files.append(rec)
        print(f"{rec['size']:>12} {d} -> chunks {sorted({g['chunk'] for g in rec['segments']})}", flush=True)

nchunks = max(g["chunk"] for r in files for g in r["segments"]) + 1
m = {"name": NAME, "created": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "chunk_raw_limit": CHUNK_RAW,
     "chunks": nchunks, "files": len(files), "bytes": sum(r["size"] for r in files),
     "chunk_bytes": [sum(g["length"] for r in files for g in r["segments"] if g["chunk"] == c) for c in range(nchunks)],
     "entries": files}
with open(out + ".tmp", "w") as f:
    json.dump(m, f, indent=1)
os.replace(out + ".tmp", out)
print(f"{m['files']} files, {m['bytes']} bytes, {nchunks} chunks: {m['chunk_bytes']}")
