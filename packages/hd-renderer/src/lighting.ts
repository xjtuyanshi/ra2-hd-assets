import { Color, DirectionalLight, HemisphereLight, Object3D, Vector3 } from 'three/webgpu';

/** One key of the day cycle: sun/sky colours and intensities in linear space. */
interface LightKey {
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
  },
];

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
    return out
      .copy(this.sun.color)
      .multiplyScalar(this.sun.intensity * sunHeight)
      .add(this.hemi.color.clone().multiplyScalar(this.hemi.intensity));
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

  /** Blend day-cycle keys; weather darkens and desaturates the key light. */
  update(hour: number, overcast: number): void {
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1]!.hour <= h) i++;
    const a = KEYS[i]!;
    const b = KEYS[i + 1]!;
    const t = (h - a.hour) / (b.hour - a.hour);
    const lerp = (x: number, y: number) => x + (y - x) * t;

    // Shadows longer than ~2x object height hurt RTS readability, so the sun never drops below 28°.
    const elevation = (Math.max(28, lerp(a.elevation, b.elevation)) * Math.PI) / 180;
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

    const grey = new Color(0.55, 0.58, 0.62);
    this.state.sunColor
      .copy(a.sun)
      .lerp(b.sun, t)
      .lerp(grey, overcast * 0.7);
    this.sun.color.copy(this.state.sunColor);
    this.sun.intensity = lerp(a.sunIntensity, b.sunIntensity) * (1 - overcast * 0.55);
    this.state.skyZenith
      .copy(a.skyZenith)
      .lerp(b.skyZenith, t)
      .lerp(grey.clone().multiplyScalar(0.5), overcast * 0.8);
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
    this.hemi.intensity = lerp(a.hemiIntensity, b.hemiIntensity) * (1 + overcast * 0.15);
    this.state.ambient.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.5);
    this.state.exposure = lerp(a.exposure, b.exposure);
    // Moonlight keys use sunIntensity 0.45, dusk 1.2, day 2.6+: map that onto 1 (night) .. 0 (day).
    this.state.night = Math.min(1, Math.max(0, 1 - (lerp(a.sunIntensity, b.sunIntensity) - 0.6) / 0.9));
  }
}
