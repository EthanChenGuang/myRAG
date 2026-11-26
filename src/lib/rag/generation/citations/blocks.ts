import { neutralizeCitationMarkers } from '@/lib/citations/marker-grammar';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { CitationLabeler, ContextBlock, UsedDocument } from '../../types';

export type AliasedBlock = ContextBlock & { alias: string };

/** D-13, D-21: the used document facts a citation record carries; only documents with at least one field are listed. */
export type CitationDocumentFacts = Pick<CitationRecord, 'isCurrent' | 'effectiveFrom' | 'effectiveTo' | 'alsoIn'>;

export interface AliasMap {
  aliases: ReadonlySet<string>;
  byAlias: ReadonlyMap<string, AliasedBlock>;
  ordered: readonly AliasedBlock[];
  documents?: ReadonlyMap<string, CitationDocumentFacts>;
}

function documentFacts(doc: UsedDocument): CitationDocumentFacts | null {
  const facts: CitationDocumentFacts = {
    ...(typeof doc.isCurrent === 'boolean' ? { isCurrent: doc.isCurrent } : {}),
    ...(typeof doc.effectiveFrom === 'string' ? { effectiveFrom: doc.effectiveFrom } : {}),
    ...(typeof doc.effectiveTo === 'string' ? { effectiveTo: doc.effectiveTo } : {}),
    ...(doc.alsoIn && doc.alsoIn.length > 0 ? { alsoIn: doc.alsoIn.map((entry) => ({ ...entry })) } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : null;
}

/** Labels each non-image block "[S<ordinal>] <title>" and neutralizes marker-like text inside it. */
export function createCitationLabeler(): CitationLabeler {
  return (block, ordinal) => {
    const alias = `S${ordinal}`;
    return { alias, header: `[${alias}] ${block.title}`, text: neutralizeCitationMarkers(block.text) };
  };
}

/** Builds the per-request alias map from the final context blocks; aliases must run S1..Sn in order. */
export function buildAliasMap(blocks: readonly ContextBlock[] | undefined, usedDocuments?: readonly UsedDocument[]): AliasMap {
  const ordered: AliasedBlock[] = [];
  for (const block of blocks ?? []) {
    if (block.alias === null || block.isImage) continue;
    const expected = `S${ordered.length + 1}`;
    if (block.alias !== expected) {
      throw new Error(`alias order broken at position ${ordered.length + 1}`);
    }
    ordered.push(block as AliasedBlock);
  }
  const documents = new Map<string, CitationDocumentFacts>();
  for (const doc of usedDocuments ?? []) {
    const facts = documentFacts(doc);
    if (facts && !documents.has(doc.id)) documents.set(doc.id, facts);
  }
  return {
    aliases: new Set(ordered.map((block) => block.alias)),
    byAlias: new Map(ordered.map((block) => [block.alias, block])),
    ordered,
    ...(documents.size > 0 ? { documents } : {}),
  };
}
