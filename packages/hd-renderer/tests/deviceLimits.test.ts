import { describe, expect, it } from 'vitest';
import { HdRenderer } from '../src/HdRenderer';

describe('WebGPU device limits', () => {
  it('asks for the adapter maximum of every limit a large or many-layered map needs', () => {
    // An Apple GPU: 16384 px textures, 4 GiB buffers and 48 sampled textures per shader stage (the default is 16,
    // which refused the live terrain material of a map with every layer and left its ground black).
    const adapter = {
      maxTextureDimension2D: 16384,
      maxBufferSize: 4294967296,
      maxSampledTexturesPerShaderStage: 48,
      maxSamplersPerShaderStage: 48,
      maxBindGroups: 4,
      maxColorAttachments: 8,
    };
    expect(HdRenderer.requiredLimitsFor(adapter)).toEqual({
      maxTextureDimension2D: 16384,
      maxBufferSize: 4294967296,
      maxSampledTexturesPerShaderStage: 48,
      maxSamplersPerShaderStage: 48,
    });
  });

  it('never invents a limit the adapter does not report', () => {
    expect(HdRenderer.requiredLimitsFor({ maxTextureDimension2D: 8192 })).toEqual({ maxTextureDimension2D: 8192 });
    expect(HdRenderer.requiredLimitsFor({ maxSampledTexturesPerShaderStage: 0 })).toEqual({});
    expect(HdRenderer.requiredLimitsFor(null)).toEqual({});
    expect(HdRenderer.requiredLimitsFor(undefined)).toEqual({});
  });
});
