import { Color, DirectionalLight, HemisphereLight, Object3D, Vector3 } from 'three/webgpu';
import type { AtmosphereProfile } from './contract';

/** One key of the day cycle: sun/sky colours and intensities in linear space. */
export interface LightKey {
  hour: number;
  sun: Color;
  sunIntensity: number;
  /** Sun elevation in degrees; azimuth stays fixed at the original screen-upper-left for readability. */
  elevation: number;
  skyZenith: Color;
  skyHorizon: Color;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  exposure: number;
  /** 0 = day, 1 = night: drives the night dressing (lamps, windows, mist) and how a map profile adjusts the key. */
  night: number;
}

const KEYS: LightKey[] = [
  {
    hour: 0,
    sun: new Color(0.5, 0.62, 1.0),
    sunIntensity: 0.6,
    elevation: 40,
    skyZenith: new Color(0.01, 0.015, 0.04),
    skyHorizon: new Color(0.03, 0.05, 0.1),
    hemiSky: new Color(0.16, 0.22, 0.42),
    hemiGround: new Color(0.04, 0.045, 0.06),
    hemiIntensity: 0.95,
    exposure: 1.75,
    night: 1,
  },
  {
    hour: 5.5,
    sun: new Color(1.0, 0.5, 0.3),
    sunIntensity: 0.9,
    elevation: 12,
    skyZenith: new Color(0.12, 0.16, 0.32),
    skyHorizon: new Color(0.9, 0.55, 0.4),
    hemiSky: new Color(0.5, 0.45, 0.6),
    hemiGround: new Color(0.2, 0.15, 0.12),
    hemiIntensity: 0.5,
    exposure: 1.2,
    night: 0.667,
  },
  {
    hour: 8,
    sun: new Color(1.0, 0.86, 0.7),
    sunIntensity: 2.6,
    elevation: 38,
    skyZenith: new Color(0.25, 0.45, 0.8),
    skyHorizon: new Color(0.75, 0.82, 0.9),
    hemiSky: new Color(0.6, 0.72, 0.9),
    hemiGround: new Color(0.3, 0.26, 0.2),
    hemiIntensity: 0.9,
    exposure: 1.0,
    night: 0,
  },
  {
    hour: 12,
    sun: new Color(1.0, 0.97, 0.92),
    sunIntensity: 3.2,
    elevation: 55,
    skyZenith: new Color(0.2, 0.42, 0.82),
    skyHorizon: new Color(0.7, 0.8, 0.92),
    hemiSky: new Color(0.62, 0.75, 0.95),
    hemiGround: new Color(0.32, 0.28, 0.22),
    hemiIntensity: 1.0,
    exposure: 1.0,
    night: 0,
  },
  {
    hour: 16,
    sun: new Color(1.0, 0.88, 0.68),
    sunIntensity: 2.7,
    elevation: 40,
    skyZenith: new Color(0.24, 0.42, 0.78),
    skyHorizon: new Color(0.82, 0.8, 0.8),
    hemiSky: new Color(0.62, 0.7, 0.88),
    hemiGround: new Color(0.32, 0.26, 0.2),
    hemiIntensity: 0.9,
    exposure: 1.0,
    night: 0,
  },
  {
    hour: 18.5,
    sun: new Color(1.0, 0.45, 0.22),
    sunIntensity: 1.2,
    elevation: 10,
    skyZenith: new Color(0.15, 0.15, 0.3),
    skyHorizon: new Color(1.0, 0.5, 0.3),
    hemiSky: new Color(0.55, 0.42, 0.55),
    hemiGround: new Color(0.2, 0.13, 0.1),
    hemiIntensity: 0.55,
    exposure: 1.15,
    night: 0.333,
  },
  {
    hour: 21,
    sun: new Color(0.5, 0.62, 1.0),
    sunIntensity: 0.6,
    elevation: 40,
    skyZenith: new Color(0.01, 0.015, 0.04),
    skyHorizon: new Color(0.03, 0.05, 0.1),
    hemiSky: new Color(0.16, 0.22, 0.42),
    hemiGround: new Color(0.04, 0.045, 0.06),
    hemiIntensity: 0.95,
    exposure: 1.75,
    night: 1,
  },
  {
    hour: 24,
    sun: new Color(0.5, 0.62, 1.0),
    sunIntensity: 0.6,
    elevation: 40,
    skyZenith: new Color(0.01, 0.015, 0.04),
    skyHorizon: new Color(0.03, 0.05, 0.1),
    hemiSky: new Color(0.16, 0.22, 0.42),
    hemiGround: new Color(0.04, 0.045, 0.06),
    hemiIntensity: 0.95,
    exposure: 1.75,
    night: 1,
  },
];

/** Moonlight and night sky are pulled 30 % towards this grey (luminance-matched) so night keeps the art readable. */
const MOON_GREY = new Color(0.72, 0.74, 0.78);
/**
 * Moonlight tint (linear, used luminance-normalised): nights are cool whatever the map's day grade (concept C: a dark
 * blue-grey base under warm lamps). A map authored as a night map adds its own [Lighting] tint on top; a day map's
 * warm grade (XMP29U2: 1/0.8/0.68) is a daylight choice and never tints its moonlight.
 */
export const MOON_TINT = new Color(0.78, 0.86, 1.0);
/** Overcast sun and sky colour (scaled to each key's sky luminance). */
const OVERCAST_GREY = new Color(0.55, 0.58, 0.62);
/**
 * Flat-ground brightness lost per unit overcast by day (overcast = 0.35 + 0.5 x rain). 0.08 keeps day rain at about
 * 0.94 of clear light, so a rainy afternoon stays above 0.85 of clear noon's frame brightness with wet ground.
 */
const OVERCAST_DIMMING = 0.08;
/**
 * Neutral tone mapping subtracts about 0.04 from mid-tones and bends everything below 0.08 into a quadratic toe, so
 * ground lit at nightLevel x noon in linear light would display about 30 % darker than that relative to noon
 * (measured on RiverRam: 0.21 instead of 0.30). The night keys aim this much higher so the displayed night ground
 * keeps the profile's night level.
 */
export const NIGHT_TONE_COMPENSATION = 1.15;
/**
 * Night rain keeps this fraction of the clear night level: the overcast grey is less blue than moonlight, so the same
 * luminance reads a little brighter on the warm original palettes; wet paving darkens on its own (terrain.ts).
 */
const NIGHT_RAIN = 0.95;
/** Night rain keeps at least this fraction of noon on flat ground. */
const NIGHT_RAIN_FLOOR = 0.26;

const luminanceOf = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Height (y) of the unit sun direction Lighting.update builds for a key elevation: the elevation is floored at 28° and
 * the classic RA2 light comes from screen upper-left, slightly towards the camera, so y is a little below sin(e).
 */
export function sunHeight(elevationDegrees: number): number {
  const e = (Math.max(28, elevationDegrees) * Math.PI) / 180;
  const x = -Math.cos(e);
  const z = -0.35 * Math.cos(e);
  return Math.sin(e) / Math.hypot(x, Math.sin(e), z);
}

/** Luminance of flat-ground irradiance at clear noon (what "noon" shows; the exposure reference is channel-averaged). */
export function noonFlatLuminance(): number {
  const noon = KEYS.find((key) => key.hour === 12)!;
  return (
    luminanceOf(noon.sun) * noon.sunIntensity * sunHeight(noon.elevation) +
    luminanceOf(noon.hemiSky) * noon.hemiIntensity
  );
}
/** `grey` scaled to the luminance of `like`. */
const matchedGrey = (grey: Color, like: Color): Color =>
  grey.clone().multiplyScalar(luminanceOf(like) / Math.max(1e-6, luminanceOf(grey)));

/**
 * Light keys adjusted to a map's atmosphere profile. Day keys (night = 0) are the very same objects, so daytime
 * lighting is unchanged bit for bit. Night-weighted keys get:
 *   - moon and night sky desaturated 30 % towards a luminance-matched grey (the original palettes stay readable);
 *   - the cool MOON_TINT, times the map's [Lighting] tint (square root) when the map was built as a night map, both
 *     normalised to luminance 1 and applied in proportion to the key's night weight;
 *   - intensities so flat unlit ground receives nightLevel x noon, split 40 % moon / 60 % sky (full-night keys), or
 *     at least that much (dawn/dusk keys, which keep their own balance).
 */
export function profileKeys(profile: AtmosphereProfile): LightKey[] {
  const target = profile.nightLevel * NIGHT_TONE_COMPENSATION * noonFlatLuminance();
  const moon = MOON_TINT.clone();
  if (profile.kind === 'night')
    moon.multiply(new Color(Math.sqrt(profile.tint[0]), Math.sqrt(profile.tint[1]), Math.sqrt(profile.tint[2])));
  moon.multiplyScalar(1 / Math.max(1e-6, luminanceOf(moon)));
  return KEYS.map((key) => {
    const n = key.night;
    if (n === 0) return key;
    const tint = new Color(1, 1, 1).lerp(moon, n);
    const sun = key.sun
      .clone()
      .lerp(matchedGrey(MOON_GREY, key.sun), 0.3 * n)
      .multiply(tint);
    const hemiSky = key.hemiSky
      .clone()
      .lerp(matchedGrey(MOON_GREY, key.hemiSky), 0.3 * n)
      .multiply(tint);
    const sinElevation = sunHeight(key.elevation);
    let sunIntensity: number;
    let hemiIntensity: number;
    if (n >= 1) {
      sunIntensity = (0.4 * target) / (luminanceOf(sun) * sinElevation);
      hemiIntensity = (0.6 * target) / luminanceOf(hemiSky);
    } else {
      const flat = luminanceOf(sun) * key.sunIntensity * sinElevation + luminanceOf(hemiSky) * key.hemiIntensity;
      // Dawn and dusk stay brighter than the night they lead into (up to 1.67x at dusk's 0.333).
      const scale = Math.max(1, (target * (2 - n)) / flat);
      sunIntensity = key.sunIntensity * scale;
      hemiIntensity = key.hemiIntensity * scale;
    }
    return { ...key, sun, hemiSky, sunIntensity, hemiIntensity };
  });
}

export interface LightingState {
  sunDirection: Vector3;
  sunColor: Color;
  skyZenith: Color;
  skyHorizon: Color;
  ambient: Color;
  exposure: number;
  /** 0 = full day, 1 = night: drives emissive windows and lamp lights. */
  night: number;
}

export class Lighting {
  readonly root = new Object3D();
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly state: LightingState = {
    sunDirection: new Vector3(),
    sunColor: new Color(),
    skyZenith: new Color(),
    skyHorizon: new Color(),
    ambient: new Color(),
    exposure: 1,
    night: 0,
  };

  constructor(mapWidth: number, mapHeight: number) {
    this.sun = new DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const half = Math.max(mapWidth, mapHeight) * 0.75;
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -half;
    shadowCamera.right = half;
    shadowCamera.top = half;
    shadowCamera.bottom = -half;
    shadowCamera.near = 1;
    shadowCamera.far = 200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    this.sun.target.position.set(mapWidth / 2, 0, mapHeight / 2);
    this.hemi = new HemisphereLight(0xffffff, 0x444444, 1);
    this.root.add(this.sun, this.sun.target, this.hemi);
  }

  /** Keep the sun and its shadow frustum centred on what the camera is looking at (maps are much larger than a view). */
  follow(target: Vector3): void {
    this.sun.target.position.copy(target);
    const shadowCamera = this.sun.shadow.camera;
    if (shadowCamera.right !== 36) {
      shadowCamera.left = -36;
      shadowCamera.right = 36;
      shadowCamera.top = 36;
      shadowCamera.bottom = -36;
      shadowCamera.updateProjectionMatrix();
    }
  }

  /** Irradiance on flat ground from the sun and sky, per channel (linear), for the current state. */
  flatIrradianceColor(out: Color): Color {
    const sunHeight = Math.max(0, this.state.sunDirection.y);
    const sun = this.sun.intensity * sunHeight;
    const sky = this.hemi.intensity;
    return out.setRGB(
      this.sun.color.r * sun + this.hemi.color.r * sky,
      this.sun.color.g * sun + this.hemi.color.g * sky,
      this.sun.color.b * sun + this.hemi.color.b * sky,
    );
  }

  /** Flat-ground irradiance at clear noon: the reference at which original art keeps its original brightness. */
  referenceIrradiance(): number {
    if (this.reference === undefined) {
      const noon = KEYS.find((key) => key.hour === 12)!;
      const sky = (noon.hemiSky.r + noon.hemiSky.g + noon.hemiSky.b) / 3;
      this.reference = noon.sunIntensity * Math.sin((noon.elevation * Math.PI) / 180) + sky * noon.hemiIntensity;
    }
    return this.reference;
  }
  private reference?: number;

  private keys: LightKey[] = KEYS;
  private profile: AtmosphereProfile | null = null;
  private readonly grey = new Color();
  private readonly halfGrey = new Color();

  /**
   * Stage the day cycle for a map's atmosphere profile (see profileKeys), or null for the procedural sandbox's
   * original keys and weather. Cheap when the profile did not change.
   */
  setProfile(profile: AtmosphereProfile | null): void {
    const same =
      profile === this.profile ||
      (!!profile &&
        !!this.profile &&
        profile.kind === this.profile.kind &&
        profile.nightLevel === this.profile.nightLevel &&
        profile.tint[0] === this.profile.tint[0] &&
        profile.tint[1] === this.profile.tint[1] &&
        profile.tint[2] === this.profile.tint[2]);
    if (same) return;
    this.profile = profile ? { ...profile, tint: [...profile.tint] } : null;
    this.keys = profile ? profileKeys(profile) : KEYS;
  }

  /** Night weight (0 day .. 1 night) of the day cycle at `hour`, without changing any state. */
  nightAt(hour: number): number {
    const keys = this.keys;
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1]!.hour <= h) i++;
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const t = (h - a.hour) / (b.hour - a.hour);
    return Math.min(1, Math.max(0, a.night + (b.night - a.night) * t));
  }

  /** Luminance of the flat-ground irradiance of the current sun and sky. */
  private flatLuminance(sunColor: Color, sunIntensity: number, hemiColor: Color, hemiIntensity: number): number {
    const height = Math.max(0, this.state.sunDirection.y);
    return luminanceOf(sunColor) * sunIntensity * height + luminanceOf(hemiColor) * hemiIntensity;
  }

  /** Blend day-cycle keys; weather darkens and desaturates the key light. */
  update(hour: number, overcast: number): void {
    const keys = this.keys;
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1]!.hour <= h) i++;
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const t = (h - a.hour) / (b.hour - a.hour);

    // Shadows longer than ~2x object height hurt RTS readability, so the sun never drops below 28°.
    const elevation = (Math.max(28, lerp(a.elevation, b.elevation, t)) * Math.PI) / 180;
    // Screen upper-left in world space is -x (see IsoCamera): the classic RA2 light direction.
    const azimuth = Math.PI;
    const dir = this.state.sunDirection
      .set(
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation) - 0.35 * Math.cos(elevation),
      )
      .normalize();
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 80);
    if (this.profile) {
      this.updateProfiled(a, b, t, overcast);
      return;
    }

    const grey = this.grey.copy(OVERCAST_GREY);
    this.state.sunColor
      .copy(a.sun)
      .lerp(b.sun, t)
      .lerp(grey, overcast * 0.7);
    this.sun.color.copy(this.state.sunColor);
    this.sun.intensity = lerp(a.sunIntensity, b.sunIntensity, t) * (1 - overcast * 0.55);
    this.state.skyZenith
      .copy(a.skyZenith)
      .lerp(b.skyZenith, t)
      .lerp(this.halfGrey.copy(grey).multiplyScalar(0.5), overcast * 0.8);
    this.state.skyHorizon
      .copy(a.skyHorizon)
      .lerp(b.skyHorizon, t)
      .lerp(grey, overcast * 0.8);
    this.hemi.color
      .copy(a.hemiSky)
      .lerp(b.hemiSky, t)
      .lerp(grey, overcast * 0.5);
    this.hemi.groundColor.copy(a.hemiGround).lerp(b.hemiGround, t);
    // Overcast skies scatter more light; keep ambient up so wet battles stay readable.
    this.hemi.intensity = lerp(a.hemiIntensity, b.hemiIntensity, t) * (1 + overcast * 0.15);
    this.state.ambient.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.5);
    this.state.exposure = lerp(a.exposure, b.exposure, t);
    // Moonlight keys use sunIntensity 0.6, dusk 1.2, day 2.6+: map that onto 1 (night) .. 0 (day). At the keys this
    // equals their explicit `night`; the procedural sandbox keeps this curve between keys.
    this.state.night = Math.min(1, Math.max(0, 1 - (lerp(a.sunIntensity, b.sunIntensity, t) - 0.6) / 0.9));
  }

  /**
   * Map profile path. Overcast moves light from the sun to the sky instead of darkening the frame: the overcast grey is
   * scaled to the key's own sky luminance (night rain stays blue-grey), the sun loses 60 % x overcast, and the sky is
   * solved so flat ground keeps (1 - OVERCAST_DIMMING x overcast) of its clear brightness by day and NIGHT_RAIN of it at
   * night (never below NIGHT_RAIN_FLOOR of noon).
   */
  private updateProfiled(a: LightKey, b: LightKey, t: number, overcast: number): void {
    const night = lerp(a.night, b.night, t);
    const sunColor = this.state.sunColor.copy(a.sun).lerp(b.sun, t);
    let sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
    this.state.skyZenith.copy(a.skyZenith).lerp(b.skyZenith, t);
    this.state.skyHorizon.copy(a.skyHorizon).lerp(b.skyHorizon, t);
    const hemiColor = this.hemi.color.copy(a.hemiSky).lerp(b.hemiSky, t);
    this.hemi.groundColor.copy(a.hemiGround).lerp(b.hemiGround, t);
    let hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
    if (overcast > 0) {
      const clearFlat = this.flatLuminance(sunColor, sunIntensity, hemiColor, hemiIntensity);
      // Scratch colours: this runs every frame in rain.
      const grey = this.grey.copy(OVERCAST_GREY).multiplyScalar(luminanceOf(hemiColor) / luminanceOf(OVERCAST_GREY));
      sunColor.lerp(grey, overcast * 0.7);
      sunIntensity *= 1 - overcast * 0.6;
      this.state.skyZenith.lerp(this.halfGrey.copy(grey).multiplyScalar(0.5), overcast * 0.8);
      this.state.skyHorizon.lerp(grey, overcast * 0.8);
      hemiColor.lerp(grey, overcast * 0.5);
      const factor = 1 - OVERCAST_DIMMING * overcast + (NIGHT_RAIN - (1 - OVERCAST_DIMMING * overcast)) * night;
      const noonFlat = noonFlatLuminance();
      const target = Math.max(clearFlat * factor, Math.min(clearFlat, NIGHT_RAIN_FLOOR * noonFlat) * night);
      const sunFlat = this.flatLuminance(sunColor, sunIntensity, hemiColor, 0);
      hemiIntensity = Math.max(0, (target - sunFlat) / Math.max(1e-6, luminanceOf(hemiColor)));
    }
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunIntensity;
    this.hemi.intensity = hemiIntensity;
    this.state.ambient.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.5);
    this.state.exposure = lerp(a.exposure, b.exposure, t);
    this.state.night = Math.min(1, Math.max(0, night));
  }

  /** The active profile's night level (unlit ground at night relative to noon), or null for the legacy keys. */
  get nightLevel(): number | null {
    return this.profile?.nightLevel ?? null;
  }
}

function lerp(x: number, y: number, t: number): number {
  return x + (y - x) * t;
}
