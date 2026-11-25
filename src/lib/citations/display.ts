import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

export interface CitationDisplayEntry {
  n: number;
  documentName: string;
  page: number | null;
  sectionPath: string[] | null;
  quote: string;
  linkDocumentId: string | null;
  unavailable: boolean;
}

/**
 * Rendering data for a record's citations, from the stored snapshots only (client-safe, no server imports).
 * A document missing from the availability map counts as unavailable: no link, the quote still shows.
 */
export function citationDisplayEntries(
  citations: readonly CitationRecord[],
  documents: Readonly<Record<string, 'current' | 'unavailable'>>,
): CitationDisplayEntry[] {
  return [...citations]
    .sort((a, b) => a.n - b.n)
    .map((citation) => {
      const current = documents[citation.documentId] === 'current';
      return {
        n: citation.n,
        documentName: citation.documentName,
        page: citation.page ?? null,
        sectionPath: citation.sectionPath ?? null,
        quote: citation.quote,
        linkDocumentId: current ? citation.documentId : null,
        unavailable: !current,
      };
    });
}
