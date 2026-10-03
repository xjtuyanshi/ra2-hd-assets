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

    def coloured_scene(self):
        rgb=np.full((256,384,3),(135,139,133),np.uint8)
        cv2.rectangle(rgb,(34,21),(139,154),(103,137,81),-1)
        cv2.circle(rgb,(266,109),49,(164,105,81),-1)
        cv2.rectangle(rgb,(173,189),(350,235),(104,123,154),-1)
        return rgb

    def test_colour_boundaries_recover_registration_despite_new_grain(self):
        source=self.coloured_scene();rng=np.random.default_rng(12)
        raw=np.clip(source.astype(float)+rng.normal(0,12,source.shape),0,255).astype(np.uint8)
        raw=cv2.warpAffine(raw,np.array([[1,0,3],[0,1,-2]],np.float32),
                           (source.shape[1],source.shape[0]),borderMode=cv2.BORDER_REFLECT)
        fit=qa.colour_boundary_fit(source,raw,np.ones(source.shape[:2],np.float32))
        self.assertIsNotNone(fit)
        _,warp,evidence=fit
        np.testing.assert_allclose(warp[:,2],[3,-2],atol=.6)
        self.assertLess(evidence['channel_agreement_max'],1)
        restored=qa.sample_aligned(source,raw,np.ones(source.shape[:2],np.float32),warp)
        self.assertLess(np.abs(cv2.GaussianBlur(restored,(0,0),6).astype(float)
                               -cv2.GaussianBlur(source,(0,0),6)).mean(),1)

    def test_colour_boundaries_cannot_excuse_a_large_geometry_shift(self):
        source=self.coloured_scene()
        raw=cv2.warpAffine(source,np.array([[1,0,24],[0,1,0]],np.float32),
                           (source.shape[1],source.shape[0]),borderMode=cv2.BORDER_REFLECT)
        self.assertIsNone(qa.colour_boundary_fit(source,raw,np.ones(source.shape[:2],np.float32)))
        reference=np.dstack([source,np.full(source.shape[:2],255,np.uint8)])
        _,report=qa.condition(reference,raw,np.zeros(source.shape[:2],np.uint8))
        self.assertFalse(report['numerical_pass'])
        self.assertIn('registration needs repair',report['rejection_reasons'])

    def test_monochrome_texture_has_no_colour_registration_evidence(self):
        reference,_=self.reference()
        self.assertIsNone(qa.colour_boundary_fit(reference[...,:3],reference[...,:3],
                                                np.ones(reference.shape[:2],np.float32)))

if __name__=='__main__':unittest.main()
