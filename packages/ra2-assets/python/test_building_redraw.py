"""Asset-free buildings-v4 acceptance: python3 -B -m unittest test_building_redraw -v."""

import fcntl
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

import building_redraw as br
import sprite_normals


BODY, ANIM, DAMAGE, BUILDUP = 'building:TEST', 'anim:TEST_A', 'anim:TEST_AD', 'anim:TESTMK'


def synthetic_library(root):
    """Distinct atlas rects, unequal anchors, fractional alpha, paint and moving coverage."""
    d = root / '_library' / 'urban'
    d.mkdir(parents=True)
    idx = np.zeros((64, 128), np.uint8)
    palette = np.full((256, 3), 118, np.uint8)
    palette[40], palette[41] = (177, 147, 92), (63, 69, 48)
    ramp = np.array([[45 - i * 2, 100 - i * 5, 220 - i * 12] for i in range(16)], np.uint8)
    palette[16:32] = ramp
    sprites = {}
    for row, (sprite, count, w, h, ox, oy) in enumerate([
            (BODY, 3, 24, 20, -12, -16), (ANIM, 3, 12, 10, 2, -22),
            (DAMAGE, 3, 12, 10, 2, -22), (BUILDUP, 3, 24, 20, -12, -16)]):
        frames = []
        for k in range(count):
            x, y = k * 32, row * 16 if row != 3 else 42
            # Body and build-up use the left/right halves to avoid overlaps.
            if row == 0:
                y = 0
            elif row == 1:
                y = 24
            elif row == 2:
                y = 24
                x += 16
            tile = idx[y:y + h, x:x + w]
            tile[2:-2, 2:-2] = 40
            tile[4:8, 4:8] = 20
            if sprite in (ANIM, DAMAGE):
                tile[2:5, 2 + k:4 + k] = 41
                tile[6:8, 2:4] = 0 if k else 40
            elif sprite == BUILDUP and k < 2:
                tile[:8-k*3] = 0
            else:
                tile[12:15, 4:18] = 41
            frames.append(dict(rect=[x, y, w, h], offset=[ox, oy], page=0))
        sprites[sprite] = dict(palette='unit', remap=True, frames=frames)
    paint = np.repeat(np.repeat(((idx >= 16) & (idx < 32)).astype(np.uint8) * 255, 2, 0), 2, 1)
    rgba = np.empty((128, 256, 4), np.uint8)
    rgba[..., :3] = np.repeat(np.repeat(palette[idx], 2, 0), 2, 1)
    rgba[..., 3] = np.repeat(np.repeat((idx > 0).astype(np.uint8) * 255, 2, 0), 2, 1)
    grey = np.repeat(np.repeat(255 - 15 * (idx.astype(int) - 16), 2, 0), 2, 1)
    rgba[..., :3][paint > 0] = grey[paint > 0, None]
    rgba[4, 8, 3] = 97
    Image.fromarray(idx).save(d / 'index.png')
    Image.fromarray(palette[None]).save(d / 'palette.png')
    Image.fromarray(rgba).save(d / 'colour.png')
    Image.fromarray(paint).save(d / 'paint.png')
    data = dict(palettes={'unit': 'palette.png'}, spriteAtlases=[{'file': 'index.png'}],
                spriteAtlasesHd=[dict(file='colour.png', remap='paint.png', scale=2)], sprites=sprites,
                types={'TEST': dict(sprite=BODY, building=dict(layers=[dict(
                    key='ActiveAnim', sprite=ANIM, damagedSprite=DAMAGE,
                    anim=dict(start=0, loopStart=0, loopEnd=3))], buildup=BUILDUP))},
                colorSchemes=[dict(remap=ramp.tolist())], colorSchemesByName={'DarkBlue': 0})
    br.write_json(d / 'library.json', data)
    return data


class BuildingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='.tmp-building-', dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.data = synthetic_library(self.root)
        self.lib = br.Lib(root=self.root)
        self.work = self.root / 'work'
        self.patches = self.root / 'patches'
        self.parts = [f'{BODY}:0', f'{ANIM}:0']
        self.specs = {'TEST': dict(name='the synthetic factory', design='a steel hall', details=['rivets'],
                                   keep='the hall', colours='blue and bronze', style=None)}
        self.addCleanup(mock.patch.stopall)
        mock.patch('sys.stdout', new_callable=io.StringIO).start()

    def body_job(self, name='TEST_i', parts=None):
        c = br.comp2x(self.lib, parts or self.parts)
        d = self.work / name
        d.mkdir(parents=True)
        br.model_input(c, 4).save(d / 'input.png')
        br.write_json(d / 'layout.json', dict(name='TEST', kind='intact', parts=c['parts'],
                      origin=c['origin'], size1=c['size1'], factor=4, finish=dict(contrast=0)))
        shutil.copyfile(d / 'input.png', d / 'output.png')
        return d, c

    def decode(self, rgba, remap):
        k = np.clip((255 - rgba[..., 1].astype(float)) / 15, 0, 15)
        i = np.floor(k).astype(int)
        ramp = self.lib.house()
        rgb = ramp[i] + (ramp[np.minimum(i + 1, 15)] - ramp[i]) * (k - i)[..., None]
        return np.where((remap > 127)[..., None], rgb, rgba[..., :3])

    def test_comp2x_geometry_clipping_and_library_decode(self):
        c = br.comp2x(self.lib, self.parts)
        self.assertEqual(c['origin'], [-12, -22])
        self.assertEqual(c['size1'], [26, 26])
        self.assertEqual(c['rects'], [(0, 12, 48, 40), (28, 0, 24, 20)])
        f = self.lib.frame(BODY, 0)
        np.testing.assert_array_equal(f['hd'][f['paint2'] == 1, :3],
                                      np.tile(self.lib.house()[4], ((f['paint2'] == 1).sum(), 1)))
        crop = br.comp2x(self.lib, self.parts, box=(-8, -18, 8, 0))
        np.testing.assert_array_equal(crop['rgb'], c['rgb'][8:44, 8:40])
        im, origin = br.composite(c['frames'])
        self.assertEqual(origin, (-12, -22))
        self.assertEqual(im.shape, (26, 26, 3))
        # The map reader shares frame decode but selects house ramps from manifest houses.
        md = self.root / 'map'
        shutil.copytree(self.lib.dir, md)
        manifest = dict(sprites=self.data['sprites'], palettes=self.data['palettes'],
                        spriteAtlas=self.data['spriteAtlases'][0], spriteAtlasHd=self.data['spriteAtlasesHd'][0],
                        houses={'Player': {'remap': self.lib.house().tolist()}})
        br.write_json(md / 'manifest.json', manifest)
        mapped = br.MapLib('map', self.root)
        np.testing.assert_array_equal(mapped.frame(BODY, 0)['hd'], f['hd'])

    def test_finish_alpha_grey_ramp_and_unpainted_encoding(self):
        c = br.comp2x(self.lib, self.parts)
        rgba, remap, shown, final = br.finish(c, c['rgb'], contrast=0, lockL=0, lockab=0,
                                            fg=np.ones(c['a'].shape, bool))
        np.testing.assert_array_equal(rgba[..., 3], br.hr.to_u8(c['a'] * 255))
        paint = remap == 255
        self.assertTrue(paint.any())
        np.testing.assert_array_equal(rgba[..., 0][paint], rgba[..., 1][paint])
        np.testing.assert_array_equal(rgba[..., 1][paint], rgba[..., 2][paint])
        np.testing.assert_allclose(self.decode(rgba, remap)[paint], c['rgb'][paint], atol=1)
        untouched = (c['a'] > 0.02) & ~paint
        np.testing.assert_array_equal(rgba[..., :3][untouched], br.hr.to_u8(final)[untouched])

    def test_register_recovers_scale_and_shift(self):
        inp = np.full((200, 240, 3), 118, np.float32)
        cv2.rectangle(inp, (38, 48), (163, 146), (190, 80, 35), -1)
        cv2.circle(inp, (149, 64), 24, (40, 150, 220), -1)
        cv2.rectangle(inp, (60, 83), (113, 111), (22, 30, 42), -1)
        expected = (1.06, 4.0, 0.94, 7.0)
        raw = cv2.warpAffine(inp, np.array([[expected[0], 0, expected[1]], [0, expected[2], expected[3]]]),
                             (240, 200), flags=cv2.INTER_LINEAR, borderValue=(118, 118, 118))
        params, _ = br.register_out(inp, raw)
        np.testing.assert_allclose(np.array(params)[[0, 2]], np.array(expected)[[0, 2]], atol=0.006)
        np.testing.assert_allclose(np.array(params)[[1, 3]], np.array(expected)[[1, 3]], atol=0.6)

    def test_post_identity_and_split_patches(self):
        d, c = self.body_job()
        _, rgba, remap, shown = br.post(d, root=self.root)
        inside = cv2.erode((c['a'] == 1).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        self.assertLess(np.abs(shown[inside] - c['rgb'][inside]).mean(), 5)
        np.testing.assert_array_equal(rgba[..., 3], br.hr.to_u8(c['a'] * 255))
        br.body_patches(self.work, self.patches, [d.name], root=self.root)
        for sprite, k, rp, rm in br.split_box(self.lib, c, rgba, remap, {ANIM: [0, 1, 2]}):
            f = self.lib.frame(sprite, k)
            self.assertEqual(rp.shape, f['hd'].shape)
            np.testing.assert_array_equal(rp[..., 3], f['hd'][..., 3])
            self.assertTrue((rm[rp[..., 3] == 0] == 0).all())
            np.testing.assert_array_equal(br.read_image(self.patches / f'{br.patch_name(sprite, k)}.png'), rp)

    def test_split_refills_body_pixels_exposed_by_other_loop_frames(self):
        # Move the layer onto opaque body pixels, then remove it in the other loop frames.
        for f in self.lib.lib['sprites'][ANIM]['frames']:
            f['offset'] = [2, -12]
        hd, _ = self.lib.hd_page(0)
        for f in self.lib.lib['sprites'][ANIM]['frames'][1:]:
            x, y, w, h = f['rect']
            hd[2*y:2*(y+h), 2*x:2*(x+w), 3] = 0
        c = br.comp2x(self.lib, self.parts)
        rgba = np.full((*c['a'].shape, 4), 180, np.uint8)
        rgba[..., 3] = 255
        x, y, w, h = c['rects'][1]
        covered = c['frames'][1]['hd'][..., 3] > 0
        rgba[y:y+h, x:x+w, :3][covered] = 20
        split = br.split_box(self.lib, c, rgba, np.zeros(c['a'].shape, np.uint8), {ANIM: [0, 1, 2]})
        # Compare exactly those texels where the disappearing layer hid an opaque body.
        bx, by, bw, bh = c['rects'][0]
        cover_box = np.zeros(c['a'].shape, bool)
        cover_box[y:y+h, x:x+w] = covered
        exposed = cover_box[by:by+bh, bx:bx+bw] & (c['frames'][0]['hd'][..., 3] > 0)
        self.assertTrue(exposed.any())
        np.testing.assert_array_equal(split[0][2][..., :3][exposed],
                                      np.full((exposed.sum(), 3), 180, np.uint8))

    def test_body_rules_prompts_styles_and_damaged_ownership(self):
        layers = self.lib.lib['types']['TEST']['building']['layers']
        layers.append(dict(key='ActiveAnimTwo', sprite=BUILDUP, anim=dict(start=2)))
        self.assertEqual(br.idle_parts(self.lib, 'TEST', storage={'TEST'}), self.parts)
        self.assertEqual(br.idle_parts(self.lib, 'TEST')[-1], f'{BUILDUP}:2')
        self.assertEqual(br.idle_parts(self.lib, 'TEST', True, {'TEST'})[1], f'{DAMAGE}:0')
        self.assertEqual([br.factor({'size1': [n, n]}) for n in (10, 128, 1000)], [10, 8, 4])
        style = self.root / 'style.png'
        Image.new('RGB', (5, 7), 'blue').save(style)
        self.specs['TEST']['style'] = style.name
        d = br.body_make('intact', 'TEST', self.lib, self.specs, self.work, style_dir=self.root, storage={'TEST'})
        self.assertEqual(br.read_image(d / 'style_reference.png').shape, (21, 15, 3))
        self.assertIn('the synthetic factory', (d / 'prompt.txt').read_text())
        shutil.copy(d / 'input.png', d / 'output.png')
        damaged = br.body_make('damaged', 'TEST', self.lib, self.specs, self.work, storage={'TEST'})
        self.assertTrue((damaged / 'intact_remaster.png').exists())
        self.assertIn(f'{DAMAGE}:0', br.read_json(damaged / 'layout.json')['parts'])
        # A layer with no damaged variant stays owned by the intact patch.
        lay = br.read_json(damaged / 'layout.json')
        lay['parts'][1] = f'{ANIM}:0'
        br.write_json(damaged / 'layout.json', lay)
        shutil.copy(damaged / 'input.png', damaged / 'output.png')
        br.post(damaged, root=self.root)
        br.body_patches(self.work, self.patches, [damaged.name], root=self.root)
        self.assertTrue((self.patches / 'building_TEST#1.png').exists())
        self.assertFalse((self.patches / 'anim_TEST_A#0.png').exists())

    def test_compose_rects_symlinks_record_and_sequential_merge(self):
        variant = self.root / 'variant'
        variant.mkdir()
        for source in self.lib.dir.iterdir():
            (variant / source.name).symlink_to(source)
        before = {p.name: p.read_bytes() for p in self.lib.dir.iterdir()}
        expected_colour = br.read_image(self.lib.dir / 'colour.png')
        expected_paint = br.read_image(self.lib.dir / 'paint.png')
        for k, value in ((0, 37), (1, 203)):
            pdir = self.root / f'p{k}'
            frame = self.data['sprites'][BODY]['frames'][k]
            x, y, w, h = frame['rect']
            rgba = np.full((2*h, 2*w, 4), value, np.uint8)
            remap = np.full((2*h, 2*w), value, np.uint8)
            br.save_patch(BODY, k, rgba, remap, patches=pdir)
            br.compose(variant, pdir)
            expected_colour[2*y:2*(y+h), 2*x:2*(x+w)] = rgba
            expected_paint[2*y:2*(y+h), 2*x:2*(x+w)] = remap
            np.testing.assert_array_equal(br.read_image(variant / 'colour.png'), expected_colour)
            np.testing.assert_array_equal(br.read_image(variant / 'paint.png'), expected_paint)
        self.assertFalse((variant / 'colour.png').is_symlink())
        self.assertFalse((variant / 'paint.png').is_symlink())
        self.assertEqual(br.read_json(variant / 'l4_frames_bldg.json'), {BODY: [0, 1]})
        for name, content in before.items():
            self.assertEqual((self.lib.dir / name).read_bytes(), content)
        br.compose(variant, self.root / 'p0', only=['anim:'], record='custom.json')
        self.assertEqual(br.read_json(variant / 'custom.json'), {})

    def test_compose_lock_covers_page_reads_and_record_writes(self):
        p = self.lib.dir
        rgba = np.full((40, 48, 4), 66, np.uint8)
        br.save_patch(BODY, 0, rgba, rgba[..., 0], patches=self.patches)
        original = br.read_image(p / 'colour.png')
        with (p / '.compose.lock').open('a') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            proc = subprocess.Popen([sys.executable, '-B', br.__file__, 'compose', '--library', str(p),
                                     '--patches', str(self.patches)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.addCleanup(lambda: proc.kill() if proc.poll() is None else None)
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=0.5)
            # A different writer changes another rect while holding the lock.
            original[0:4, 220:224] = 199
            Image.fromarray(original).save(p / 'colour.png')
            br.write_json(p / 'l4_frames_bldg.json', {'other:sprite': [9]})
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        stdout, stderr = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 0, stderr)
        np.testing.assert_array_equal(br.read_image(p / 'colour.png')[0:4, 220:224], original[0:4, 220:224])
        self.assertEqual(br.read_json(p / 'l4_frames_bldg.json'), {BODY: [0], 'other:sprite': [9]})

    def test_anim_identity_roundtrip_and_multi(self):
        d, _ = self.body_job()
        br.post(d, root=self.root)
        sheet = br.anim_make('TEST_A', d.name, ANIM, [0, 1, 2], 2, 4, 'the vane', work=self.work, root=self.root)
        layout = br.read_json(sheet / 'layout.json')
        self.assertEqual(layout['region'], [-4, -28, 20, -6])
        self.assertEqual(layout['cells'][1]['box'], [128, 0, 96, 88])
        shutil.copy(sheet / 'input.png', sheet / 'output.png')
        br.anim_post(sheet.name, work=self.work, patches=self.patches, root=self.root)
        for k in range(3):
            rgba = br.read_image(self.patches / f'anim_TEST_A#{k}.png')
            rm = br.read_image(self.patches / f'anim_TEST_A#{k}-remap.png')
            f = self.lib.frame(ANIM, k)
            np.testing.assert_array_equal(rgba[..., 3], f['hd'][..., 3])
            inside = cv2.erode((rgba[..., 3] == 255).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
            self.assertLess(np.abs(self.decode(rgba, rm)[inside] - f['hd'][..., :3][inside]).mean(), 10)
        code = br.main(['anim', 'make_multi', 'multi', d.name, ANIM, f'{ANIM}:0,{DAMAGE}:1', '2', '4', 'the vane',
                        '--work', str(self.work), '--root', str(self.root)])
        self.assertEqual(code, 0)
        multi = self.work / 'multi'
        shutil.copy(multi / 'input.png', multi / 'output.png')
        br.anim_post('multi', work=self.work, patches=self.patches, root=self.root)
        self.assertTrue((self.patches / 'anim_TEST_AD#1.png').exists())

    def test_anim_static_pixels_keep_body_redraw(self):
        d, _ = self.body_job()
        br.post(d, root=self.root)
        sheet = br.anim_make('static', d.name, ANIM, [0], 1, 4, 'nothing', work=self.work, root=self.root)
        shutil.copy(sheet / 'input.png', sheet / 'output.png')
        br.anim_post(sheet.name, work=self.work, patches=self.patches, root=self.root)
        original = br.read_image(self.patches / 'anim_TEST_A#0.png')
        image = br.read_image(sheet / 'input.png')
        image[...] = [30, 180, 60]
        Image.fromarray(image).save(sheet / 'output.png')
        br.anim_post(sheet.name, work=self.work, patches=self.patches, root=self.root)
        np.testing.assert_array_equal(br.read_image(self.patches / 'anim_TEST_A#0.png'), original)

    def test_buildup_make_post_has_no_static_body_blend(self):
        d, _ = self.body_job()
        br.post(d, root=self.root)
        br.main(['buildup', 'make', 'TEST', d.name, '0-2', '2', '4', '--root', str(self.root), '--work', str(self.work)])
        sheet = self.work / 'TEST_MK'
        lay = br.read_json(sheet / 'layout.json')
        self.assertFalse(np.load(sheet / 'static_none.npy').any())
        self.assertTrue(lay['buildup'])
        self.assertIn('BUILD-UP ANIMATION', (sheet / 'prompt.txt').read_text())
        shutil.copy(sheet / 'input.png', sheet / 'output.png')
        br.anim_post(sheet.name, work=self.work, patches=self.patches, root=self.root, buildup=True)
        before = br.read_image(self.patches / 'anim_TESTMK#2.png')
        reg = br.read_image(d / 'post/reg4x.png')
        reg[:] = [240, 30, 40]
        Image.fromarray(reg).save(d / 'post/reg4x.png')
        br.anim_post(sheet.name, work=self.work, patches=self.patches, root=self.root, buildup=True)
        np.testing.assert_array_equal(br.read_image(self.patches / 'anim_TESTMK#2.png'), before)

    def test_pack_wrap_refs_identity_split_and_raw_precedence(self):
        jobs = []
        for k, size in enumerate(((40, 30), (30, 25), (60, 35))):
            d = self.work / str(k)
            d.mkdir(parents=True)
            a = np.random.default_rng(k).integers(0, 256, (*size[::-1], 3), dtype=np.uint8)
            Image.fromarray(a).save(d / 'input.png')
            br.write_json(d / 'layout.json', {'factor': 4})
            (d / 'cell.txt').write_text(f'part {k}')
            jobs.append(d)
        prompt = self.root / 'prompt.txt'
        prompt.write_text('Redraw {n} cells:\n{cells}\nKeep {literal}.')
        pack = self.root / 'pack'
        br.main(['pack', 'make', str(pack), '--prompt', str(prompt), '--max-width', '120',
                 '--ref', f'ref.png={jobs[0] / "input.png"}', *map(str, jobs)])
        lay = br.read_json(pack / 'layout.json')
        self.assertEqual([c['box'] for c in lay['cells']], [[0, 0, 40, 30], [88, 0, 30, 25], [0, 78, 60, 35]])
        self.assertIn('cell 3 (row 2, column 1): part 2', (pack / 'prompt.txt').read_text())
        self.assertEqual((pack / 'ref.png').read_bytes(), (jobs[0] / 'input.png').read_bytes())
        shutil.copy(pack / 'input.png', pack / 'output.png')
        self.assertEqual(br.pack_split(pack), 3)
        for d in jobs:
            np.testing.assert_array_equal(br.read_image(d / 'input.png'), br.read_image(d / 'output.png'))
            self.assertEqual((d / 'packed_from.txt').read_text().strip(), str(pack))
        Image.new('RGB', (10, 10), (17, 28, 39)).save(pack / 'raw.png')
        br.pack_split(pack)
        np.testing.assert_array_equal(br.read_image(jobs[0] / 'output.png')[0, 0], [17, 28, 39])
        br.write_json(jobs[1] / 'layout.json', {'factor': 8})
        with self.assertRaisesRegex(ValueError, 'share one factor'):
            br.pack_make(self.root / 'bad', prompt, jobs)

    def test_normals_job_assist_and_sibling_geometry(self):
        d, _ = self.body_job()
        br.post(d, root=self.root)
        br.normals_job(self.work, [d.name])
        nd = self.work / f'{d.name}_N'
        out = br.load(d / 'output.png')
        mask = br.hr.foreground(out, 10)
        normal = np.zeros(out.shape, np.uint8)
        normal[mask] = [128, 238, 191]
        Image.fromarray(normal).save(nd / 'output.png')
        assist = self.root / 'assist'
        br.normals_assist(self.work, assist, [d.name], root=self.root, extra={ANIM: [DAMAGE]})
        for sprite, count in ((BODY, 1), (ANIM, 3), (DAMAGE, 3)):
            for k in range(count):
                path = assist / f'{br.patch_name(sprite, k)}.png'
                image = br.read_image(path)
                alpha = self.lib.frame(sprite, k)['hd'][..., 3] / 255
                self.assertEqual(image.shape[:2], alpha.shape)
                if sprite == BODY:
                    self.assertTrue((image[alpha == 0] == 0).all())
                inside = cv2.erode((alpha > 0.9).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
                vec = image[inside].astype(float) / 127.5 - 1
                np.testing.assert_allclose(np.linalg.norm(vec, axis=-1), 1, atol=0.016)
                self.assertIsNotNone(sprite_normals.load_assist(path, alpha))

    def test_cli_no_assets_and_environment_root(self):
        result = subprocess.run([sys.executable, '-B', br.__file__, '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('normals-assist', result.stdout)
        with mock.patch.dict(os.environ, {'HD_CACHE_DIR': str(self.root)}):
            self.assertEqual(br.Lib().dir, self.lib.dir)


class TransferTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='.tmp-xfer-', dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.directory = self.root / '_library' / 'snow'
        self.directory.mkdir(parents=True)
        self.patches = self.root / 'patches'
        self.indices = np.full((4, 60), 50, np.uint8)
        self.indices[:, :10] = 40
        self.indices[:, 10:20] = 42
        for x, value in ((20, 40), (30, 40), (40, 42), (50, 40)):
            self.indices[:, x:x+4] = value
        Image.fromarray(self.indices).save(self.directory / 'index.png')
        baseline = np.full((8, 120, 4), [20, 30, 40, 255], np.uint8)
        baseline[0, 40, 3] = 97
        Image.fromarray(baseline).save(self.directory / 'colour.png')
        Image.fromarray(np.zeros((8, 120), np.uint8)).save(self.directory / 'paint.png')
        Image.new('RGB', (256, 1), 'grey').save(self.directory / 'palette.png')
        sprites = {}
        for sprite, positions in ((BODY, [0, 10]), (ANIM, [20, 30]), (DAMAGE, [40]), (BUILDUP, [50])):
            sprites[sprite] = dict(palette='unit', frames=[
                dict(rect=[x, 0, 10, 4], offset=[-7, -3], page=0) for x in positions])
        self.data = dict(palettes={'unit': 'palette.png'}, sprites=sprites,
                         spriteAtlases=[dict(file='index.png')],
                         spriteAtlasesHd=[dict(file='colour.png', remap='paint.png')],
                         types={'TEST': dict(sprite=BODY, building=dict(buildup=BUILDUP, layers=[
                             dict(key='BuildAnim', sprite=ANIM, damagedSprite=DAMAGE, anim=dict(start=0))]))})
        br.write_json(self.directory / 'library.json', self.data)

    def patch(self, sprite, frame, colour, tag='model:accepted'):
        rgba = np.full((8, 20, 4), [*colour, 255], np.uint8)
        br.save_patch(sprite, frame, rgba, np.zeros((8, 20), np.uint8), tag, patches=self.patches)
        return rgba

    def cli(self, command, *selectors, extra=()):
        result = subprocess.run([sys.executable, '-B', br.__file__, command, '--library-root', str(self.root),
                                 '--theater', 'snow', '--patches', str(self.patches), *extra, *selectors],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_xfer_states_copy_matching_indices_keep_baseline_and_model_patch(self):
        self.patch(BODY, 0, (210, 90, 30))
        self.patch(BODY, 1, (40, 180, 210))
        self.patch(ANIM, 1, (99, 19, 201))
        before = {p.name: p.read_bytes() for p in self.patches.iterdir()}
        self.cli('xfer', 'TEST')
        for sprite, state, colour in ((ANIM, 'i', (210, 90, 30)), (DAMAGE, 'd', (40, 180, 210)),
                                       (BUILDUP, 'mk', (210, 90, 30))):
            name = br.patch_name(sprite, 0)
            output = br.read_image(self.patches / f'{name}.png')
            np.testing.assert_array_equal(output[4, 2, :3], colour)
            # Beyond the feather's immediate rim, differing indices retain baseline bytes.
            np.testing.assert_array_equal(output[:, 12:, :3], np.full((8, 8, 3), [20, 30, 40], np.uint8))
            original = br.Xfer(br.Lib('snow', self.root), self.patches).raw(sprite, 0)[1]
            np.testing.assert_array_equal(output[..., 3], original[..., 3])
            self.assertEqual((self.patches / f'{name}.src').read_text(), f'xfer:TEST_{state}')
        for name, content in before.items():
            self.assertEqual((self.patches / name).read_bytes(), content)
        # Generated transfers may be refreshed, but accepted model files stay protected.
        self.patch(BODY, 0, (80, 210, 30))
        self.cli('xfer', 'TEST:i')
        np.testing.assert_array_equal(br.read_image(self.patches / 'anim_TEST_A#0.png')[4, 2, :3], [80, 210, 30])
        self.assertEqual((self.patches / 'anim_TEST_A#1.png').read_bytes(), before['anim_TEST_A#1.png'])

    def test_explicit_parts_override_and_missing_provenance_protects_patch(self):
        self.patch(BODY, 1, (40, 180, 210))
        self.indices[:, 20:24] = 42
        Image.fromarray(self.indices).save(self.directory / 'index.png')
        self.patch(ANIM, 1, (201, 20, 40), tag='')
        protected = (self.patches / 'anim_TEST_A#1.png').read_bytes()
        override = self.root / 'parts.json'
        br.write_json(override, {'TEST:i': [f'{BODY}:1']})
        self.cli('xfer', 'TEST:i', extra=('--parts', str(override)))
        np.testing.assert_array_equal(br.read_image(self.patches / 'anim_TEST_A#0.png')[4, 2, :3], [40, 180, 210])
        self.assertEqual((self.patches / 'anim_TEST_A#1.png').read_bytes(), protected)

    def test_remap_codes_are_copied_without_feathering(self):
        self.patch(BODY, 0, (195, 195, 195))
        Image.fromarray(np.full((8, 20), 255, np.uint8)).save(self.patches / 'building_TEST#0-remap.png')
        self.cli('xfer', 'TEST:i')
        output = br.read_image(self.patches / 'anim_TEST_A#0.png')
        remap = br.read_image(self.patches / 'anim_TEST_A#0-remap.png')
        np.testing.assert_array_equal(output[:, :8, :3], np.full((8, 8, 3), 195, np.uint8))
        np.testing.assert_array_equal(remap[:, :8], np.full((8, 8), 255, np.uint8))
        np.testing.assert_array_equal(remap[:, 8:], 0)

    def test_transfer_idle_rules_include_bib_idle_two_and_only_first_super(self):
        lib = br.Lib('snow', self.root)
        lib.lib['sprites']['bib:TEST'] = lib.lib['sprites'][BODY]
        building = lib.lib['types']['TEST']['building']
        building['bib'] = 'bib:TEST'
        building['layers'] = [dict(key=key, sprite=sprite, anim=dict(start=0)) for key, sprite in (
            ('IdleAnimTwo', ANIM), ('SuperAnim', DAMAGE), ('SuperAnim', BUILDUP))]
        # Flat buildings may have an empty body; their bib and layers form the reference.
        lib.lib['sprites'][BODY]['frames'][0]['rect'][2] = 0
        self.assertEqual(br.idle_parts(lib, 'TEST'), [f'{BODY}:0'])
        self.assertEqual(br.idle_parts(lib, 'TEST', include_auxiliary=True),
                         ['bib:TEST:0', f'{ANIM}:0', f'{DAMAGE}:0'])
        self.assertEqual(br.idle_parts(lib, 'TEST', damaged=True, include_auxiliary=True),
                         ['bib:TEST:1', f'{BODY}:1', f'{ANIM}:0', f'{DAMAGE}:0'])

    def test_damaged_loop_takes_sheet_drawn_intact_frames_only(self):
        self.indices[:, 40:44] = 40  # damaged frame 0 shares the intact frame's 1x indices
        Image.fromarray(self.indices).save(self.directory / 'index.png')

        def run():
            result = subprocess.run([sys.executable, '-B', br.__file__, 'dmg-xfer', '--library-root', str(self.root),
                                     '--theater', 'snow', '--patches', str(self.patches), f'{ANIM},{DAMAGE}'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

        self.patch(ANIM, 0, (12, 200, 90), tag='model:accepted')  # not from a sheet: no transfer
        self.assertIn(f'-> {DAMAGE} 0', run())
        self.patch(ANIM, 0, (12, 200, 90), tag='sheet A_TEST_A')
        self.assertIn(f'-> {DAMAGE} 1', run())
        out = br.read_image(self.patches / 'anim_TEST_AD#0.png')
        np.testing.assert_array_equal(out[4, 2, :3], [12, 200, 90])
        self.assertEqual((self.patches / 'anim_TEST_AD#0.src').read_text(), f'xfer:sheet {ANIM}')
        protected = self.patch(DAMAGE, 0, (5, 6, 7), tag='sheet A_TEST_AD')
        self.assertIn(f'-> {DAMAGE} 0', run())
        np.testing.assert_array_equal(br.read_image(self.patches / 'anim_TEST_AD#0.png'), protected)

    def test_index_paint_encodes_remap_range_texels_once(self):
        self.indices[:, 2:5] = 20  # house paint indices inside the body's first frame
        Image.fromarray(self.indices).save(self.directory / 'index.png')
        palette = np.full((1, 256, 3), 128, np.uint8)
        palette[0, 16:32] = [[250 - 12 * i, 40, 30] for i in range(16)]
        Image.fromarray(palette).save(self.directory / 'palette.png')
        self.patch(BODY, 0, (180, 40, 30))

        def run():
            result = subprocess.run([sys.executable, '-B', br.__file__, 'index-paint', '--library-root', str(self.root),
                                     '--theater', 'snow', '--patches', str(self.patches), BODY],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

        self.assertIn('paint texels 80', run())  # 6 index columns plus a 2-texel red fringe on both sides
        rgba = br.read_image(self.patches / 'building_TEST#0.png')
        remap = br.read_image(self.patches / 'building_TEST#0-remap.png', 'L')
        self.assertTrue((remap[:, 2:12] == 255).all())
        self.assertTrue((remap[:, :2] == 0).all() and (remap[:, 12:] == 0).all())
        self.assertTrue((rgba[:, 2:12, 0] == rgba[:, 2:12, 1]).all())  # grey-ramp encoded
        np.testing.assert_array_equal(rgba[:, 12, :3], np.tile([180, 40, 30], (8, 1)))
        self.assertIn('paint texels 0', run())

    def test_restore_paint_hue_recolours_violet_drift_on_design_paint_only(self):
        design = np.full((40, 40, 3), 118, np.uint8)
        design[10:30, 10:20] = (200, 30, 30)
        redraw = np.full((80, 80, 3), 118, np.uint8)
        redraw[20:60, 20:40] = (110, 70, 190)  # violet drift on the paint
        redraw[20:60, 60:75] = (40, 90, 220)  # genuine blue elsewhere stays
        rgb, count = br.restore_paint_hue(design, redraw, 38)
        self.assertGreater(count, 600)
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
        hue = np.degrees(np.arctan2(lab[40, 30, 2] - 128, lab[40, 30, 1] - 128))
        self.assertLess(abs(hue - 38), 12)
        self.assertGreater(rgb[40, 30, 0], rgb[40, 30, 2])
        np.testing.assert_array_equal(rgb[40, 65], redraw[40, 65])
        job = self.root / 'job'
        job.mkdir()
        Image.fromarray(design).save(job / 'input.png')
        Image.fromarray(redraw).save(job / 'raw.png')
        self.assertEqual(br.fix_sheet_hue(job), count)
        np.testing.assert_array_equal(br.read_image(job / 'raw_prefix.png', 'RGB'), redraw)
        self.assertEqual(br.fix_sheet_hue(job), count)  # idempotent: always restarts from the backup

    def test_walls_frame_17_takes_piece_1_and_keeps_model_damage(self):
        sprite = 'building:WALL'
        self.data['sprites'][sprite] = dict(palette='unit', frames=[
            dict(rect=[0, 0, 10, 4], offset=[-7, -3], page=0) for _ in range(18)])
        self.data['types']['WALL'] = dict(sprite=sprite)
        br.write_json(self.directory / 'library.json', self.data)
        self.patch(sprite, 0, (210, 90, 30))
        piece = self.patch(sprite, 1, (40, 180, 210))
        self.patch(sprite, 16, (99, 19, 201))
        protected = (self.patches / 'building_WALL#16.png').read_bytes()
        self.cli('walls-xfer', 'WALL')
        np.testing.assert_array_equal(br.read_image(self.patches / 'building_WALL#17.png'), piece)
        self.assertEqual((self.patches / 'building_WALL#17.src').read_text(), 'xfer:WALL_wall')
        self.assertEqual((self.patches / 'building_WALL#16.png').read_bytes(), protected)


if __name__ == '__main__':
    unittest.main()


class DeltaTransferTests(unittest.TestCase):
    def test_colour_cycle_keeps_redraw_detail_shifted_by_palette_delta(self):
        class FakeLib:
            pal = {'unit': np.stack([np.arange(256)] * 3, 1).astype(np.float32)}
            lib = {'sprites': {'anim:X': {'palette': 'unit'}}}
        x = br.Xfer(FakeLib(), '.', delta=True)
        rid = np.full((8, 8), 100, np.int32); idx = rid.copy(); idx[2:6, 2:6] = 160
        changed = x.colour_changed('anim:X', idx, rid, np.ones((8, 8), bool), idx == rid)
        self.assertTrue(changed[3, 3]); self.assertFalse(changed[0, 0])
        redraw = np.zeros((16, 16, 3), np.float32) + 100; redraw[::2, ::2] = 140  # invented detail
        out = x.shift_colour('anim:X', redraw, idx, rid, changed)
        self.assertGreater(out[7, 7].mean(), redraw[7, 7].mean() + 30)   # brighter where the index got brighter
        self.assertGreater(abs(out[6, 6].mean() - out[7, 7].mean()), 10)  # detail pattern survives
        self.assertTrue(np.allclose(out[0, 0], redraw[0, 0]))            # untouched outside the change
        moved = rid.copy(); moved[:, :4] = 0                              # silhouette change: no delta mode
        self.assertIsNone(x.colour_changed('anim:X', idx, moved, np.ones((8, 8), bool), idx == moved))
