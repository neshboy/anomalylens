import type { Anomaly, Detector, MetricSeries } from '../types.js';

/**
 * Runs every configured detector against every series and returns all
 * flagged anomalies merged into one chronologically sorted list. A single
 * point can legitimately be flagged by more than one detector -- each
 * flag carries its own independent explanation.
 */
export function runDetectors(series: readonly MetricSeries[], detectors: readonly Detector[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const s of series) {
    for (const detector of detectors) {
      anomalies.push(...detector.detect(s));
    }
  }
  anomalies.sort((a, b) => a.timestampMs - b.timestampMs);
  return anomalies;
}
