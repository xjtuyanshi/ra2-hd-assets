"""Atomic file installation and locked JSON updates in a copy-on-write symlink farm."""

import contextlib
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Callable


@contextlib.contextmanager
def _locked(path: Path):
    # Keep the lock inode stable: unlinking it would let new callers bypass existing waiters.
    with path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _exchange(left: Path, right: Path) -> None:
    """Swap a directory and a symlink without an unlink/rename visibility gap."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        args = (os.fsencode(left), os.fsencode(right), 2)  # RENAME_SWAP
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        args = (-100, os.fsencode(left), -100, os.fsencode(right), 2)  # AT_FDCWD, RENAME_EXCHANGE
    else:
        raise OSError(errno.ENOTSUP, "atomic directory realisation requires macOS or Linux", str(right))
    rename.restype = ctypes.c_int
    if rename(*args) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(right))


def _realise(path: Path) -> None:
    with _locked(path.with_name(f".{path.name}.realise.lock")):
        # A concurrent installer may have realised this directory while we waited.
        if not path.is_symlink():
            if not path.is_dir():
                raise NotADirectoryError(str(path))
            return
        source = path.resolve(strict=True)
        if not source.is_dir():
            raise NotADirectoryError(str(path))
        tmp = Path(tempfile.mkdtemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent))
        try:
            for child in source.iterdir():
                (tmp / child.name).symlink_to(child)
            _exchange(tmp, path)
        finally:
            # After the swap, tmp is the old symlink; on failure it is our unpublished directory.
            if tmp.is_symlink():
                tmp.unlink()
            else:
                shutil.rmtree(tmp)


def _ensure_dir(path: Path, *, parents=False) -> None:
    try:
        path.mkdir(parents=parents)
    except FileExistsError:
        if path.is_symlink():
            _realise(path)
        elif not path.is_dir():
            raise NotADirectoryError(str(path))


def _destination(root: Path, rel: str) -> Path:
    relative = Path(rel)
    if relative.is_absolute() or ".." in relative.parts or not relative.name:
        raise ValueError("destination must be a non-empty relative file path without '..'")
    # Resolving root here would follow a farm's symlink and send writes into the base cache.
    root = root.absolute()
    _ensure_dir(root, parents=True)
    parent = root
    for component in relative.parts[:-1]:
        parent /= component
        _ensure_dir(parent)
    return parent / relative.name


@contextlib.contextmanager
def _temporary_file(dst: Path):
    fd, name = tempfile.mkstemp(prefix=f".{dst.name}-", suffix=".tmp", dir=dst.parent)
    os.close(fd)
    tmp = Path(name)
    try:
        yield tmp
        os.replace(tmp, dst)
    finally:
        # replace() is a no-op if both names already refer to the same hard-linked inode.
        tmp.unlink(missing_ok=True)


def install_file(root: Path, rel: str, data_path: Path) -> None:
    """Atomically install a hard link (or a cross-device copy), replacing files and symlinks."""
    dst = _destination(root, rel)
    source = data_path.resolve(strict=True)
    with _temporary_file(dst) as tmp:
        if source.stat().st_dev == dst.parent.stat().st_dev:
            tmp.unlink()
            try:
                os.link(source, tmp)
                return
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise
        shutil.copyfile(source, tmp)


def patch_json(root: Path, rel: str, fn: Callable[[object], None]) -> None:
    """Read through a symlink, mutate under a per-file lock, and replace it with a real JSON file."""
    dst = _destination(root, rel)
    with _locked(dst.with_name(f".{dst.name}.lock")):
        data = json.loads(dst.read_text(encoding="utf-8"))
        fn(data)
        with _temporary_file(dst) as tmp:
            tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
