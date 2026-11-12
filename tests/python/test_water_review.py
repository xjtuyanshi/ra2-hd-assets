"""Asset-free acceptance and native-FPS evidence checks. No game or browser is launched."""
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name):
    spec=importlib.util.spec_from_file_location(name, ROOT/'scripts/remaster/qa'/f'{name}.py')
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

class WaterReviewTests(unittest.TestCase):
    def test_gates_and_missing_spectrum(self):
        m=load('water_analyze')
        s={'hsvS':.2,'L':20,'Lstd':2,'p99_med':5,'highlight_frac':0,'spectrum':None,'motion_1_6':.1,'motion_1s':.3,'shore_step':10}
        self.assertEqual(m.gates(s,s)['anisotropy'],'UNVERIFIED')
        bad={**s,'hsvS':.36,'shore_step':-1,'motion_1s':2.1}
        for key in ['sat','shore','motion_1s']: self.assertEqual(m.gates(bad,s)[key],'FAIL')
        self.assertEqual(m.gates({**s,'hsvS':.35},s)['sat'],'PASS')

    def test_fast_mask_morph_matches_pillow_at_edges_and_large_radius(self):
        import numpy as np
        from PIL import Image, ImageFilter
        m=load('water_analyze')
        mask=np.random.default_rng(3).random((21,31))>.4
        for radius in [1,4,15]:
            for operation,filter_class in [('e',ImageFilter.MinFilter),('d',ImageFilter.MaxFilter)]:
                expected=np.asarray(Image.fromarray((mask*255).astype(np.uint8)).filter(filter_class(2*radius+1)))>127
                np.testing.assert_array_equal(m.mask_morph(mask,radius,operation),expected)

    def test_fps_rejects_host_fallback_gaps_and_short_windows(self):
        m=load('water_fps')
        rows=[{'kind':'speed','time':f'2026-11-12T00:01:{i:02d}Z','windowMs':5000,'logicFps':59,'logicSource':'game','targetFps':60,'hdShown':True} for i in range(0,60,5)]
        start=m.timestamp('2026-11-12T00:00:55Z'); end=m.timestamp('2026-11-12T00:02:00Z')
        self.assertEqual(len(m.extract(rows,start,end)),12)
        with self.assertRaises(ValueError): m.extract(rows[:-1],start,end)
        rows[2]['logicSource']='host'
        with self.assertRaises(ValueError): m.extract(rows,start,end)

if __name__=='__main__': unittest.main()
