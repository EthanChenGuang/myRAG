import { describe, expect, it } from 'vitest';
import { bm25Scores, createLocalBm25Reranker } from '@/lib/rag/rerank/local-bm25';
import { lexicalTokens, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';

describe('bm25Scores', () => {
  it('ranks Chinese documents with XR-2000 and 保修期 first at score 1.0', () => {
    const query = '型号XR-2000保修';
    const docs = [
      '本产品无关内容，仅提及厨房用品。',
      'XR-2000 型号设备的保修期为两年，请联系支持。',
      '另一型号 ABC-100 保修一年。',
    ];
    const queryTokens = queryLexicalTokens(query);
    const perDoc = docs.map(() => queryTokens);
    const docTokens = docs.map((d) => lexicalTokens(d));
    const scores = bm25Scores(perDoc, docTokens);
    expect(scores[1]).toBe(1);
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[0]).toBe(0);
  });

  it('returns all zeros when no document matches and never NaN', () => {
    const queryTokens = queryLexicalTokens('zzzznoterm');
    const docTokens = [['alpha'], ['beta'], ['gamma']];
    const scores = bm25Scores([queryTokens, queryTokens, queryTokens], docTokens);
    expect(scores).toEqual([0, 0, 0]);
    expect(scores.every((s) => Number.isFinite(s))).toBe(true);
  });

  it('uses per-document query token lists when they differ', () => {
    const main = queryLexicalTokens('refund policy');
    const italian = queryLexicalTokens('politica di rimborso');
    const docs = ['English refund policy text here.', 'Politica di rimborso per clienti italiani.'];
    const docTokens = docs.map((d) => lexicalTokens(d));
    const scoresVariant = bm25Scores([main, italian], docTokens);
    const scoresMain = bm25Scores([main, main], docTokens);
    expect(scoresVariant[1]).toBeGreaterThanOrEqual(scoresMain[1] ?? 0);
  });
});

describe('createLocalBm25Reranker', () => {
  const reranker = createLocalBm25Reranker();

  it('exposes relative semantics and bm25-v2 model', () => {
    expect(reranker.id).toBe('local_bm25');
    expect(reranker.model).toBe('bm25-v2');
    expect(reranker.scoreSemantics).toBe('relative');
  });

  it('returns every index through completeScores in index order', async () => {
    const docs = ['doc one XR-2000', 'doc two unrelated', 'doc three 保修'];
    const { scores } = await reranker.rerank('XR-2000保修', docs, { signal: AbortSignal.timeout(5000) });
    expect(scores.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(scores[0]!.score).toBeGreaterThanOrEqual(scores[1]!.score);
  });

  it('scores an Italian document higher when queryByDoc uses the Italian variant', async () => {
    const docs = ['Refund policy in English.', 'Politica di rimborso completa.'];
    const withVariant = await reranker.rerank('refund policy', docs, {
      signal: AbortSignal.timeout(5000),
      queryByDoc: ['refund policy', 'politica di rimborso'],
    });
    const withoutVariant = await reranker.rerank('refund policy', docs, {
      signal: AbortSignal.timeout(5000),
    });
    expect(withVariant.scores[1]!.score).toBeGreaterThanOrEqual(withoutVariant.scores[1]!.score);
  });
});