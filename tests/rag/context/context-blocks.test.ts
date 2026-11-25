import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  type AssembleInput,
  type AssemblyCandidate,
  type AssemblyDocumentRow,
} from '@/lib/rag/context/assemble';
import type { CitationLabeler, ContextBlock } from '@/lib/rag/types';

function candidate(id: string, documentId: string, similarity: number, content: string): AssemblyCandidate {
  return { chunk_id: id, document_id: documentId, content, similarity };
}

function row(id: string, filename: string, extra: Partial<AssemblyDocumentRow> & Record<string, unknown> = {}): AssemblyDocumentRow {
  return { id, filename, created_at: '2026-01-01T00:00:00Z', content: null, metadata: null, ...extra };
}

function input(
  candidates: AssemblyCandidate[],
  documents: AssemblyDocumentRow[],
  overrides: Partial<AssembleInput> = {},
): AssembleInput {
  return {
    queryText: 'widgets pricing policy',
    candidates,
    documents: new Map(documents.map((doc) => [doc.id, doc])),
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'balanced',
    webSearchEnabled: false,
    applyRelevanceFilter: false,
    ...overrides,
  };
}

function blocksOf(out: unknown): ContextBlock[] {
  const blocks = (out as { blocks?: ContextBlock[] }).blocks;
  expect(Array.isArray(blocks)).toBe(true);
  return blocks ?? [];
}

function expectInOrder(context: string, parts: string[]): void {
  let from = 0;
  for (const part of parts) {
    const at = context.indexOf(part, from);
    expect(at, `missing or out of order: ${JSON.stringify(part.slice(0, 40))}`).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

const upperLabeler: CitationLabeler = (block, ordinal) => ({
  alias: `S${ordinal}`,
  header: `[S${ordinal}] ${block.title}`,
  text: block.text.toUpperCase(),
});

const gptChunk = (name: string, n: number, of: number, body: string) => `Document: ${name}. Chunk ${n} of ${of}. Content: ${body}`;

describe('legacy context blocks without a labeler', () => {
  const docs = [row('doc-A', 'alpha.pdf'), row('doc-B', 'beta.pdf')];
  const candidates = [
    candidate('a2', 'doc-A', 0.7, 'alpha second'),
    candidate('b1', 'doc-B', 0.85, 'beta only'),
    candidate('a1', 'doc-A', 0.9, 'alpha first'),
  ];

  it('returns one block per rendered chunk in render order with no alias', () => {
    const out = assembleContext(input(candidates, docs));
    const blocks = blocksOf(out);
    expect(blocks.map((block) => block.chunkIds)).toEqual([['a1'], ['a2'], ['b1']]);
    expect(blocks.every((block) => block.alias === null)).toBe(true);
    expect(blocks.map((block) => block.documentId)).toEqual(['doc-A', 'doc-A', 'doc-B']);
    expect(blocks.map((block) => block.documentName)).toEqual(['alpha.pdf', 'alpha.pdf', 'beta.pdf']);
    expect(blocks.map((block) => block.text)).toEqual(['alpha first', 'alpha second', 'beta only']);
    expectInOrder(out.context, blocks.map((block) => block.text));
  });

  it('follows groupOrder for the block order', () => {
    const out = assembleContext(input(candidates, docs, { groupOrder: ['doc-B', 'doc-A'] }));
    expect(blocksOf(out).map((block) => block.chunkIds[0])).toEqual(['b1', 'a1', 'a2']);
  });

  it('uses the content after the [Source: ...] line as the block text in the GPT form', () => {
    const gpt = [
      candidate('g2', 'doc-A', 0.9, gptChunk('alpha.pdf', 2, 3, 'Second part.')),
      candidate('g1', 'doc-A', 0.8, gptChunk('alpha.pdf', 1, 3, 'First part.')),
    ];
    const out = assembleContext(input(gpt, docs, { isGPTModel: true }));
    const blocks = blocksOf(out);
    expect(blocks.map((block) => block.text)).toEqual(['First part.', 'Second part.']);
    expectInOrder(
      out.context,
      blocks.map((block) => `[Source: alpha.pdf]\n${block.text}`),
    );
  });

  it('reads version, page and section path from the fetched rows and leaves them null otherwise', () => {
    const versioned = [row('doc-A', 'alpha.pdf', { version: 3 }), row('doc-B', 'beta.pdf')];
    const chunkMetadata = new Map<string, Record<string, unknown> | null>([
      ['a1', { page_start: 4, section_path: ['Intro', 'Scope'] }],
      ['b1', { section_path: [] }],
    ]);
    const out = assembleContext(input(candidates, versioned, { chunkMetadata: chunkMetadata as AssembleInput['chunkMetadata'] }));
    const byId = new Map(blocksOf(out).map((block) => [block.chunkIds[0], block]));
    expect(byId.get('a1')).toMatchObject({ documentVersion: 3, page: 4, sectionPath: ['Intro', 'Scope'], isImage: false });
    expect(byId.get('a1')?.title).toBe('alpha.pdf, p.4 / Intro > Scope');
    expect(byId.get('a2')).toMatchObject({ documentVersion: 3, page: null, sectionPath: null, title: 'alpha.pdf' });
    expect(byId.get('b1')).toMatchObject({ documentVersion: null, page: null, sectionPath: null, title: 'beta.pdf' });
  });

  it('gives no block to an image document and an empty list when nothing is rendered', () => {
    const imageDocs = [row('doc-I', 'photo.png'), row('doc-A', 'alpha.pdf')];
    const out = assembleContext(
      input([candidate('i1', 'doc-I', 0.9, 'a photo caption'), candidate('a1', 'doc-A', 0.8, 'alpha first')], imageDocs),
    );
    expect(blocksOf(out).map((block) => block.chunkIds)).toEqual([['a1']]);

    const empty = assembleContext(input([], docs));
    expect(empty.context).toBe('No relevant context found.');
    expect(blocksOf(empty)).toEqual([]);
  });
});

describe('legacy context blocks with a labeler', () => {
  const docs = [row('doc-A', 'alpha.pdf'), row('doc-B', 'beta.pdf')];
  const chunkMetadata = new Map<string, Record<string, unknown> | null>([
    ['img', { image_url: 'https://cdn.test/figure.png' }],
  ]);
  const candidates = [
    candidate('a1', 'doc-A', 0.9, 'alpha first'),
    candidate('img', 'doc-A', 0.8, 'figure caption text'),
    candidate('a2', 'doc-A', 0.7, 'alpha second'),
    candidate('b1', 'doc-B', 0.6, 'beta only'),
  ];

  it('writes each header on its own line before the transformed text, numbering non-image blocks only', () => {
    const seen: Array<[string, number]> = [];
    const labeler: CitationLabeler = (block, ordinal) => {
      expect(block).not.toHaveProperty('alias');
      seen.push([block.chunkIds[0]!, ordinal]);
      return upperLabeler(block, ordinal);
    };
    const out = assembleContext(input(candidates, docs, { chunkMetadata: chunkMetadata as AssembleInput['chunkMetadata'], citationLabeler: labeler }));
    const blocks = blocksOf(out);

    expect(seen).toEqual([
      ['a1', 1],
      ['a2', 2],
      ['b1', 3],
    ]);
    expect(blocks.map((block) => [block.chunkIds[0], block.alias, block.isImage])).toEqual([
      ['a1', 'S1', false],
      ['img', null, true],
      ['a2', 'S2', false],
      ['b1', 'S3', false],
    ]);
    expect(blocks.map((block) => block.text)).toEqual(['ALPHA FIRST', 'figure caption text', 'ALPHA SECOND', 'BETA ONLY']);
    expectInOrder(out.context, [
      '\n[S1] alpha.pdf\nALPHA FIRST',
      '\n\nfigure caption text',
      '\n[S2] alpha.pdf\nALPHA SECOND',
      '\n[S3] beta.pdf\nBETA ONLY',
    ]);
    expect(out.context).not.toContain('alpha first');
    expect(out.context).not.toMatch(/\[S\d+\][^\n]*\nfigure caption text/);
  });

  it('replaces the [Source: ...] line with the header in the GPT form', () => {
    const gpt = [candidate('g1', 'doc-A', 0.9, gptChunk('alpha.pdf', 1, 2, 'First part.'))];
    const out = assembleContext(input(gpt, docs, { isGPTModel: true, citationLabeler: upperLabeler }));
    expect(out.context).toContain('[S1] alpha.pdf\nFIRST PART.');
    expect(out.context).not.toContain('[Source: alpha.pdf]');
  });

  it('leaves kept, usedDocuments, sourceImages and links as without a labeler', () => {
    const base = input(candidates, docs, { chunkMetadata: chunkMetadata as AssembleInput['chunkMetadata'] });
    const plain = assembleContext(base);
    const labelled = assembleContext({ ...base, citationLabeler: upperLabeler });
    expect(labelled.kept).toEqual(plain.kept);
    expect(labelled.usedDocuments).toEqual(plain.usedDocuments);
    expect(labelled.sourceImages).toEqual(plain.sourceImages);
    expect(labelled.links).toEqual(plain.links);
    expect(labelled.context).not.toBe(plain.context);
  });
});

describe('referenced documents as blocks', () => {
  const docs = [row('doc-A', 'alpha.pdf')];
  const candidates = [candidate('a1', 'doc-A', 0.9, 'alpha first')];
  const refContext = '\n\n=== DOCUMENT: "Ref Doc" ===\nref one\n\nref two\n=== END OF DOCUMENT ===\n\n\nDocument "Gone" was referenced but no content could be retrieved.\n';
  const referenced = {
    usedDocuments: [{ id: 'doc-R', name: 'Ref Doc', filename: 'ref.md', explicitly_referenced: true }],
    context: refContext,
    sections: [
      { documentId: 'doc-R', documentName: 'Ref Doc', chunkIds: ['r1', 'r2'], text: 'ref one\n\nref two' },
      { documentId: 'doc-G', documentName: 'Gone', chunkIds: [], text: '', missing: true },
    ],
  };

  it('puts referenced blocks first without a labeler and keeps the referenced context string', () => {
    const out = assembleContext(input(candidates, docs, { referenced }));
    expect(out.context.startsWith(refContext)).toBe(true);
    expect(blocksOf(out).map((block) => [block.documentId, block.chunkIds, block.alias, block.title])).toEqual([
      ['doc-R', ['r1', 'r2'], null, 'Ref Doc'],
      ['doc-A', ['a1'], null, 'alpha.pdf'],
    ]);
  });

  it('labels referenced sections first and continues the ordinals into the retrieved chunks', () => {
    const out = assembleContext(input(candidates, docs, { referenced, citationLabeler: upperLabeler }));
    expect(blocksOf(out).map((block) => [block.documentId, block.alias])).toEqual([
      ['doc-R', 'S1'],
      ['doc-A', 'S2'],
    ]);
    expect(
      out.context.startsWith(
        '\n\n=== DOCUMENT: "Ref Doc" ===\n[S1] Ref Doc\nREF ONE\n\nREF TWO\n=== END OF DOCUMENT ===\n\n\nDocument "Gone" was referenced but no content could be retrieved.\n',
      ),
    ).toBe(true);
    expect(out.context).toContain('[S2] alpha.pdf\nALPHA FIRST');
  });

  it('labels referenced sections even when no chunk was retrieved', () => {
    const out = assembleContext(input([], docs, { referenced, citationLabeler: upperLabeler }));
    expect(blocksOf(out).map((block) => block.alias)).toEqual(['S1']);
    expect(out.context).toContain('[S1] Ref Doc\nREF ONE');
  });
});
