import type { Anomaly, Detector, MetricSeries } from '../types.js';
import { populationStats } from '../stats.js';
import { severityFromRatio } from './severity.js';

export interface ZScoreOptions {
  /** How many preceding samples form the rolling baseline window. */
  readonly windowSize?: number;
  /** Flag when |z| >= this value. */
  readonly threshold?: number;
}

/**
 * Rolling z-score / standard-deviation detector.
 *
 * For each point at index i (once at least `windowSize` prior points
 * exist), computes the population mean and standard deviation of the
 * preceding `windowSize` points, then scores the current point as:
 *
 *   z = (value - windowMean) / windowStddev
 *
 * A point is flagged when |z| >= threshold. This is the simplest of the
 * three detectors and the one most amenable to hand-verification -- see
 * test/zscore.test.ts for an exact hand-computed example.
 */
export class RollingZScoreDetector implements Detector {
  readonly name = 'rolling-zscore';
  private readonly windowSize: number;
  private readonly threshold: number;

  constructor(options: ZScoreOptions = {}) {
    this.windowSize = options.windowSize ?? 30;
    this.threshold = options.threshold ?? 3;
    if (!Number.isFinite(this.windowSize) || this.windowSize < 2) {
      throw new RangeError('windowSize must be a finite number >= 2');
    }
    if (!Number.isFinite(this.threshold) || this.threshold <= 0) {
      throw new RangeError('threshold must be a finite positive number');
    }
  }

  detect(series: MetricSeries): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const { points } = series;

    for (let i = this.windowSize; i < points.length; i++) {
      const window = points.slice(i - this.windowSize, i).map((p) => p.value);
      const { mean, stddev } = populationStats(window);
      // A perfectly flat window has zero variance: any deviation would be
      // an infinite z-score, which is not meaningful to report. Skip it.
      if (stddev === 0) continue;

      const point = points[i];
      const z = (point.value - mean) / stddev;
      const absZ = Math.abs(z);

      if (absZ >= this.threshold) {
        anomalies.push({
          metric: series.name,
          labels: series.labels,
          timestampMs: point.timestampMs,
          value: point.value,
          detector: this.name,
          severity: severityFromRatio(absZ / this.threshold),
          score: z,
          explanation:
            `z-score ${z.toFixed(2)} (value ${point.value.toFixed(2)} vs rolling window mean ` +
            `${mean.toFixed(2)}, stddev ${stddev.toFixed(2)} over the last ${this.windowSize} samples) ` +
            `exceeds threshold ${this.threshold.toFixed(2)}`,
        });
      }
    }

    return anomalies;
  }
}
