/**
 * D-45, SC4, SC5: the upload latency target, measured from the 202 of the upload route to a ready status read, with fake providers
 * and the always-on worker loop of the real sidecar app.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { perStage, percentile } from './latency-stats.mts';

describe('latency stats: nearest-rank percentiles and per-stage aggregation', () => {
  const oneToTwenty = Array.from({ length: 20 }, (_, index) => index + 1);

  test('stats: the nearest-rank p95 of 1..20 is 19 and the p50 is 10, in any input order', () => {
    assert.equal(percentile(oneToTwenty, 0.95), 19);
    assert.equal(percentile(oneToTwenty, 0.5), 10);
    assert.equal(percentile([...oneToTwenty].reverse(), 0.95), 19);
    assert.equal(percentile([7], 0.95), 7);
    assert.equal(percentile(oneToTwenty, 1), 20);
  });

  test('stats: an empty sample or a fraction outside (0, 1] throws', () => {
    assert.throws(() => percentile([], 0.95), /empty/);
    assert.throws(() => percentile([1, 2], 0), /fraction/);
    assert.throws(() => percentile([1, 2], 1.5), /fraction/);
  });

  test('stats: perStage gives p50 and p95 per stage name and ignores runs without that stage', () => {
    const timings = [
      ...oneToTwenty.map((value) => ({ parse: value * 10, chunk: value })),
      { embed: 5 },
      { embed: 7, parse: null },
      {},
    ];
    const stats = perStage(timings);
    assert.deepEqual(Object.keys(stats).sort(), ['chunk', 'embed', 'parse']);
    assert.deepEqual(stats.parse, { n: 20, p50: 100, p95: 190 });
    assert.deepEqual(stats.chunk, { n: 20, p50: 10, p95: 19 });
    assert.deepEqual(stats.embed, { n: 2, p50: 5, p95: 7 });
  });
});
