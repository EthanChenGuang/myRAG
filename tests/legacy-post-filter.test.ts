import { describe, expect, it } from 'vitest';
import {
  applyLegacyPostFilter,
  legacyQueryTerms,
  type LegacyCandidate,
  type LegacyDocumentRow,
  type LegacyPostFilterInput,
} from '@/lib/rag-eval/legacy-post-filter';

const NO_CONTEXT = 'No relevant context found.';
const ZH_QUERY = '年度订阅可以在多少天内退款？';

function candidate(id: string, documentId: string, similarity: number, extra: Partial<LegacyCandidate> = {}): LegacyCandidate {
  return { chunk_id: id, document_id: documentId, content: `content of ${id}`, similarity, ...extra };
}

function documentRow(id: string, filename: string, content: string | null = null): LegacyDocumentRow {
  return { id, filename, content };
}

function run(
  queryText: string,
  candidates: LegacyCandidate[],
  documents: LegacyDocumentRow[],
  overrides: Partial<LegacyPostFilterInput> = {},
) {
  return applyLegacyPostFilter({
    queryText,
    candidates,
    documents: new Map(documents.map((doc) => [doc.id, doc])),
    chunkMetadata: new Map(),
    chunkUrlMetadata: new Map(),
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    ...overrides,
  });
}

describe('legacyQueryTerms', () => {
  it('yields the empty string for a Chinese query because every CJK character is stripped', () => {
    expect(legacyQueryTerms(ZH_QUERY)).toContain('');
  });

  it('strips Italian accents instead of folding them', () => {
    const terms = legacyQueryTerms('Perché il piano annuale');
    expect(terms).toContain('perch');
    expect(terms).not.toContain('perche');
    expect(terms).toEqual(['perch', 'piano', 'annuale']);
  });

  it('drops terms of three characters or fewer before stripping', () => {
    expect(legacyQueryTerms('the refund of day')).toEqual(['refund']);
  });
});

describe('Filter 1', () => {
  const docs = [documentRow('d1', 'notes.md', 'unrelated body')];

  it('drops a chunk at similarity 0.65 with no term match and no image', () => {
    const result = run('zzzz qqqq', [candidate('c1', 'd1', 0.65)], docs);
    expect(result.kept).toEqual([]);
    expect(result.context).toBe(NO_CONTEXT);
  });

  it('keeps a chunk at 0.651 with kept_by similarity', () => {
    const result = run('zzzz qqqq', [candidate('c1', 'd1', 0.651)], docs);
    expect(result.kept.map((chunk) => [chunk.chunk_id, chunk.kept_by])).toEqual([['c1', 'similarity']]);
  });

  it('keeps an image chunk at 0.26 with kept_by image and drops it at 0.25', () => {
    const imageDocs = [documentRow('d1', 'photo.png', 'unrelated body')];
    const withImage = (similarity: number) =>
      run('zzzz qqqq', [candidate('c1', 'd1', similarity, { metadata: { image_url: 'https://example.com/a.png' } })], imageDocs);

    expect(withImage(0.26).kept.map((chunk) => chunk.kept_by)).toEqual(['image']);
    expect(withImage(0.25).kept).toEqual([]);
  });

  it('keeps a low-similarity chunk whose query term appears in the document content, kept_by name', () => {
    const result = run('refund window', [candidate('c1', 'd1', 0.1)], [documentRow('d1', 'notes.md', 'the refund policy')]);
    expect(result.kept.map((chunk) => chunk.kept_by)).toEqual(['name']);
  });

  it('keeps every candidate that has a document row for a Chinese query', () => {
    const result = run(
      ZH_QUERY,
      [candidate('c1', 'd1', 0.05), candidate('c2', 'd2', 0.01), candidate('c3', 'missing', 0.9)],
      [documentRow('d1', 'a.md'), documentRow('d2', 'b.md')],
    );
    expect(result.kept.map((chunk) => chunk.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.kept.every((chunk) => chunk.kept_by === 'name')).toBe(true);
    expect(result.refused).toBe(false);
  });

  it('skips candidates whose document row is missing even at high similarity', () => {
    const result = run('zzzz', [candidate('c1', 'missing', 0.99)], docs);
    expect(result.kept).toEqual([]);
    expect(result.context).toBe(NO_CONTEXT);
  });
});

describe('Filter 2 and the strict refusal', () => {
  it('keeps a Filter 1 document at similarity 0.62 in usedDocuments', () => {
    const result = run('refund', [candidate('c1', 'd1', 0.62)], [documentRow('d1', 'notes.md', 'the refund policy')]);
    expect(result.usedDocuments.map((doc) => doc.document_id)).toEqual(['d1']);
    expect(result.refused).toBe(false);
  });

  it('keeps similarity 0.6 in Filter 2 although Filter 1 alone would need more than 0.65', () => {
    const viaName = run('refund', [candidate('c1', 'd1', 0.6)], [documentRow('d1', 'notes.md', 'the refund policy')]);
    expect(viaName.usedDocuments).toHaveLength(1);

    const withoutName = run('zzzz', [candidate('c1', 'd1', 0.6)], [documentRow('d1', 'notes.md', 'unrelated')]);
    expect(withoutName.kept).toEqual([]);
    expect(withoutName.usedDocuments).toEqual([]);
  });

  it('removes a 0.55 document with no filename match from usedDocuments but keeps the context and does not refuse', () => {
    const result = run('refund', [candidate('c1', 'd1', 0.55)], [documentRow('d1', 'notes.md', 'the refund policy')]);
    expect(result.kept).toHaveLength(1);
    expect(result.usedDocuments).toEqual([]);
    expect(result.context).not.toBe(NO_CONTEXT);
    expect(result.context).toContain('content of c1');
    expect(result.refused).toBe(false);
    expect(result.refusalReason).toBeNull();
  });

  it('keeps a 0.55 document when a query term appears in its filename', () => {
    const result = run('refund', [candidate('c1', 'd1', 0.55)], [documentRow('d1', 'refund-policy.md', 'body')]);
    expect(result.usedDocuments.map((doc) => doc.document_id)).toEqual(['d1']);
  });

  it('refuses in strict mode only when Filter 1 kept nothing', () => {
    const input: [string, LegacyCandidate[], LegacyDocumentRow[]] = [
      'zzzz qqqq',
      [candidate('c1', 'd1', 0.4)],
      [documentRow('d1', 'notes.md', 'unrelated')],
    ];

    const strict = run(...input);
    expect(strict.context).toBe(NO_CONTEXT);
    expect(strict.refused).toBe(true);
    expect(strict.refusalReason).toBe('no_relevant_context');

    expect(run(...input, { webSearchEnabled: true }).refused).toBe(false);
    expect(run(...input, { ragMode: 'balanced' }).refused).toBe(false);
    expect(run(...input, { ragMode: 'flexible' }).refused).toBe(false);
  });

  it('does not refuse an empty candidate list outside strict mode and refuses it in strict mode', () => {
    expect(run('refund', [], []).refused).toBe(true);
    expect(run('refund', [], [], { ragMode: 'balanced' }).refused).toBe(false);
  });
});

describe('context assembly', () => {
  it('excludes image documents from the context text but lists them with image_url', () => {
    const result = run(
      'zzzz',
      [
        candidate('c1', 'd1', 0.3, { metadata: { image_url: 'https://example.com/diagram.png' } }),
        candidate('c2', 'd2', 0.9),
      ],
      [documentRow('d1', 'diagram.png'), documentRow('d2', 'guide.md')],
    );

    expect(result.context).toContain('=== RELEVANT INFORMATION FROM DOCUMENTS ===');
    expect(result.context).toContain('content of c2');
    expect(result.context).not.toContain('content of c1');
    expect(result.context).not.toContain('Document: diagram.png');
    const image = result.usedDocuments.find((doc) => doc.document_id === 'd1');
    expect(image).toMatchObject({ name: 'diagram.png', image_url: 'https://example.com/diagram.png' });
  });

  it('includes a context block for an image-only retrieval so strict mode does not refuse', () => {
    const result = run(
      'zzzz',
      [candidate('c1', 'd1', 0.3, { metadata: { image_url: 'https://example.com/diagram.png' } })],
      [documentRow('d1', 'diagram.png')],
    );
    expect(result.context).not.toBe(NO_CONTEXT);
    expect(result.refused).toBe(false);
  });

  it('merges image_url from the chunk metadata lookup when the candidate has none', () => {
    const result = applyLegacyPostFilter({
      queryText: 'zzzz',
      candidates: [candidate('c1', 'd1', 0.3)],
      documents: new Map([['d1', documentRow('d1', 'diagram.png')]]),
      chunkMetadata: new Map([['c1', { image_url: 'https://example.com/lookup.png' }]]),
      chunkUrlMetadata: new Map(),
      isGPTModel: false,
      ragMode: 'strict',
      webSearchEnabled: false,
    });
    expect(result.kept.map((chunk) => chunk.kept_by)).toEqual(['image']);
    expect(result.usedDocuments[0].image_url).toBe('https://example.com/lookup.png');
  });

  it('labels chunks with a Source line for GPT models when the chunk number is known', () => {
    const chunk = candidate('c1', 'd1', 0.9, { content: 'Document: a.md. Chunk 2 of 3. Content: the body' });
    const docs = [documentRow('d1', 'a.md')];

    expect(run('zzzz', [chunk], docs, { isGPTModel: true }).context).toContain('[Source: a.md]\nthe body');
    expect(run('zzzz', [chunk], docs, { isGPTModel: false }).context).toContain('Document: a.md. Chunk 2 of 3. Content: the body');
  });

  it('orders chunks of a document by chunk number when present', () => {
    const result = run(
      'zzzz',
      [
        candidate('c1', 'd1', 0.9, { content: 'Chunk 2 of 3 second' }),
        candidate('c2', 'd1', 0.8, { content: 'Chunk 1 of 3 first' }),
      ],
      [documentRow('d1', 'a.md')],
    );
    expect(result.context.indexOf('Chunk 1 of 3 first')).toBeLessThan(result.context.indexOf('Chunk 2 of 3 second'));
  });

  it('lets a chunk that failed Filter 1 ride in on its document and inherit the document kept_by', () => {
    const result = run(
      'zzzz',
      [candidate('c1', 'd1', 0.9), candidate('c2', 'd1', 0.1)],
      [documentRow('d1', 'a.md')],
    );
    expect(result.kept.map((chunk) => [chunk.chunk_id, chunk.kept_by])).toEqual([
      ['c1', 'similarity'],
      ['c2', 'similarity'],
    ]);
    expect(result.kept.map((chunk) => chunk.rank)).toEqual([1, 2]);
  });
});
