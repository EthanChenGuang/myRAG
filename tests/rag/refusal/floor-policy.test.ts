import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { legacyQueryTerms } from '@/lib/rag/context/relevance';
import { LEGACY_IMAGE_FLOOR, LEGACY_TEXT_FLOOR, legacyRuleFloor } from '@/lib/rag/refusal/floor';

const floors = { text: LEGACY_TEXT_FLOOR, image: LEGACY_IMAGE_FLOOR };

function configWarnings(warn: MockInstance<(...args: unknown[]) => void>): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[RAG Config]'));
}

describe('RAG_REFUSAL_FLOOR parse', () => {
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    resetRagConfigForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('defaults to similarity and accepts legacy_rule in any case and spacing', () => {
    expect(loadRagConfig({}).v2.refusalFloor).toBe('similarity');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: '' }).v2.refusalFloor).toBe('similarity');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'similarity' }).v2.refusalFloor).toBe('similarity');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'legacy_rule' }).v2.refusalFloor).toBe('legacy_rule');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'LEGACY_RULE ' }).v2.refusalFloor).toBe('legacy_rule');
    expect(configWarnings(warn)).toEqual([]);
  });

  it('an unknown value gives similarity with one warning', () => {
    for (let i = 0; i < 3; i += 1) expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'bogus' }).v2.refusalFloor).toBe('similarity');
    const lines = configWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('RAG_REFUSAL_FLOOR');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'bogus' }).warnings).toHaveLength(1);
  });

  it('is part of the memo key', () => {
    const a = loadRagConfig({ RAG_PIPELINE: 'v2' });
    const b = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_REFUSAL_FLOOR: 'legacy_rule' });
    expect(a).not.toBe(b);
    expect(a.v2.refusalFloor).toBe('similarity');
    expect(b.v2.refusalFloor).toBe('legacy_rule');
  });
});

describe('legacyRuleFloor', () => {
  const terms = legacyQueryTerms('where is the widget manual');

  it('is not applied without candidates', () => {
    expect(legacyRuleFloor({ candidates: [], terms, floors })).toMatchObject({ decision: 'not_applied', reason: 'no_candidates' });
  });

  it('answers on a filename term match below both floors', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: 0.2, hasImage: false, filename: 'Widget-Guide.pdf', text: 'unrelated sample text' }],
      terms,
      floors,
    });
    expect(record).toMatchObject({ decision: 'answer', basis: 'none', reason: 'query_term_match', topScore: 0.2, threshold: 0.65 });
  });

  it('answers by similarity or image with the similarity reason', () => {
    const bySimilarity = legacyRuleFloor({
      candidates: [{ similarity: 0.7, hasImage: false, filename: 'a.txt', text: 'none' }],
      terms,
      floors,
    });
    expect(bySimilarity).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', topScore: 0.7 });
    const byImage = legacyRuleFloor({
      candidates: [{ similarity: 0.3, hasImage: true, filename: 'a.png', text: '' }],
      terms,
      floors,
    });
    expect(byImage).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', topScore: 0.3 });
  });

  it('refuses when nothing passes, with the best similarity and the text floor', () => {
    const record = legacyRuleFloor({
      candidates: [
        { similarity: 0.4, hasImage: false, filename: 'a.txt', text: 'first sample passage' },
        { similarity: 0.5, hasImage: false, filename: 'b.txt', text: 'second sample passage' },
        { similarity: null, hasImage: false, filename: 'c.txt', text: 'third sample passage' },
      ],
      terms,
      floors,
    });
    expect(record).toEqual({
      decision: 'refuse',
      basis: 'similarity_floor',
      reason: 'below_similarity_floor',
      topScore: 0.5,
      threshold: 0.65,
      cellKey: null,
    });
  });

  it('refuses with a null top score when no candidate is dense', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: null, hasImage: false, filename: 'a.txt', text: 'sample passage' }],
      terms,
      floors,
    });
    expect(record).toMatchObject({ decision: 'refuse', reason: 'below_similarity_floor', topScore: null, threshold: 0.65 });
  });

  it('answers a lexical-only candidate on a term match in its text', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: null, hasImage: false, filename: 'a.txt', text: 'The Widget manual covers setup.' }],
      terms,
      floors,
    });
    expect(record).toMatchObject({ decision: 'answer', reason: 'query_term_match', topScore: null });
  });

  it('uses the floors it is given', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: 0.2, hasImage: false, filename: 'a.txt', text: 'sample' }],
      terms: [],
      floors: { text: 0.15, image: 0.1 },
    });
    expect(record).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', threshold: 0.15 });
  });
});
