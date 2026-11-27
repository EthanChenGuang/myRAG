import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

export interface CitationAlsoIn {
  documentId: string;
  filename: string;
  chunkId: string;
}

export interface CitationDisplayEntry {
  n: number;
  documentName: string;
  page: number | null;
  sectionPath: string[] | null;
  quote: string;
  linkDocumentId: string | null;
  unavailable: boolean;
  version?: number;
  isCurrent?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  alsoIn?: CitationAlsoIn[];
}

/**
 * Rendering data for a record's citations, from the stored snapshots only (client-safe, no server imports).
 * A document missing from the availability map counts as unavailable: no link, the quote still shows.
 * The version and also-in fields (D-13, D-21) are copied only when the record has them; the cited document is not listed in alsoIn.
 */
export function citationDisplayEntries(
  citations: readonly CitationRecord[],
  documents: Readonly<Record<string, 'current' | 'unavailable'>>,
): CitationDisplayEntry[] {
  return [...citations]
    .sort((a, b) => a.n - b.n)
    .map((citation) => {
      const current = documents[citation.documentId] === 'current';
      const alsoIn = citation.alsoIn?.filter((entry) => entry.documentId !== citation.documentId);
      return {
        n: citation.n,
        documentName: citation.documentName,
        page: citation.page ?? null,
        sectionPath: citation.sectionPath ?? null,
        quote: citation.quote,
        linkDocumentId: current ? citation.documentId : null,
        unavailable: !current,
        ...(typeof citation.documentVersion === 'number' && citation.isCurrent !== undefined ? { version: citation.documentVersion } : {}),
        ...(citation.isCurrent !== undefined ? { isCurrent: citation.isCurrent } : {}),
        ...(citation.effectiveFrom !== undefined ? { effectiveFrom: citation.effectiveFrom } : {}),
        ...(citation.effectiveTo !== undefined ? { effectiveTo: citation.effectiveTo } : {}),
        ...(alsoIn && alsoIn.length > 0 ? { alsoIn: alsoIn.map((entry) => ({ ...entry })) } : {}),
      };
    });
}
