import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleContext, type AssembleInput, type AssemblyCandidate, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { fetchAssemblyRows } from '@/lib/rag/context/fetch-rows';
import type { ContextBlock, ReferencedState } from '@/lib/rag/types';

const BASE_SELECT = 'id, filename, created_at, content, metadata';
const DOC_A = '00000000-0000-4000-8000-0000000000d1';
const DOC_B = '00000000-0000-4000-8000-0000000000d2';
const USER_A = '00000000-0000-4000-8000-0000000000c1';

interface Call {
  table: string;
  select?: string;
  values?: string[];
}

function fakeAdmin(data: Record<string, Array<Record<string, unknown>>>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table };
      const builder = {
        select(select: string) {
          call.select = select;
          return builder;
        },
        in(_column: string, values: string[]) {
          call.values = values;
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          calls.push(call);
          const rows = (data[table] ?? []).filter((item) => (call.values ?? []).includes(String(item.id)));
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { client: client as never, calls };
}

const CANDIDATES: AssemblyCandidate[] = [
  { chunk_id: 'c1', document_id: DOC_A, content: 'first synthetic widget passage', similarity: 0.9 },
  { chunk_id: 'c2', document_id: DOC_A, content: 'second synthetic widget passage', similarity: 0.8 },
  { chunk_id: 'c3', document_id: DOC_B, content: 'third synthetic widget passage', similarity: 0.7 },
];

const DOCUMENT_ROWS = [
  { id: DOC_A, filename: 'a.md', created_at: '2026-01-01T00:00:00Z', content: null, metadata: null, user_id: USER_A },
  { id: DOC_B, filename: 'b.md', created_at: '2026-01-01T00:00:00Z', content: null, metadata: null, user_id: null },
];

function data() {
  return { documents: DOCUMENT_ROWS, document_chunks: CANDIDATES.map((candidate) => ({ id: candidate.chunk_id, metadata: null })) };
}

function input(documents: Map<string, AssemblyDocumentRow>, overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    queryText: 'synthetic widget',
    candidates: CANDIDATES,
    documents,
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'balanced',
    webSearchEnabled: false,
    applyRelevanceFilter: false,
    ...overrides,
  };
}

function blocksOf(documents: Map<string, AssemblyDocumentRow>, overrides: Partial<AssembleInput> = {}): ContextBlock[] {
  return (assembleContext(input(documents, overrides)) as { blocks: ContextBlock[] }).blocks;
}

function withoutUserId(rows: Map<string, AssemblyDocumentRow>): Map<string, AssemblyDocumentRow> {
  return new Map(
    [...rows].map(([id, row]) => {
      const { user_id: _drop, ...rest } = row as AssemblyDocumentRow & { user_id?: unknown };
      return [id, rest as AssemblyDocumentRow];
    }),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe('uploader on context blocks (D-44)', () => {
  it('switch off: the documents select is the base string and blocks carry no uploaderId key', async () => {
    vi.stubEnv('RAG_SECURITY_EVENTS', '');
    const { client, calls } = fakeAdmin(data());
    const rows = await fetchAssemblyRows(CANDIDATES, { adminClient: client, signal: new AbortController().signal });
    expect(calls.find((call) => call.table === 'documents')!.select).toBe(BASE_SELECT);
    const blocks = blocksOf(withoutUserId(rows.documents));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).not.toHaveProperty('uploaderId');
    expect(blocks).toEqual(blocksOf(withoutUserId(rows.documents)));
  });

  it('switch on: the same single documents read also selects user_id, and each block carries its uploader', async () => {
    vi.stubEnv('RAG_SECURITY_EVENTS', 'true');
    const { client, calls } = fakeAdmin(data());
    const rows = await fetchAssemblyRows(CANDIDATES, { adminClient: client, signal: new AbortController().signal });
    const documentCalls = calls.filter((call) => call.table === 'documents');
    expect(documentCalls).toHaveLength(1);
    expect(documentCalls[0]!.select).toBe(`${BASE_SELECT}, user_id`);
    expect(calls).toHaveLength(2);
    const blocks = blocksOf(rows.documents);
    const byDocument = new Map(blocks.map((block) => [block.documentId, block.uploaderId]));
    expect(byDocument.get(DOC_A)).toBe(USER_A);
    expect(byDocument.get(DOC_B)).toBeNull();
  });

  it('the uploader does not change any other block field', async () => {
    vi.stubEnv('RAG_SECURITY_EVENTS', 'true');
    const { client } = fakeAdmin(data());
    const rows = await fetchAssemblyRows(CANDIDATES, { adminClient: client, signal: new AbortController().signal });
    const on = blocksOf(rows.documents).map(({ uploaderId: _uploader, ...rest }) => rest);
    expect(on).toEqual(blocksOf(withoutUserId(rows.documents)));
  });

  it('a referenced section block takes the uploader of its document row', () => {
    const rows = new Map<string, AssemblyDocumentRow>(DOCUMENT_ROWS.map((row) => [row.id, row]));
    const referenced: ReferencedState = {
      usedDocuments: [],
      context: '',
      sections: [{ documentId: DOC_A, documentName: 'a.md', chunkIds: ['c9'], text: 'referenced synthetic section' }],
    } as unknown as ReferencedState;
    const blocks = blocksOf(rows, { candidates: [], referenced });
    expect(blocks[0]!.documentId).toBe(DOC_A);
    expect(blocks[0]!.uploaderId).toBe(USER_A);
    const plain = blocksOf(withoutUserId(rows), { candidates: [], referenced });
    expect(plain[0]).not.toHaveProperty('uploaderId');
  });
});
