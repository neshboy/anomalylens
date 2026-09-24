# AnomalyLens

Explainable statistical anomaly detection for security/ops telemetry.
Every flagged anomaly names exactly which detector fired and the concrete
numbers behind that decision -- there is no black-box score to trust
blindly.

## The problem

Vendor AIOps anomaly detectors love to flag things. What they don't do is
tell you *why*. A dashboard that says "anomaly score: 0.94" gives an
on-call engineer nothing to triage against at 3am: is this a real
incident, a known weekly traffic pattern, or a model that just drifted?
Without a reason, the only rational response over time is to stop trusting
the tool and start ignoring its alerts -- the exact opposite of what an
anomaly detector is for.

AnomalyLens takes the opposite position: **the statistical core is the
product, not an implementation detail hidden behind a score.** Every
detector here is a simple, auditable, well-documented statistical rule.
When one fires, it emits a plain-English explanation that names the
detector and the exact numbers it compared -- the kind of sentence you
could hand-check on a whiteboard. Any future ML-based scoring in this
project is explicitly meant to be layered *on top of* this inspectable
core (e.g. to rank or triage anomalies these detectors already found), not
to replace it with an opaque model.

## Install / quick start

Requires Node.js >= 18.17.

```bash
git clone <this-repo>
cd anomalylens
npm install
npm run build
```

Run against a Prometheus text-exposition file:

```bash
node dist/cli.js detect test/fixtures/sample.prom
```

Or pipe metrics in over stdin:

```bash
cat metrics.prom | node dist/cli.js detect -
```

Get machine-readable JSON (useful for piping into another tool, or for CI):

```bash
node dist/cli.js detect metrics.prom --output json
```

Sample output (text mode):

```
2023-11-14T22:48:20.000Z [CRITICAL] http_request_duration_seconds{service="checkout"} value=500 :: rolling-zscore :: z-score 355.41 (value 500.00 vs rolling window mean 100.00, stddev 1.13 over the last 30 samples) exceeds threshold 3.00
2023-11-14T22:48:20.000Z [CRITICAL] http_request_duration_seconds{service="checkout"} value=500 :: seasonal-baseline :: value 500.00 is 400.00 MADs above the Tue-22:00 seasonal baseline median of 100.00 (MAD 1.00, n=44 historical samples)
2023-11-14T22:48:20.000Z [CRITICAL] http_request_duration_seconds{service="checkout"} value=500 :: cusum-changepoint :: CUSUM upper statistic 399.41 exceeded threshold 5.55 (baseline mean 100.03, std 1.11, slack k 0.56) after 6 sample(s) since the last reset -- an upward change point
```

Every line names the metric, the exact detector that fired, and the
numbers that led to the flag.

The CLI exits `0` when no anomalies are found, `1` when one or more are
flagged (handy for CI gates), and `2` on a usage error. Run
`node dist/cli.js --help` for the full flag reference (window sizes,
thresholds, bucketing granularity, etc. are all configurable per detector).

### As a library

```ts
import {
  parsePrometheusText,
  RollingZScoreDetector,
  SeasonalBaselineDetector,
  CusumChangePointDetector,
  runDetectors,
} from 'anomalylens';

const series = parsePrometheusText(promText);
const anomalies = runDetectors(series, [
  new RollingZScoreDetector({ windowSize: 60, threshold: 3 }),
  new SeasonalBaselineDetector({ thresholdMads: 3, bucketBy: 'day-hour' }),
  new CusumChangePointDetector({ warmupSize: 30, thresholdStd: 5, slackStd: 0.5 }),
]);

for (const a of anomalies) {
  console.log(a.explanation);
}
```

## How each detector's math works

All three detectors implement `Detector { name; detect(series): Anomaly[] }`
and are independent -- run any subset via `--detectors zscore,seasonal,cusum`.

### 1. Rolling z-score detector (`rolling-zscore`)

For each point, once at least `windowSize` prior samples exist, compute the
**population** mean and standard deviation of the preceding `windowSize`
points, then score the current point:

```
mean   = (1/N) * sum(window)
stddev = sqrt( (1/N) * sum((x - mean)^2) )
z      = (value - mean) / stddev
```

Flag when `|z| >= threshold` (default window `30`, threshold `3`).
Population (divide-by-N) standard deviation is used deliberately: the
window is treated as the complete baseline population for that
comparison, not a sample estimating some larger population. A perfectly
flat window (`stddev == 0`) is skipped rather than producing an infinite
or undefined z-score.

*Hand-verified example* (see `test/zscore.test.ts`): window
`[2, 4, 4, 4, 5, 5, 7, 9]` has `mean = 5`, `stddev = 2` exactly. A following
value of `13` gives `z = (13 - 5) / 2 = 4.0` exactly.

### 2. Seasonal baseline detector (`seasonal-baseline`)

Many operational metrics have a weekly or daily rhythm -- "high on Monday
lunch, near-zero at 3am Sunday" is normal, not anomalous. A single rolling
window can't distinguish that from a real incident because it has no
notion of *which* hour or day it's looking at. This detector buckets every
sample by real calendar time and compares each point only against its own
seasonal slot's history:

1. Bucket every point by `day-of-week + hour-of-day` (e.g. `Tue-14:00`),
   or by hour-of-day alone with `--seasonal-bucket hour`.
2. For a given point, build its baseline from every *other* point sharing
   its bucket (leave-one-out -- a point never scores against itself).
3. Compute the baseline's **median** and **MAD** (median absolute
   deviation: the median of `|x - median|` over the baseline):

   ```
   median = median(baseline)
   MAD    = median(|baseline_i - median|)
   score  = (value - median) / MAD
   ```
4. Flag when `|score| >= thresholdMads` (default `3`) -- and only once the
   bucket has at least `minBucketSamples` (default `4`) other historical
   points; with too little history for that slot, the detector abstains
   rather than guessing.

Median/MAD are used instead of mean/stddev because they're robust to the
very kind of extreme outliers this detector is trying to catch (a single
past incident in the baseline shouldn't drag the whole baseline toward it).

*Hand-verified example* (see `test/seasonal.test.ts`): six Tuesdays at
14:00 with values `100, 110, 120, 130, 140, 145`. The leave-one-out
baseline for `145` is `[100, 110, 120, 130, 140]`, median `120`, MAD `10`
(deviations `20,10,0,10,20` -> sorted `0,10,10,20,20` -> median `10`), so
`score = (145 - 120) / 10 = 2.5` exactly. The baseline for `100` is
`[110, 120, 130, 140, 145]`, median `130`, MAD `10`, so
`score = (100 - 130) / 10 = -3.0` exactly.

### 3. CUSUM change-point detector (`cusum-changepoint`)

Some incidents never produce one extreme point -- they're a small,
sustained shift that a single-point z-score never notices. A two-sided
CUSUM (cumulative sum) control chart accumulates deviation over many
samples to catch exactly that:

1. The first `warmupSize` points (default `30`) are used purely to learn
   a baseline population mean `mu` and stddev `sigma` -- never themselves
   scored.
2. `k = slackStd * sigma` (an allowance that absorbs noise this small,
   default `slackStd = 0.5`) and `h = thresholdStd * sigma` (the decision
   threshold, default `thresholdStd = 5`).
3. From there, two running sums track drift:

   ```
   S+_t = max(0, S+_{t-1} + (x_t - mu - k))   // upward drift
   S-_t = min(0, S-_{t-1} + (x_t - mu + k))   // downward drift
   ```
4. Flag the instant `S+ > h` (upward change point) or `S- < -h` (downward
   change point). After a flag, that side's sum resets to `0` so a later,
   independent change point can still be caught instead of the detector
   staying permanently saturated.

*Hand-verified example* (see `test/cusum.test.ts`): warm-up
`[2, 4, 4, 4, 5, 5, 7, 9]` gives `mu = 5`, `sigma = 2`, so `k = 1`, `h = 10`.
Streaming `10, 11, 12` gives `S+ = 4, 9, 15` -- `15 > 10` flags on the third
sample with `score = 15.00` exactly.

## Explanations, not scores

Every `Anomaly` returned by every detector carries:

- `detector` -- which detector fired (`rolling-zscore` / `seasonal-baseline` / `cusum-changepoint`)
- `score` -- the signed detector-specific statistic (z, MAD-multiple, or CUSUM statistic)
- `severity` -- `info` / `warning` / `critical`, derived from how far past threshold the score is
- `explanation` -- a human-readable sentence naming the detector, the value, the baseline it was compared to, and the threshold, e.g.:

  > `value 145.00 is 2.50 MADs above the Tue-14:00 seasonal baseline median of 120.00 (MAD 10.00, n=5 historical samples)`

`test/explanation.test.ts` specifically checks that every explanation names
its firing detector, cites concrete numbers (not vague prose), and that
distinct anomalies from the same detector get distinct explanations.

## Ingestion

AnomalyLens parses the real **Prometheus text exposition format**
(`# HELP` / `# TYPE` metadata plus `metric_name{labels} value timestamp`
sample lines, per the
[official spec](https://prometheus.io/docs/instrumenting/exposition_formats/)).
The parser groups samples into `MetricSeries` by name + label set, sorts
each series chronologically, and handles Prometheus's special float values
(`NaN`, `+Inf`, `-Inf`) and escaped characters inside label values.

## Limitations

- **No built-in scraping.** AnomalyLens ingests a static file or stdin
  stream you already have -- it does not scrape a live Prometheus
  `/metrics` endpoint, poll an OTel collector, or maintain any persistent
  state between runs. Pair it with whatever already exports your metrics
  to a file (e.g. a cron'd `curl` of `/metrics`, or a Prometheus remote
  write to disk).
- **Prometheus text format only.** OTel JSON metrics export is not yet
  implemented (the parser layer is isolated behind `MetricSeries`
  specifically so a second ingestion path could be added without touching
  any detector).
- **`# HELP` / `# TYPE` metadata is parsed only to be skipped.** Metric
  type (counter vs. gauge) is not currently used to change detector
  behavior (e.g. no automatic rate-of-change conversion for counters).
- **Each detector treats every series independently.** There is no
  cross-metric correlation (e.g. "these five metrics all shifted at the
  same time, so this is probably one incident, not five").
- **No ML-based scoring is implemented in this initial version.** The
  architecture is intentionally structured so a scoring/ranking layer
  could sit on top of these detectors' outputs later, but it must never
  replace the ability to see the underlying statistical explanation.
- **Seasonal baselines need real history.** With too few historical
  samples in a given day/hour bucket, the seasonal detector deliberately
  abstains rather than flagging off a baseline of one or two points.

## Development

```bash
npm install
npm run build       # compile TypeScript -> dist/
npm test            # builds, then runs the full vitest suite
npm run typecheck   # strict type-check only, no emit
```

## License

MIT (c) 2026 AnomalyLens contributors. See [LICENSE](LICENSE).
