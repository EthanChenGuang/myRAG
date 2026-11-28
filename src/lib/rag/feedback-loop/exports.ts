import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import {
  DictionaryCandidateSchema,
  ExpertLabelSchema,
  ReviewItemSchema,
  TrainingPairSchema,
  type DictionaryCandidate,
  type ExpertLabel,
  type TrainingPair,
} from '@/lib/rag-eval/contracts.generated';
import { parseTenantKey } from '@/lib/rag/tenant/embed';
import { normalizeQuoteText } from './labels';
import { fetchServableChunks, hashForLog, isReviewItemId } from './review-access';

/**
 * D-17 and D-20 hand-offs. Every read runs on the service-role client filtered by one tenant_key (in SQL and again in code), only
 * labelled items with the requested triage value leave the database, and no line carries user, chat or trace ids. Training and
 * dictionary lines carry no chunk text; the golden line carries the current text of its own evidence chunks, re-read under the
 * item's tenant, so the Python promotion can re-check quotes.
 */

type Client = SupabaseClient;
type Row = Record<string, unknown>;
type Triage = 'dictionary' | 'training' | 'golden';

export const EXPORT_KINDS = ['dictionary', 'training', 'golden'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

const PAGE_SIZE = 500;
const MAX_HARD_NEGATIVES = 10;
const MAX_EXAMPLE_IDS = 20;

const READ_COLUMNS = [
  'id',
  'tenant_key',
  'query_masked',
  'query_language',
  'channel',
  'outcome',
  'candidates',
  'reasons',
  'occurrences',
  'status',
  'triage',
  'label',
  'labelled_at',
  'split',
  'split_group',
  'mining_window',
  'mined_at',
] as const;

interface StoredItem {
  row: Row;
  id: string;
  label: ExpertLabel;
}

/** Keyset pages over one tenant's items in a status set; the label must still satisfy the ExpertLabel contract. */
async function readItems(admin: Client, tenantKey: string, triage: Triage, statuses: readonly string[]): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  let after: string | null = null;
  for (;;) {
    let builder = admin
      .from('rag_review_items')
      .select(READ_COLUMNS.join(','))
      .eq('tenant_key', tenantKey)
      .in('status', [...statuses])
      .contains('triage', [triage]);
    if (after) builder = builder.gt('id', after);
    const { data, error } = await builder.order('id', { ascending: true }).limit(PAGE_SIZE);
    if (error) throw new Error('feedback_export_read_failed');
    const rows = (data ?? []) as unknown as Row[];
    for (const row of rows) {
      if (row.tenant_key !== tenantKey || !statuses.includes(String(row.status))) continue;
      if (!Array.isArray(row.triage) || !row.triage.includes(triage) || !isReviewItemId(row.id)) continue;
      const label = ExpertLabelSchema.safeParse(row.label);
      if (!label.success || !label.data.triage.includes(triage)) {
        console.error('[Feedback Loop] export skipped an item whose label fails the contract', { item: hashForLog(String(row.id)) });
        continue;
      }
      items.push({ row, id: String(row.id).toLowerCase(), label: label.data });
    }
    if (rows.length < PAGE_SIZE) break;
    after = String(rows[rows.length - 1].id);
  }
  return items;
}

function logExport(kind: ExportKind, tenantKey: string, count: number, skipped: number): void {
  console.log('[Feedback Loop] export', { kind, tenant: hashForLog(tenantKey), count, skipped });
}

// --- Dictionary (Phase 4.1.1 hand-off) ---

export async function exportDictionary(admin: Client, tenantKey: string): Promise<DictionaryCandidate[]> {
  const items = await readItems(admin, tenantKey, 'dictionary', ['labelled']);
  const groups = new Map<string, { candidate: DictionaryCandidate; ids: Set<string> }>();
  for (const item of items) {
    const occurrences = Math.max(1, Number.isInteger(item.row.occurrences) ? (item.row.occurrences as number) : 1);
    for (const term of item.label.dictionary_terms ?? []) {
      const observed = term.observed_term.trim();
      const canonical = term.canonical_term.trim();
      if (observed === '' || canonical === '') continue;
      const canonicalLanguage = term.canonical_language ?? null;
      const key = JSON.stringify([item.label.language, observed, canonical, term.relation, canonicalLanguage]);
      const group = groups.get(key) ?? {
        candidate: {
          tenant_key: tenantKey,
          language: item.label.language,
          observed_term: observed,
          canonical_term: canonical,
          relation: term.relation,
          canonical_language: canonicalLanguage,
          example_review_item_ids: [],
          occurrences: 0,
        },
        ids: new Set<string>(),
      };
      if (!group.ids.has(item.id)) {
        group.ids.add(item.id);
        group.candidate.occurrences += occurrences;
        if (group.candidate.example_review_item_ids.length < MAX_EXAMPLE_IDS) group.candidate.example_review_item_ids.push(item.id);
      }
      groups.set(key, group);
    }
  }
  const out: DictionaryCandidate[] = [];
  let skipped = 0;
  for (const { candidate } of groups.values()) {
    // A translation without its target language is refused by the Pydantic model rule, which the generated Zod does not carry.
    if (candidate.relation === 'translation' && !candidate.canonical_language) {
      skipped += 1;
      continue;
    }
    const parsed = DictionaryCandidateSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
    else skipped += 1;
  }
  logExport('dictionary', tenantKey, out.length, skipped);
  return out;
}

// --- Training pairs (Phase 6.1 hand-off) ---

interface SnapshotCandidate {
  chunkId: string;
  documentId: string;
  rank: number;
  score: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The logged candidates by rank; the score is the one the final order used (rerank, else fused, else similarity). */
function snapshotCandidates(value: unknown): SnapshotCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SnapshotCandidate[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Row;
    const chunkId = typeof row.chunk_id === 'string' ? row.chunk_id.toLowerCase() : '';
    const documentId = typeof row.document_id === 'string' ? row.document_id.toLowerCase() : '';
    const rank = row.rank;
    const score = finite(row.rerank_score) ?? finite(row.fused_score) ?? finite(row.similarity);
    if (chunkId === '' || chunkId.length > 128 || !UUID_RE.test(documentId) || !Number.isInteger(rank) || (rank as number) < 1 || score === null) continue;
    if (seen.has(chunkId)) continue;
    seen.add(chunkId);
    out.push({ chunkId, documentId, rank: rank as number, score });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * D-17 hard negatives. First the candidates the expert marked not relevant (confirmed), then candidates ranked above the
 * lowest-ranked positive that are not cited as evidence (unconfirmed), candidates of other documents before those of a positive's
 * document, at most 10. When no positive was retrieved, every logged candidate outranked it.
 */
export function selectHardNegatives(candidates: SnapshotCandidate[], label: ExpertLabel): NonNullable<TrainingPair['hard_negatives']> {
  const evidence = label.evidence ?? [];
  const cited = new Set(evidence.map((span) => span.chunk_id.toLowerCase()));
  const positiveDocs = new Set(evidence.map((span) => span.document_id.toLowerCase()));
  const positiveRanks = candidates.filter((entry) => cited.has(entry.chunkId)).map((entry) => entry.rank);
  const lowestPositive = positiveRanks.length > 0 ? Math.max(...positiveRanks) : Number.POSITIVE_INFINITY;
  const notRelevant = new Set((label.not_relevant_chunk_ids ?? []).map((chunkId) => chunkId.toLowerCase()));

  const confirmed = candidates.filter((entry) => notRelevant.has(entry.chunkId) && !cited.has(entry.chunkId));
  const unconfirmed = candidates.filter((entry) => !notRelevant.has(entry.chunkId) && !cited.has(entry.chunkId) && entry.rank < lowestPositive);
  const otherDocsFirst = [
    ...unconfirmed.filter((entry) => !positiveDocs.has(entry.documentId)),
    ...unconfirmed.filter((entry) => positiveDocs.has(entry.documentId)),
  ];
  return [
    ...confirmed.map((entry) => ({ chunk_id: entry.chunkId, document_id: entry.documentId, rank: entry.rank, score: entry.score, confirmed: true })),
    ...otherDocsFirst.map((entry) => ({ chunk_id: entry.chunkId, document_id: entry.documentId, rank: entry.rank, score: entry.score, confirmed: false })),
  ].slice(0, MAX_HARD_NEGATIVES);
}

interface GoldenDocument {
  heldOut: boolean;
  group: string | null;
}

/**
 * Documents cited as evidence by the tenant's golden items (labelled or exported). A document is held out when any golden item citing
 * it has split test or no split yet; its group is the frozen split_group of such an item when one is set.
 */
async function goldenDocuments(admin: Client, tenantKey: string): Promise<Map<string, GoldenDocument>> {
  const golden = await readItems(admin, tenantKey, 'golden', ['labelled', 'exported']);
  const documents = new Map<string, GoldenDocument>();
  for (const item of golden) {
    const split = item.row.split === 'dev' || item.row.split === 'test' ? item.row.split : null;
    const group = typeof item.row.split_group === 'string' && item.row.split_group !== '' ? item.row.split_group.slice(0, 128) : null;
    for (const span of item.label.evidence ?? []) {
      const documentId = span.document_id.toLowerCase();
      const entry = documents.get(documentId) ?? { heldOut: false, group: null };
      if (split !== 'dev') entry.heldOut = true;
      if (!entry.group && group) entry.group = group;
      documents.set(documentId, entry);
    }
  }
  return documents;
}

/** D-21 group id of a document that no frozen golden group names yet: sha256 of the (lower-case) document id. */
function documentGroupId(documentId: string): string {
  return createHash('sha256').update(documentId).digest('hex');
}

export async function exportTraining(admin: Client, tenantKey: string): Promise<TrainingPair[]> {
  const items = await readItems(admin, tenantKey, 'training', ['labelled']);
  const golden = await goldenDocuments(admin, tenantKey);
  const out: TrainingPair[] = [];
  let skipped = 0;
  for (const item of items) {
    const positiveSpan = (item.label.evidence ?? [])[0];
    const query = typeof item.row.query_masked === 'string' ? item.row.query_masked.trim() : '';
    if (!positiveSpan || query === '') {
      skipped += 1;
      continue;
    }
    const positiveDoc = positiveSpan.document_id.toLowerCase();
    const goldenDoc = golden.get(positiveDoc);
    const pair: TrainingPair = {
      tenant_key: tenantKey,
      query_masked: query,
      language: item.label.language,
      positive: { chunk_id: positiveSpan.chunk_id.toLowerCase(), document_id: positiveDoc, quote: positiveSpan.quote },
      hard_negatives: selectHardNegatives(snapshotCandidates(item.row.candidates), item.label),
      document_group: goldenDoc?.group ?? documentGroupId(positiveDoc),
      split: goldenDoc?.heldOut ? 'held_out' : 'train',
      source: 'production_feedback',
      review_item_id: item.id,
    };
    const parsed = TrainingPairSchema.safeParse(pair);
    if (parsed.success) out.push(parsed.data);
    else skipped += 1;
  }
  logExport('training', tenantKey, out.length, skipped);
  return out;
}

// --- Golden candidates (Python promotion, D-20) ---

const GoldenEvidenceSchema = z
  .object({
    chunk_id: z.string().min(1).max(128),
    document_id: z.string().regex(UUID_RE),
    document_name: z.string().min(1).max(512),
    section: z.string().max(512),
    quote: z.string().min(2).max(2000),
    chunk_text: z.string().nullable(),
    quote_verified: z.boolean(),
  })
  .strict();

/**
 * One golden export line: the review item fields the promotion needs (never user, chat, trace or log ids, the expert's id or the
 * candidate snapshot), the ExpertLabel, and per evidence span the current chunk text under the item's tenant (null when the chunk is
 * no longer current, ready and non-quarantined in that tenant) with quote_verified.
 */
export const GoldenExportLineSchema = ReviewItemSchema.pick({
  id: true,
  tenant_key: true,
  query_masked: true,
  query_language: true,
  channel: true,
  outcome: true,
  reasons: true,
  occurrences: true,
  labelled_at: true,
  split: true,
  split_group: true,
  mining_window: true,
  mined_at: true,
})
  .extend({ label: ExpertLabelSchema, evidence: z.array(GoldenEvidenceSchema).max(20) })
  .strict();
export type GoldenExportLine = z.infer<typeof GoldenExportLineSchema>;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function exportGolden(admin: Client, tenantKey: string): Promise<GoldenExportLine[]> {
  const items = await readItems(admin, tenantKey, 'golden', ['labelled']);
  const out: GoldenExportLine[] = [];
  let skipped = 0;
  let chunkReads = 0;
  for (let start = 0; start < items.length; start += 50) {
    const page = items.slice(start, start + 50);
    const servable = await fetchServableChunks(
      admin,
      tenantKey,
      page.flatMap((item) => (item.label.evidence ?? []).map((span) => span.chunk_id)),
    );
    for (const item of page) {
      const evidence = (item.label.evidence ?? []).map((span) => {
        const chunk = servable.get(span.chunk_id.toLowerCase());
        const current = chunk && chunk.document_id === span.document_id.toLowerCase() ? chunk : null;
        const quote = normalizeQuoteText(span.quote);
        if (current) chunkReads += 1;
        return {
          chunk_id: span.chunk_id,
          document_id: span.document_id,
          document_name: span.document_name,
          section: span.section,
          quote: span.quote,
          chunk_text: current ? current.text : null,
          quote_verified: current !== null && quote !== '' && normalizeQuoteText(current.text).includes(quote),
        };
      });
      const line = {
        id: item.id,
        tenant_key: tenantKey,
        query_masked: stringOrNull(item.row.query_masked),
        query_language: stringOrNull(item.row.query_language),
        channel: item.row.channel,
        outcome: item.row.outcome ?? 'unknown',
        reasons: Array.isArray(item.row.reasons) ? item.row.reasons : [],
        occurrences: item.row.occurrences,
        labelled_at: stringOrNull(item.row.labelled_at),
        split: stringOrNull(item.row.split),
        split_group: stringOrNull(item.row.split_group),
        mining_window: stringOrNull(item.row.mining_window),
        mined_at: item.row.mined_at,
        label: item.label,
        evidence,
      };
      const parsed = GoldenExportLineSchema.safeParse(line);
      if (parsed.success) out.push(parsed.data);
      else skipped += 1;
    }
  }
  logExport('golden', tenantKey, out.length, skipped);
  console.log('[Review] chunks', { export: 'golden', tenant: hashForLog(tenantKey), count: chunkReads });
  return out;
}

export async function buildExport(admin: Client, kind: ExportKind, tenantKey: string): Promise<unknown[]> {
  if (!parseTenantKey(tenantKey)) throw new Error('feedback_export_invalid_tenant');
  if (kind === 'dictionary') return exportDictionary(admin, tenantKey);
  if (kind === 'training') return exportTraining(admin, tenantKey);
  return exportGolden(admin, tenantKey);
}

// --- Mark exported (D-20, D-21) ---

export const MarkExportedRequestSchema = z
  .object({
    tenant: z.string().min(1).max(64),
    items: z
      .array(
        z
          .object({
            id: z.string().regex(UUID_RE),
            split: z.enum(['dev', 'test']).optional(),
            split_group: z.string().min(1).max(128).optional(),
          })
          .strict()
          .refine((item) => (item.split === undefined) === (item.split_group === undefined), 'split and split_group go together'),
      )
      .min(1)
      .max(500)
      .refine((items) => new Set(items.map((item) => item.id.toLowerCase())).size === items.length, 'item ids must be unique'),
  })
  .strict();
export type MarkExportedRequest = z.infer<typeof MarkExportedRequestSchema>;
export type MarkItem = MarkExportedRequest['items'][number];

export interface MarkResult {
  marked: Array<{ id: string; split: string | null; split_group: string | null }>;
  conflicts: Array<{ id: string; reason: 'split_immutable' }>;
  ignored: Array<{ id: string; reason: 'not_found' | 'not_labelled' }>;
}

function isSplitImmutable(error: unknown): boolean {
  const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : '';
  return message.includes('split_immutable');
}

/**
 * Sets status exported, and split with split_group when given, on the named items of one tenant (service-role client, each update
 * filtered by id and tenant_key). An item of another tenant or a missing one is ignored as not_found, an open or skipped item as
 * not_labelled; the guard trigger refuses a change to a frozen split, which is reported as a conflict for that item only.
 */
export async function markExported(admin: Client, tenantKey: string, items: MarkItem[]): Promise<MarkResult> {
  if (!parseTenantKey(tenantKey)) throw new Error('feedback_export_invalid_tenant');
  const result: MarkResult = { marked: [], conflicts: [], ignored: [] };
  const requested = items.map((item) => ({ ...item, id: item.id.toLowerCase() }));
  const { data, error } = await admin
    .from('rag_review_items')
    .select('id,tenant_key,status')
    .in(
      'id',
      requested.map((item) => item.id),
    )
    .eq('tenant_key', tenantKey);
  if (error) throw new Error('feedback_export_read_failed');
  const found = new Map<string, Row>();
  for (const row of (data ?? []) as unknown as Row[]) {
    if (row.tenant_key === tenantKey) found.set(String(row.id).toLowerCase(), row);
  }

  for (const item of requested) {
    const row = found.get(item.id);
    if (!row) {
      result.ignored.push({ id: item.id, reason: 'not_found' });
      continue;
    }
    if (row.status !== 'labelled' && row.status !== 'exported') {
      result.ignored.push({ id: item.id, reason: 'not_labelled' });
      continue;
    }
    const values: Row = { status: 'exported' };
    if (item.split !== undefined) {
      values.split = item.split;
      values.split_group = item.split_group;
    }
    const update = await admin
      .from('rag_review_items')
      .update(values)
      .eq('id', item.id)
      .eq('tenant_key', tenantKey)
      .select('id,split,split_group')
      .maybeSingle();
    if (update.error) {
      if (isSplitImmutable(update.error)) {
        result.conflicts.push({ id: item.id, reason: 'split_immutable' });
        continue;
      }
      throw new Error('feedback_export_mark_failed');
    }
    if (!update.data) {
      result.ignored.push({ id: item.id, reason: 'not_found' });
      continue;
    }
    const stored = update.data as unknown as Row;
    result.marked.push({ id: item.id, split: stringOrNull(stored.split), split_group: stringOrNull(stored.split_group) });
  }
  console.log('[Feedback Loop] export marked', {
    tenant: hashForLog(tenantKey),
    marked: result.marked.length,
    conflicts: result.conflicts.length,
    ignored: result.ignored.length,
  });
  return result;
}
