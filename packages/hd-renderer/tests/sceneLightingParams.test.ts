import { describe, expect, it } from 'vitest';
import { parseSceneLighting } from '../sandbox/sceneLighting';

const map = { ambient: 1, red: 1, green: 0.8, blue: 0.68, ground: 0.05, level: 0.008 };

describe('scene lighting bench parameter', () => {
  it('preserves replay lighting when the parameter is absent', () => {
    expect(parseSceneLighting(null, map)).toBeUndefined();
  });

  it('keeps authored height terms and distinguishes a raw storm override', () => {
    expect(parseSceneLighting('.87,1,.8,.68,.3,.4,.75', map)).toEqual({
      ambient: 0.87,
      ground: 0.05,
      level: 0.008,
      tint: [1, 0.8, 0.68],
      override: [0.3, 0.4, 0.75],
      event: 'storm',
    });
    expect(parseSceneLighting('1,1,.8,.68', map)?.override).toBeNull();
    expect(parseSceneLighting('1,1,.8,.68', map)?.event).toBeNull();
  });

  it.each(['', '1,1,,1', '1,1,1', 'NaN,1,1,1', '-1,1,1,1', '1,1,1,1,1'])('rejects malformed %s', (value) => {
    expect(() => parseSceneLighting(value, map)).toThrow('Invalid lighting');
  });
});
