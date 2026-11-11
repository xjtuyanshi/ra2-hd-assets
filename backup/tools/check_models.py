#!/usr/bin/env python3
"""Offline load check for the diffusion models, run with the diffusion venv:

  gameres/tools/diffusion/.venv/bin/python -I backup/tools/check_models.py gameres/tools/diffusion/models

Loads the same three components the same way packages/ra2-assets/python/rematerialize.py
does (local files only, safetensors, fp16 variant where present), without running any
diffusion. Prints "models OK (mps=True)" on success. Takes about a minute and ~10 GB RAM.
"""
import os, sys
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import torch
from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetImg2ImgPipeline

models = Path(sys.argv[1])
common = {"torch_dtype": torch.float16, "local_files_only": True, "use_safetensors": True}


def variant(folder):
    return {"variant": "fp16"} if any(folder.glob("*.fp16.safetensors")) else {}


vae = AutoencoderKL.from_pretrained(models / "sdxl-vae-fp16-fix", force_upcast=False, **common,
                                    **variant(models / "sdxl-vae-fp16-fix"))
controlnet = ControlNetModel.from_pretrained(models / "controlnet-tile-sdxl", **common,
                                             **variant(models / "controlnet-tile-sdxl"))
pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
    models / "sdxl-base", variant="fp16", vae=vae, controlnet=controlnet, add_watermarker=False, **common)
n = sum(p.numel() for p in pipe.unet.parameters())
print(f"unet parameters: {n/1e9:.2f} B; controlnet: {sum(p.numel() for p in controlnet.parameters())/1e9:.2f} B")
print(f"models OK (mps={torch.backends.mps.is_available()})")
