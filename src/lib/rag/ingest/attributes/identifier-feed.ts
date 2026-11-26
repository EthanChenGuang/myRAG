import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import { normalizeIdentifier } from '../../ids/normalize';
import { MAX_CHUNK_IDENTIFIERS, MAX_IDENTIFIER_CHARS, type ChunkIdentifiers } from '../../identifiers/extract';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';

/**
 * TPL-04 identifier feed (D-25, F-13): values of attributes flagged in_identifier_index become identifier entries that the Phase 4.2
 * indexer (indexDocumentForLookup) merges into every chunk's identifier arrays; the document union follows in SQL. This module writes no
 * identifier column itself. Logs carry counts and code words only, never an identifier or a value.
 */

export interface AttributeIdentifierEntry {
  /** The value as stored. */
  raw: string;
  /** normalizeIdentifier(raw). */
  norm: string;
}

/**
 * One entry per flagged attribute with a string value, in key order; an empty normalised form or a form longer than the indexer stores is
 * skipped; two attributes with the same normalised form give one entry (the first key). Only code definitions can be flagged (1001), so a
 * flagged value is one string. Pure.
 */
export function attributeIdentifierEntries(
  definitions: readonly AttributeDefinition[],
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): AttributeIdentifierEntry[] {
  if (!attributes) return [];
  const flagged = new Set(definitions.filter((definition) => definition.in_identifier_index).map((definition) => definition.key));
  if (flagged.size === 0) return [];
  const seen = new Set<string>();
  const entries: AttributeIdentifierEntry[] = [];
  for (const key of Object.keys(attributes).sort()) {
    if (!flagged.has(key)) continue;
    const value = attributes[key];
    if (typeof value !== 'string') continue;
    const norm = normalizeIdentifier(value);
    if (norm === '' || seen.has(norm) || value.length > MAX_IDENTIFIER_CHARS || norm.length > MAX_IDENTIFIER_CHARS) continue;
    seen.add(norm);
    entries.push({ raw: value, norm });
  }
  return entries;
}

/**
 * Appends the attribute entries to every chunk's entries in order, skipping a normalised form the chunk already has; raw and norm stay
 * aligned. The per-chunk cap of the indexer holds: entries past it are counted in truncated. Pure.
 */
export function mergeAttributeIdentifiers(
  chunkEntries: readonly ChunkIdentifiers[],
  attributeEntries: readonly AttributeIdentifierEntry[],
): ChunkIdentifiers[] {
  if (attributeEntries.length === 0) return [...chunkEntries];
  return chunkEntries.map((chunk) => {
    const seen = new Set(chunk.norm);
    const raw = [...chunk.raw];
    const norm = [...chunk.norm];
    let truncated = chunk.truncated;
    for (const entry of attributeEntries) {
      if (seen.has(entry.norm)) continue;
      if (norm.length >= MAX_CHUNK_IDENTIFIERS) {
        truncated += 1;
        continue;
      }
      seen.add(entry.norm);
      raw.push(entry.raw);
      norm.push(entry.norm);
    }
    return { raw, norm, truncated };
  });
}

/** A schema or attribute read failed; the indexer counts it as an identifier failure for the document. */
export class AttributeIdentifierReadError extends Error {
  constructor() {
    super('[Ingest] attribute identifiers could not be read');
    this.name = 'AttributeIdentifierReadError';
  }
}

/**
 * The document's attribute identifier entries for the indexer, read for the scope's tenant only. Null while RAG_DOC_ATTRIBUTES is
 * effectively off (nothing is read) or the tenant has no flagged definition (only the cached schema is read). Throws
 * AttributeIdentifierReadError when the schema or the attributes cannot be read.
 */
export async function loadAttributeIdentifiers(
  scope: TenantScope,
  documentId: string,
  options: { signal: AbortSignal },
): Promise<AttributeIdentifierEntry[] | null> {
  const [{ docAttributesEnabled, loadAttributeSchema }, { readDocumentAttributes }, { getIngestDeps }] = await Promise.all([
    import('./schema'),
    import('./apply'),
    import('../deps'),
  ]);
  if (!docAttributesEnabled()) return null;
  assertTenantScope(scope);
  const schema = await loadAttributeSchema(scope, { signal: options.signal });
  options.signal.throwIfAborted();
  if (!schema.ok) throw new AttributeIdentifierReadError();
  if (!schema.definitions.some((definition) => definition.in_identifier_index)) return null;
  const db = getIngestDeps().db();
  if (!db) throw new AttributeIdentifierReadError();
  const read = await readDocumentAttributes(db, scopeKey(scope), [documentId], options.signal);
  if (!read.ok) throw new AttributeIdentifierReadError();
  const attributes = read.rows.find((row) => row.documentId === documentId)?.attributes ?? null;
  return attributeIdentifierEntries(schema.definitions, attributes as Record<string, unknown> | null);
}

// --- Re-index (plan 03.3-16 Task 3) — stub ---

export const ATTRIBUTE_IDENTIFIER_FEED_OFF = 'attribute_identifier_feed_off';

export interface ReindexAttributeIdentifiersReport {
  status: 'done' | 'feed_off';
  documents: number;
  failed: number;
  chunksWritten: number;
  documentsChanged: number;
}

export async function reindexAttributeIdentifiers(_scope: TenantScope, _documentIds: readonly string[] | 'all', _deps: unknown): Promise<ReindexAttributeIdentifiersReport> {
  return { status: 'done', documents: 0, failed: 0, chunksWritten: 0, documentsChanged: 0 };
}

export function resetAttributeIdentifierFeedForTests(): void {}
