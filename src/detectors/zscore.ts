import type { Anomaly, Detector, MetricSeries } from '../types.js';
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
    const { points } = series;
    const windowSize = this.windowSize;

    if (points.length <= windowSize) return [];

    // Below this window size, a full O(windowSize) recompute per point is
    // already cheap (this is exactly what the original brute-force
    // implementation did, and it measured well under a second even at
    // 50k points with the default window of 30) and it's immune to the
    // incremental accumulator's floating-point pitfalls below, so there's
    // no reason to take on that risk for the common case. The incremental
    // path below only earns its complexity for the large-window workloads
    // (e.g. windowSize in the thousands) where re-summing the whole window
    // per point actually shows up as O(n * windowSize) cost.
    if (windowSize <= EXACT_RECOMPUTE_MAX_WINDOW) {
      return this.detectExact(points, series);
    }
    return this.detectIncremental(points, series);
  }

  /** Brute-force per-point recompute. Exact and simple; used for small/moderate windows. */
  private detectExact(points: MetricSeries['points'], series: MetricSeries): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const windowSize = this.windowSize;

    for (let i = windowSize; i < points.length; i++) {
      let sum = 0;
      for (let k = i - windowSize; k < i; k++) sum += points[k].value;
      const mean = sum / windowSize;
      let sqSum = 0;
      for (let k = i - windowSize; k < i; k++) {
        const d = points[k].value - mean;
        sqSum += d * d;
      }
      const stddev = Math.sqrt(sqSum / windowSize);
      this.scorePoint(points[i], mean, stddev, windowSize, series, anomalies);
    }

    return anomalies;
  }

  /**
   * Maintains the rolling window's mean and sum-of-squared-deviations (M2,
   * Welford's running-variance accumulator) incrementally as the window
   * slides by one point per iteration, instead of re-slicing and re-summing
   * all `windowSize` values from scratch at every index -- that's what
   * makes this path pay off for large windows, where the brute-force cost
   * would scale as O(n * windowSize) rather than O(n).
   */
  private detectIncremental(points: MetricSeries['points'], series: MetricSeries): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const windowSize = this.windowSize;

    let mean = 0;
    let m2 = 0;
    for (let k = 0; k < windowSize; k++) {
      const x = points[k].value;
      const delta = x - mean;
      mean += delta / (k + 1);
      m2 += delta * (x - mean);
    }

    for (let i = windowSize; i < points.length; i++) {
      let variance = Math.max(m2 / windowSize, 0);

      // The incremental remove-then-add update at the bottom of this loop is
      // exact in real-number arithmetic, but it works by subtracting two
      // nearly-equal floating-point magnitudes -- classic catastrophic
      // cancellation. That's harmless when the window's true variance is far
      // from zero (the leftover rounding error is negligible next to it),
      // but right when a window transitions to being flat or near-flat (e.g.
      // a long run of identical values right after an outlier ages out of
      // it -- a very common telemetry pattern, like an error counter sitting
      // at exactly 0), it can leave `variance` as a tiny nonzero residual
      // instead of the true (near-)zero, which then turns an ordinary point
      // into a wildly inflated bogus z-score by dividing by a spurious
      // near-zero stddev. Whenever the incrementally-tracked variance looks
      // suspiciously small relative to the window's value scale, fall back
      // to an exact O(windowSize) recompute for just this one point --
      // expensive only when triggered, and it's rare by construction, so it
      // doesn't reintroduce the O(n * windowSize) cost this loop exists to
      // avoid.
      const scale = Math.max(mean * mean, 1);
      if (variance <= scale * 1e-6) {
        let exactMean = 0;
        for (let k = i - windowSize; k < i; k++) exactMean += points[k].value;
        exactMean /= windowSize;
        let exactM2 = 0;
        for (let k = i - windowSize; k < i; k++) {
          const d = points[k].value - exactMean;
          exactM2 += d * d;
        }
        mean = exactMean;
        m2 = exactM2;
        variance = Math.max(m2 / windowSize, 0);
      }

      const stddev = Math.sqrt(variance);
      this.scorePoint(points[i], mean, stddev, windowSize, series, anomalies);

      // Slide the window forward by one: remove the oldest point and add
      // the point we just scored, via the standard incremental
      // remove-then-add update for a running mean/M2 accumulator.
      const leaving = points[i - windowSize].value;
      const entering = points[i].value;

      const meanAfterRemove = (windowSize * mean - leaving) / (windowSize - 1);
      m2 -= (leaving - meanAfterRemove) * (leaving - mean);
      mean = meanAfterRemove;

      const deltaIn = entering - mean;
      mean += deltaIn / windowSize;
      m2 += deltaIn * (entering - mean);
    }

    return anomalies;
  }

  private scorePoint(
    point: MetricSeries['points'][number],
    mean: number,
    stddev: number,
    windowSize: number,
    series: MetricSeries,
    anomalies: Anomaly[],
  ): void {
    // A perfectly flat window has zero variance: any deviation would be
    // an infinite z-score, which is not meaningful to report. Skip it.
    if (stddev === 0) return;

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
          `${mean.toFixed(2)}, stddev ${stddev.toFixed(2)} over the last ${windowSize} samples) ` +
          `exceeds threshold ${this.threshold.toFixed(2)}`,
      });
    }
  }
}

/**
 * Windows at or below this size use the simple, always-exact brute-force
 * recompute (see `detectExact`) rather than the incremental accumulator --
 * cheap enough not to matter, and it sidesteps the incremental path's
 * floating-point edge cases entirely.
 */
const EXACT_RECOMPUTE_MAX_WINDOW = 256;
