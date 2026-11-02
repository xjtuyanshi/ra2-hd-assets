#!/usr/bin/env python3
"""Materialise the HD farm as the renderer sees it and write a content manifest.

Usage: build_manifest.py FARM_DIR OUT_JSON [CHUNK_LIMIT_BYTES]

Follows every symlink (the farm is a chain play12 -> play9 -> play6 -> s2x/...),
de-duplicates identical inodes and identical content, and records symlinks that
loop back to an ancestor directory as relative symlinks so the restore recreates
them without infinite recursion. Each unique content blob is assigned to a chunk
(an independent tar) by its canonical (first, sorted) farm path.
"""
import hashlib, json, os, stat, sys, time

farm = os.path.abspath(sys.argv[1])
out = sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else int(1.9 * 2**30)

files = []      # (relpath, (dev, ino), size)
loops = []      # (relpath, relative target)
broken = []     # (relpath, readlink)
dirs = []       # relative dir paths (for empty dirs)


def walk(real_dir, rel, ancestors):
    try:
        entries = sorted(os.scandir(real_dir), key=lambda e: e.name)
    except OSError as e:
        print(f"unreadable dir {rel}: {e}", file=sys.stderr)
        return
    dirs.append(rel)
    for e in entries:
        r = f"{rel}/{e.name}" if rel else e.name
        p = os.path.join(real_dir, e.name)
        try:
            st = os.stat(p)  # follows symlinks
        except OSError:
            broken.append((r, os.readlink(p) if os.path.islink(p) else None))
            continue
        if stat.S_ISDIR(st.st_mode):
            rp = os.path.realpath(p)
            if rp in ancestors:
                # loop back to an ancestor: keep as a relative symlink
                target = os.path.relpath(ancestors[rp] or ".", os.path.dirname(r) or ".")
                loops.append((r, target))
                continue
            walk(rp, r, {**ancestors, rp: r})
        elif stat.S_ISREG(st.st_mode):
            files.append((r, (st.st_dev, st.st_ino), st.st_size))


t0 = time.time()
walk(os.path.realpath(farm), "", {os.path.realpath(farm): ""})
print(f"walk: {len(files)} file paths, {len(loops)} loop links, {len(broken)} broken, {time.time()-t0:.1f}s",
      file=sys.stderr)

by_inode = {}
for r, key, size in files:
    by_inode.setdefault(key, []).append(r)
inode_sha = {}
for key, paths in by_inode.items():
    h = hashlib.sha256()
    with open(os.path.join(farm, paths[0]), "rb") as f:
        while chunk := f.read(4 << 20):
            h.update(chunk)
    inode_sha[key] = h.hexdigest()
print(f"hashed {len(by_inode)} inodes, {time.time()-t0:.1f}s", file=sys.stderr)

blobs = {}
for r, key, size in files:
    b = blobs.setdefault(inode_sha[key], {"size": size, "paths": []})
    b["paths"].append(r)
for b in blobs.values():
    b["paths"].sort()

order = sorted(blobs.items(), key=lambda kv: kv[1]["paths"][0])
chunk, used = 0, 0
for sha, b in order:
    cost = b["size"] + 1536  # tar header (+ possible pax header) + padding
    if cost > limit:
        raise SystemExit(f"file too large for a chunk: {b['paths'][0]}")
    if used and used + cost > limit:
        chunk, used = chunk + 1, 0
    b["chunk"] = chunk
    used += cost

has_files = set()
for r, _, _ in files:
    d = os.path.dirname(r)
    while d and d not in has_files:
        has_files.add(d)
        d = os.path.dirname(d)
for r, _ in loops:
    d = os.path.dirname(r)
    while d:
        has_files.add(d)
        d = os.path.dirname(d)

manifest = {
    "format": "ra2-hd-farm-manifest/1",
    "farm_name": os.path.basename(farm),
    "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "chunk_limit": limit,
    "chunks": chunk + 1,
    "unique_blobs": len(blobs),
    "unique_bytes": sum(b["size"] for b in blobs.values()),
    "file_paths": len(files),
    "logical_bytes": sum(s for _, _, s in files),
    "blobs": [{"sha256": sha, "size": b["size"], "chunk": b["chunk"], "canonical": b["paths"][0],
               "paths": b["paths"]} for sha, b in order],
    "loop_symlinks": [{"path": r, "target": t} for r, t in sorted(loops)],
    "broken_symlinks": [{"path": r, "readlink": t} for r, t in sorted(broken)],
    "empty_dirs": sorted(d for d in dirs if d and d not in has_files),
}
with open(out, "w") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)
summary = {k: manifest[k] for k in ("chunks", "unique_blobs", "unique_bytes", "file_paths", "logical_bytes")}
print(json.dumps(summary), file=sys.stderr)
print(f"loops: {manifest['loop_symlinks']}", file=sys.stderr)
print(f"broken: {manifest['broken_symlinks'][:20]}", file=sys.stderr)
print(f"empty dirs: {len(manifest['empty_dirs'])}", file=sys.stderr)
