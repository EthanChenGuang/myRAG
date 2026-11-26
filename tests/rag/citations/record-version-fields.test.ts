import { describe, expect, it } from 'vitest';
import { assembleContext, type AssembleInput, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { buildAliasMap, createCitationLabeler } from '@/lib/rag/generation/citations/blocks';
import { buildCitationRecords } from '@/lib/rag/generation/citations/record';
import { CitationRecordSchema } from '@/lib/rag-eval/contracts.generated';
import type { UsedDocument } from '@/lib/rag/types';

/** D-13, D-21: version and duplicate-source facts of the used document reach the citation record; synthetic text only. */
const documents = new Map<string, AssemblyDocumentRow>([
  ['doc-a', { id: 'doc-a', filename: 'plorvan-notes.md', content: null }],
  ['doc-b', { id: 'doc-b', filename: 'plorvan-index.md', content: null }],
]);

function input(): AssembleInput {
  return {
    queryText: 'plorvan notes index',
    candidates: [
      { chunk_id: 'a1', document_id: 'doc-a', content: 'The plorvan notes list three quiet steps in order.', similarity: 0.95 },
      { chunk_id: 'b1', document_id: 'doc-b', content: 'The plorvan index points to the notes by step number.', similarity: 0.9 },
    ],
    documents,
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
    citationLabeler: createCitationLabeler(),
  };
}

const ALSO_IN = [
  { documentId: 'doc-c', filename: 'plorvan-copy-1.md', chunkId: 'c1' },
  { documentId: 'doc-d', filename: 'plorvan-copy-2.md', chunkId: 'd1' },
];

function used(extra: Partial<UsedDocument>[] = []): UsedDocument[] {
  return [
    { id: 'doc-a', name: 'plorvan-notes.md', filename: 'plorvan-notes.md', ...extra[0] },
    { id: 'doc-b', name: 'plorvan-index.md', filename: 'plorvan-index.md', ...extra[1] },
  ];
}

function records(usedDocuments?: UsedDocument[]) {
  const map = buildAliasMap(assembleContext(input()).blocks, usedDocuments);
  return buildCitationRecords([...map.aliases], map, 'chunk-alias');
}

describe('buildCitationRecords version and alsoIn fields (D-13, D-21)', () => {
  it('copies isCurrent, the effective dates and alsoIn from the used document', () => {
    const out = records(
      used([{ version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31', alsoIn: ALSO_IN }]),
    );
    const a = out.find((record) => record.documentId === 'doc-a')!;
    expect(a.isCurrent).toBe(false);
    expect(a.effectiveFrom).toBe('2026-01-01');
    expect(a.effectiveTo).toBe('2026-03-31');
    expect(a.alsoIn).toEqual(ALSO_IN);
    const b = out.find((record) => record.documentId === 'doc-b')!;
    expect(b).not.toHaveProperty('isCurrent');
    expect(b).not.toHaveProperty('alsoIn');
    for (const record of out) expect(CitationRecordSchema.parse(record)).toEqual(record);
  });

  it('leaves out null dates and keeps isCurrent', () => {
    const [a] = records(used([{ version: 2, isCurrent: true, effectiveFrom: null, effectiveTo: null }])).filter((r) => r.documentId === 'doc-a');
    expect(a!.isCurrent).toBe(true);
    expect(a).not.toHaveProperty('effectiveFrom');
    expect(a).not.toHaveProperty('effectiveTo');
    expect(CitationRecordSchema.parse(a)).toEqual(a);
  });

  it('equals the output without used documents when none of the fields is set', () => {
    const plain = records();
    expect(records(used())).toEqual(plain);
    expect(JSON.stringify(records(used()))).toBe(JSON.stringify(plain));
    for (const record of plain) {
      for (const field of ['isCurrent', 'effectiveFrom', 'effectiveTo', 'alsoIn']) expect(record).not.toHaveProperty(field);
    }
  });

  it('a record stored before this phase still parses', () => {
    const stored = {
      n: 1,
      alias: 'S1',
      chunkIds: ['a1'],
      documentId: 'doc-a',
      documentName: 'plorvan-notes.md',
      documentVersion: null,
      page: null,
      sectionPath: null,
      quote: 'The plorvan notes list three quiet steps in order.',
      quoteHash: 'a'.repeat(64),
      strategy: 'chunk-alias',
    };
    expect(CitationRecordSchema.parse(stored)).toEqual(stored);
  });
});
