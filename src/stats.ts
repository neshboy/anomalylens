/**
 * Shared, dependency-free numeric primitives used by every detector.
 * Keeping these in one place means the arithmetic can be hand-verified
 * once (see test/*.test.ts) and then trusted everywhere it's reused.
 */

export interface PopulationStats {
  readonly mean: number;
  readonly stddev: number;
}

/**
 * Population mean and population standard deviation (divide by N, not
 * N-1) of a finite sample window. Population stddev is used deliberately:
 * detectors here always treat their window/warm-up slice as the *complete*
 * baseline population being compared against, not as a random sample
 * estimating some larger population.
 */
export function populationStats(values: readonly number[]): PopulationStats {
  if (values.length === 0) {
    return { mean: NaN, stddev: NaN };
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * The median of a list of numbers (average of the two middle values for
 * an even-length list). Robust to outliers, unlike the mean, which is why
 * the seasonal baseline detector uses it instead of an average.
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Median Absolute Deviation: the median of the absolute deviations from
 * the median. A robust (outlier-resistant) analogue of standard deviation.
 * `median` may be supplied if already computed, to avoid sorting twice.
 */
export function medianAbsoluteDeviation(
  values: readonly number[],
  median: number = medianOf(values),
): number {
  const deviations = values.map((v) => Math.abs(v - median));
  return medianOf(deviations);
}
