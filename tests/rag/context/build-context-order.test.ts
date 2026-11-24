import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  buildContext,
  filterCandidates,
  type AssembleInput,
  type AssemblyCandidate,
  type AssemblyDocumentRow,
} from '@/lib/rag/context/assemble';

function candidate(id: string, documentId: string, similarity: number, content?: string): AssemblyCandidate {
  return {
    chunk_id: id,
    document_id: documentId,
    content: content ?? `body of ${id}`,
    similarity,
  };
}

function row(id: string, filename: string): AssemblyDocumentRow {
  return { id, filename, created_at: '2026-01-01T00:00:00Z', content: null, metadata: null };
}

function input(
  candidates: AssemblyCandidate[],
  documents: AssemblyDocumentRow[],
  overrides: Partial<AssembleInput> = {},
): AssembleInput {
  return {
    queryText: 'widgets pricing',
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

function sectionIndex(context: string, docName: string): number {
  return context.indexOf(`--- Document: ${docName}`);
}

describe('buildContext groupOrder and keptByOverride', () => {
  const docs = [row('doc-A', 'alpha.pdf'), row('doc-B', 'beta.pdf')];
  const candidates = [
    candidate('c1', 'doc-A', 0.9, 'alpha chunk one'),
    candidate('c2', 'doc-B', 0.8, 'beta chunk one'),
  ];

  it('renders documents in groupOrder when provided', () => {
    const filtered = filterCandidates(input(candidates, docs));
    const out = buildContext(filtered, input(candidates, docs, { groupOrder: ['doc-B', 'doc-A'] }));
    expect(sectionIndex(out.context, 'beta.pdf')).toBeLessThan(sectionIndex(out.context, 'alpha.pdf'));
    expect(out.context).toContain('(1 relevant chunks)');
  });

  it('applies keptByOverride on every kept entry', () => {
    const out = assembleContext(input(candidates, docs, { keptByOverride: 'rerank' }));
    expect(out.kept.every((entry) => entry.kept_by === 'rerank')).toBe(true);
  });

  it('ignores unknown groupOrder ids and appends unlisted docs in first-seen order', () => {
    const extra = [candidate('c3', 'doc-C', 0.7, 'gamma chunk'), ...candidates];
    const moreDocs = [...docs, row('doc-C', 'gamma.pdf')];
    const filtered = filterCandidates(input(extra, moreDocs));
    const out = buildContext(filtered, input(extra, moreDocs, { groupOrder: ['doc-B', 'missing-id', 'doc-A'] }));
    const b = sectionIndex(out.context, 'beta.pdf');
    const a = sectionIndex(out.context, 'alpha.pdf');
    const g = sectionIndex(out.context, 'gamma.pdf');
    expect(b).toBeLessThan(a);
    expect(a).toBeLessThan(g);
  });

  it('matches legacy bytes when optional fields are absent', () => {
    const legacy = assembleContext(input(candidates, docs));
    const filtered = filterCandidates(input(candidates, docs));
    const direct = buildContext(filtered, input(candidates, docs));
    expect(direct.context).toBe(legacy.context);
    expect(direct.usedDocuments).toEqual(legacy.usedDocuments);
    expect(direct.kept).toEqual(legacy.kept);
  });
});