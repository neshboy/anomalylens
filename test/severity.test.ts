import { describe, expect, it } from 'vitest';
import { severityFromRatio } from '../src/detectors/severity.js';

describe('severityFromRatio', () => {
  it('classifies below-threshold ratios as info', () => {
    expect(severityFromRatio(0)).toBe('info');
    expect(severityFromRatio(0.5)).toBe('info');
    expect(severityFromRatio(0.999)).toBe('info');
  });

  it('classifies 1x-2x threshold as warning', () => {
    expect(severityFromRatio(1)).toBe('warning');
    expect(severityFromRatio(1.5)).toBe('warning');
    expect(severityFromRatio(1.999)).toBe('warning');
  });

  it('classifies 2x+ threshold as critical', () => {
    expect(severityFromRatio(2)).toBe('critical');
    expect(severityFromRatio(10)).toBe('critical');
  });
});
