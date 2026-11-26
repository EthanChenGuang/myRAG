import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerSentenceSchema } from '@/lib/rag-eval/contracts.generated';
import { buildAnswerChecksInput } from '@/lib/rag/generation/answer-checks';
import { answerTextHash } from '@/lib/rag/generation/sentences-record';
import { runAnswerChain } from '../../helpers/answer-chain';

afterEach(() => vi.restoreAllMocks());

describe('finish metadata at stream end (D-20, UI-SPEC 8.1)', () => {
  it('per-sentence on: sentences of the last text part with its part index and hash', async () => {
    const out = await runAnswerChain({
      pieces: ['Alpha is one [S1]. ', 'Beta is two.'],
      options: { before: [{ pieces: ['Checking.'], toolCall: { toolName: 'lookup', input: { query: 'q' } } }] },
      citations: true,
      perSentence: true,
    });
    const sentences = out.finishMetadata?.sentences as Array<Record<string, unknown>>;
    expect(Array.isArray(sentences)).toBe(true);
    expect(sentences).toHaveLength(2);
    for (const record of sentences) {
      expect(AnswerSentenceSchema.safeParse(record).success).toBe(true);
      expect(record.part).toBe(1);
      expect(record.text_hash).toBe(answerTextHash('Alpha is one [S1]. Beta is two.'));
    }
    expect(sentences.map((record) => record.cited)).toEqual([true, false]);
    expect(out.finishMetadata?.answerLanguage).toBe('en');
    expect(out.finishMetadata?.truncated).toBe(false);
    expect(out.collector.lastTextPart()).toEqual({ index: 1, text: 'Alpha is one [S1]. Beta is two.' });
  });

  it('every switch off: the finish metadata is empty, even after a cut', async () => {
    const out = await runAnswerChain({ pieces: ['Alpha is one [S1]. Beta'], finishReason: 'length', citations: true, anyNonDefault: false });
    expect(out.collector.finishMetadata()).toEqual({});
  });

  it('per-sentence off with another switch on: no sentences key', async () => {
    const out = await runAnswerChain({ pieces: ['Alpha is one [S1].'], citations: true });
    expect(out.finishMetadata).toEqual({ answerLanguage: 'en', truncated: false });
  });

  it('claim check on, per-sentence off: records reach the checks input but not the metadata', async () => {
    const out = await runAnswerChain({ pieces: ['Alpha is one [S1]. Beta is two.'], citations: true, claimCheck: true });
    expect(out.finishMetadata?.sentences).toBeUndefined();
    const checks = buildAnswerChecksInput({ collector: out.collector });
    expect(checks.sentences).toHaveLength(2);
  });

  it('a sentinel refusal yields no records and refusal true with refusalOrigin model_relevance', async () => {
    const out = await runAnswerChain({ pieces: ['%%NO_ANSWER_IN_CONTEXT%%'], sentinel: true, perSentence: true, citations: true });
    expect(out.collector.sentences()).toBeNull();
    expect(out.finishMetadata?.sentences).toBeUndefined();
    expect(out.finishMetadata?.refusal).toBe(true);
    expect(out.finishMetadata?.refusalOrigin).toBe('model_relevance');
    expect(buildAnswerChecksInput({ collector: out.collector }).sentences).toBeUndefined();
  });

  it('logs one [Citations] line with counts only when records are computed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await runAnswerChain({ pieces: ['Alpha is one [S1]. Beta is two.'], citations: true, perSentence: true });
    out.collector.finishMetadata();
    buildAnswerChecksInput({ collector: out.collector });
    const lines = log.mock.calls.filter(([first]) => typeof first === 'string' && first.startsWith('[Citations]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({ factual: 2, cited: 1, uncited: 1 });
  });
});
