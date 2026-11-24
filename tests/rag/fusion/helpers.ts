import type { RankedHit } from '@/lib/rag/backend/types';
import type { RankedList } from '@/lib/rag/fusion/rrf';

export function hit(chunkId: string, overrides: Partial<RankedHit> = {}): RankedHit {
  return {
    rank: 1,
    chunkId,
    documentId: 'doc-1',
    parentId: null,
    content: `content-${chunkId}`,
    metadata: {},
    chunkIndex: 0,
    sectionPath: [],
    chunkKind: null,
    similarity: null,
    lexicalScore: null,
    docType: null,
    language: null,
    document: {
      filename: 'file.txt',
      createdAt: null,
      metadata: {},
      contentPreview: '',
    },
    ...overrides,
  };
}

export function rankedList(id: string, chunkIds: string[], weight = 1): RankedList {
  return {
    id,
    weight,
    hits: chunkIds.map((chunkId, index) => hit(chunkId, { rank: index + 1 })),
  };
}