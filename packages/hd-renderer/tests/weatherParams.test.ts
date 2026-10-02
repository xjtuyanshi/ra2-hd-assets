import { describe, expect, it } from 'vitest';
import { parseWeatherParams, weatherSettings, type WeatherParamKeys } from '../src/weatherParams';

const surfaces: [string, WeatherParamKeys][] = [
  ['live bridge', { weather: 'hd-weather', intensity: 'hd-weather-intensity' }],
  ['replay sandbox', { weather: 'weather', intensity: 'wi' }],
];

describe.each(surfaces)('%s weather parameters', (_surface, keys) => {
  const parse = (weather?: string, intensity?: string) => {
    const params = new URLSearchParams();
    if (weather !== undefined) params.set(keys.weather, weather);
    if (intensity !== undefined) params.set(keys.intensity, intensity);
    return parseWeatherParams(params, keys);
  };

  it('defaults to clear and ignores intensity for unknown or clear weather', () => {
    expect(parse()).toEqual({ weather: 'clear', weatherIntensity: 0 });
    for (const weather of [undefined, '', 'clear', 'fog', 'RAIN'])
      expect(parse(weather, '0.9')).toEqual({ weather: 'clear', weatherIntensity: 0 });
  });

  it.each([
    ['rain', 0.8],
    ['snow', 0.8],
    ['storm', 1],
  ] as const)('uses the %s default and accepts an explicit intensity', (weather, fallback) => {
    expect(parse(weather)).toEqual({ weather, weatherIntensity: fallback });
    expect(parse(weather, '0.35')).toEqual({ weather, weatherIntensity: 0.35 });
    expect(parse(weather, '0')).toEqual({ weather, weatherIntensity: 0 });
  });

  it('clamps finite intensities without accepting malformed or non-finite input', () => {
    expect(parse('snow', '-0.2').weatherIntensity).toBe(0);
    expect(parse('rain', '1.5').weatherIntensity).toBe(1);
    for (const value of ['', '  ', 'NaN', 'Infinity', '-Infinity', '0.2snow', 'no']) {
      expect(parse('rain', value).weatherIntensity).toBe(0.8);
      expect(parse('storm', value).weatherIntensity).toBe(1);
    }
  });

  it('reads only the requested keys', () => {
    const params = new URLSearchParams({
      weather: 'snow',
      wi: '0.2',
      'hd-weather': 'rain',
      'hd-weather-intensity': '0.6',
    });
    const isBridge = keys.weather === 'hd-weather';
    expect(parseWeatherParams(params, keys)).toEqual({
      weather: isBridge ? 'rain' : 'snow',
      weatherIntensity: isBridge ? 0.6 : 0.2,
    });
  });
});

it('defaults to the sandbox parameter names', () => {
  expect(parseWeatherParams(new URLSearchParams('weather=snow&wi=0.4'))).toEqual({
    weather: 'snow',
    weatherIntensity: 0.4,
  });
});

it('normalizes runtime weather controls with the same defaults and bounds', () => {
  expect(weatherSettings('snow')).toEqual({ weather: 'snow', weatherIntensity: 0.8 });
  expect(weatherSettings('storm')).toEqual({ weather: 'storm', weatherIntensity: 1 });
  expect(weatherSettings('rain', NaN)).toEqual({ weather: 'rain', weatherIntensity: 0.8 });
  expect(weatherSettings('snow', Infinity)).toEqual({ weather: 'snow', weatherIntensity: 0.8 });
  expect(weatherSettings('snow', -1).weatherIntensity).toBe(0);
  expect(weatherSettings('snow', 2).weatherIntensity).toBe(1);
  expect(weatherSettings('rain', 0).weatherIntensity).toBe(0);
  expect(weatherSettings('clear', 1)).toEqual({ weather: 'clear', weatherIntensity: 0 });
  expect(weatherSettings('unknown', 1)).toEqual({ weather: 'clear', weatherIntensity: 0 });
});
