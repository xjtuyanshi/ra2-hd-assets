#!/usr/bin/env python3
"""Queued uploader for the Build 12 environment backup (Wine, Real-ESRGAN, diffusion models).

Usage: pack_env_upload.py REPO_ROOT MANIFEST_JSON WORK_DIR FARM_WORK_DIR REPO TAG

1. Waits until the farm uploader is finished: FARM_WORK_DIR/upload.log contains
   "all chunks verified", or FARM_WORK_DIR/progress.json records every farm chunk as
   verified. Nothing is packed or uploaded before that, so the two uploads never share
   the uplink and at most one chunk is on disk at a time.
2. Creates the release TAG if it does not exist and uploads the small static assets
   (manifest, restore_env.py).
3. For each chunk not yet verified in WORK_DIR/progress.json: packs it lazily into a
   tar.zst (re-hashing every source byte range against the manifest; a changed file
   aborts), uploads it, checks size, state and the sha256 digest reported by the GitHub
   API, deletes the local chunk and records progress. SHA256SUMS is re-published after
   every chunk. Rerunning resumes; an incomplete remote asset is deleted and re-uploaded.
"""
import hashlib, io, json, os, subprocess, sys, tarfile, time

repo_root, manifest_path, work, farm_work, repo, tag = sys.argv[1:7]
os.makedirs(work, exist_ok=True)
progress_path = os.path.join(work, "progress.json")
log_path = os.path.join(work, "upload.log")
m = json.load(open(manifest_path))
name = m["name"]
LIMIT = int(1.9 * 2**30)
progress = json.load(open(progress_path)) if os.path.exists(progress_path) else {"chunks": {}}
here = os.path.dirname(os.path.abspath(__file__))
STATIC = [manifest_path, os.path.join(here, "restore_env.py")]


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(log_path, "a") as f:
        f.write(line + "\n")


def save():
    with open(progress_path + ".tmp", "w") as f:
        json.dump(progress, f, indent=1)
    os.replace(progress_path + ".tmp", progress_path)


def farm_done():
    try:
        with open(os.path.join(farm_work, "upload.log")) as f:
            if any("all chunks verified" in l for l in f):
                return True
    except OSError:
        pass
    try:
        p = json.load(open(os.path.join(farm_work, "progress.json")))
        fm = json.load(open(os.path.join(os.path.dirname(farm_work), "manifest.json")))
        return sum(1 for r in p["chunks"].values() if r.get("verified")) >= fm["chunks"]
    except (OSError, ValueError, KeyError):
        return False


def farm_count():
    try:
        p = json.load(open(os.path.join(farm_work, "progress.json")))
        return sum(1 for r in p["chunks"].values() if r.get("verified"))
    except (OSError, ValueError, KeyError):
        return "?"


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while c := f.read(8 << 20):
            h.update(c)
    return h.hexdigest()


class RangeReader(io.RawIOBase):
    """Reads one byte range of a file and hashes what it returns."""

    def __init__(self, f, length):
        self.f, self.left, self.h = f, length, hashlib.sha256()

    def readable(self):
        return True

    def readinto(self, b):
        if self.left <= 0:
            return 0
        n = self.f.readinto(memoryview(b)[: min(len(b), self.left)])
        if n:
            self.h.update(memoryview(b)[:n])
            self.left -= n
        return n


def gh(*a, capture=True):
    return subprocess.run(["gh", *a], check=True, capture_output=capture, text=True).stdout


def gh_assets(release_id):
    out = gh("api", "--paginate", f"repos/{repo}/releases/{release_id}/assets?per_page=100", "--jq", ".[]|@json")
    return {a["name"]: a for a in (json.loads(l) for l in out.splitlines() if l.strip())}


def build(chunk, path):
    segs = [(r, g) for r in m["entries"] for g in r["segments"] if g["chunk"] == chunk]
    zstd = subprocess.Popen(["zstd", "-3", "-T2", "-q", "-f", "-o", path], stdin=subprocess.PIPE)
    with tarfile.open(fileobj=zstd.stdin, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        for r, g in segs:
            src = os.path.join(repo_root, r["src"])
            st = os.stat(src)
            if st.st_size != r["size"]:
                raise SystemExit(f"size changed since manifest: {r['src']}")
            ti = tarfile.TarInfo(g["member"])
            ti.size, ti.mtime, ti.mode = g["length"], int(st.st_mtime), r["mode"]
            with open(src, "rb", buffering=0) as f:
                f.seek(g["offset"])
                rr = RangeReader(f, g["length"])
                tar.addfile(ti, io.BufferedReader(rr, 1 << 20))
            want = g.get("sha256") or r["sha256"]
            if rr.h.hexdigest() != want:
                raise SystemExit(f"content changed since manifest: {r['src']} segment {g['member']}")
    zstd.stdin.close()
    if zstd.wait() != 0:
        raise SystemExit("zstd failed")
    return len(segs), sum(g["length"] for _, g in segs)


def upload(path, asset, release_id, size):
    existing = gh_assets(release_id).get(asset)
    if existing and (existing["size"] != size or existing.get("state") != "uploaded"):
        gh("api", "-X", "DELETE", f"repos/{repo}/releases/assets/{existing['id']}")
        existing = None
    if existing:
        return None
    t = time.time()
    for attempt in range(6):
        r = subprocess.run(["gh", "release", "upload", tag, path, "--repo", repo, "--clobber"])
        if r.returncode == 0:
            return time.time() - t
        log(f"upload attempt {attempt+1} failed for {asset}; retrying in 60 s")
        time.sleep(60)
    raise SystemExit(f"upload failed: {asset}")


def verify(asset, release_id, size, digest):
    a = gh_assets(release_id).get(asset)
    got = (a or {}).get("digest")
    if not (a and a["size"] == size and a.get("state") == "uploaded" and got == f"sha256:{digest}"):
        raise SystemExit(f"remote verification failed for {asset}: {a and (a['size'], a.get('state'), got)}")
    return a


def publish_sums(release_id):
    lines = [f"{r['sha256']}  {r['asset']}" for r in progress.get("static", {}).values() if r.get("verified")]
    lines += [f"{r['sha256']}  {r['asset']}" for k, r in sorted(progress["chunks"].items()) if r.get("verified")]
    path = os.path.join(work, "SHA256SUMS")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    subprocess.run(["gh", "release", "upload", tag, path, "--repo", repo, "--clobber"], check=True)


# 1. wait for the farm upload
if not farm_done():
    log(f"waiting for the farm uploader ({farm_work}) to verify all chunks; nothing packed yet")
    last = 0
    while not farm_done():
        if time.time() - last > 3600:
            log(f"still waiting: farm chunks verified {farm_count()}")
            last = time.time()
        time.sleep(300)
log("farm upload finished; starting environment upload")

# 2. release + static assets
r = subprocess.run(["gh", "api", f"repos/{repo}/releases/tags/{tag}", "--jq", ".id"], capture_output=True, text=True)
if r.returncode != 0:
    notes = ("Build 12 environment backup: free Wine 11.0 (unmodified upstream archive), Real-ESRGAN "
             "ncnn-vulkan with models, SDXL diffusion weights, licences. Private; see AI_SETUP.md.")
    gh("release", "create", tag, "--repo", repo, "--title", "Build 12 environment backup (2026-11-02)",
       "--notes", notes, "--target", "main")
    r = subprocess.run(["gh", "api", f"repos/{repo}/releases/tags/{tag}", "--jq", ".id"],
                       check=True, capture_output=True, text=True)
release_id = r.stdout.strip()
progress.setdefault("static", {})
for p in STATIC:
    asset = os.path.basename(p)
    rec = {"asset": asset, "bytes": os.path.getsize(p), "sha256": sha_file(p)}
    old = progress["static"].get(asset)
    if old and old.get("verified") and old["sha256"] == rec["sha256"]:
        continue
    upload(p, asset, release_id, rec["bytes"])
    verify(asset, release_id, rec["bytes"], rec["sha256"])
    rec["verified"] = True
    progress["static"][asset] = rec
    save()
    log(f"verified static asset {asset}")

# 3. chunks
for chunk in range(m["chunks"]):
    key = f"{chunk:02d}"
    asset = f"{name}.part{key}.tar.zst"
    if progress["chunks"].get(key, {}).get("verified"):
        continue
    path = os.path.join(work, asset)
    rec = progress["chunks"].get(key, {})
    if not (os.path.exists(path) and rec.get("sha256") and os.path.getsize(path) == rec.get("bytes")):
        t = time.time()
        n, raw = build(chunk, path)
        rec = {"asset": asset, "members": n, "raw_bytes": raw, "bytes": os.path.getsize(path)}
        rec["sha256"] = sha_file(path)
        progress["chunks"][key] = rec
        save()
        log(f"packed {asset}: {n} members, {raw} raw -> {rec['bytes']} bytes in {time.time()-t:.0f}s")
    if rec["bytes"] >= LIMIT:
        raise SystemExit(f"{asset} is {rec['bytes']} bytes, not below 1.9 GiB")
    dt = upload(path, asset, release_id, rec["bytes"])
    if dt:
        rec["upload_seconds"] = round(dt)
        log(f"uploaded {asset} in {dt:.0f}s ({rec['bytes']/dt/2**20:.2f} MiB/s)")
    a = verify(asset, release_id, rec["bytes"], rec["sha256"])
    rec.update({"verified": True, "asset_id": a["id"], "remote_digest": a["digest"]})
    save()
    os.remove(path)
    log(f"verified {asset} (id {a['id']}, {a['digest']}); local chunk removed")
    publish_sums(release_id)
    done = [r for r in progress["chunks"].values() if r.get("verified") and r.get("upload_seconds")]
    if done:
        rate = sum(r["bytes"] for r in done) / sum(r["upload_seconds"] for r in done)
        left = sum(m["chunk_bytes"][c] for c in range(m["chunks"])
                   if not progress["chunks"].get(f"{c:02d}", {}).get("verified"))
        nv = sum(1 for r in progress["chunks"].values() if r.get("verified"))
        log(f"status: {nv}/{m['chunks']} chunks verified; rate {rate/2**20:.2f} MiB/s; "
            f"~{left/2**30:.1f} GiB raw left; ETA {left/rate/3600:.1f} h")

publish_sums(release_id)
log("all environment chunks verified")
