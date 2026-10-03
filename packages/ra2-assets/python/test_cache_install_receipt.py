import json
from pathlib import Path
import tempfile
import unittest

import cache_farm
import cache_install_receipt as receipts


class ReceiptTests(unittest.TestCase):
    def test_undo_realized_farm_without_writing_base_and_keep_later_json_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base, farm = root / 'base', root / 'farm'
            (base / 'map').mkdir(parents=True)
            (base / 'map' / 'manifest.json').write_text('{"original":1,"terrain":"old"}')
            (base / 'map' / 'page.png').write_bytes(b'base')
            farm.mkdir()
            (farm / 'map').symlink_to(base / 'map')
            receipt = root / 'receipts' / 'terrain.json'
            receipts.begin(farm, receipt, ['map'])
            cache_farm.patch_json(farm, 'map/manifest.json', lambda d: d.update(terrain='new'))
            new = root / 'new.png'
            new.write_bytes(b'new')
            cache_farm.install_file(farm, 'map/page.png', new)
            self.assertEqual(receipts.finish(receipt), 2)
            cache_farm.patch_json(farm, 'map/manifest.json', lambda d: d.update(tree='later'))
            receipts.undo(receipt)
            self.assertEqual(json.loads((farm / 'map/manifest.json').read_text()),
                             {'original': 1, 'terrain': 'old', 'tree': 'later'})
            self.assertEqual((farm / 'map/page.png').read_bytes(), b'base')
            self.assertEqual((base / 'map/manifest.json').read_text(), '{"original":1,"terrain":"old"}')
            self.assertEqual((base / 'map/page.png').read_bytes(), b'base')

    def test_conflicting_later_binary_change_aborts_all_rollback_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            farm = root / 'farm'
            farm.mkdir()
            (farm / 'a.json').write_text('{"x":1}')
            (farm / 'b.png').write_bytes(b'old')
            receipt = root / 'receipt.json'
            receipts.begin(farm, receipt, ['.'])
            cache_farm.patch_json(farm, 'a.json', lambda d: d.update(x=2))
            source = root / 'new.png'
            source.write_bytes(b'new')
            cache_farm.install_file(farm, 'b.png', source)
            receipts.finish(receipt)
            source.write_bytes(b'later')
            with self.assertRaisesRegex(ValueError, 'later file edit'):
                receipts.undo(receipt)
            self.assertEqual(json.loads((farm / 'a.json').read_text()), {'x': 2})

    def test_reverse_json_does_not_lose_sibling_keys_and_refuses_conflicting_key(self):
        self.assertEqual(receipts.reverse_json({'a': 2, 'sibling': 3}, {'a': 1}, {'a': 2}),
                         {'a': 1, 'sibling': 3})
        with self.assertRaisesRegex(ValueError, 'root.a'):
            receipts.reverse_json({'a': 4}, {'a': 1}, {'a': 2})

    def test_new_json_nested_key_undo_preserves_later_sibling(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            farm = root / 'farm'
            farm.mkdir()
            receipt = root / 'receipt.json'
            receipts.begin(farm, receipt, ['.'])
            cache_farm.patch_json(farm, 'data.json', lambda d: d.update(layer={'ours': 1}), default={})
            receipts.finish(receipt)
            cache_farm.patch_json(farm, 'data.json', lambda d: d['layer'].update(sibling=2))
            receipts.undo(receipt)
            self.assertEqual(json.loads((farm / 'data.json').read_text()), {'layer': {'sibling': 2}})


if __name__ == '__main__':
    unittest.main()
