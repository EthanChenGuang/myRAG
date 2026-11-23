import { describe, expect, test, vi } from 'vitest';
import { hybridRerank as legacyHybridRerank } from '@/lib/reranker-local';
import { assembleVoiceResults, enrichVoiceCandidates } from '@/lib/rag/context/voice';
import { hybridRerank, type ChunkWithScore } from '@/lib/rag/rerank/local-hybrid';
import { mintScope } from '@/lib/rag/tenant/scope';
import { deriveVoiceKeywords, voiceKeywordFallback, type VoiceChunk } from '@/lib/rag/voice/keyword-fallback';
import { opsOf, recordingAdmin, type RecordedCall } from './helpers/recording-admin';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const DOC_1 = '00000000-0000-4000-8000-0000000000d1';
const DOC_2 = '00000000-0000-4000-8000-0000000000d2';

const WORDS = ['refund', 'window', 'policy', 'logo', 'brand', 'creator', 'warehouse', 'floorplan', 'shipping', 'invoice', 'support', 'onboarding'];

function seededChunks(seed: number, count: number): ChunkWithScore[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => ({
    chunk_id: `chunk-${seed}-${index}`,
    document_id: `doc-${index % 4}`,
    content: Array.from({ length: 6 + Math.floor(next() * 20) }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' '),
    similarity: Math.round(next() * 1000) / 1000,
    metadata: { name: `item-${index}` },
  }));
}

describe('hybridRerank re-homed', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('matches the legacy implementation for seeded candidate set %i', (seed) => {
    const chunks = seededChunks(seed, 8 + seed);
    const query = 'refund window policy for the logo';
    const expected = legacyHybridRerank(query, structuredClone(chunks), { topK: 5, includeScores: true });
    const actual = hybridRerank(query, structuredClone(chunks), { topK: 5, includeScores: true });
    expect(actual).toEqual(expected);
    expect(actual.length).toBe(5);
  });

  test('returns the input untouched when it already fits in topK', () => {
    const chunks = seededChunks(11, 3);
    expect(hybridRerank('refund', chunks, { topK: 5 })).toBe(chunks);
  });

  test('drops scores when includeScores is false, as before', () => {
    const chunks = seededChunks(12, 9);
    const expected = legacyHybridRerank('shipping invoice', structuredClone(chunks), { topK: 4, includeScores: false });
    const actual = hybridRerank('shipping invoice', structuredClone(chunks), { topK: 4, includeScores: false });
    expect(actual).toEqual(expected);
    expect(actual.every((chunk) => chunk.rerankScore === undefined)).toBe(true);
  });
});

function chunkRow(id: string, documentId: string, metadata: Record<string, unknown> = {}) {
  return { id, document_id: documentId, content: `content ${id}`, metadata };
}

function responderFor(options: { documentIds?: string[]; chunks?: Array<Record<string, unknown>> }) {
  return (call: RecordedCall) => {
    if (call.table === 'documents') return { data: (options.documentIds ?? []).map((id) => ({ id })), error: null };
    return { data: options.chunks ?? [], error: null };
  };
}

function orFilters(call: RecordedCall): string[] {
  return opsOf(call, 'or').map((args) => String(args[0]));
}

describe('voiceKeywordFallback', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  };

  test('single scope issues exactly the three query shapes and reads no documents', async () => {
    quiet();
    const { admin, calls } = recordingAdmin(responderFor({}));
    await voiceKeywordFallback({
      query: 'show me the logo',
      scope: mintScope('single', null, null),
      admin,
      signal: new AbortController().signal,
      existing: [],
    });

    expect(calls.map((call) => call.table)).toEqual(['document_chunks', 'document_chunks', 'document_chunks']);
    const [images, phrase, keywords] = calls;

    expect(opsOf(images, 'select')).toEqual([['id, document_id, content, metadata']]);
    expect(opsOf(images, 'not')).toEqual([['metadata->>image_url', 'is', 'null']]);
    expect(opsOf(images, 'limit')).toEqual([[20]]);
    expect(orFilters(images)[0]).toContain('metadata->>image_context.ilike.%logo%,metadata->>name.ilike.%logo%');

    expect(opsOf(phrase, 'select')).toEqual([['id, document_id, content, metadata']]);
    expect(orFilters(phrase)).toEqual(['metadata->>name.ilike.%logo%,metadata->>image_context.ilike.%logo%']);
    expect(opsOf(phrase, 'limit')).toEqual([[100]]);

    expect(opsOf(keywords, 'select')).toEqual([['id, document_id, content, metadata, embedding']]);
    expect(opsOf(keywords, 'limit')).toEqual([[50]]);

    for (const call of calls) expect(opsOf(call, 'in')).toEqual([]);
  });

  test('personal scope reads in-scope document ids first and restricts every chunk query to them', async () => {
    quiet();
    const { admin, calls } = recordingAdmin(responderFor({ documentIds: [DOC_1, DOC_2] }));
    await voiceKeywordFallback({
      query: 'show me the logo',
      scope: mintScope('personal', USER_A, null),
      admin,
      signal: new AbortController().signal,
      existing: [],
    });

    expect(calls[0].table).toBe('documents');
    expect(opsOf(calls[0], 'eq')).toEqual([['user_id', USER_A]]);
    expect(opsOf(calls[0], 'is')).toEqual([['organization_id', null]]);

    const chunkCalls = calls.slice(1);
    expect(chunkCalls).toHaveLength(3);
    for (const call of chunkCalls) {
      expect(call.table).toBe('document_chunks');
      expect(opsOf(call, 'in')).toEqual([['document_id', [DOC_1, DOC_2]]]);
    }
  });

  test('org scope filters documents by organization', async () => {
    quiet();
    const { admin, calls } = recordingAdmin(responderFor({ documentIds: [DOC_1] }));
    await voiceKeywordFallback({
      query: 'who created this',
      scope: mintScope('org', USER_A, ORG_O),
      admin,
      signal: new AbortController().signal,
      existing: [],
    });

    expect(calls[0].table).toBe('documents');
    expect(opsOf(calls[0], 'eq')).toEqual([['organization_id', ORG_O]]);
    expect(opsOf(calls[0], 'is')).toEqual([]);
    for (const call of calls.slice(1)) expect(opsOf(call, 'in')).toEqual([['document_id', [DOC_1]]]);
  });

  test('zero in-scope documents issues no chunk query and returns the existing candidates', async () => {
    quiet();
    const { admin, calls } = recordingAdmin(responderFor({ documentIds: [] }));
    const existing: VoiceChunk[] = [{ id: 'c1', document_id: DOC_1, content: 'x', similarity: 0.5, metadata: {} }];
    const merged = await voiceKeywordFallback({
      query: 'show me the logo',
      scope: mintScope('personal', USER_A, null),
      admin,
      signal: new AbortController().signal,
      existing,
    });

    expect(calls.map((call) => call.table)).toEqual(['documents']);
    expect(merged).toEqual(existing);
  });

  test('a query that tries to close the filter cannot inject a condition', async () => {
    quiet();
    const { admin, calls } = recordingAdmin(responderFor({}));
    await voiceKeywordFallback({
      query: 'logo),id.eq.x',
      scope: mintScope('single', null, null),
      admin,
      signal: new AbortController().signal,
      existing: [],
    });

    const filters = calls.flatMap(orFilters);
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      expect(filter).not.toContain(')');
      for (const condition of filter.split(',')) {
        expect(condition).toMatch(/^(metadata->>image_context|metadata->>name|content)\.ilike\.%[a-z0-9_%]+%$/);
      }
    }
  });

  test('merges phrase and image matches with the same scores and priorities as before', async () => {
    quiet();
    const logo = chunkRow('img-logo', DOC_1, { name: 'Brand logo', image_context: 'logo mark', image_url: 'https://example.invalid/logo.png' });
    const person = chunkRow('img-person', DOC_1, { name: 'Creator portrait', image_context: 'founder', image_url: 'https://example.invalid/p.png' });
    const { admin } = recordingAdmin(responderFor({ chunks: [logo, person] }));
    const merged = await voiceKeywordFallback({
      query: 'show me the logo',
      scope: mintScope('single', null, null),
      admin,
      signal: new AbortController().signal,
      existing: [{ id: 'img-logo', document_id: DOC_1, content: 'v', similarity: 0.2, metadata: {} }],
    });

    const boosted = merged.find((chunk) => chunk.id === 'img-logo');
    expect(boosted?.similarity).toBe(3.0);
    expect(merged.filter((chunk) => chunk.id === 'img-person').every((chunk) => chunk.similarity !== 3.0)).toBe(true);
  });
});

describe('deriveVoiceKeywords', () => {
  test('keeps the possessive and punctuation cleaning byte-identical', () => {
    expect(deriveVoiceKeywords("show me myRAG's logo!")).toEqual({
      cleanQuery: 'show me myrag logo',
      keywords: ['myrag', 'logo'],
      searchKeywords: ['myrag', 'logo', 'icon', 'symbol'],
    });
  });

  test('long queries produce no keywords', () => {
    const query = Array.from({ length: 15 }, () => 'word').join(' ');
    expect(deriveVoiceKeywords(query)).toEqual({ cleanQuery: '', keywords: [], searchKeywords: [] });
  });
});

describe('assembleVoiceResults', () => {
  const brand: VoiceChunk = {
    id: 'brand',
    document_id: DOC_1,
    content: 'brand text',
    similarity: 0.7,
    metadata: { name: 'Brand logo', image_context: 'logo', image_url: 'https://example.invalid/logo.png', type: 'image/png' },
  };
  const person: VoiceChunk = {
    id: 'person',
    document_id: DOC_1,
    content: 'person text',
    similarity: 0.6,
    metadata: { name: 'Creator portrait', image_context: 'founder', image_url: 'https://example.invalid/p.png' },
  };

  test('enrichment appends the metadata suffix and normalises ids', () => {
    const [enriched] = enrichVoiceCandidates([{ chunk_id: 'raw', content: 'body', similarity: 0.4, metadata: { name: 'N', image_context: 'ctx', document_title: 'T' } }]);
    expect(enriched).toEqual({
      chunk_id: 'raw',
      document_id: 'unknown',
      content: 'body\n[Metadata: ctx N T]',
      similarity: 0.4,
      metadata: { name: 'N', image_context: 'ctx', document_title: 'T' },
    });
  });

  test('similarity prefers the rerank score and image_url falls back to null', () => {
    const { results } = assembleVoiceResults({
      query: 'refund policy',
      chunks: [{ chunk_id: 'a', document_id: 'd', content: 'x', similarity: 0.5, rerankScore: 0.9, metadata: {} }],
      matchCount: 5,
    });
    expect(results).toEqual([{ chunk_id: 'a', document_id: 'd', content: 'x', similarity: 0.9, rerankScore: 0.9, metadata: {}, image_url: null }]);
  });

  test('a logo query keeps only logo images', () => {
    const { source_images } = assembleVoiceResults({ query: 'what does the logo look like', chunks: enrichVoiceCandidates([brand, person]), matchCount: 5 });
    expect(source_images).toEqual([{ url: 'https://example.invalid/logo.png', name: 'Brand logo', type: 'image/png' }]);
  });

  test('a person query keeps only the creator image and defaults the type', () => {
    const { source_images } = assembleVoiceResults({ query: 'who created this', chunks: enrichVoiceCandidates([brand, person]), matchCount: 5 });
    expect(source_images).toEqual([{ url: 'https://example.invalid/p.png', name: 'Creator portrait', type: 'image/jpeg' }]);
  });

  test('a general query hides the person when a logo is present', () => {
    const { source_images } = assembleVoiceResults({ query: 'tell me about the product', chunks: enrichVoiceCandidates([brand, person]), matchCount: 5 });
    expect(source_images.map((image) => image.name)).toEqual(['Brand logo']);
  });
});
