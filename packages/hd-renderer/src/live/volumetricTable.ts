import { VOLUMETRIC_BLAST_PRESETS } from '../volumetricBlasts';

/** Native art policy: radius as a multiple of the visible art's half-width. */
export const VOLUMETRIC_ANIMS: Record<string, { preset: keyof typeof VOLUMETRIC_BLAST_PRESETS; size: number }> = {
  EXPLOLRG: { preset: 'fireball', size: 0.75 },
  EXPLOMED: { preset: 'fireball', size: 0.75 },
  EXPLOSML: { preset: 'fireball', size: 0.75 },
  S_BANG48: { preset: 'fireball', size: 0.75 },
  S_BANG34: { preset: 'fireball', size: 0.75 },
  S_CLSN58: { preset: 'fireball', size: 0.75 },
  TWLT070: { preset: 'mushroom', size: 0.75 },
  TWLT100: { preset: 'mushroom', size: 0.75 },
  TWLT050: { preset: 'mushroom', size: 0.75 },
  BRRLEXP1: { preset: 'groundBurst', size: 0.75 },
  BRRLEXP2: { preset: 'groundBurst', size: 0.75 },
  S_TUMU60: { preset: 'column', size: 0.75 },
  S_BRNL58: { preset: 'oilBurn', size: 0.75 },
  APOCEXP: { preset: 'fireball', size: 0.75 },
  VTEXPLOD: { preset: 'fireball', size: 0.75 },
};
