import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { insertAnswerRecord } from '@/lib/answers/store';
import { citedQuotesOf } from '@/lib/answers/exchange';
import { pickAnswerMetadata } from '@/lib/chat/answer-metadata';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

// 06.3-SECURITY W8: a citation quote is evidence text; an empty quote is reserved for the purge's withdrawn marker (0724),
// and a quote shorter than two code points identifies no span, so it is neither stored nor used as a cited quote.

const USER = '00000000-0000-4000-8000-0000000000a8';

function citation(quote: string, extra: Partial<CitationRecord> = {}): CitationRecord {
  return {
    n: 1,
    alias: 'S1',
    chunkIds: ['chunk-1'],
    documentId: 'doc-1',
    documentName: 'neutral.md',
    documentVersion: 1,
    page: null,
    sectionPath: null,
    quote,
    quoteHash: crypto.createHash('sha256').update(quote).digest('hex'),
    strategy: 'chunk-alias',
    ...extra,
  };
}

function fakeAdmin() {
  const upserts: unknown[] = [];
  const client = {
    from() {
      const builder = {
        upsert(payload: unknown) {
          upserts.push(payload);
          return builder;
        },
        select() {
          return Promise.resolve({ data: [{ id: 'x' }], error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, upserts };
}

function insert(admin: SupabaseClient, citations: CitationRecord[]) {
  return insertAnswerRecord(admin, {
    id: crypto.randomUUID(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'trace-1',
    modelId: 'model-1',
    citationStrategy: 'chunk-alias',
    ragMode: 'strict',
    answerLanguage: null,
    invalidCitations: 0,
    citations,
    groundedness: { status: 'not_checked' } as never,
  });
}

describe('citation quote minimum (06.3-SECURITY W8)', () => {
  it.each([
    ['empty', ''],
    ['one character', 'x'],
    ['one code point of two UTF-16 units', '\u{1F600}'],
    ['whitespace only', '   '],
  ])('the store refuses a non-withdrawn citation with a %s quote', async (_label, quote) => {
    const admin = fakeAdmin();
    await expect(insert(admin.client, [citation(quote)])).rejects.toThrow();
    expect(admin.upserts).toHaveLength(0);
  });

  it('the store keeps a two code point quote and a withdrawn marker with the empty quote', async () => {
    const admin = fakeAdmin();
    await expect(insert(admin.client, [citation('ab'), citation('', { n: 2, alias: 'S2', withdrawn: true, withdrawnAt: '2026-11-28T00:00:00.000Z' })])).resolves.toEqual({
      inserted: true,
    });
    expect(admin.upserts).toHaveLength(1);
  });

  it('message metadata drops a too-short non-withdrawn quote and keeps withdrawn markers', () => {
    const picked = pickAnswerMetadata({
      citations: [
        citation('x'),
        citation('a neutral sentence', { n: 2, alias: 'S2' }),
        citation('', { n: 3, alias: 'S3', withdrawn: true, withdrawnAt: '2026-11-28T00:00:00.000Z' }),
      ],
    });
    expect(picked.citations?.map((entry) => entry.alias)).toEqual(['S2', 'S3']);
  });

  it('cited quotes used as review and feedback context skip too-short quotes', () => {
    expect(citedQuotesOf([citation('x'), citation('\u{1F600}'), citation('a neutral sentence')])).toEqual(['a neutral sentence']);
  });
});
