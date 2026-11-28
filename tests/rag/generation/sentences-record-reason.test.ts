import { describe, expect, it } from 'vitest';
import { AnswerChecksSchema, AnswerSentenceSchema } from '@/lib/rag-eval/contracts.generated';
import { buildAnswerChecksInput } from '@/lib/rag/generation/answer-checks';
import { answerTextHash, buildSentenceRecords } from '@/lib/rag/generation/sentences-record';
import { runAnswerChain } from '../../helpers/answer-chain';

const TEXT = 'Alpha is one [S1]. Beta is two.';

function sentence(overrides: Record<string, unknown>) {
  return {
    index: 0,
    part: 0,
    start: 0,
    end: 10,
    kind: 'sentence',
    text_hash: answerTextHash(TEXT),
    factual: true,
    cited: false,
    ...overrides,
  };
}

describe('not_checked sentences carry a reason on the chat path (GEN-09, GEN-10)', () => {
  it('per-sentence on, claim check off: every record is not_checked with reason claim_check_off', async () => {
    const out = await runAnswerChain({ pieces: [TEXT], citations: true, perSentence: true });
    const records = out.collector.sentences();
    expect(records).toHaveLength(2);
    for (const record of records ?? []) {
      expect(record.support).toBe('not_checked');
      expect(record.reason).toBe('claim_check_off');
      expect(AnswerSentenceSchema.safeParse(record).success).toBe(true);
    }
    const metadata = out.finishMetadata?.sentences as Array<Record<string, unknown>>;
    expect(metadata.map((record) => record.reason)).toEqual(['claim_check_off', 'claim_check_off']);
  });

  it('claim check on: records start as not_checked with reason claim_check_not_run until the check labels them', async () => {
    const out = await runAnswerChain({ pieces: [TEXT], citations: true, claimCheck: true });
    const checks = buildAnswerChecksInput({ collector: out.collector });
    expect(checks.sentences?.map((record) => record.reason)).toEqual(['claim_check_not_run', 'claim_check_not_run']);
    expect(AnswerChecksSchema.safeParse(checks).success).toBe(true);
  });

  it('buildSentenceRecords defaults to claim_check_off and takes claim_check_not_run when the check will run', () => {
    const aliases = new Set(['S1']);
    const off = buildSentenceRecords({ text: TEXT, part: 0, language: 'en', aliases });
    expect(off.map((record) => record.reason)).toEqual(['claim_check_off', 'claim_check_off']);
    const on = buildSentenceRecords({ text: TEXT, part: 0, language: 'en', aliases, claimCheck: true });
    expect(on.map((record) => record.reason)).toEqual(['claim_check_not_run', 'claim_check_not_run']);
  });

  it('the generated Zod schema enforces the Pydantic rule: not_checked needs a reason', () => {
    expect(AnswerSentenceSchema.safeParse(sentence({ support: 'not_checked', reason: null })).success).toBe(false);
    expect(AnswerSentenceSchema.safeParse(sentence({ reason: null })).success).toBe(false);
    expect(AnswerSentenceSchema.safeParse(sentence({})).success).toBe(false);
    expect(AnswerSentenceSchema.safeParse(sentence({ support: 'not_checked', reason: 'claim_check_off' })).success).toBe(true);
    expect(AnswerSentenceSchema.safeParse(sentence({ support: 'supported', scorer: 'hhem_2_1_open', reason: null })).success).toBe(true);
  });
});

describe('records stored before the reason rule keep loading', () => {
  it('message metadata and stored checks with reason null read back as claim_check_off', async () => {
    const { pickAnswerMetadata } = await import('@/lib/chat/answer-metadata');
    const legacy = sentence({ support: 'not_checked', reason: null });
    const picked = pickAnswerMetadata({ sentences: [legacy], checks: { truncated: false, finish_reason: 'stop', sentences: [legacy] } });
    expect(picked.sentences?.map((record) => record.reason)).toEqual(['claim_check_off']);
    expect(picked.checks?.sentences?.map((record) => record.reason)).toEqual(['claim_check_off']);
  });
});
