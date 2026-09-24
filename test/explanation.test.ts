import { describe, expect, it } from 'vitest';
import { RollingZScoreDetector } from '../src/detectors/zscore.js';
import { SeasonalBaselineDetector } from '../src/detectors/seasonal.js';
import { CusumChangePointDetector } from '../src/detectors/cusum.js';
import type { Detector, MetricSeries } from '../src/types.js';

/**
 * These tests specifically target explainability -- the entire premise of
 * AnomalyLens is that every flagged anomaly names exactly which detector
 * fired and the concrete numbers behind that decision, unlike a black-box
 * vendor AIOps score. The arithmetic itself is hand-verified separately in
 * zscore.test.ts / seasonal.test.ts / cusum.test.ts; these tests check the
 * *shape and traceability* of the resulting explanation strings.
 */

function series(values: number[], startMs = 0, stepMs = 60_000): MetricSeries {
  return {
    name: 'explanation_metric',
    labels: { service: 'api' },
    points: values.map((value, i) => ({ timestampMs: startMs + i * stepMs, value })),
  };
}

describe('explanation strings', () => {
  const cases: Array<{ detector: Detector; series: MetricSeries; expectedSubstrings: string[] }> = [
    {
      detector: new RollingZScoreDetector({ windowSize: 8, threshold: 3 }),
      series: series([2, 4, 4, 4, 5, 5, 7, 9, 13]),
      expectedSubstrings: ['z-score', 'rolling window mean', 'stddev', 'threshold'],
    },
    {
      detector: new CusumChangePointDetector({ warmupSize: 8, thresholdStd: 5, slackStd: 0.5 }),
      series: series([2, 4, 4, 4, 5, 5, 7, 9, 10, 11, 12]),
      expectedSubstrings: ['CUSUM', 'baseline mean', 'slack k', 'change point'],
    },
  ];

  it('names the firing detector and cites concrete numbers for every anomaly', () => {
    for (const { detector, series: s, expectedSubstrings } of cases) {
      const anomalies = detector.detect(s);
      expect(anomalies.length).toBeGreaterThan(0);
      for (const anomaly of anomalies) {
        // The anomaly must be attributable to exactly the detector that produced it.
        expect(anomaly.detector).toBe(detector.name);
        expect(typeof anomaly.explanation).toBe('string');
        expect(anomaly.explanation.length).toBeGreaterThan(20);
        for (const substring of expectedSubstrings) {
          expect(anomaly.explanation).toContain(substring);
        }
        // Every explanation must be traceable to a concrete number, not vague prose.
        expect(anomaly.explanation).toMatch(/-?\d+\.\d{2}/);
      }
    }
  });

  it('produces a seasonal explanation naming the exact bucket label and MAD math', () => {
    // See test/seasonal.test.ts for the full hand-verified arithmetic behind
    // this fixture -- at thresholdMads=2.4, both the 100 (-3.0 MADs) and the
    // 145 (+2.5 MADs) samples clear the threshold.
    const tuesday = Date.UTC(2024, 0, 2, 14, 0, 0);
    const week = 7 * 24 * 60 * 60 * 1000;
    const values = [100, 110, 120, 130, 140, 145];
    const s: MetricSeries = {
      name: 'seasonal_metric',
      labels: {},
      points: values.map((value, i) => ({ timestampMs: tuesday + i * week, value })),
    };
    const detector = new SeasonalBaselineDetector({ thresholdMads: 2.4 });
    const anomalies = detector.detect(s);

    expect(anomalies).toHaveLength(2);
    const above = anomalies.find((a) => a.value === 145)!;
    expect(above.explanation).toContain('Tue-14:00');
    expect(above.explanation).toContain('MADs above');
    expect(above.explanation).toMatch(/MAD \d+\.\d{2}/);
    expect(above.explanation).toContain('historical samples');

    const below = anomalies.find((a) => a.value === 100)!;
    expect(below.explanation).toContain('MADs below');
  });

  it('never emits an anomaly without a non-empty, unique-per-firing explanation', () => {
    // A regression guard: two different anomalies from the same detector on
    // the same series must not share an identical, generic explanation --
    // each must cite that point's own numbers. Built on the same textbook
    // window ([2,4,4,4,5,5,7,9], mean=5, stddev=2) used in zscore.test.ts,
    // followed by a high spike (13) and, after the window has rolled
    // forward, a low spike (-10) -- two flags with clearly different
    // window statistics and therefore necessarily different explanations.
    const detector = new RollingZScoreDetector({ windowSize: 8, threshold: 3 });
    const values = [2, 4, 4, 4, 5, 5, 7, 9, 13, 5, 5, 4, 4, 7, 9, -10];
    const s = series(values);
    const anomalies = detector.detect(s);
    expect(anomalies).toHaveLength(2);
    expect(anomalies[0].value).toBe(13);
    expect(anomalies[1].value).toBe(-10);
    const explanations = anomalies.map((a) => a.explanation);
    expect(new Set(explanations).size).toBe(explanations.length);
  });
});
