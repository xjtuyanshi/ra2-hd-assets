# Third-party licences for the environment backup

These files travel with the release `env-build12-20261102` (inside the chunks under
`LICENSES/`) and are also committed in the private repository under
`backup/LICENSES/`. The backup is a private, personal, non-commercial copy for the
repository owner. Nothing here is original game data.

## Wine (release asset `wine-stable-11.0_1-osx64.tar.xz`, unmodified, inside the chunks)

- Project: Gcenx macOS_Wine_builds, release tag `11.0_1`, asset
  `wine-stable-11.0_1-osx64.tar.xz`, 185,303,032 bytes, sha256
  `b50dc50ec7f41d58b115a6b685d4d1315ba3c797bd3aa0f49213f2703cb82388` (equal to the digest
  that release publishes). `wine --version` reports `wine-11.0`.
- Wine is licensed under the GNU Lesser General Public License, version 2.1 or later:
  `wine/LICENSE`, `wine/COPYING.LIB` and `wine/AUTHORS` are taken from the Wine source
  tree at tag `wine-11.0` (WineHQ; mirrored as wine-mirror/wine on GitHub).
- Corresponding source: Wine tag `wine-11.0` from WineHQ, and the build scripts in the
  Gcenx macOS_Wine_builds repository (its `.github` workflows; that repository carries
  no separate licence file). The archive is stored byte-for-byte as published.
- The archive also bundles third-party dylibs under
  `Wine Stable.app/Contents/Resources/wine/lib/`. Their upstream licences, as stated by
  each project (not re-verified file by file here): MoltenVK (Apache-2.0,
  `wine/MoltenVK-LICENSE`), SDL2 (zlib), brotli (MIT), bzip2 (bzip2 licence), libiconv,
  libcharset and libintl (LGPL), libxml2, libxslt, libexslt (MIT), libffi (MIT),
  FreeType (FreeType License or GPL-2.0), GMP (LGPL-3.0 or GPL-2.0), GnuTLS (LGPL-2.1+),
  Nettle/Hogweed (LGPL-3.0 or GPL-2.0), ICU 76 (Unicode License v3), libidn2
  (LGPL-3.0 or GPL-2.0), libinotify-kqueue (MIT), LZ4 (BSD-2-Clause), XZ liblzma
  (0BSD), p11-kit (BSD-3-Clause), libpcap (BSD-3-Clause), libpng (libpng licence),
  libtasn1 (LGPL-2.1+), libunistring (LGPL-3.0 or GPL-2.0), zlib (zlib), zstd
  (BSD-3-Clause), MacPorts legacy-support (MIT/BSD-style). All permit redistribution.
- Not included and never to be uploaded: Wine prefixes (they hold the owner's registry
  and game state) and CrossOver (proprietary).

## Diffusion models (`gameres/tools/diffusion/models/`)

| Folder                 | Upstream repository (Hugging Face)         | Licence                   | Text here                                                    |
| ---------------------- | ------------------------------------------ | ------------------------- | ------------------------------------------------------------ |
| `sdxl-base`            | `stabilityai/stable-diffusion-xl-base-1.0` | CreativeML Open RAIL++-M  | `diffusion/sdxl-base/LICENSE.md`, model card `README.md`     |
| `sdxl-vae-fp16-fix`    | `madebyollin/sdxl-vae-fp16-fix`            | MIT (model card metadata) | `diffusion/sdxl-vae-fp16-fix/README.md`                      |
| `controlnet-tile-sdxl` | `xinsir/controlnet-tile-sdxl-1.0`          | Apache-2.0                | `diffusion/controlnet-tile-sdxl/README.md`, `Apache-2.0.txt` |

Only the files selected by `gameres/tools/diffusion/download.py` were fetched (fp16
weights, configs, tokenizers, scheduler); they are stored unmodified.

CreativeML Open RAIL++-M notice (Section III, paragraphs 4 and 5): the SDXL base model is
subject to the use-based restrictions in Attachment A of `diffusion/sdxl-base/LICENSE.md`.
Anyone who receives these weights receives that licence with them and must not use the
model or its derivatives for the restricted uses listed there. Redistribution is
permitted under those conditions; this backup stays private to the owner.

## Real-ESRGAN (`gameres/tools/realesrgan/`)

- Binary and models from Real-ESRGAN release `v0.2.5.0`, asset
  `realesrgan-ncnn-vulkan-20220424-macos.zip` (51,817,124 bytes, same size as the local
  copy; local copy sha256 `e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a`).
- Real-ESRGAN models: BSD-3-Clause (`realesrgan/Real-ESRGAN-LICENSE`).
- realesrgan-ncnn-vulkan program: MIT (`realesrgan/Real-ESRGAN-ncnn-vulkan-LICENSE`).
- ncnn (linked into the program): BSD-3-Clause (`realesrgan/ncnn-LICENSE.txt`).
- Left out on purpose: the zip's demo files `input.jpg`, `input2.jpg` and
  `onepiece_demo.mp4` (third-party sample media, not used by any pipeline).

## Python packages

The Python virtual environments are not backed up; they are recreated from the pinned
lists in `backup/python/` with `uv` / `pip` from the public package index, so no Python
package is redistributed here.
