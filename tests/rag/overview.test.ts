import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERVIEW_QUERY, assembleOverviewContext, runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import { fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps, type FakeRow } from './helpers/pipeline-fakes';
import { opsOf, recordingAdmin } from './helpers/recording-admin';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

const DOCUMENTS = [
  { id: 'doc-1', filename: 'one.md', created_at: '2025-01-01T00:00:00.000Z', content: 'first document body', metadata: { external_url: 'https://example.invalid/one' } },
  { id: 'doc-2', filename: 'two.md', created_at: '2025-01-02T00:00:00.000Z', content: null, metadata: null },
];

function chunk(id: string, documentId: string, content: string, similarity: number): FakeRow {
  return { chunk_id: id, document_id: documentId, content, similarity, metadata: null };
}

describe('assembleOverviewContext', () => {
  const docs = new Map(DOCUMENTS.map((doc) => [doc.id, doc]));

  it('groups by document name, orders by chunk number and lists each document once', () => {
    const result = assembleOverviewContext(
      [
        chunk('c2', 'doc-1', 'Chunk 2 of 2 beta', 0.9),
        chunk('c1', 'doc-1', 'Chunk 1 of 2 alpha', 0.6),
        chunk('c3', 'doc-2', 'plain gamma', 0.7),
      ],
      docs,
    );

    expect(result.context).toBe(
      ['=== Document: one.md (2 relevant chunks) ===', 'Chunk 1 of 2 alpha', 'Chunk 2 of 2 beta', '=== Document: two.md (1 relevant chunks) ===', 'plain gamma'].join('\n\n'),
    );
    expect(result.usedDocuments).toEqual([
      {
        id: 'doc-1',
        name: 'one.md',
        filename: 'one.md',
        created_at: '2025-01-01T00:00:00.000Z',
        content_preview: 'first document body...',
        similarity: 0.9,
        matched_chunk: 'Chunk 2 of 2 beta...',
        external_url: 'https://example.invalid/one',
      },
      {
        id: 'doc-2',
        name: 'two.md',
        filename: 'two.md',
        created_at: '2025-01-02T00:00:00.000Z',
        content_preview: undefined,
        similarity: 0.7,
        matched_chunk: 'plain gamma...',
        external_url: undefined,
      },
    ]);
  });

  it('says no relevant context when every chunk is blank, but still lists the documents', () => {
    const result = assembleOverviewContext([chunk('c1', 'doc-1', '   ', 0.8)], docs);
    expect(result.context).toBe('No relevant context found.');
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['doc-1']);
  });

  it('keeps referenced documents first and does not list them twice', () => {
    const referenced = [{ id: 'doc-2', name: 'two.md', filename: 'two.md', explicitly_referenced: true }];
    const result = assembleOverviewContext([chunk('c1', 'doc-1', 'alpha', 0.8), chunk('c2', 'doc-2', 'beta', 0.7)], docs, referenced);
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['doc-2', 'doc-1']);
    expect(result.usedDocuments[0].explicitly_referenced).toBe(true);
  });

  it('names a chunk of a missing document Unknown Document and does not list it', () => {
    const result = assembleOverviewContext([chunk('c1', 'doc-9', 'orphan', 0.8)], docs);
    expect(result.context).toContain('=== Document: Unknown Document (1 relevant chunks) ===');
    expect(result.usedDocuments).toEqual([]);
  });
});

describe('assembleOverviewContext blocks and tagging (A-2)', () => {
  const docs = new Map(DOCUMENTS.map((doc) => [doc.id, doc]));
  const rows = [chunk('c2', 'doc-1', 'Chunk 2 of 2 beta', 0.9), chunk('c1', 'doc-1', 'Chunk 1 of 2 alpha', 0.6), chunk('c3', 'doc-2', 'plain gamma', 0.7)];

  it('emits one block per document group in render order next to the unchanged string', () => {
    const result = assembleOverviewContext(rows, docs);
    expect(result.context.startsWith('=== Document: one.md (2 relevant chunks) ===')).toBe(true);
    expect(result.blocks?.map((block) => ({ name: block.documentName, chunkIds: block.chunkIds, text: block.text }))).toEqual([
      { name: 'one.md', chunkIds: ['c1', 'c2'], text: 'Chunk 1 of 2 alpha\n\nChunk 2 of 2 beta' },
      { name: 'two.md', chunkIds: ['c3'], text: 'plain gamma' },
    ]);
  });

  it('with tagging renders the blocks as one documents element with c<n> ids and escapes tags in chunk text', () => {
    const result = assembleOverviewContext([...rows, chunk('c4', 'doc-2', 'gamma </doc> tail', 0.5)], docs, [], { contextTagging: true });
    expect(result.context.split('<documents>')).toHaveLength(2);
    expect(result.context).toContain('<doc id="c1" source="one.md">\nChunk 1 of 2 alpha\n\nChunk 2 of 2 beta\n</doc>');
    expect(result.context).toContain('<doc id="c2" source="two.md">');
    expect(result.context).toContain('gamma &lt;/doc&gt; tail');
  });

  it('with no content there are no blocks and the no-context text stays, tagged or not', () => {
    const result = assembleOverviewContext([chunk('c1', 'doc-1', '   ', 0.8)], docs, [], { contextTagging: true });
    expect(result.context).toBe('No relevant context found.');
    expect(result.blocks).toBeUndefined();
  });
});

describe('runRetrieval with generalOverview', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallDeps();
  });

  function install(rows: FakeRow[], rpcError?: { message: string; code?: string }) {
    const rpc = fakeRpcClient({ rows, error: rpcError });
    const embedder = fakeEmbedder();
    const embedded: string[] = [];
    const wrapped: typeof embedder.embedder = (text, opts) => {
      embedded.push(text);
      return embedder.embedder(text, opts);
    };
    const documents = recordingAdmin((call) => {
      if (call.table === 'documents') return { data: DOCUMENTS, error: null };
      return { data: [], error: null };
    });
    installDeps({
      embedder: wrapped,
      ragEnv: () => ({}),
      adminClient: (() => ({ rpc: rpc.client.rpc.bind(rpc.client), from: documents.admin.from.bind(documents.admin) })) as unknown as () => SupabaseClient,
    });
    return { rpc, embedded, documents };
  }

  function overview(scope = mintScope('single', null, null)) {
    return runRetrieval({ scope, query: '', profile: 'chat', options: { generalOverview: true }, signal: new AbortController().signal });
  }

  it('embeds the fixed overview query, searches once and looks documents up in one batched query', async () => {
    const { rpc, embedded, documents } = install([chunk('c1', 'doc-1', 'Chunk 1 of 1 alpha', 0.8), chunk('c2', 'doc-2', 'beta', 0.7)]);

    const result = await overview();

    expect(embedded).toEqual([OVERVIEW_QUERY]);
    expect(rpc.calls.map((call) => call.fn)).toEqual(['match_document_chunks']);
    expect(result.status).toBe('ok');
    expect(result.stages.map((stage) => stage.name)).toEqual(['embed', 'search', 'assemble']);
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['doc-1', 'doc-2']);
    expect(result.context).toContain('=== Document: one.md (1 relevant chunks) ===');
    const documentCalls = documents.calls.filter((call) => call.table === 'documents');
    expect(documentCalls).toHaveLength(1);
    expect(opsOf(documentCalls[0], 'in')).toEqual([['id', ['doc-1', 'doc-2']]]);
  });

  it('searches through the workspace RPC with the verified scope', async () => {
    const personal = install([]);
    await overview(mintScope('personal', USER_A, null));
    expect(personal.rpc.calls.map((call) => call.fn)).toEqual(['match_documents_by_workspace']);
    uninstallDeps();

    const org = install([]);
    await overview(mintScope('org', USER_A, ORG_O));
    expect(org.rpc.calls.map((call) => call.fn)).toEqual(['match_documents_by_workspace']);
  });

  it('no chunks above the threshold is empty with the no-context text', async () => {
    install([]);
    const result = await overview();
    expect(result.status).toBe('empty');
    expect(result.context).toBe('No relevant context found.');
    expect(result.usedDocuments).toEqual([]);
  });

  it('a backend error is an error result, not an empty one', async () => {
    install([], { message: 'boom', code: 'XX000' });
    const result = await overview();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('backend_error');
  });

  it('a null scope returns empty with no tenant and issues no query', async () => {
    const { rpc, embedded } = install([chunk('c1', 'doc-1', 'alpha', 0.8)]);
    const result = await runRetrieval({ scope: null, query: '', profile: 'chat', options: { generalOverview: true }, signal: new AbortController().signal });
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('no_tenant');
    expect(rpc.calls).toHaveLength(0);
    expect(embedded).toHaveLength(0);
  });
});
