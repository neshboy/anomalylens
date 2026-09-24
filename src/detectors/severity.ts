import type { Severity } from '../types.js';

/**
 * Maps "how far past threshold" (as a ratio, e.g. |z| / threshold) onto a
 * coarse severity bucket. A ratio of exactly 1.0 means the value just
 * cleared the threshold; 2.0+ means it's twice the configured threshold.
 */
export function severityFromRatio(ratio: number): Severity {
  if (ratio >= 2) return 'critical';
  if (ratio >= 1) return 'warning';
  return 'info';
}
