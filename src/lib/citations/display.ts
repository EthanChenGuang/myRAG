import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

export type CitationDocumentStatus = 'current' | 'unavailable' | 'withdrawn';

export interface CitationDisplayEntry {
  n: number;
  documentName: string;
  page: number | null;
  sectionPath: string[] | null;
  quote: string;
  linkDocumentId: string | null;
  unavailable: boolean;
  withdrawn: boolean;
  withdrawnAt: string | null;
}

/** Withdrawn when the citation's own flag says so or the server's availability map does (D-36, UI-SPEC 6.9). */
export function isCitationWithdrawn(
  citation: Pick<CitationRecord, 'documentId' | 'withdrawn'>,
  documents: Readonly<Record<string, CitationDocumentStatus>>,
): boolean {
  return citation.withdrawn === true || documents[citation.documentId] === 'withdrawn';
}

/**
 * Rendering data for a record's citations, from the stored snapshots only (client-safe, no server imports).
 * A document missing from the availability map counts as unavailable: no link, the quote still shows.
 * A withdrawn citation never carries its quote, whatever text the browser still holds.
 */
export function citationDisplayEntries(
  citations: readonly CitationRecord[],
  documents: Readonly<Record<string, CitationDocumentStatus>>,
): CitationDisplayEntry[] {
  return [...citations]
    .sort((a, b) => a.n - b.n)
    .map((citation) => {
      const base = {
        n: citation.n,
        documentName: citation.documentName,
        page: citation.page ?? null,
        sectionPath: citation.sectionPath ?? null,
      };
      if (isCitationWithdrawn(citation, documents)) {
        return { ...base, quote: '', linkDocumentId: null, unavailable: false, withdrawn: true, withdrawnAt: citation.withdrawnAt ?? null };
      }
      const current = documents[citation.documentId] === 'current';
      return {
        ...base,
        quote: citation.quote,
        linkDocumentId: current ? citation.documentId : null,
        unavailable: !current,
        withdrawn: false,
        withdrawnAt: null,
      };
    });
}

/** The citation numbers shown as withdrawn, for the chips in the answer text. */
export function withdrawnCitationNumbers(
  citations: readonly CitationRecord[],
  documents: Readonly<Record<string, CitationDocumentStatus>>,
): number[] {
  return citations.filter((citation) => isCitationWithdrawn(citation, documents)).map((citation) => citation.n).sort((a, b) => a - b);
}
