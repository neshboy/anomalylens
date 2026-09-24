/**
 * A single timestamped sample of a metric.
 */
export interface DataPoint {
  readonly timestampMs: number;
  readonly value: number;
}

/**
 * A named, labeled time series: one metric name + one label set + its
 * chronologically ordered samples. This mirrors how Prometheus and OTel
 * both model a "metric" once you fix its label set.
 */
export interface MetricSeries {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly points: DataPoint[];
}

export type Severity = 'info' | 'warning' | 'critical';

/**
 * A flagged anomaly. `explanation` is not optional decoration -- it is the
 * whole point of this project: every anomaly must say exactly which
 * detector fired and the concrete numbers that triggered it, so an on-call
 * engineer can verify the reasoning instead of trusting a black-box score.
 */
export interface Anomaly {
  readonly metric: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly timestampMs: number;
  readonly value: number;
  readonly detector: string;
  readonly severity: Severity;
  /** Signed detector-specific score (z-score, MAD-multiple, or CUSUM statistic). */
  readonly score: number;
  readonly explanation: string;
}

/**
 * The common interface every statistical (or, in the future, ML-layered)
 * detector implements. A detector inspects one series at a time and returns
 * every point it flags, each with a self-contained explanation.
 */
export interface Detector {
  readonly name: string;
  detect(series: MetricSeries): Anomaly[];
}
