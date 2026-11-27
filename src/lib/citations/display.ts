import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

export interface CitationAlsoIn {
  documentId: string;
  filename: string;
  chunkId: string;
}

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
  version?: number;
  isCurrent?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  alsoIn?: CitationAlsoIn[];
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
 * The version and also-in fields (D-13, D-21) are copied only when the record has them; the cited document is not listed in alsoIn.
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
      const alsoIn = citation.alsoIn?.filter((entry) => entry.documentId !== citation.documentId);
      return {
        ...base,
        quote: citation.quote,
        linkDocumentId: current ? citation.documentId : null,
        unavailable: !current,
        withdrawn: false,
        withdrawnAt: null,
        ...(typeof citation.documentVersion === 'number' && citation.isCurrent !== undefined ? { version: citation.documentVersion } : {}),
        ...(citation.isCurrent !== undefined ? { isCurrent: citation.isCurrent } : {}),
        ...(citation.effectiveFrom !== undefined ? { effectiveFrom: citation.effectiveFrom } : {}),
        ...(citation.effectiveTo !== undefined ? { effectiveTo: citation.effectiveTo } : {}),
        ...(alsoIn && alsoIn.length > 0 ? { alsoIn: alsoIn.map((entry) => ({ ...entry })) } : {}),
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
