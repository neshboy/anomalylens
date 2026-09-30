#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parsePrometheusText } from './parsers/prometheus.js';
import { RollingZScoreDetector } from './detectors/zscore.js';
import { SeasonalBaselineDetector, type SeasonalBucketBy } from './detectors/seasonal.js';
import { CusumChangePointDetector } from './detectors/cusum.js';
import { runDetectors } from './detectors/run.js';
import type { Anomaly, Detector } from './types.js';

export class CliUsageError extends Error {}

export interface CliOptions {
  file?: string;
  output: 'text' | 'json';
  detectors: string[];
  zscoreWindow: number;
  zscoreThreshold: number;
  seasonalThreshold: number;
  seasonalMinSamples: number;
  seasonalBucket: SeasonalBucketBy;
  cusumWarmup: number;
  cusumThreshold: number;
  cusumSlack: number;
}

const DEFAULTS: CliOptions = {
  output: 'text',
  detectors: ['zscore', 'seasonal', 'cusum'],
  zscoreWindow: 30,
  zscoreThreshold: 3,
  seasonalThreshold: 3,
  seasonalMinSamples: 4,
  seasonalBucket: 'day-hour',
  cusumWarmup: 30,
  cusumThreshold: 5,
  cusumSlack: 0.5,
};

export const HELP_TEXT = `AnomalyLens -- explainable statistical anomaly detection for telemetry

Usage:
  anomalylens detect <file|-> [options]

Options:
  --output <text|json>              Output format (default: text)
  --detectors <list>                 Comma-separated: zscore,seasonal,cusum (default: all three)
  --zscore-window <n>                 Rolling window size for the z-score detector (default: 30)
  --zscore-threshold <n>              |z| threshold to flag (default: 3)
  --seasonal-threshold <n>            MAD threshold to flag (default: 3)
  --seasonal-min-samples <n>          Minimum historical samples per bucket (default: 4)
  --seasonal-bucket <hour|day-hour>   Bucketing granularity (default: day-hour)
  --cusum-warmup <n>                  Warm-up sample count used to learn the baseline (default: 30)
  --cusum-threshold <n>               CUSUM threshold in units of std dev (default: 5)
  --cusum-slack <n>                   CUSUM slack (k) in units of std dev (default: 0.5)

Input is read from <file>, or from stdin if <file> is "-" or omitted.
Only the Prometheus text exposition format is supported (see README).

Exit codes:
  0  no anomalies found
  1  one or more anomalies found
  2  usage error
`;

export function parseArgs(argv: string[]): { command: 'help' } | ({ command: 'detect' } & CliOptions) {
  const rest = [...argv];
  const command = rest.shift();

  if (!command || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command !== 'detect') {
    throw new CliUsageError(`Unknown command "${command}". Expected "detect".`);
  }

  const options: CliOptions = { ...DEFAULTS, detectors: [...DEFAULTS.detectors] };
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--output': {
        const value = requireValue(rest, ++i, arg);
        if (value !== 'text' && value !== 'json') {
          throw new CliUsageError(`--output must be "text" or "json", got "${value}"`);
        }
        options.output = value;
        break;
      }
      case '--detectors':
        options.detectors = requireValue(rest, ++i, arg)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case '--zscore-window':
        options.zscoreWindow = requireNumber(rest, ++i, arg);
        break;
      case '--zscore-threshold':
        options.zscoreThreshold = requireNumber(rest, ++i, arg);
        break;
      case '--seasonal-threshold':
        options.seasonalThreshold = requireNumber(rest, ++i, arg);
        break;
      case '--seasonal-min-samples':
        options.seasonalMinSamples = requireNumber(rest, ++i, arg);
        break;
      case '--seasonal-bucket': {
        const value = requireValue(rest, ++i, arg);
        if (value !== 'hour' && value !== 'day-hour') {
          throw new CliUsageError(`--seasonal-bucket must be "hour" or "day-hour", got "${value}"`);
        }
        options.seasonalBucket = value;
        break;
      }
      case '--cusum-warmup':
        options.cusumWarmup = requireNumber(rest, ++i, arg);
        break;
      case '--cusum-threshold':
        options.cusumThreshold = requireNumber(rest, ++i, arg);
        break;
      case '--cusum-slack':
        options.cusumSlack = requireNumber(rest, ++i, arg);
        break;
      default:
        if (arg.startsWith('--')) {
          throw new CliUsageError(`Unknown flag "${arg}"`);
        }
        positionals.push(arg);
    }
  }

  options.file = positionals[0];
  return { command: 'detect', ...options };
}

function requireValue(rest: string[], idx: number, flag: string): string {
  const v = rest[idx];
  if (v === undefined) throw new CliUsageError(`Missing value for ${flag}`);
  return v;
}

function requireNumber(rest: string[], idx: number, flag: string): number {
  const v = requireValue(rest, idx, flag);
  const n = Number(v);
  if (Number.isNaN(n)) throw new CliUsageError(`${flag} expects a number, got "${v}"`);
  return n;
}

export function buildDetectors(options: CliOptions): Detector[] {
  const factories: Record<string, () => Detector> = {
    zscore: () => new RollingZScoreDetector({ windowSize: options.zscoreWindow, threshold: options.zscoreThreshold }),
    seasonal: () =>
      new SeasonalBaselineDetector({
        thresholdMads: options.seasonalThreshold,
        minBucketSamples: options.seasonalMinSamples,
        bucketBy: options.seasonalBucket,
      }),
    cusum: () =>
      new CusumChangePointDetector({
        warmupSize: options.cusumWarmup,
        thresholdStd: options.cusumThreshold,
        slackStd: options.cusumSlack,
      }),
  };

  return options.detectors.map((rawName) => {
    const name = rawName.trim();
    const factory = factories[name];
    if (!factory) {
      throw new CliUsageError(`Unknown detector "${name}". Expected one of: zscore, seasonal, cusum`);
    }
    return factory();
  });
}

export function formatText(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) return 'No anomalies detected.\n';
  return (
    anomalies
      .map((a) => {
        const labelStr = Object.entries(a.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        const metricStr = labelStr ? `${a.metric}{${labelStr}}` : a.metric;
        const ts = new Date(a.timestampMs).toISOString();
        return `${ts} [${a.severity.toUpperCase()}] ${metricStr} value=${a.value} :: ${a.detector} :: ${a.explanation}`;
      })
      .join('\n') + '\n'
  );
}

export function formatJson(anomalies: Anomaly[]): string {
  return JSON.stringify(anomalies, null, 2) + '\n';
}

function defaultReadInput(file?: string): string {
  if (file && file !== '-') {
    return readFileSync(file, 'utf8');
  }
  // fd 0 is stdin; works for piped/redirected input.
  return readFileSync(0, 'utf8');
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The CLI's core logic as a pure(ish) function: takes argv, returns the
 * exit code plus the text that would be written to stdout/stderr, without
 * touching process.stdout/process.exit directly. This makes it possible to
 * test the full ingest -> detect -> format pipeline in-process, and it's
 * also exercised end-to-end via the compiled binary (see test/cli.test.ts).
 */
export function runCli(argv: string[], deps: { readInput?: (file?: string) => string } = {}): CliResult {
  const readInput = deps.readInput ?? defaultReadInput;

  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      return { exitCode: 0, stdout: HELP_TEXT, stderr: '' };
    }

    const input = readInput(parsed.file);
    const series = parsePrometheusText(input);
    const detectors = buildDetectors(parsed);
    const anomalies = runDetectors(series, detectors);

    const stdout = parsed.output === 'json' ? formatJson(anomalies) : formatText(anomalies);
    return { exitCode: anomalies.length > 0 ? 1 : 0, stdout, stderr: '' };
  } catch (err) {
    if (err instanceof CliUsageError || err instanceof RangeError) {
      return { exitCode: 2, stdout: '', stderr: `Error: ${err.message}\n\n${HELP_TEXT}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: '', stderr: `Error: ${message}\n` };
  }
}

export function main(): void {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
