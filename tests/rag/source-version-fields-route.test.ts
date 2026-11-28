import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalResult, UsedDocument } from '@/lib/rag/types';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../helpers/chat-route-fakes';

/**
 * D-13, D-21: the chat route copies version, isCurrent, effectiveFrom, effectiveTo and alsoIn from each used document onto its
 * document source entries, and only when the used document has them. The used documents come from the real retrieval; the test
 * adds the fields the version-scope and diversity stages would set (covered end to end in tests/rag-db). Synthetic text only.
 */
const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    decorate: null as null | ((doc: UsedDocument) => UsedDocument),
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  return {
    ...actual,
    runRetrieval: async (...args: Parameters<typeof actual.runRetrieval>): Promise<RetrievalResult> => {
      const result = await actual.runRetrieval(...args);
      const decorate = h.decorate;
      return decorate ? { ...result, usedDocuments: result.usedDocuments.map((doc) => decorate(doc)) } : result;
    },
  };
});

const FIELDS = ['version', 'isCurrent', 'effectiveFrom', 'effectiveTo', 'alsoIn'] as const;
const ALSO_IN = [{ documentId: 'doc-copy-1', filename: 'quell-copy-1.md', chunkId: 'chunk-copy-1' }];

function seed() {
  h.supabase.store.documents = [
    { id: 'doc-old', filename: 'quell-guide-v1.md', created_at: '2026-01-01T00:00:00.000Z', content: 'Quell guide one', metadata: {} },
    { id: 'doc-new', filename: 'quell-guide-v2.md', created_at: '2026-02-01T00:00:00.000Z', content: 'Quell guide two', metadata: {} },
  ];
  h.supabase.store.document_chunks = [
    { id: 'chunk-old', document_id: 'doc-old', metadata: null },
    { id: 'chunk-new', document_id: 'doc-new', metadata: null },
  ];
  const chunk = (chunk_id: string, document_id: string, content: string, similarity: number) => ({
    chunk_id,
    document_id,
    content,
    similarity,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  });
  h.retrieval.mockResolvedValue(
    retrievalWith([
      chunk('chunk-old', 'doc-old', 'The quell guide lists four calm steps for the dial.', 0.92),
      chunk('chunk-new', 'doc-new', 'The quell guide lists five calm steps for the dial.', 0.9),
    ]),
  );
}

async function run() {
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  const response = await POST(
    chatRequest({ messages: [{ role: 'user', content: 'quell guide calm steps dial' }], data: { ragMode: 'strict', settings: { webSearch: false } } }),
  );
  await readSse(response);
  const toolResults: Array<Record<string, any>> = [];
  await h.capture.calls[0].onStepFinish({ text: '', toolCalls: [], toolResults });
  const documents = toolResults.find((part) => part.toolName === 'query_documents')?.output.documents as Array<Record<string, unknown>>;
  const metadata = toolResults.find((part) => part.type === 'metadata')?.usedDocuments as Array<Record<string, unknown>>;
  return { documents, metadata, toolResults };
}

const strip = (parts: Array<Record<string, any>>) => JSON.stringify(parts).replace(/document-sources-\d+/g, 'document-sources-<t>');

describe('chat route document sources: version and alsoIn fields (D-13, D-21)', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.decorate = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seed();
  });

  afterEach(() => {
    h.decorate = null;
    vi.restoreAllMocks();
  });

  it('carries the version fields of a superseded and a current version on both source parts', async () => {
    h.decorate = (doc) =>
      doc.id === 'doc-old'
        ? { ...doc, version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: null }
        : { ...doc, version: 2, isCurrent: true, effectiveFrom: null, effectiveTo: null };
    const { documents, metadata } = await run();
    expect(documents.map((doc) => doc.id).sort()).toEqual(['doc-new', 'doc-old']);
    for (const list of [documents, metadata]) {
      const old = list.find((doc) => doc.id === 'doc-old')!;
      expect(old).toMatchObject({ version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: null });
      expect(old).not.toHaveProperty('alsoIn');
      const current = list.find((doc) => doc.id === 'doc-new')!;
      expect(current).toMatchObject({ version: 2, isCurrent: true, effectiveFrom: null, effectiveTo: null });
    }
  });

  it('carries alsoIn on the kept document', async () => {
    h.decorate = (doc) => (doc.id === 'doc-old' ? { ...doc, alsoIn: ALSO_IN } : doc);
    const { documents, metadata } = await run();
    expect(documents.find((doc) => doc.id === 'doc-old')!.alsoIn).toEqual(ALSO_IN);
    expect(metadata.find((doc) => doc.id === 'doc-old')!.alsoIn).toEqual(ALSO_IN);
    const other = documents.find((doc) => doc.id === 'doc-new')!;
    for (const field of FIELDS) expect(other).not.toHaveProperty(field);
  });

  it('without the fields the persisted parts are byte-identical to an undecorated request', async () => {
    const plain = await run();
    for (const list of [plain.documents, plain.metadata]) {
      for (const doc of list) for (const field of FIELDS) expect(doc).not.toHaveProperty(field);
    }
    h.capture.reset();
    h.decorate = (doc) => ({ ...doc });
    const identity = await run();
    expect(strip(identity.toolResults)).toBe(strip(plain.toolResults));
  });
});
