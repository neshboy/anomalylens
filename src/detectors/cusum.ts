import type { Anomaly, Detector, MetricSeries } from '../types.js';
import { populationStats } from '../stats.js';
import { severityFromRatio } from './severity.js';

export interface CusumOptions {
  /** How many leading samples are used to learn the baseline mean/stddev. */
  readonly warmupSize?: number;
  /** CUSUM decision threshold h, expressed in units of baseline stddev. */
  readonly thresholdStd?: number;
  /** CUSUM slack/allowance k, expressed in units of baseline stddev. */
  readonly slackStd?: number;
}

/**
 * Sudden change-point detector using a two-sided CUSUM (cumulative sum)
 * control chart.
 *
 * The first `warmupSize` points are used purely to learn a baseline
 * population mean (mu) and standard deviation (sigma) -- they are never
 * themselves scored. From there, two running sums track sustained drift
 * away from the baseline:
 *
 *   k      = slackStd * sigma        (allowance -- ignores noise this small)
 *   h      = thresholdStd * sigma     (decision threshold)
 *   S+_t   = max(0, S+_{t-1} + (x_t - mu - k))   (upward drift)
 *   S-_t   = min(0, S-_{t-1} + (x_t - mu + k))   (downward drift)
 *
 * A point is flagged the moment S+ exceeds h (upward change point) or S-
 * drops below -h (downward change point). After a flag, that side's
 * cumulative sum resets to 0 so the detector can independently catch a
 * *later* change point rather than staying permanently saturated.
 *
 * Unlike the rolling z-score detector (which only looks at one point vs.
 * its recent window), CUSUM accumulates small, sustained deviations over
 * many samples -- so it can catch a gradual level shift that never
 * produces any single extreme point.
 */
export class CusumChangePointDetector implements Detector {
  readonly name = 'cusum-changepoint';
  private readonly warmupSize: number;
  private readonly thresholdStd: number;
  private readonly slackStd: number;

  constructor(options: CusumOptions = {}) {
    this.warmupSize = options.warmupSize ?? 30;
    this.thresholdStd = options.thresholdStd ?? 5;
    this.slackStd = options.slackStd ?? 0.5;
    if (!Number.isFinite(this.warmupSize) || this.warmupSize < 2) {
      throw new RangeError('warmupSize must be a finite number >= 2');
    }
    if (!Number.isFinite(this.thresholdStd) || this.thresholdStd <= 0) {
      throw new RangeError('thresholdStd must be a finite positive number');
    }
    if (!Number.isFinite(this.slackStd) || this.slackStd < 0) {
      throw new RangeError('slackStd must be a finite non-negative number');
    }
  }

  detect(series: MetricSeries): Anomaly[] {
    const { points } = series;
    if (points.length <= this.warmupSize) return [];

    const warmupValues = points.slice(0, this.warmupSize).map((p) => p.value);
    const { mean, stddev } = populationStats(warmupValues);
    // A perfectly flat baseline has no notion of "how many stddevs" --
    // there is nothing to divide by, so this detector abstains.
    if (stddev === 0) return [];

    const k = this.slackStd * stddev;
    const h = this.thresholdStd * stddev;

    const anomalies: Anomaly[] = [];
    let sHigh = 0;
    let sLow = 0;
    let samplesSinceReset = 0;

    for (let i = this.warmupSize; i < points.length; i++) {
      const point = points[i];
      sHigh = Math.max(0, sHigh + (point.value - mean - k));
      sLow = Math.min(0, sLow + (point.value - mean + k));
      samplesSinceReset++;

      if (sHigh > h) {
        anomalies.push({
          metric: series.name,
          labels: series.labels,
          timestampMs: point.timestampMs,
          value: point.value,
          detector: this.name,
          severity: severityFromRatio(sHigh / h),
          score: sHigh,
          explanation:
            `CUSUM upper statistic ${sHigh.toFixed(2)} exceeded threshold ${h.toFixed(2)} ` +
            `(baseline mean ${mean.toFixed(2)}, std ${stddev.toFixed(2)}, slack k ${k.toFixed(2)}) ` +
            `after ${samplesSinceReset} sample(s) since the last reset -- an upward change point`,
        });
        sHigh = 0;
        samplesSinceReset = 0;
      } else if (sLow < -h) {
        const magnitude = Math.abs(sLow);
        anomalies.push({
          metric: series.name,
          labels: series.labels,
          timestampMs: point.timestampMs,
          value: point.value,
          detector: this.name,
          severity: severityFromRatio(magnitude / h),
          score: sLow,
          explanation:
            `CUSUM lower statistic ${magnitude.toFixed(2)} exceeded threshold ${h.toFixed(2)} ` +
            `(baseline mean ${mean.toFixed(2)}, std ${stddev.toFixed(2)}, slack k ${k.toFixed(2)}) ` +
            `after ${samplesSinceReset} sample(s) since the last reset -- a downward change point`,
        });
        sLow = 0;
        samplesSinceReset = 0;
      }
    }

    return anomalies;
  }
}
