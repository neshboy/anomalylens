import type { Anomaly, Detector, MetricSeries } from '../types.js';
import { medianAbsoluteDeviation, medianOf } from '../stats.js';
import { severityFromRatio } from './severity.js';

export type SeasonalBucketBy = 'hour' | 'day-hour';

export interface SeasonalOptions {
  /** Flag when |deviation| / MAD >= this many MADs. */
  readonly thresholdMads?: number;
  /** A bucket needs at least this many *other* historical samples to score against. */
  readonly minBucketSamples?: number;
  /** 'hour' buckets only by hour-of-day; 'day-hour' buckets by day-of-week + hour-of-day. */
  readonly bucketBy?: SeasonalBucketBy;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// Guards against division by zero when a bucket's historical values are
// perfectly identical (MAD would otherwise be exactly 0).
const EPSILON = 1e-9;

/**
 * Seasonal baseline detector using real day-of-week / hour-of-day bucketed
 * historical median + MAD (median absolute deviation).
 *
 * Many operational metrics have a weekly or daily rhythm (e.g. traffic is
 * always higher on weekday afternoons than at 3am on Sunday). A single
 * rolling window can't tell "normal Monday lunch spike" apart from "actual
 * incident" -- it needs a baseline for *that specific slot*, not the whole
 * series.
 *
 * For each sample, this detector:
 *   1. Buckets every point in the series by (day-of-week, hour-of-day) --
 *      or just hour-of-day, if `bucketBy: 'hour'`.
 *   2. Builds that point's baseline from every *other* point that shares
 *      its bucket (leave-one-out, so a point never scores against itself).
 *   3. Computes the baseline's median and MAD.
 *   4. Scores the point as (value - median) / MAD, in "MADs".
 *
 * A point is flagged when |score| >= thresholdMads, and only once its
 * bucket has at least `minBucketSamples` other historical points -- with
 * too little history the baseline itself isn't trustworthy, so the
 * detector deliberately abstains rather than guessing.
 */
export class SeasonalBaselineDetector implements Detector {
  readonly name = 'seasonal-baseline';
  private readonly thresholdMads: number;
  private readonly minBucketSamples: number;
  private readonly bucketBy: SeasonalBucketBy;

  constructor(options: SeasonalOptions = {}) {
    this.thresholdMads = options.thresholdMads ?? 3;
    this.minBucketSamples = options.minBucketSamples ?? 4;
    this.bucketBy = options.bucketBy ?? 'day-hour';
    if (!Number.isFinite(this.thresholdMads) || this.thresholdMads <= 0) {
      throw new RangeError('thresholdMads must be a finite positive number');
    }
    if (!Number.isInteger(this.minBucketSamples) || this.minBucketSamples < 2) {
      throw new RangeError('minBucketSamples must be an integer >= 2');
    }
  }

  /** Exposed for tests and callers that want to inspect bucketing directly. */
  bucketKeyFor(timestampMs: number): string {
    const date = new Date(timestampMs);
    const hourLabel = `${date.getUTCHours().toString().padStart(2, '0')}:00`;
    if (this.bucketBy === 'hour') return hourLabel;
    return `${DAY_NAMES[date.getUTCDay()]}-${hourLabel}`;
  }

  detect(series: MetricSeries): Anomaly[] {
    const { points } = series;

    // Real bucketing: group every sample's index by its seasonal slot.
    const bucketIndices = new Map<string, number[]>();
    const keyForIndex: string[] = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const key = this.bucketKeyFor(points[i].timestampMs);
      keyForIndex[i] = key;
      const indices = bucketIndices.get(key);
      if (indices) indices.push(i);
      else bucketIndices.set(key, [i]);
    }

    const anomalies: Anomaly[] = [];

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const key = keyForIndex[i];
      const indices = bucketIndices.get(key);
      if (!indices) continue;

      // Leave-one-out: the baseline for this point excludes this point.
      const baseline = indices.filter((idx) => idx !== i).map((idx) => points[idx].value);
      if (baseline.length < this.minBucketSamples) continue;

      const median = medianOf(baseline);
      const mad = medianAbsoluteDeviation(baseline, median);
      const effectiveMad = mad === 0 ? EPSILON : mad;
      const deviation = point.value - median;
      const score = deviation / effectiveMad;
      const absScore = Math.abs(score);

      if (absScore >= this.thresholdMads) {
        const direction = deviation >= 0 ? 'above' : 'below';
        anomalies.push({
          metric: series.name,
          labels: series.labels,
          timestampMs: point.timestampMs,
          value: point.value,
          detector: this.name,
          severity: severityFromRatio(absScore / this.thresholdMads),
          score,
          explanation:
            `value ${point.value.toFixed(2)} is ${absScore.toFixed(2)} MADs ${direction} the ` +
            `${key} seasonal baseline median of ${median.toFixed(2)} (MAD ${mad.toFixed(2)}, ` +
            `n=${baseline.length} historical samples)`,
        });
      }
    }

    return anomalies;
  }
}
