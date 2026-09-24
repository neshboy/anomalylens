import { describe, expect, it } from 'vitest';
import { CusumChangePointDetector } from '../src/detectors/cusum.js';
import type { MetricSeries } from '../src/types.js';

describe('CusumChangePointDetector', () => {
  it('matches a hand-computed CUSUM upper statistic', () => {
    // Warm-up window (population mean=5, stddev=2 -- identical arithmetic to
    // zscore.test.ts's textbook example): [2, 4, 4, 4, 5, 5, 7, 9]
    //
    // With thresholdStd=5 and slackStd=0.5:
    //   k = 0.5 * 2 = 1
    //   h = 5 * 2   = 10
    //
    // Streaming values after warm-up: 10, 11, 12
    //   S+_1 = max(0, 0 + (10 - 5 - 1)) = max(0, 4)  = 4
    //   S+_2 = max(0, 4 + (11 - 5 - 1)) = max(0, 9)  = 9
    //   S+_3 = max(0, 9 + (12 - 5 - 1)) = max(0, 15) = 15   -- 15 > h(10) => flag
    const warmup = [2, 4, 4, 4, 5, 5, 7, 9];
    const stream = [10, 11, 12];
    const values = [...warmup, ...stream];
    const points = values.map((value, i) => ({ timestampMs: i * 60_000, value }));
    const series: MetricSeries = { name: 'test_metric', labels: {}, points };

    const detector = new CusumChangePointDetector({
      warmupSize: warmup.length,
      thresholdStd: 5,
      slackStd: 0.5,
    });

    const anomalies = detector.detect(series);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].score).toBeCloseTo(15, 10);
    expect(anomalies[0].value).toBe(12);
    expect(anomalies[0].detector).toBe('cusum-changepoint');
    expect(anomalies[0].explanation).toBe(
      'CUSUM upper statistic 15.00 exceeded threshold 10.00 (baseline mean 5.00, std 2.00, slack k 1.00) after 3 sample(s) since the last reset -- an upward change point',
    );
  });

  it('detects a downward change point symmetrically', () => {
    // Same warm-up (mean=5, stddev=2, k=1, h=10). Streaming values 0, -1, -2:
    //   S-_1 = min(0, 0 + (0 - 5 + 1))  = min(0, -4)  = -4
    //   S-_2 = min(0, -4 + (-1 - 5 + 1)) = min(0, -9)  = -9
    //   S-_3 = min(0, -9 + (-2 - 5 + 1)) = min(0, -15) = -15  -- |-15| > h(10) => flag
    const warmup = [2, 4, 4, 4, 5, 5, 7, 9];
    const stream = [0, -1, -2];
    const values = [...warmup, ...stream];
    const points = values.map((value, i) => ({ timestampMs: i * 60_000, value }));
    const series: MetricSeries = { name: 'test_metric', labels: {}, points };

    const detector = new CusumChangePointDetector({
      warmupSize: warmup.length,
      thresholdStd: 5,
      slackStd: 0.5,
    });

    const anomalies = detector.detect(series);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].score).toBeCloseTo(-15, 10);
    expect(anomalies[0].value).toBe(-2);
    expect(anomalies[0].explanation).toContain('CUSUM lower statistic 15.00 exceeded threshold 10.00');
    expect(anomalies[0].explanation).toContain('downward change point');
  });

  it('does not flag a perfectly stable series (zero baseline variance)', () => {
    const values = Array(40).fill(5);
    const points = values.map((value, i) => ({ timestampMs: i * 1000, value }));
    const series: MetricSeries = { name: 'm', labels: {}, points };
    const detector = new CusumChangePointDetector({ warmupSize: 30 });
    expect(detector.detect(series)).toHaveLength(0);
  });

  it('returns no anomalies when the series is not longer than the warm-up window', () => {
    const values = [1, 2, 3];
    const points = values.map((value, i) => ({ timestampMs: i * 1000, value }));
    const series: MetricSeries = { name: 'm', labels: {}, points };
    const detector = new CusumChangePointDetector({ warmupSize: 30 });
    expect(detector.detect(series)).toHaveLength(0);
  });
});
