import { describe, expect, it } from 'vitest';
import { SeasonalBaselineDetector } from '../src/detectors/seasonal.js';
import type { MetricSeries } from '../src/types.js';

describe('SeasonalBaselineDetector', () => {
  it('matches hand-computed MAD scores for a Tue-14:00 bucket', () => {
    // Six Tuesdays at 14:00 UTC, one week apart, with values:
    //   v0=100, v1=110, v2=120, v3=130, v4=140, v5=145
    //
    // Leave-one-out baseline (the other five values), for every point:
    //
    // v0=100: baseline [110,120,130,140,145] sorted -> median = 130
    //   deviations |110-130|,|120-130|,|130-130|,|140-130|,|145-130|
    //            = 20,10,0,10,15 -> sorted [0,10,10,15,20] -> MAD = 10
    //   score = (100-130)/10 = -3.0   -> |score| 3.0 >= 2.4  FLAGGED (below)
    //
    // v1=110: baseline [100,120,130,140,145] -> median = 130
    //   deviations = 30,10,0,10,15 -> sorted [0,10,10,15,30] -> MAD = 10
    //   score = (110-130)/10 = -2.0   -> 2.0 < 2.4            not flagged
    //
    // v2=120: baseline [100,110,130,140,145] -> median = 130
    //   deviations = 30,20,0,10,15 -> sorted [0,10,15,20,30] -> MAD = 15
    //   score = (120-130)/15 = -0.667                          not flagged
    //
    // v3=130: baseline [100,110,120,140,145] -> median = 120
    //   deviations = 20,10,0,20,25 -> sorted [0,10,20,20,25] -> MAD = 20
    //   score = (130-120)/20 = 0.5                              not flagged
    //
    // v4=140: baseline [100,110,120,130,145] -> median = 120
    //   deviations = 20,10,0,10,25 -> sorted [0,10,10,20,25] -> MAD = 10
    //   score = (140-120)/10 = 2.0     -> 2.0 < 2.4            not flagged
    //
    // v5=145: baseline [100,110,120,130,140] -> median = 120
    //   deviations = 20,10,0,10,20 -> sorted [0,10,10,20,20] -> MAD = 10
    //   score = (145-120)/10 = 2.5     -> 2.5 >= 2.4           FLAGGED (above)
    //
    // So exactly two of the six points clear a 2.4 MAD threshold: v0 (100,
    // -3.0 MADs below) and v5 (145, 2.5 MADs above).
    const tuesday = Date.UTC(2024, 0, 2, 14, 0, 0); // 2024-01-02 is a Tuesday (UTC)
    const week = 7 * 24 * 60 * 60 * 1000;
    const values = [100, 110, 120, 130, 140, 145];
    const points = values.map((value, i) => ({ timestampMs: tuesday + i * week, value }));
    const series: MetricSeries = { name: 'test_metric', labels: {}, points };

    const detector = new SeasonalBaselineDetector({
      thresholdMads: 2.4,
      minBucketSamples: 4,
      bucketBy: 'day-hour',
    });

    expect(detector.bucketKeyFor(tuesday)).toBe('Tue-14:00');

    const anomalies = detector.detect(series);

    expect(anomalies).toHaveLength(2);

    expect(anomalies[0].value).toBe(100);
    expect(anomalies[0].score).toBeCloseTo(-3.0, 10);
    expect(anomalies[0].detector).toBe('seasonal-baseline');
    expect(anomalies[0].explanation).toBe(
      'value 100.00 is 3.00 MADs below the Tue-14:00 seasonal baseline median of 130.00 (MAD 10.00, n=5 historical samples)',
    );

    expect(anomalies[1].value).toBe(145);
    expect(anomalies[1].score).toBeCloseTo(2.5, 10);
    expect(anomalies[1].explanation).toBe(
      'value 145.00 is 2.50 MADs above the Tue-14:00 seasonal baseline median of 120.00 (MAD 10.00, n=5 historical samples)',
    );
  });

  it('does not flag when fewer than minBucketSamples historical points exist', () => {
    const tuesday = Date.UTC(2024, 0, 2, 14, 0, 0);
    const week = 7 * 24 * 60 * 60 * 1000;
    // Only 2 leave-one-out baseline samples available per point (below the
    // default minBucketSamples of 4) -- the detector must abstain entirely.
    const values = [100, 110, 500];
    const points = values.map((value, i) => ({ timestampMs: tuesday + i * week, value }));
    const series: MetricSeries = { name: 'm', labels: {}, points };
    const detector = new SeasonalBaselineDetector({ minBucketSamples: 4 });
    expect(detector.detect(series)).toHaveLength(0);
  });

  it('buckets by hour-of-day only when configured with bucketBy: "hour"', () => {
    const detector = new SeasonalBaselineDetector({ bucketBy: 'hour' });
    const tuesday14 = Date.UTC(2024, 0, 2, 14, 0, 0);
    const wednesday14 = Date.UTC(2024, 0, 3, 14, 0, 0);
    expect(detector.bucketKeyFor(tuesday14)).toBe('14:00');
    expect(detector.bucketKeyFor(tuesday14)).toBe(detector.bucketKeyFor(wednesday14));
  });
});
