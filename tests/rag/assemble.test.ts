import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  normalizeQueryText,
  type AssembleInput,
  type AssemblyCandidate,
  type AssemblyDocumentRow,
} from '@/lib/rag/context/assemble';
import { fetchAssemblyRows } from '@/lib/rag/context/fetch-rows';
import type { UsedDocument } from '@/lib/rag/types';

const NO_CONTEXT = 'No relevant context found.';
const HEADER = '\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ===';
const FOOTER = '=== END OF RELEVANT INFORMATION ===\n';

function candidate(id: string, documentId: string, similarity: number, extra: Partial<AssemblyCandidate> = {}): AssemblyCandidate {
  return { chunk_id: id, document_id: documentId, content: `content of ${id}`, similarity, ...extra };
}

function row(id: string, filename: string, extra: Partial<AssemblyDocumentRow> = {}): AssemblyDocumentRow {
  return { id, filename, created_at: '2026-01-01T00:00:00Z', content: null, metadata: null, ...extra };
}

function run(
  queryText: unknown,
  candidates: AssemblyCandidate[],
  documents: AssemblyDocumentRow[],
  overrides: Partial<AssembleInput> = {},
) {
  return assembleContext({
    queryText,
    candidates,
    documents: new Map(documents.map((doc) => [doc.id, doc])),
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
    ...overrides,
  });
}

describe('normalizeQueryText', () => {
  it('lower-cases a string', () => {
    expect(normalizeQueryText('Refund WINDOW')).toBe('refund window');
  });

  it('takes the first text part of an array and ignores other parts', () => {
    expect(normalizeQueryText([{ type: 'image', image: 'x' }, { type: 'text', text: 'Hello World' }])).toBe('hello world');
  });

  it('returns an empty string for anything else', () => {
    expect(normalizeQueryText(null)).toBe('');
    expect(normalizeQueryText([])).toBe('');
    expect(normalizeQueryText({ type: 'text' })).toBe('');
  });
});

describe('relevance filter', () => {
  const docs = [row('d1', 'notes.md', { content: 'unrelated body' })];

  it('keeps a Chinese query chunk below the similarity threshold because the empty term matches every name', () => {
    const result = run('年度订阅可以在多少天内退款？', [candidate('c1', 'd1', 0.1)], docs);
    expect(result.queryTerms).toContain('');
    expect(result.relevantChunks.map((chunk) => chunk.chunk_id)).toEqual(['c1']);
    expect(result.kept.map((chunk) => chunk.kept_by)).toEqual(['name']);
    expect(result.context).toContain('--- Document: notes.md (1 relevant chunks) ---');
  });

  it('drops a chunk at similarity 0.65 with no term match and no image, and accepts one just above', () => {
    expect(run('zzzzzz', [candidate('c1', 'd1', 0.65)], docs).context).toBe(NO_CONTEXT);
    const above = run('zzzzzz', [candidate('c1', 'd1', 0.651)], docs);
    expect(above.relevantChunks).toHaveLength(1);
    expect(above.kept[0].kept_by).toBe('similarity');
  });

  it('keeps an image chunk above 0.25 and drops it at 0.25', () => {
    const imageDocs = [row('d1', 'photo.png')];
    const withImage = (similarity: number) =>
      run('zzzzzz', [candidate('c1', 'd1', similarity, { metadata: { image_url: 'https://img.test/a.png' } })], imageDocs);
    expect(withImage(0.26).usedDocuments).toHaveLength(1);
    expect(withImage(0.26).kept[0].kept_by).toBe('image');
    expect(withImage(0.25).usedDocuments).toHaveLength(0);
  });

  it('skips a candidate whose document row is missing, but keeps its chunk when the document was referenced', () => {
    const referencedDoc: UsedDocument = {
      id: 'dref',
      name: 'ref.md',
      filename: 'ref.md',
      explicitly_referenced: true,
    };
    const result = run('zzzzzz', [candidate('c1', 'dmissing', 0.99), candidate('c2', 'dref', 0.01)], [], {
      referenced: { usedDocuments: [referencedDoc], context: '=== DOCUMENT: "ref.md" ===\nbody\n' },
    });
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['dref']);
    expect(result.relevantChunks.map((chunk) => chunk.chunk_id)).toEqual(['c2']);
    expect(result.context).not.toContain('content of c1');
    expect(result.context).toContain('content of c2');
  });

  it('keeps every candidate whose row exists when the relevance filter is off', () => {
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.01), candidate('c2', 'dmissing', 0.9)], docs, {
      applyRelevanceFilter: false,
    });
    expect(result.relevantChunks.map((chunk) => chunk.chunk_id)).toEqual(['c1']);
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['d1']);
    expect(result.context).toContain('content of c1');
  });

  it('Filter 2 drops a document kept only by content match from usedDocuments while its text stays in the context', () => {
    const contentOnly = [row('d1', 'notes.md', { content: 'the refund policy' })];
    const result = run('refund', [candidate('c1', 'd1', 0.3)], contentOnly);
    expect(result.usedDocuments).toEqual([]);
    expect(result.context).toContain('content of c1');
    expect(result.refusalCandidate).toBe(false);
  });

  it('Filter 2 keeps a document at 0.6 and one whose filename holds a query term', () => {
    const named = [row('d1', 'refund-policy.md'), row('d2', 'other.md', { content: 'refund' })];
    const result = run('refund', [candidate('c1', 'd1', 0.3), candidate('c2', 'd2', 0.6)], named);
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['d1', 'd2']);
  });
});

describe('metadata merge and urls', () => {
  it('uses the candidate image_url without a merge, but still reads urls from the row metadata', () => {
    const chunk = candidate('c1', 'd1', 0.9, { metadata: { image_url: 'https://img.test/own.png', note: 'own' } });
    const result = run('zzzzzz', [chunk], [row('d1', 'a.md')], {
      chunkMetadata: new Map([
        ['c1', { image_url: 'https://img.test/row.png', note: 'row', urls: [{ url: 'https://x.test/a', text: 'A', context: 'c', type: 'link' }] }],
      ]),
    });
    expect(result.usedDocuments[0].image_url).toBe('https://img.test/own.png');
    expect(result.links.map((link) => link.url)).toEqual(['https://x.test/a']);
  });

  it('merges row metadata over candidate metadata when the candidate has no image_url', () => {
    const chunk = candidate('c1', 'd1', 0.9, { metadata: { note: 'own' } });
    const result = run('zzzzzz', [chunk], [row('d1', 'a.png')], {
      chunkMetadata: new Map([['c1', { image_url: 'https://img.test/row.png' }]]),
    });
    expect(result.usedDocuments[0].image_url).toBe('https://img.test/row.png');
    expect(chunk.metadata).toEqual({ note: 'own' });
  });

  it('de-duplicates urls across chunks and appends the links section after the footer', () => {
    const link = { url: 'https://x.test/a', text: 'A', context: 'c', type: 'link' };
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.9), candidate('c2', 'd1', 0.8)], [row('d1', 'a.md')], {
      chunkMetadata: new Map([
        ['c1', { urls: [link] }],
        ['c2', { urls: [link] }],
      ]),
    });
    expect(result.links).toHaveLength(1);
    const footerAt = result.context.indexOf(FOOTER);
    expect(footerAt).toBeGreaterThan(0);
    expect(result.context.slice(footerAt + FOOTER.length)).toContain('https://x.test/a');
  });
});

describe('formatting', () => {
  it('groups two documents with the same filename into one section', () => {
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.9), candidate('c2', 'd2', 0.8)], [row('d1', 'same.md'), row('d2', 'same.md')]);
    expect(result.context.match(/--- Document: same\.md/g)).toHaveLength(1);
    expect(result.context).toContain('--- Document: same.md (2 relevant chunks) ---');
  });

  it('sorts by chunk number when both have one, else by similarity descending', () => {
    const numbered = [
      candidate('c1', 'd1', 0.9, { content: 'Document: a.md. Chunk 2 of 3. Content: second' }),
      candidate('c2', 'd1', 0.7, { content: 'Document: a.md. Chunk 1 of 3. Content: first' }),
    ];
    const result = run('zzzzzz', numbered, [row('d1', 'a.md')]);
    expect(result.context.indexOf('first')).toBeLessThan(result.context.indexOf('second'));

    const plain = run('zzzzzz', [candidate('c1', 'd1', 0.7), candidate('c2', 'd1', 0.9)], [row('d1', 'a.md')]);
    expect(plain.context.indexOf('content of c2')).toBeLessThan(plain.context.indexOf('content of c1'));
  });

  it('skips image documents in the text but still feeds sourceImages', () => {
    const result = run(
      'zzzzzz',
      [candidate('c1', 'd1', 0.9, { metadata: { image_url: 'https://img.test/a.png' } }), candidate('c2', 'd2', 0.9)],
      [row('d1', 'Chart.PNG'), row('d2', 'text.md')],
    );
    expect(result.context).not.toContain('Chart.PNG');
    expect(result.context).toContain('--- Document: text.md');
    expect(result.sourceImages).toEqual([{ name: 'Chart.PNG', size: 0, type: 'image/jpeg', url: 'https://img.test/a.png' }]);
  });

  it('rewrites source labels for GPT models only on chunks that have a chunk number', () => {
    const chunks = [
      candidate('c1', 'd1', 0.9, { content: 'Document: a.md. Chunk 1 of 2. Content: the body' }),
      candidate('c2', 'd1', 0.8, { content: 'no chunk number here' }),
    ];
    const gpt = run('zzzzzz', chunks, [row('d1', 'a.md')], { isGPTModel: true });
    expect(gpt.context).toContain('[Source: a.md]\nthe body');
    expect(gpt.context).toContain('no chunk number here');
    expect(gpt.context).not.toContain('[Source: a.md]\nno chunk number here');
    const plain = run('zzzzzz', chunks, [row('d1', 'a.md')], { isGPTModel: false });
    expect(plain.context).toContain('Document: a.md. Chunk 1 of 2. Content: the body');
  });

  it('wraps the groups in the fixed header and footer', () => {
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.9)], [row('d1', 'a.md')]);
    expect(result.context).toBe(
      [HEADER, '\n--- Document: a.md (1 relevant chunks) ---', 'content of c1', FOOTER].join('\n\n'),
    );
  });
});

describe('used documents', () => {
  it('returns the full chat shape with previews and the external url', () => {
    const body = 'x'.repeat(300);
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.9, { content: 'y'.repeat(200) })], [
      row('d1', 'a.md', { content: body, metadata: { external_url: 'https://ext.test/a' } }),
    ]);
    expect(result.usedDocuments).toEqual([
      {
        id: 'd1',
        name: 'a.md',
        filename: 'a.md',
        created_at: '2026-01-01T00:00:00Z',
        content_preview: `${'x'.repeat(200)}...`,
        similarity: 0.9,
        matched_chunk: `${'y'.repeat(150)}...`,
        explicitly_referenced: false,
        image_url: undefined,
        external_url: 'https://ext.test/a',
      },
    ]);
  });

  it('raises similarity and matched_chunk to the best chunk of a document', () => {
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.7), candidate('c2', 'd1', 0.95)], [row('d1', 'a.md')]);
    expect(result.usedDocuments[0].similarity).toBe(0.95);
    expect(result.usedDocuments[0].matched_chunk).toBe('content of c2...');
  });
});

describe('referenced documents', () => {
  const referencedDoc: UsedDocument = {
    id: 'dref',
    name: 'ref.md',
    filename: 'ref.md',
    explicitly_referenced: true,
    similarity: 1,
  };
  const referenced = { usedDocuments: [referencedDoc], context: '=== DOCUMENT: "ref.md" ===\nreferenced body\n' };

  it('puts the referenced section before the semantic section and keeps the document through Filter 2', () => {
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.9)], [row('d1', 'a.md')], { referenced });
    expect(result.context.startsWith(referenced.context)).toBe(true);
    expect(result.context.indexOf('referenced body')).toBeLessThan(result.context.indexOf('--- Document: a.md'));
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['dref', 'd1']);
  });

  it('does not mutate the referenced state it was given', () => {
    const given = { ...referencedDoc, similarity: 0.1 };
    run('zzzzzz', [candidate('c1', 'dref', 0.99)], [row('dref', 'ref.md')], { referenced: { usedDocuments: [given], context: '' } });
    expect(given.similarity).toBe(0.1);
  });
});

describe('refusal candidate', () => {
  const lowChunk = [candidate('c1', 'd1', 0.1)];
  const docs = [row('d1', 'notes.md')];

  it('is true in strict mode without web search when nothing survived', () => {
    const result = run('zzzzzz', lowChunk, docs);
    expect(result.context).toBe(NO_CONTEXT);
    expect(result.refusalCandidate).toBe(true);
  });

  it('is false with web search, in balanced mode, or when a document survived', () => {
    expect(run('zzzzzz', lowChunk, docs, { webSearchEnabled: true }).refusalCandidate).toBe(false);
    expect(run('zzzzzz', lowChunk, docs, { ragMode: 'balanced' }).refusalCandidate).toBe(false);
    expect(run('zzzzzz', [candidate('c1', 'd1', 0.9)], docs).refusalCandidate).toBe(false);
  });

  it('is true for an empty candidate list', () => {
    const result = run('zzzzzz', [], []);
    expect(result.context).toBe(NO_CONTEXT);
    expect(result.refusalCandidate).toBe(true);
  });
});

describe('kept chunks', () => {
  it('numbers ranks by candidate order and names the document', () => {
    const result = run('zzzzzz', [candidate('c1', 'd1', 0.9), candidate('c2', 'dx', 0.9), candidate('c3', 'd1', 0.7)], [row('d1', 'a.md')]);
    expect(result.kept.map((chunk) => [chunk.chunk_id, chunk.rank, chunk.document_name])).toEqual([
      ['c1', 1, 'a.md'],
      ['c3', 3, 'a.md'],
    ]);
  });
});

interface Call {
  table: string;
  select: string;
  column: string;
  values: string[];
  signal: AbortSignal | undefined;
}

function fakeAdmin(data: Record<string, Array<Record<string, unknown>>>, options: { error?: string } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Partial<Call> = { table };
      const builder = {
        select(select: string) {
          call.select = select;
          return builder;
        },
        in(column: string, values: string[]) {
          call.column = column;
          call.values = values;
          return builder;
        },
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          calls.push(call as Call);
          const rows = (data[table] ?? []).filter((item) => (call.values ?? []).includes(String(item.id)));
          const response = options.error ? { data: null, error: { message: options.error } } : { data: rows, error: null };
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { client: client as never, calls };
}

describe('fetchAssemblyRows', () => {
  const candidates = [
    candidate('c1', 'd1', 0.9),
    candidate('c2', 'd1', 0.8),
    candidate('c3', 'd2', 0.7),
  ];
  const data = {
    documents: [
      { id: 'd1', filename: 'a.md', created_at: 'x', content: 'body', metadata: null },
      { id: 'd2', filename: 'b.md', created_at: 'x', content: 'body', metadata: { external_url: 'u' } },
    ],
    document_chunks: [
      { id: 'c1', metadata: { urls: [] } },
      { id: 'c2', metadata: null },
      { id: 'c3', metadata: { image_url: 'i' } },
    ],
  };

  it('issues exactly one documents query and one document_chunks query with de-duplicated ids and the signal', async () => {
    const { client, calls } = fakeAdmin(data);
    const controller = new AbortController();
    const rows = await fetchAssemblyRows(candidates, { adminClient: client, signal: controller.signal });
    expect(calls.map((call) => call.table).sort()).toEqual(['document_chunks', 'documents']);
    const documents = calls.find((call) => call.table === 'documents')!;
    const chunks = calls.find((call) => call.table === 'document_chunks')!;
    expect(documents.select).toBe('id, filename, created_at, content, metadata');
    expect(documents.column).toBe('id');
    expect(documents.values).toEqual(['d1', 'd2']);
    expect(chunks.select).toBe('id, metadata');
    expect(chunks.column).toBe('id');
    expect(chunks.values).toEqual(['c1', 'c2', 'c3']);
    expect(documents.signal).toBe(controller.signal);
    expect(chunks.signal).toBe(controller.signal);
    expect([...rows.documents.keys()].sort()).toEqual(['d1', 'd2']);
    expect(rows.chunkMetadata.get('c3')).toEqual({ image_url: 'i' });
    expect(rows.chunkMetadata.get('c2')).toBeNull();
  });

  it('issues no query for an empty candidate list', async () => {
    const { client, calls } = fakeAdmin(data);
    const rows = await fetchAssemblyRows([], { adminClient: client, signal: new AbortController().signal });
    expect(calls).toEqual([]);
    expect(rows.documents.size).toBe(0);
  });

  it('throws on a query error', async () => {
    const { client } = fakeAdmin(data, { error: 'boom' });
    await expect(fetchAssemblyRows(candidates, { adminClient: client, signal: new AbortController().signal })).rejects.toThrow(/boom/);
  });

  it('throws when the signal is aborted after a query', async () => {
    const { client } = fakeAdmin(data);
    const controller = new AbortController();
    const pending = fetchAssemblyRows(candidates, { adminClient: client, signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow();
  });
});
