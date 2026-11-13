"""Asset-free acceptance-policy tests; no browser or game footage is substituted."""
import unittest
from water_analyze import gates, LOOKS, LABELS


class ClearPolicyTest(unittest.TestCase):
    def sample(self):
        return dict(hsvS=.5, L=30, Lstd=3, p99_med=8, highlight_frac=.015,
                    spectrum=dict(anisotropy=.3, wavelength_gpx=4),
                    motion_1_6=.3, motion_1s=1.2, shore_step=10)

    def test_modern_candidate_uses_absolute_saturation_and_preserves_coast_gate(self):
        original = self.sample() | dict(hsvS=.1, L=18)
        result = gates(self.sample(), original, 'clear')
        self.assertTrue(all(value == 'PASS' for value in result.values()))
        self.assertNotIn('mean_L', result)
        for field, value, gate in [('hsvS', .56, 'sat'), ('highlight_frac', .021, 'highlights'),
                                   ('motion_1s', 1.51, 'motion_1s'), ('shore_step', -1, 'shore')]:
            self.assertEqual(gates(self.sample() | {field: value}, original, 'clear')[gate], 'FAIL')
        self.assertEqual(gates(self.sample() | dict(spectrum=dict(anisotropy=.36, wavelength_gpx=4)), original, 'clear')['anisotropy'], 'FAIL')
        self.assertEqual(gates(self.sample() | dict(spectrum=None), original, 'clear')['anisotropy'], 'UNVERIFIED')
        self.assertEqual(gates(self.sample(), original, 'muted')['mean_L'], 'FAIL')

    def test_capture_and_analysis_have_the_same_four_looks(self):
        import json
        import subprocess
        from pathlib import Path
        script = Path(__file__).with_name('water_boards.mjs').as_uri()
        actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
            f'import {{looks}} from {json.dumps(script)}; console.log(JSON.stringify(looks))']))
        self.assertEqual(actual, LOOKS)
        self.assertEqual(len(LABELS), len(LOOKS))


if __name__ == '__main__':
    unittest.main()
