import { describe, expect, it } from 'vitest';
import { lexicalTokens, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import {
  bm25Scores,
  bm25ScoresWithStats,
  createLocalBm25Reranker,
  LOCAL_BM25_POOL_MODEL,
  LOCAL_BM25_TENANT_MODEL,
} from '@/lib/rag/rerank/local-bm25';
import type { LocalStatsGroup, LocalStatsProvider } from '@/lib/rag/rerank/types';
import { lcg } from '../../helpers/neutral-lexical-corpus';

/** 04.4-21 (D-55, D-56): local_bm25 with supplied tenant statistics. Neutral synthetic words only (D-41). */
const WORDS = ['amber', 'cobalt', 'river', 'panel', 'marker', 'gauge', 'north', 'tile', 'row', 'seven', 'lantern', 'meadow', 'copper', 'harbor'];
const K1 = 1.2;
const B = 0.75;

function seededPool(seed: number, size: number): string[] {
  const random = lcg(seed);
  return Array.from({ length: size }, () =>
    Array.from({ length: 3 + Math.floor(random() * 12) }, () => WORDS[Math.floor(random() * WORDS.length)] as string).join(' '),
  );
}

function fixedStats(seed: number): LocalStatsGroup {
  const random = lcg(seed);
  const df = new Map<string, number>();
  for (const word of WORDS) if (random() < 0.85) df.set(word, 1 + Math.floor(random() * 400));
  return { chunkCount: 500, totalLength: 500 * 11, df };
}

/** An independent BM25 reference over supplied statistics (df clamped to [1, N], a term without a counter has df 1). */
function referenceRaw(query: string[], doc: string[], stats: LocalStatsGroup): number {
  const n = stats.chunkCount;
  const avgdl = stats.totalLength / n;
  let score = 0;
  for (const term of query) {
    const tf = doc.filter((t) => t === term).length;
    if (tf === 0) continue;
    const df = Math.min(Math.max(stats.df.get(term) ?? 0, 1), n);
    score += Math.log((n - df + 0.5) / (df + 0.5)) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgdl)));
  }
  return score;
}

function provider(
  groupByDoc: Array<string | null>,
  answer: (terms: string[], groups: string[]) => ReadonlyMap<string, LocalStatsGroup> | null | Promise<never>,
): LocalStatsProvider & { calls: Array<{ terms: string[]; groups: string[] }> } {
  const calls: Array<{ terms: string[]; groups: string[] }> = [];
  return {
    groupByDoc,
    calls,
    async read(terms, groups) {
      calls.push({ terms, groups });
      return answer(terms, groups);
    },
  };
}

function orderOf(scores: number[], keys: string[]): string[] {
  return keys
    .map((key, index) => ({ key, score: scores[index] as number, index }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((entry) => entry.key);
}

const signal = () => AbortSignal.timeout(5000);

describe('local_bm25 pool mode is unchanged (D-54)', () => {
  it('without a provider the scores equal bm25Scores, the model is bm25-v2 and no localStats field is reported', async () => {
    const reranker = createLocalBm25Reranker();
    expect(reranker.model).toBe(LOCAL_BM25_POOL_MODEL);
    for (const seed of [1, 2, 3]) {
      const docs = seededPool(seed, 30);
      const query = 'cobalt river marker';
      const out = await reranker.rerank(query, docs, { signal: signal() });
      const expected = bm25Scores(docs.map(() => queryLexicalTokens(query)), docs.map((d) => lexicalTokens(d)));
      expect(out.scores.map((s) => s.score)).toEqual(expected);
      expect(out).toEqual({ scores: out.scores });
    }
  });
});

describe('local_bm25 with tenant statistics (D-56)', () => {
  it('scores equal a reference BM25 over the supplied statistics; model bm25-v3-tenant', async () => {
    const docs = seededPool(7, 25);
    const stats = fixedStats(7);
    const query = 'amber panel seven';
    const p = provider(docs.map(() => 'g'), () => new Map([['g', stats]]));
    const out = await createLocalBm25Reranker().rerank(query, docs, { signal: signal(), localStats: p });
    expect(out.localStats).toBe('tenant');
    expect(out.model).toBe(LOCAL_BM25_TENANT_MODEL);
    const q = queryLexicalTokens(query);
    const raw = docs.map((d) => referenceRaw(q, lexicalTokens(d), stats));
    const max = Math.max(...raw, 0);
    out.scores.forEach((s, i) => expect(s.score).toBeCloseTo(max === 0 ? 0 : (raw[i] as number) / max, 12));
    expect(p.calls).toHaveLength(1);
    expect(new Set(p.calls[0]?.terms)).toEqual(new Set(q));
    expect(p.calls[0]?.groups).toEqual(['g']);
  });

  it('per-document groups read their own statistics', async () => {
    const docs = ['cobalt cobalt river', 'cobalt river'];
    const a = fixedStats(11);
    const b = { chunkCount: 40, totalLength: 120, df: new Map([['cobalt', 39], ['river', 2]]) };
    const p = provider(['a', 'b'], () => new Map([['a', a], ['b', b]]));
    const out = await createLocalBm25Reranker().rerank('cobalt river', docs, { signal: signal(), localStats: p });
    const expected = bm25ScoresWithStats(docs.map(() => queryLexicalTokens('cobalt river')), docs.map((d) => lexicalTokens(d)), [a, b]);
    expect(out.scores.map((s) => s.score)).toEqual(expected);
    expect(p.calls[0]?.groups.sort()).toEqual(['a', 'b']);
  });

  it('property: adding, removing or replacing other candidates never changes the relative order of the remaining ones', () => {
    const stats = fixedStats(3);
    const query = queryLexicalTokens('copper harbor lantern tile');
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = lcg(seed * 13);
      const pool = seededPool(seed, 20).map((text, i) => ({ key: `k${i}`, tokens: lexicalTokens(text) }));
      const score = (rows: typeof pool) => bm25ScoresWithStats(rows.map(() => query), rows.map((r) => r.tokens), rows.map(() => stats));
      const base = orderOf(score(pool), pool.map((r) => r.key));
      const kept = pool.filter(() => random() < 0.6);
      const extra = seededPool(seed + 1000, 1 + Math.floor(random() * 10)).map((text, i) => ({ key: `x${i}`, tokens: lexicalTokens(text) }));
      const changed = [...extra.slice(0, 3), ...kept, ...extra.slice(3)];
      const after = orderOf(score(changed), changed.map((r) => r.key)).filter((key) => key.startsWith('k'));
      expect(after, `seed ${seed}`).toEqual(base.filter((key) => kept.some((r) => r.key === key)));
    }
  });

  it('pool statistics do not have that property (the reason for D-55): some seed reorders a kept pair', () => {
    const query = queryLexicalTokens('copper harbor lantern tile');
    let reordered = false;
    for (let seed = 1; seed <= 40 && !reordered; seed += 1) {
      const random = lcg(seed * 13);
      const pool = seededPool(seed, 20).map((text, i) => ({ key: `k${i}`, tokens: lexicalTokens(text) }));
      const score = (rows: typeof pool) => bm25Scores(rows.map(() => query), rows.map((r) => r.tokens));
      const base = orderOf(score(pool), pool.map((r) => r.key));
      const kept = pool.filter(() => random() < 0.6);
      const extra = seededPool(seed + 1000, 1 + Math.floor(random() * 10)).map((text, i) => ({ key: `x${i}`, tokens: lexicalTokens(text) }));
      const changed = [...extra, ...kept];
      const after = orderOf(score(changed), changed.map((r) => r.key)).filter((key) => key.startsWith('k'));
      reordered = JSON.stringify(after) !== JSON.stringify(base.filter((key) => kept.some((r) => r.key === key)));
    }
    expect(reordered).toBe(true);
  });

  it('a term without a counter is scored with df 1', () => {
    const stats: LocalStatsGroup = { chunkCount: 100, totalLength: 1000, df: new Map() };
    const [score] = bm25ScoresWithStats([['meadow']], [['meadow', 'row']], [stats]);
    expect(score).toBe(1);
    expect(referenceRaw(['meadow'], ['meadow', 'row'], stats)).toBeGreaterThan(0);
  });

  it('per-variant query tokens (queryByDoc) reach the read and the scores', async () => {
    const docs = ['amber tile row', 'copper harbor'];
    const stats: LocalStatsGroup = { chunkCount: 200, totalLength: 1000, df: new Map([['amber', 5], ['tile', 9], ['copper', 3], ['harbor', 4]]) };
    const p = provider(['g', 'g'], () => new Map([['g', stats]]));
    const out = await createLocalBm25Reranker().rerank('amber tile', docs, { signal: signal(), localStats: p, queryByDoc: ['amber tile', 'copper harbor'] });
    expect(new Set(p.calls[0]?.terms)).toEqual(new Set([...queryLexicalTokens('amber tile'), ...queryLexicalTokens('copper harbor')]));
    expect(out.scores[1]?.score).toBeGreaterThan(0);
  });
});

describe('fallback to pool statistics, never a refusal (D-55)', () => {
  const docs = seededPool(9, 12);
  const query = 'river gauge north';
  const poolScores = () => bm25Scores(docs.map(() => queryLexicalTokens(query)), docs.map((d) => lexicalTokens(d)));
  const cases: Array<[string, () => LocalStatsProvider]> = [
    ['the read answers null', () => provider(docs.map(() => 'g'), () => null)],
    ['the read throws', () => provider(docs.map(() => 'g'), () => Promise.reject(new Error('boom')) as never)],
    ['a document has no group', () => provider(docs.map((_, i) => (i === 3 ? null : 'g')), () => new Map([['g', fixedStats(1)]]))],
    ['a group is missing from the answer', () => provider(docs.map((_, i) => (i === 3 ? 'h' : 'g')), () => new Map([['g', fixedStats(1)]]))],
    ['a group holds no chunk', () => provider(docs.map(() => 'g'), () => new Map([['g', { chunkCount: 0, totalLength: 0, df: new Map() }]]))],
    ['the provider covers another number of documents', () => provider(['g'], () => new Map([['g', fixedStats(1)]]))],
  ];
  for (const [name, make] of cases) {
    it(`${name}: pool scores, model bm25-v2, localStats pool`, async () => {
      const out = await createLocalBm25Reranker().rerank(query, docs, { signal: signal(), localStats: make() });
      expect(out.localStats).toBe('pool');
      expect(out.model).toBeUndefined();
      expect(out.scores.map((s) => s.score)).toEqual(poolScores());
    });
  }

  it('an aborted read rejects (the stage timeout keeps RNK-06 behaviour)', async () => {
    const controller = new AbortController();
    const p: LocalStatsProvider = {
      groupByDoc: docs.map(() => 'g'),
      read: async () => {
        controller.abort(new Error('timeout'));
        return null;
      },
    };
    await expect(createLocalBm25Reranker().rerank(query, docs, { signal: controller.signal, localStats: p })).rejects.toThrow('timeout');
  });
});
