import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runCli } from '../src/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'sample.prom');
const DIST_CLI = join(__dirname, '..', 'dist', 'cli.js');

describe('runCli (in-process)', () => {
  it('emits JSON anomalies with detector names and explanations for the sample fixture', () => {
    const result = runCli(['detect', FIXTURE, '--output', 'json', '--detectors', 'zscore,cusum']);
    expect(result.exitCode).toBe(1); // anomalies found -> non-zero exit
    const anomalies = JSON.parse(result.stdout);
    expect(Array.isArray(anomalies)).toBe(true);
    expect(anomalies.length).toBeGreaterThan(0);

    const detectorNames = new Set(anomalies.map((a: { detector: string }) => a.detector));
    expect(detectorNames.has('rolling-zscore')).toBe(true);
    expect(detectorNames.has('cusum-changepoint')).toBe(true);

    for (const anomaly of anomalies) {
      expect(typeof anomaly.explanation).toBe('string');
      expect(anomaly.explanation.length).toBeGreaterThan(10);
      expect(anomaly.metric).toBe('http_request_duration_seconds');
      expect(anomaly.labels).toEqual({ service: 'checkout' });
    }
  });

  it('renders human-readable text output naming metric, detector, and explanation', () => {
    const result = runCli(['detect', FIXTURE, '--output', 'text', '--detectors', 'zscore']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('http_request_duration_seconds{service="checkout"}');
    expect(result.stdout).toContain('rolling-zscore');
    expect(result.stdout).toContain('z-score');
  });

  it('reports "no anomalies" text and exit code 0 for a flat series', () => {
    const flatText = Array.from({ length: 40 }, (_, i) => `flat_metric{} 5 ${1_700_000_000_000 + i * 60_000}`).join(
      '\n',
    );
    const result = runCli(['detect', '-', '--detectors', 'zscore,cusum'], { readInput: () => flatText });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('No anomalies detected.\n');
  });

  it('reads from the injected input source when file is "-"', () => {
    const result = runCli(['detect', '-', '--output', 'json'], { readInput: () => '' });
    // Sanity: an empty exposition file yields no series and no anomalies, exit 0.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('shows help text for --help and no command', () => {
    expect(runCli(['--help']).stdout).toContain('Usage:');
    expect(runCli([]).stdout).toContain('Usage:');
  });

  it('returns a usage error (exit 2) for an unknown detector', () => {
    const result = runCli(['detect', FIXTURE, '--detectors', 'not-a-real-detector']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown detector');
  });

  it('returns a usage error (exit 2) for an unknown command', () => {
    const result = runCli(['bogus']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown command');
  });

  it('returns a usage error (exit 2) for an unknown flag', () => {
    const result = runCli(['detect', FIXTURE, '--not-a-real-flag']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown flag');
  });

  it('surfaces a non-usage runtime error (e.g. missing file) as exit code 1', () => {
    const result = runCli(['detect', join(__dirname, 'fixtures', 'does-not-exist.prom')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error:');
  });
});

describe('anomalylens CLI binary (subprocess integration)', () => {
  it('builds and runs end-to-end via the compiled dist/cli.js entry point', () => {
    let stdout: string;
    try {
      stdout = execFileSync(
        process.execPath,
        [DIST_CLI, 'detect', FIXTURE, '--output', 'json', '--detectors', 'zscore,cusum'],
        { encoding: 'utf8' },
      );
    } catch (error: unknown) {
      // A nonzero exit code (anomalies found) makes execFileSync throw;
      // the real stdout captured before exit is still on the error object.
      stdout = (error as { stdout: string }).stdout;
    }
    const anomalies = JSON.parse(stdout);
    expect(Array.isArray(anomalies)).toBe(true);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0]).toHaveProperty('explanation');
    expect(anomalies[0]).toHaveProperty('detector');
    expect(anomalies[0]).toHaveProperty('severity');
  });

  it('exits 0 with "No anomalies detected." on a flat series piped over stdin', () => {
    const flatText = Array.from({ length: 40 }, (_, i) => `flat_metric{} 5 ${1_700_000_000_000 + i * 60_000}`).join(
      '\n',
    );
    const stdout = execFileSync(process.execPath, [DIST_CLI, 'detect', '-'], {
      encoding: 'utf8',
      input: flatText,
    });
    expect(stdout).toBe('No anomalies detected.\n');
  });
});
