"""Asset-free numerical QA regressions; visual review remains separate."""
from pathlib import Path
import tempfile
import unittest
import cv2
import numpy as np
from PIL import Image
import terrain_tile_qa as qa

class TerrainQaTests(unittest.TestCase):
    def reference(self):
        rng=np.random.default_rng(17)
        grain=cv2.GaussianBlur(rng.uniform(-8,8,(128,192)).astype(np.float32),(0,0),1)
        rgb=np.clip(np.array([115,126,98])+grain[...,None],0,255).astype(np.uint8)
        alpha=np.full((128,192),255,np.uint8);alpha[:10]=0
        return np.dstack([rgb,alpha]),np.zeros((128,192),np.uint8)
    def test_smoothing_is_rejected_without_hiding_it_in_colour_lock(self):
        ref,water=self.reference();raw=cv2.GaussianBlur(ref[...,:3],(0,0),3)
        _,report=qa.condition(ref,raw,water,alignment=False)
        self.assertLess(report['texture_gain'],1);self.assertFalse(report['numerical_pass'])
        self.assertFalse(report['accepted'])
    def test_gain_is_diagnostic_and_does_not_fabricate_visual_acceptance(self):
        ref,water=self.reference();rng=np.random.default_rng(11)
        raw=np.clip(ref[...,:3].astype(float)+rng.integers(-8,9,ref[...,:3].shape),0,255).astype(np.uint8)
        _,report=qa.condition(ref,raw,water,alignment=False)
        self.assertGreater(report['texture_gain'],1);self.assertTrue(report['numerical_pass'])
        self.assertFalse(report['accepted']);self.assertIn('PENDING',report['visual_status'])
    def test_water_and_alpha_are_exact_even_when_generator_invents_them(self):
        ref,water=self.reference();water[:,120:]=255
        raw=ref[...,:3].copy();raw[:10]=(240,20,5);raw[:,120:]=(0,255,255)
        result,report=qa.condition(ref,raw,water,alignment=False)
        np.testing.assert_array_equal(result[...,3],ref[...,3])
        np.testing.assert_array_equal(result[water>=128],ref[water>=128])
        np.testing.assert_array_equal(result[:10],ref[:10])
        self.assertTrue(report['protected_rgb_exact'])
    def test_mismatched_output_shape_is_rejected(self):
        ref,water=self.reference()
        with self.assertRaises(ValueError):qa.condition(ref,ref[:-1,:,:3],water,alignment=False)
    def test_water_only_region_has_no_false_texture_success(self):
        ref,water=self.reference();water[:]=255
        result,report=qa.condition(ref,np.zeros_like(ref[...,:3]),water,alignment=False)
        np.testing.assert_array_equal(result,ref)
        self.assertIsNone(report['texture_gain']);self.assertFalse(report['accepted'])

if __name__=='__main__':unittest.main()
