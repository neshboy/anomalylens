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

/**
 * Median of `|x - center|` for every `x` in `sorted`, an array that must
 * already be sorted ascending. Computed in O(n) by merging the two
 * monotonic runs of deviations that sit on either side of `center` (values
 * at or below `center` produce decreasing deviations as they approach it,
 * values above it produce increasing ones), instead of building a fresh
 * deviations array and re-sorting it from scratch like
 * `medianAbsoluteDeviation` does. Callers that already have a sorted array
 * on hand (e.g. a leave-one-out baseline derived from a precomputed sort)
 * should prefer this to avoid a redundant O(n log n) sort per call.
 */
export function medianAbsoluteDeviationFromSorted(sorted: readonly number[], center: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;

  // First index with sorted[idx] > center (i.e. an upper-bound search).
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] > center) hi = mid;
    else lo = mid + 1;
  }
  const splitIdx = lo;
  const leftLen = splitIdx;
  const rightLen = n - splitIdx;

  // Deviations ascend as k grows, walking outward from `center` in either
  // direction: leftDevAt(0) is the value just at/below center, rightDevAt(0)
  // the value just above it.
  const leftDevAt = (k: number): number => center - sorted[splitIdx - 1 - k];
  const rightDevAt = (k: number): number => sorted[splitIdx + k] - center;

  // The k-th smallest (0-indexed) deviation, found by merging the two
  // ascending runs above -- the same merge step mergesort uses, just with
  // the two "arrays" generated lazily instead of materialized.
  const nthSmallestDeviation = (rank: number): number => {
    let i = 0;
    let j = 0;
    let value = NaN;
    for (let count = 0; count <= rank; count++) {
      const leftVal = i < leftLen ? leftDevAt(i) : Infinity;
      const rightVal = j < rightLen ? rightDevAt(j) : Infinity;
      if (leftVal <= rightVal) {
        value = leftVal;
        i++;
      } else {
        value = rightVal;
        j++;
      }
    }
    return value;
  };

  const mid = Math.floor(n / 2);
  if (n % 2 === 0) {
    return (nthSmallestDeviation(mid - 1) + nthSmallestDeviation(mid)) / 2;
  }
  return nthSmallestDeviation(mid);
}
