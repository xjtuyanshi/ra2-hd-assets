#!/usr/bin/env python3
"""Pack, upload and verify farm chunks one at a time (resumable).

Usage: pack_upload.py FARM_DIR MANIFEST_JSON WORK_DIR REPO TAG

For each chunk not yet recorded as verified in WORK_DIR/progress.json:
  1. stream the chunk's canonical files into an independent tar.zst
     (re-hashing each file while reading; a changed file aborts),
  2. sha256 the archive, upload it as a release asset,
  3. verify size and digest reported by the GitHub API,
  4. delete the local archive and record progress.
"""
import hashlib, io, json, os, subprocess, sys, tarfile, time

farm, manifest_path, work, repo, tag = sys.argv[1:6]
os.makedirs(work, exist_ok=True)
progress_path = os.path.join(work, "progress.json")
log_path = os.path.join(work, "upload.log")
m = json.load(open(manifest_path))
name = m["farm_name"]
progress = json.load(open(progress_path)) if os.path.exists(progress_path) else {"chunks": {}}


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(log_path, "a") as f:
        f.write(line + "\n")


def save():
    tmp = progress_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(progress, f, indent=1)
    os.replace(tmp, progress_path)


class HashReader(io.RawIOBase):
    def __init__(self, f):
        self.f, self.h = f, hashlib.sha256()

    def readable(self):
        return True

    def readinto(self, b):
        n = self.f.readinto(b)
        if n:
            self.h.update(memoryview(b)[:n])
        return n


release_id = subprocess.run(["gh", "api", f"repos/{repo}/releases/tags/{tag}", "--jq", ".id"],
                            check=True, capture_output=True, text=True).stdout.strip()


def gh_assets():
    out = subprocess.run(["gh", "api", "--paginate", f"repos/{repo}/releases/{release_id}/assets?per_page=100", "--jq", ".[]|@json"],
                         check=True, capture_output=True, text=True).stdout
    return {a["name"]: a for a in (json.loads(l) for l in out.splitlines() if l.strip())}


def build(chunk, path):
    blobs = [b for b in m["blobs"] if b["chunk"] == chunk]
    zstd = subprocess.Popen(["zstd", "-3", "-T2", "-q", "-f", "-o", path], stdin=subprocess.PIPE)
    with tarfile.open(fileobj=zstd.stdin, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        for b in blobs:
            src = os.path.join(farm, b["canonical"])
            st = os.stat(src)
            if st.st_size != b["size"]:
                raise SystemExit(f"size changed since manifest: {b['canonical']}")
            ti = tarfile.TarInfo(b["canonical"])
            ti.size, ti.mtime, ti.mode = st.st_size, int(st.st_mtime), 0o644
            with open(src, "rb", buffering=0) as f:
                hr = HashReader(f)
                tar.addfile(ti, io.BufferedReader(hr, 1 << 20))
            if hr.h.hexdigest() != b["sha256"]:
                raise SystemExit(f"content changed since manifest: {b['canonical']}")
    zstd.stdin.close()
    if zstd.wait() != 0:
        raise SystemExit("zstd failed")
    return len(blobs), sum(b["size"] for b in blobs)


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while c := f.read(8 << 20):
            h.update(c)
    return h.hexdigest()


def publish_sums():
    """SHA256SUMS = static assets (work/static.sha256) + every verified chunk; re-uploaded after each chunk."""
    lines = []
    static = os.path.join(work, "static.sha256")
    if os.path.exists(static):
        lines += [l.rstrip("\n") for l in open(static) if l.strip()]
    for k in sorted(progress["chunks"]):
        r = progress["chunks"][k]
        if r.get("verified"):
            lines.append(f"{r['sha256']}  {r['asset']}")
    path = os.path.join(work, "SHA256SUMS")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    subprocess.run(["gh", "release", "upload", tag, path, "--repo", repo, "--clobber"], check=True)


def status():
    done = [r for r in progress["chunks"].values() if r.get("verified") and r.get("upload_seconds")]
    nver = sum(1 for r in progress["chunks"].values() if r.get("verified"))
    if done:
        rate = sum(r["bytes"] for r in done) / sum(r["upload_seconds"] for r in done)
        left = sum(b["size"] for b in m["blobs"] if f"{b['chunk']:02d}" not in
                   {k for k, r in progress["chunks"].items() if r.get("verified")})
        log(f"status: {nver}/{m['chunks']} chunks verified; rate {rate/2**20:.2f} MiB/s; "
            f"~{left/2**30:.1f} GiB left; ETA {left/rate/3600:.1f} h")


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
        rec = {"asset": asset, "files": n, "raw_bytes": raw, "bytes": os.path.getsize(path)}
        rec["sha256"] = sha_file(path)
        progress["chunks"][key] = rec
        save()
        log(f"packed {asset}: {n} blobs, {raw} raw -> {rec['bytes']} bytes in {time.time()-t:.0f}s")
    if rec["bytes"] >= 2**31:
        raise SystemExit(f"{asset} exceeds 2 GiB")
    existing = gh_assets().get(asset)
    if existing and (existing["size"] != rec["bytes"] or existing.get("state") != "uploaded"):
        subprocess.run(["gh", "api", "-X", "DELETE", f"repos/{repo}/releases/assets/{existing['id']}"], check=True)
        existing = None
    if not existing:
        t = time.time()
        for attempt in range(4):
            r = subprocess.run(["gh", "release", "upload", tag, path, "--repo", repo, "--clobber"])
            if r.returncode == 0:
                break
            log(f"upload attempt {attempt+1} failed for {asset}; retrying")
            time.sleep(30)
        else:
            raise SystemExit(f"upload failed: {asset}")
        dt = time.time() - t
        log(f"uploaded {asset} in {dt:.0f}s ({rec['bytes']/dt/2**20:.1f} MiB/s)")
        rec["upload_seconds"] = round(dt)
    a = gh_assets().get(asset)
    digest = (a or {}).get("digest")
    ok = a and a["size"] == rec["bytes"] and a.get("state") == "uploaded" and digest == f"sha256:{rec['sha256']}"
    if not ok:
        raise SystemExit(f"remote verification failed for {asset}: {a and (a['size'], a.get('state'), digest)}")
    rec.update({"verified": True, "asset_id": a["id"], "remote_digest": digest})
    save()
    os.remove(path)
    log(f"verified {asset} (id {a['id']}, {digest}); local chunk removed")
    publish_sums()
    status()

publish_sums()
log("all chunks verified")
