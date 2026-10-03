# Prepared HD atlas layout transfer

`atlas_relayout.py` copies existing prepared HD/remap pixels into an authoritative
map's native packing. It does not generate, resize, recolour or invent sprites.
It requires Pillow and NumPy. Map inputs and all output art remain outside Git.
Only single-page map atlases are supported; this does not add TerrainTypes to a
theatre library or change runtime sprite coverage.

The read-only command validates all sprite IDs, original filenames, palette
bytes, canvas, frame counts, selected source frames, timing metadata, frame
offsets and exact native indexed crop bytes. Both native and HD dimensions are
checked before any output write. Every nonempty target body and shadow must
match. A target empty shadow remains empty even when newer source preparation
contains an additional shadow; each excluded source-only shadow appears under
`discarded_unused_source_shadow`. Other empty-state mismatches fail.

```bash
python3 -B packages/ra2-assets/python/atlas_relayout.py \
  --source "$PREPARED_MAP" --target "$NATIVE_MAP" > "$VALIDATION_RECEIPT"
```

For a receipt with `direct_install_compatible: true`, the existing
`atlas_install.py map` path can install the prepared HD reference directly. When
packing differs, install the exact crop transfer into a separate farm:

```bash
python3 -B packages/ra2-assets/python/atlas_relayout.py \
  --source "$PREPARED_MAP" --target "$NATIVE_MAP" \
  --farm "$STAGING_FARM" --name "$MAP" > "$INSTALL_RECEIPT"
```

The farm must already expose the native target manifest. The installer only
fills an empty `spriteAtlasHd` reference, preserving all current sibling JSON
fields and every indexed file. It publishes pages with full SHA-256 content
names through `cache_farm.install_file`, then patches the reference under the
manifest lock. Source/target SHA-256s are rechecked before publication. Symlinked
farm directories and manifest entries are replaced through copy-on-write;
neither original input tree is writable through this path. Interrupted page
publication can leave unused content-addressed files, but cannot publish an
incomplete reference. No subsequent install overwrites an existing HD reference.

To undo this metadata install alone, remove only the `spriteAtlasHd` reference
recorded in the receipt with a locked `cache_farm.patch_json` callback after
checking that it still equals the receipt's reference. Keep unrelated JSON and
indexed files. Content-addressed pages can remain unreferenced; removing them is
optional only after checking no current reference uses them. Later art patches
that depend on the reference must be undone before removing it.

```bash
python3 -B -m pytest packages/ra2-assets/python/test_atlas_relayout.py \
  packages/ra2-assets/python/test_cache_farm.py \
  packages/ra2-assets/python/test_sprite_frame_patch.py -q
```

Synthetic tests prove byte-exact HD/remap body/shadow transfer, failure before
farm writes on native mismatch, preserved source and target trees, discarded
source-only shadows, and locked sibling preservation. These are headless checks;
rendered anchors, lighting, remap colours and tree shadow behavior need separate
live-game acceptance.
