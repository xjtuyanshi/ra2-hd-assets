/**
 * RA2/YR infantry art whose HD body pages carry no soft contact shadow of their own (game policy for the live view).
 *
 * The cinematic look draws the native infantry footprint at INFANTRY_SHADOW_SOFT_OPACITY (sprites.ts), calibrated on
 * conscripts: their HD body pages paint a soft contact shadow in the footprint's place and the two multiply. The
 * animal pages (sandbox review, fx=infantry with infantryShadow:0, B1 round 1) paint none, so under that opacity a dog
 * or a cow stands on the bare ground where the original draws a solid black shadow. Keyed by art image (the HD page's
 * owner), so types that share an image (YDOG = DOG, YADOG = ADOG) follow it.
 */
const BARE_HD_INFANTRY_IMAGES: ReadonlySet<string> = new Set([
  'DOG',
  'ADOG',
  'COW',
  'ALL',
  'CAML',
  'DNOA',
  'DNOB',
  'JOSH',
  'POLARB',
]);

/** True when the HD body page of this infantry art image has no contact shadow of its own. */
export function hdInfantryPageIsBare(image: string | undefined): boolean {
  return !!image && BARE_HD_INFANTRY_IMAGES.has(image.toUpperCase());
}
