import { createHash } from 'node:crypto';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { AliasMap } from './blocks';

export const MESSAGE_QUOTE_CAP = 1000;

/** One record per validated alias, numbered in order of first appearance in the answer. */
export function buildCitationRecords(
  validAliases: readonly string[],
  aliasMap: AliasMap,
  strategy: CitationRecord['strategy'],
): CitationRecord[] {
  const records: CitationRecord[] = [];
  for (const alias of validAliases) {
    const block = aliasMap.byAlias.get(alias);
    if (!block || block.text.length === 0) continue;
    const facts = aliasMap.documents?.get(block.documentId);
    records.push({
      n: records.length + 1,
      alias,
      chunkIds: [...block.chunkIds],
      documentId: block.documentId,
      documentName: block.documentName,
      documentVersion: block.documentVersion,
      page: block.page,
      sectionPath: block.sectionPath ? [...block.sectionPath] : null,
      quote: block.text,
      quoteHash: createHash('sha256').update(block.text).digest('hex'),
      strategy,
      // D-13, D-21: the used document's version currency, effective dates and other sources, only when set.
      ...(facts?.isCurrent !== undefined ? { isCurrent: facts.isCurrent } : {}),
      ...(facts?.effectiveFrom !== undefined ? { effectiveFrom: facts.effectiveFrom } : {}),
      ...(facts?.effectiveTo !== undefined ? { effectiveTo: facts.effectiveTo } : {}),
      ...(facts?.alsoIn !== undefined ? { alsoIn: facts.alsoIn.map((entry) => ({ ...entry })) } : {}),
    });
  }
  return records;
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const code = text.charCodeAt(cap - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap;
  return text.slice(0, end);
}

/** Caps each quote for message metadata; quoteHash keeps identifying the full snapshot. */
export function capQuotes(records: readonly CitationRecord[], cap: number = MESSAGE_QUOTE_CAP): CitationRecord[] {
  return records.map((record) => ({ ...record, quote: capText(record.quote, cap) }));
}
