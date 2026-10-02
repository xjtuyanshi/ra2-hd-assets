import type { RenderEnvironment } from './contract';

export interface WeatherParamKeys {
  weather: string;
  intensity: string;
}

/** Normalize presentation inputs from URLs or runtime controls without changing the simulation's weather. */
export function weatherSettings(
  weather: string | null,
  intensity?: number,
): Pick<RenderEnvironment, 'weather' | 'weatherIntensity'> {
  if (weather !== 'rain' && weather !== 'snow' && weather !== 'storm') return { weather: 'clear', weatherIntensity: 0 };
  return {
    weather,
    weatherIntensity:
      intensity !== undefined && Number.isFinite(intensity)
        ? Math.max(0, Math.min(1, intensity))
        : weather === 'storm'
          ? 1
          : 0.8,
  };
}

/** Shared presentation-only URL settings; callers select their own parameter names. */
export function parseWeatherParams(
  params: Pick<URLSearchParams, 'get'>,
  keys: WeatherParamKeys = { weather: 'weather', intensity: 'wi' },
): Pick<RenderEnvironment, 'weather' | 'weatherIntensity'> {
  const raw = params.get(keys.intensity);
  // An empty query value is absent, not numeric zero. Reject partial numbers and non-finite input as well.
  const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return weatherSettings(params.get(keys.weather), value);
}
