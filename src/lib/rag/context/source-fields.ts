import type { AlsoIn, UsedDocument } from '../types';

export interface SourceDocumentFields {
  version?: number;
  isCurrent?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  alsoIn?: AlsoIn[];
}

/** D-13, D-21: the version and duplicate-source fields of a used document, each only when it is set, for a source payload entry. */
export function sourceDocumentFields(doc: UsedDocument): SourceDocumentFields {
  return {
    ...(doc.version !== undefined ? { version: doc.version } : {}),
    ...(doc.isCurrent !== undefined ? { isCurrent: doc.isCurrent } : {}),
    ...(doc.effectiveFrom !== undefined ? { effectiveFrom: doc.effectiveFrom } : {}),
    ...(doc.effectiveTo !== undefined ? { effectiveTo: doc.effectiveTo } : {}),
    ...(doc.alsoIn && doc.alsoIn.length > 0 ? { alsoIn: doc.alsoIn.map((entry) => ({ ...entry })) } : {}),
  };
}
