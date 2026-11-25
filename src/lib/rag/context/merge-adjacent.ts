export interface AdjacentChunk {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  parent_id?: string | null;
  rank: number;
}

export interface DocumentGroup {
  documentId: string;
  rank: number;
  runs: AdjacentChunk[][];
}

function adjacentIndex(a: AdjacentChunk, b: AdjacentChunk): boolean {
  return b.chunk_index === a.chunk_index + 1;
}

function sameParent(a: AdjacentChunk, b: AdjacentChunk): boolean {
  return Boolean(a.parent_id && a.parent_id === b.parent_id);
}

function buildRuns(chunks: AdjacentChunk[]): AdjacentChunk[][] {
  if (chunks.length === 0) return [];
  const sorted = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);
  const runs: AdjacentChunk[][] = [];
  let current: AdjacentChunk[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = current[current.length - 1]!;
    const next = sorted[i]!;
    if (adjacentIndex(prev, next) || sameParent(prev, next)) {
      current.push(next);
    } else {
      runs.push(current);
      current = [next];
    }
  }
  runs.push(current);
  return runs;
}

export function mergeAdjacent(selected: AdjacentChunk[]): DocumentGroup[] {
  const byDoc = new Map<string, AdjacentChunk[]>();
  for (const chunk of selected) {
    const list = byDoc.get(chunk.document_id) ?? [];
    list.push(chunk);
    byDoc.set(chunk.document_id, list);
  }

  const groups: DocumentGroup[] = [];
  for (const [documentId, chunks] of byDoc) {
    const rank = Math.min(...chunks.map((c) => c.rank));
    groups.push({ documentId, rank, runs: buildRuns(chunks) });
  }

  groups.sort((a, b) => a.rank - b.rank || a.documentId.localeCompare(b.documentId));
  return groups;
}