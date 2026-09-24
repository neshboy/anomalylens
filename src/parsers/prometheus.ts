import type { MetricSeries } from '../types.js';

/**
 * A real parser for the Prometheus text exposition format:
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 *   # HELP metric_name Some description.
 *   # TYPE metric_name counter
 *   metric_name{label="value",other="value"} 123.45 1633024800000
 *
 * `# HELP` / `# TYPE` / other `#`-prefixed lines are metadata/comments and
 * are skipped -- this parser only extracts samples (name, labels, value,
 * optional millisecond timestamp), which is all the detectors need. The
 * timestamp is optional per the spec; when omitted, the current time is
 * used as the ingestion timestamp.
 */

// name{labels}? value timestamp?
const SAMPLE_LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(?:\s+(-?\d+(?:\.\d+)?))?\s*$/;

export function parsePrometheusText(text: string): MetricSeries[] {
  const seriesByKey = new Map<string, MetricSeries>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = SAMPLE_LINE_RE.exec(line);
    if (!match) continue; // Not a well-formed sample line -- skip it.

    const [, name, , labelSection, valueToken, timestampToken] = match;
    const value = parseSampleValue(valueToken);
    if (value === undefined) continue;

    const labels = labelSection ? parseLabelString(labelSection) : {};
    const timestampMs = timestampToken !== undefined ? Number(timestampToken) : Date.now();

    const key = seriesKey(name, labels);
    let series = seriesByKey.get(key);
    if (!series) {
      series = { name, labels, points: [] };
      seriesByKey.set(key, series);
    }
    series.points.push({ timestampMs, value });
  }

  const allSeries = [...seriesByKey.values()];
  for (const series of allSeries) {
    series.points.sort((a, b) => a.timestampMs - b.timestampMs);
  }
  return allSeries;
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const sortedLabelPairs = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `${name}{${sortedLabelPairs.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`;
}

function parseSampleValue(token: string): number | undefined {
  if (token === 'NaN') return NaN;
  if (token === '+Inf' || token === 'Inf') return Infinity;
  if (token === '-Inf') return -Infinity;
  const parsed = Number(token);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parses a Prometheus label-set string (the content between `{` and `}`,
 * e.g. `method="get",code="200"`) into a plain object. Hand-written as a
 * small character scanner (rather than a single regex) so it correctly
 * handles escaped quotes/backslashes inside label values, per spec.
 */
function parseLabelString(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  const n = raw.length;

  while (i < n) {
    while (i < n && (raw[i] === ' ' || raw[i] === ',' || raw[i] === '\t')) i++;
    if (i >= n) break;

    const keyStart = i;
    while (i < n && raw[i] !== '=') i++;
    const key = raw.slice(keyStart, i).trim();
    i++; // skip '='

    while (i < n && raw[i] !== '"') i++;
    i++; // skip opening quote

    let value = '';
    while (i < n && raw[i] !== '"') {
      if (raw[i] === '\\' && i + 1 < n) {
        const next = raw[i + 1];
        if (next === 'n') value += '\n';
        else if (next === 't') value += '\t';
        else value += next; // handles \" and \\
        i += 2;
        continue;
      }
      value += raw[i];
      i++;
    }
    i++; // skip closing quote

    if (key) labels[key] = value;
  }

  return labels;
}
