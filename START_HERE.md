# Start here: Build 12 HD on a friend's Windows PC

Give your Windows coding assistant this file and one sentence:

> 请阅读 START_HERE.md，下载并复用已制作好的高清素材，在我的 Windows 电脑上完成适配和实机验证；只修改我自己的副本，不向原作者仓库推送。

## Scope for the coding assistant

The current PC owner is the original author's friend. Work in this PC owner's local
copy and a separate Windows branch. Do not push to the original repository, open a PR,
change repository visibility, or publish/upload assets. Only use the PC owner's own
GitHub identity when authentication is needed. The original-author instructions in
other runbooks to sign in as `xjtuyanshi` or push every step to the original `main`
do not apply to this handoff. Follow the remaining repository rules in
[AGENTS.md](AGENTS.md).

**Windows is a porting task, not a verified installer.** Follow
[WINDOWS_SETUP.md](WINDOWS_SETUP.md) for the implementation and acceptance criteria.
Use [AI_SETUP.md](AI_SETUP.md) sections 5–6 for resource restoration details, translated
to Windows paths and commands; do not follow its Mac/Wine/model-environment setup.

## Where everything comes from

The source repository and published release attachments are publicly readable. All
release names below belong to **`xjtuyanshi/ra2-hd-assets`**, including when working in a fork. Cloning/forking the Git repository does not download
or copy its release attachments.

| Required item                                                  | Location                                                                                                                      | Action                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source code and HD renderer                                    | Source repository, `main`                                                                                                     | Clone to `C:\ra2-hd\code`, or use a source snapshot supplied by the author. Record the commit.                                                                        |
| **Finished HD resource pack**, called the "HD cache" or "farm" | Release `farm-build12-20261102`: `hd-cache-play12.part00.tar.zst` through `hd-cache-play12.part31.tar.zst`                    | Download and restore all 32 chunks to `C:\ra2-hd\farm\hd-cache-play12`. **Do not regenerate the art.**                                                                |
| Existing game-to-page bridge binaries                          | The same release: `ddraw.dll`, `ra2launch.exe`                                                                                | Verify and place in `code\packages\native-host\build\`. These are project-built components, separate from the original game binaries.                                 |
| Restore script, manifest and checksums                         | The same release: `restore_farm.py`, `hd-cache-play12.manifest.json`, `SHA256SUMS`                                            | Download into `C:\ra2-hd\dl`; use together to restore and verify the pack. The script source is also in [backup/tools/restore_farm.py](backup/tools/restore_farm.py). |
| Original Yuri's Revenge installation                           | Supplied by the current PC owner from their own installation                                                                  | Copy to `C:\ra2-hd\game\YURI`. Never download game executables or original game resources.                                                                            |
| Optional art-making environment                                | Release `env-build12-20261102`: `env-build12.part00.tar.zst` through `part05.tar.zst`, manifest, restore script and checksums | **Not needed to run the finished HD pack or port the launcher.** Skip Wine, SDXL, ControlNet and art-generation environments for this task.                           |

The "HD cache" is the already-produced HD art and prepared rendering data, not a
missing model or an instruction to remake the game. Restoration extracts, verifies and
recreates file relationships. The pack is the **2026-11-02 snapshot**; later Mac-only
polish mentioned in [WINDOWS_SETUP.md](WINDOWS_SETUP.md) is not included. Report that
limitation instead of silently regenerating or substituting content.

The release's `launcher-build12.command` is the Mac entry, not a Windows launcher.
A Windows entry and native process startup still need to be implemented.

## Execution order

1. Check repository/release access before installing or downloading large files. Public
   HTTPS source and release downloads need no GitHub login. If GitHub CLI requests
   authentication, use the PC owner's own account or anonymous HTTPS downloads instead.
   Never request the original author's credentials.
   If access is missing, report exactly which source or asset is unavailable and continue
   only work that does not depend on it.
2. Read the Windows guide, check the actual toolchain requirements and available disk,
   initialize a local Git repository first if using a snapshot without `.git`, run
   `git config core.hooksPath scripts/git-hooks`, then
   `pnpm install --frozen-lockfile` and `pnpm run check`. For installations, login,
   administrator operations and DLL registration, print the exact command for the PC
   owner to run; keep system security settings intact.
3. Inspect the release inventory, require all 32 named farm chunks and the required
   metadata/binaries, and verify downloads against the current `SHA256SUMS`. Restore
   chunk 0 first to check Windows paths, then restore the rest one chunk at a time and
   run the final verification. A missing checksum or failed verification is not success.
   Do not delete a chunk until its restore and verification succeed. Validate hard-link
   and symbolic-link handling on Windows; the existing script is not Windows-verified.
   Budget about 59.7 GiB with hard links, plus staging/game/code space; copies of
   duplicate content can increase the pack to about 96.6 GB. Do not start by downloading
   every chunk when space is insufficient.
4. Implement the Windows path in `scripts/remaster/native/play-native.mjs` and a Windows
   double-click entry as specified in the Windows guide. Reuse the released bridge
   binaries first; rebuild from `packages/native-host` only when actually needed,
   checking its build scripts for compiler and Go requirements. Preserve macOS behavior
   and exact backup/restore of the game directory's `ddraw.dll`.
5. Run `pnpm run check` and relevant regressions from [docs/TESTING.md](docs/TESTING.md).
   Exercise the menu, HD/original switch, selection, movement, building, scrolling,
   save/load and exit restoration; the PC owner then plays a full match and checks the
   remaining Windows-guide acceptance items. Report passed, failed and `UNVERIFIED`
   separately, with progress and results in Chinese. Keep game files, HD assets, models,
   recordings and personal data out of Git;
   retain the EA non-endorsement disclaimer and third-party notices.

To locate the attachments with GitHub CLI (read-only; CLI login may be required):

```powershell
gh release view farm-build12-20261102 --repo xjtuyanshi/ra2-hd-assets --json assets --jq '.assets[].name'
```

The farm release is the download source even when `origin` points to your own fork.
For a full backup inventory, see [RESTORE.md](RESTORE.md); its launch commands target Mac.
