import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickAnswerMetadata } from '@/lib/chat/answer-metadata';
import { AnswerRecordSchema, CitationRecordSchema } from '@/lib/rag-eval/contracts.generated';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'contracts', 'samples.json'), 'utf8'),
) as {
  samples: Record<string, Record<string, unknown>>;
  variants: Record<string, { model: string; value: Record<string, unknown> }>;
};

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const withdrawn = (): Record<string, unknown> => ({ ...(fixture.variants['CitationRecord:withdrawn']?.value ?? {}) });
const current = (): Record<string, unknown> => ({ ...fixture.samples.CitationRecord });

describe('withdrawn citation contract (D-36)', () => {
  it('the committed withdrawn sample has an empty quote, the empty-string hash and a timestamp', () => {
    const value = withdrawn();
    expect(fixture.variants['CitationRecord:withdrawn']?.model).toBe('CitationRecord');
    expect(value.withdrawn).toBe(true);
    expect(value.quote).toBe('');
    expect(value.quoteHash).toBe(EMPTY_SHA256);
    expect(typeof value.withdrawnAt).toBe('string');
  });

  it('the generated schema accepts the withdrawn sample and round-trips it', () => {
    const result = CitationRecordSchema.safeParse(withdrawn());
    expect(result.success).toBe(true);
    expect(result.data).toEqual(withdrawn());
  });

  it('validCitations keeps a withdrawn citation with an empty quote', () => {
    const picked = pickAnswerMetadata({ citations: [withdrawn(), current()] });
    expect(picked.citations).toHaveLength(2);
    expect(picked.citations?.[0]?.withdrawn).toBe(true);
    expect(picked.citations?.[0]?.quote).toBe('');
  });

  it('validCitations drops an empty quote without the withdrawn flag', () => {
    const noFlag = { ...current(), quote: '', quoteHash: EMPTY_SHA256 };
    const flagFalse = { ...noFlag, withdrawn: false };
    const picked = pickAnswerMetadata({ citations: [noFlag, flagFalse, current()] });
    expect(picked.citations).toEqual([current()]);
  });

  it('a citation written before this phase parses without gaining new keys', () => {
    const result = CitationRecordSchema.safeParse(current());
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('withdrawn');
    expect(result.data).not.toHaveProperty('withdrawnAt');
  });

  it('an unknown extra key is still rejected on a withdrawn citation', () => {
    expect(CitationRecordSchema.safeParse({ ...withdrawn(), rogue: true }).success).toBe(false);
  });

  it('answer record document availability accepts withdrawn', () => {
    const record = { ...fixture.samples.AnswerRecord, documents: { 'doc-a': 'withdrawn' } };
    expect(AnswerRecordSchema.safeParse(record).success).toBe(true);
  });
});
