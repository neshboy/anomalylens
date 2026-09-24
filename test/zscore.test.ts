import { describe, expect, it } from 'vitest';
import { RollingZScoreDetector } from '../src/detectors/zscore.js';
import type { MetricSeries } from '../src/types.js';

describe('RollingZScoreDetector', () => {
  it('matches a hand-computed z-score for a textbook population (mean=5, stddev=2)', () => {
    // Window values: 2, 4, 4, 4, 5, 5, 7, 9 -- a classic statistics-textbook
    // population where:
    //   mean     = (2+4+4+4+5+5+7+9)/8 = 40/8 = 5
    //   variance = ((2-5)^2 + (4-5)^2*3 + (5-5)^2*2 + (7-5)^2 + (9-5)^2) / 8
    //            = (9 + 1*3 + 0*2 + 4 + 16) / 8 = 32/8 = 4
    //   stddev   = sqrt(4) = 2
    // A following value of 13 therefore gives an EXACT z-score of:
    //   z = (13 - 5) / 2 = 4.0
    const windowValues = [2, 4, 4, 4, 5, 5, 7, 9];
    const baseTime = Date.UTC(2024, 0, 1, 0, 0, 0);
    const points = windowValues.map((value, i) => ({
      timestampMs: baseTime + i * 60_000,
      value,
    }));
    points.push({ timestampMs: baseTime + windowValues.length * 60_000, value: 13 });

    const series: MetricSeries = { name: 'test_metric', labels: {}, points };
    const detector = new RollingZScoreDetector({ windowSize: 8, threshold: 3 });

    const anomalies = detector.detect(series);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].score).toBeCloseTo(4.0, 10);
    expect(anomalies[0].value).toBe(13);
    expect(anomalies[0].detector).toBe('rolling-zscore');
    // severity ratio = |z| / threshold = 4.0 / 3.0 = 1.33, which is in [1, 2) -> 'warning'.
    expect(anomalies[0].severity).toBe('warning');
    expect(anomalies[0].explanation).toBe(
      'z-score 4.00 (value 13.00 vs rolling window mean 5.00, stddev 2.00 over the last 8 samples) exceeds threshold 3.00',
    );
  });

  it('does not flag values within the threshold', () => {
    const values = [10, 10, 10, 10, 10, 11];
    const points = values.map((value, i) => ({ timestampMs: i * 1000, value }));
    const series: MetricSeries = { name: 'm', labels: {}, points };
    const detector = new RollingZScoreDetector({ windowSize: 5, threshold: 3 });
    expect(detector.detect(series)).toHaveLength(0);
  });

  it('rejects an invalid configuration', () => {
    expect(() => new RollingZScoreDetector({ windowSize: 1 })).toThrow(RangeError);
    expect(() => new RollingZScoreDetector({ threshold: 0 })).toThrow(RangeError);
  });
});
