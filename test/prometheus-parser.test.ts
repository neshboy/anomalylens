import { describe, expect, it } from 'vitest';
import { parsePrometheusText } from '../src/parsers/prometheus.js';

const SAMPLE = `
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="get",code="200"} 1027 1633024800000
http_requests_total{method="get",code="200"} 1050 1633024860000
http_requests_total{method="post",code="500"} 3 1633024800000
# HELP process_cpu_seconds_total Total user and system CPU time spent
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 12.5 1633024800000
# A comment line with no HELP/TYPE keyword should also be skipped
up{job="node",instance="10.0.0.1:9100"} 1
`;

describe('parsePrometheusText', () => {
  it('parses the real Prometheus text exposition format into grouped series', () => {
    const series = parsePrometheusText(SAMPLE);

    expect(series).toHaveLength(4);

    const requestsGet = series.find((s) => s.name === 'http_requests_total' && s.labels.method === 'get');
    expect(requestsGet).toBeDefined();
    expect(requestsGet!.labels).toEqual({ method: 'get', code: '200' });
    expect(requestsGet!.points).toEqual([
      { timestampMs: 1633024800000, value: 1027 },
      { timestampMs: 1633024860000, value: 1050 },
    ]);

    const requestsPost = series.find((s) => s.name === 'http_requests_total' && s.labels.method === 'post');
    expect(requestsPost!.points).toEqual([{ timestampMs: 1633024800000, value: 3 }]);

    const cpu = series.find((s) => s.name === 'process_cpu_seconds_total');
    expect(cpu!.labels).toEqual({});
    expect(cpu!.points).toEqual([{ timestampMs: 1633024800000, value: 12.5 }]);

    const up = series.find((s) => s.name === 'up');
    expect(up!.labels).toEqual({ job: 'node', instance: '10.0.0.1:9100' });
    expect(up!.points).toHaveLength(1);
    expect(up!.points[0].value).toBe(1);
    // No explicit timestamp on this line -- the parser must assign a real,
    // current ingestion timestamp rather than a placeholder like 0 or NaN.
    expect(up!.points[0].timestampMs).toBeGreaterThan(Date.now() - 5000);
  });

  it('sorts points chronologically regardless of input line order', () => {
    const text = ['temp{sensor="a"} 10 3000', 'temp{sensor="a"} 5 1000', 'temp{sensor="a"} 7 2000'].join('\n');
    const [series] = parsePrometheusText(text);
    expect(series.points.map((p) => p.value)).toEqual([5, 7, 10]);
  });

  it('handles special float values (NaN, +Inf, -Inf) and skips malformed lines', () => {
    const text = [
      'weird_metric{} NaN 1000',
      'weird_metric{} +Inf 2000',
      'weird_metric{} -Inf 3000',
      'this is not a valid exposition-format line at all !!',
      'weird_metric{} 42 4000',
    ].join('\n');
    const [series] = parsePrometheusText(text);
    expect(series.points).toHaveLength(4);
    expect(Number.isNaN(series.points[0].value)).toBe(true);
    expect(series.points[1].value).toBe(Infinity);
    expect(series.points[2].value).toBe(-Infinity);
    expect(series.points[3].value).toBe(42);
  });

  it('parses escaped quotes and backslashes inside label values', () => {
    const text = String.raw`escaped_metric{msg="he said \"hi\"",path="C:\\temp"} 1 1000`;
    const [series] = parsePrometheusText(text);
    expect(series.labels).toEqual({ msg: 'he said "hi"', path: 'C:\\temp' });
  });

  it('returns an empty array for empty or comment-only input', () => {
    expect(parsePrometheusText('')).toEqual([]);
    expect(parsePrometheusText('# HELP x y\n# TYPE x counter\n')).toEqual([]);
  });
});
