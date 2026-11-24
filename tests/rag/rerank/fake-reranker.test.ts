import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeRerankScores, type FakeRerankOptions } from '../../../eval/harness/fake-reranker.mts';
import { fakeReranker } from '../helpers/pipeline-fakes';

describe('fakeRerankScores', () => {
  it('is deterministic for identical inputs', () => {
    const query = 'onboarding checklist';
    const docs = ['onboarding checklist for new hires', 'unrelated warehouse floorplan'];
    const opts: FakeRerankOptions = { languageOffsets: { zh: -0.05 } };
    const a = fakeRerankScores(query, docs, opts);
    const b = fakeRerankScores(query, docs, opts);
    expect(a).toEqual(b);
    a.forEach((score) => {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  it('scores a matching document above a non-matching one', () => {
    const query = 'refund policy window';
    const docs = ['refund policy window is thirty days', 'shipping delays to the warehouse'];
    const scores = fakeRerankScores(query, docs, {});
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });

  it('lowers zh documents by the zh offset clamped to [0, 1]', () => {
    const query = '产品保修';
    const zhDoc = '本产品保修期为一年。';
    const enDoc = 'Product warranty is one year.';
    const offset = 0.05;
    const withOffset = fakeRerankScores(query, [zhDoc, enDoc], { languageOffsets: { zh: -offset } });
    const without = fakeRerankScores(query, [zhDoc, enDoc], {});
    expect(withOffset[0]).toBeCloseTo(Math.max(0, (without[0] ?? 0) - offset), 5);
  });

  it('imports nothing from eval fixtures or golden paths', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'eval/harness/fake-reranker.mts'), 'utf8');
    expect(source).not.toMatch(/eval\/fixtures|golden/i);
    expect(source).toMatch(/export function fakeRerankScores/);
  });
});

describe('fakeReranker (pipeline-fakes)', () => {
  it('rejects after delayMs when fail is set', async () => {
    const { reranker } = fakeReranker({ delayMs: 50, fail: true, model: 'fake-quality-v1' });
    const started = Date.now();
    await expect(
      reranker.rerank('query', ['doc a', 'doc b'], { signal: AbortSignal.timeout(5000) }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('partial drops an index so rerank throws incomplete scores', async () => {
    const { reranker } = fakeReranker({ partial: true, model: 'fake-fast-v1' });
    await expect(
      reranker.rerank('query', ['doc a', 'doc b', 'doc c'], { signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow(/incomplete rerank/i);
  });

  it('honours abort before the timer fires', async () => {
    const { reranker } = fakeReranker({ delayMs: 500 });
    const controller = new AbortController();
    const pending = reranker.rerank('query', ['doc'], { signal: controller.signal });
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await expect(pending).rejects.toBeDefined();
  });
});