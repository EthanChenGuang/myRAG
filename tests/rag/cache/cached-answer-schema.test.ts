import { describe, expect, it } from 'vitest';
import { CachedAnswerSchema } from '@/lib/rag-eval/contracts.generated';
import { cachedAnswer } from './fixtures';

const DOC = '00000000-0000-4000-8000-00000000d301';

function groundedness(status: 'pending' | 'scored' | 'not_checked', label: 'verified' | 'possibly_unreliable' | 'not_checked' | null) {
  return { ...cachedAnswer().groundedness, status, label };
}

const CITATION = {
  alias: 'S1',
  chunkIds: ['chunk-1'],
  documentId: DOC,
  documentName: 'sample.md',
  documentVersion: 1,
  n: 1,
  page: null,
  quote: 'A neutral quoted sentence.',
  quoteHash: 'f'.repeat(64),
  sectionPath: null,
  strategy: 'chunk-alias' as const,
};

describe('CachedAnswerSchema carries the Pydantic _storable rules (W-2)', () => {
  it('accepts scored+verified and not_checked groundedness', () => {
    expect(CachedAnswerSchema.safeParse(cachedAnswer()).success).toBe(true);
    expect(CachedAnswerSchema.safeParse(cachedAnswer({ groundedness: groundedness('scored', 'verified') })).success).toBe(true);
  });

  it.each([
    ['scored', 'possibly_unreliable'],
    ['scored', null],
    ['pending', null],
    ['pending', 'verified'],
  ] as const)('rejects groundedness status %s with label %s', (status, label) => {
    expect(CachedAnswerSchema.safeParse(cachedAnswer({ groundedness: groundedness(status, label) })).success).toBe(false);
  });

  it('rejects a refusal that carries citations; a cited answer and an uncited refusal pass', () => {
    const versions = [{ document_id: DOC, version: 1 }];
    expect(CachedAnswerSchema.safeParse(cachedAnswer({ is_refusal: true, citations: [CITATION], source_versions: versions })).success).toBe(false);
    expect(CachedAnswerSchema.safeParse(cachedAnswer({ is_refusal: false, citations: [CITATION], source_versions: versions })).success).toBe(true);
    expect(CachedAnswerSchema.safeParse(cachedAnswer({ is_refusal: true, citations: [] })).success).toBe(true);
    expect(CachedAnswerSchema.safeParse(cachedAnswer({ is_refusal: true })).success).toBe(true);
  });
});
