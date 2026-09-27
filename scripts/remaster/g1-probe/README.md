# g1-probe

Offline, read-only Red Alert 2 / Yuri's Revenge install checker; Node.js 22+, no dependencies.
Run: `node g1-probe.mjs /path/to/game`
Save JSON: `node g1-probe.mjs /path/to/game --json /path/outside/game/report.json`
The output must be a new file outside the game directory; existing outputs are never overwritten.
Scans files at the top level and one subfolder level, matching names case-insensitively.
File symlinks are read; directory symlinks are reported as skipped; duplicate matches retain their paths.
Reports required/optional files, byte sizes, streamed SHA-256, and known executable hashes.
Analyzes every discovered EXE/DLL: DOS/PE headers, sections, entropy, imports, overlay, version strings.
Detects protection markers, suspicious imports, unusual entry points, and executable entropy > 7.2.
Verdicts are `likely_clean`, `protection_suspected`, or `not_pe`; heuristics are not proof.
Malformed version resources produce null; malformed binaries produce `not_pe` without stopping the scan.
Stdout includes inventory, PE details, per-file flags, and an overall summary.
Exit status: 0 for a completed scan (including missing/protected files), 1 for I/O or usage errors.
Tests: `node --test` (synthetic PE32/PE32+ images and temporary directories; no game install needed).
