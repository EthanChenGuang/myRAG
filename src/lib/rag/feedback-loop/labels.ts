import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import { ExpertLabelSchema, type ExpertLabel } from '@/lib/rag-eval/contracts.generated';
import { parseTenantKey } from '@/lib/rag/tenant/embed';
import { fetchServableChunks, hashForLog, readVisibleItem, snapshotRefs } from './review-access';

type Client = SupabaseClient;
type Row = Record<string, unknown>;

/** Code points for which Python str.isspace() is true (JS \s differs: it adds U+FEFF and lacks 0x1C-0x1F and NEL). */
const PY_SPACE_CODES: ReadonlyArray<number | [number, number]> = [
  [0x09, 0x0d], [0x1c, 0x20], 0x85, 0xa0, 0x1680, [0x2000, 0x200a], 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];
const PY_SPACE = new Set<number>(
  PY_SPACE_CODES.flatMap((entry) => (Array.isArray(entry) ? Array.from({ length: entry[1] - entry[0] + 1 }, (_, i) => entry[0] + i) : [entry])),
);
const PUNCTUATION_RE = /\p{P}/u;

/**
 * TypeScript twin of eval normalize_text (rag_eval.matching): NFKC, case fold, then every whitespace and punctuation code point
 * removed. Case folding is upper-then-lower per string, which matches Python's casefold for zh, en and it text (ß, ſ, final sigma).
 */
export function normalizeQuoteText(text: string): string {
  const folded = text.normalize('NFKC').toUpperCase().toLowerCase();
  let out = '';
  for (const char of folded) {
    if (!PY_SPACE.has(char.codePointAt(0) ?? 0) && !PUNCTUATION_RE.test(char)) out += char;
  }
  return out;
}

const UNANSWERABLE_CATEGORIES = new Set(['no_answer', 'small_talk', 'off_topic_context']);

/** The model rules of the Pydantic ExpertLabel (generated Zod carries the fields only). */
function checkLabelRules(label: ExpertLabel, ctx: z.RefinementCtx): void {
  const evidence = label.evidence ?? [];
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (UNANSWERABLE_CATEGORIES.has(label.category) === label.answerable) {
    issue('category no_answer or small_talk if and only if answerable is false');
  }
  if (label.answerable) {
    if (!label.expected_answer || label.expected_answer.trim() === '') issue('an answerable label needs a non-empty expected_answer');
    if (evidence.length === 0) issue('an answerable label needs at least one evidence span');
  } else if (evidence.length > 0) {
    issue('a label that is not answerable carries no evidence');
  }
  if (label.triage.includes('golden') && !label.pii_checked) issue('golden triage requires pii_checked true');
  if (label.triage.includes('dictionary') && (label.dictionary_terms ?? []).length === 0) {
    issue('dictionary triage requires at least one dictionary term');
  }
  const cited = new Set(evidence.map((span) => span.chunk_id));
  if ((label.not_relevant_chunk_ids ?? []).some((chunkId) => cited.has(chunkId))) {
    issue('a chunk cited as evidence cannot be marked not relevant');
  }
  if (new Set(evidence.map((span) => `${span.chunk_id}\u0000${span.quote}`)).size !== evidence.length) {
    issue('evidence contains identical spans');
  }
}

/** Clients may only label or skip; the tenant never comes from the body (strict objects reject any extra key). */
export const LabelRequestSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('labelled'), label: ExpertLabelSchema.superRefine(checkLabelRules) }).strict(),
  z.object({ status: z.literal('skipped') }).strict(),
]);
export type LabelRequest = z.infer<typeof LabelRequestSchema>;

export type EvidenceFailureReason = 'chunk_not_in_tenant' | 'chunk_not_servable' | 'document_mismatch' | 'quote_empty' | 'quote_not_found';

export type SaveLabelResult =
  | { ok: true; item_id: string; status: 'labelled' | 'skipped'; triage: string[]; label: ExpertLabel | null; labelled_at: string }
  | { ok: false; reason: 'not_found' | 'exported' }
  | { ok: false; reason: 'invalid_evidence'; span: number; detail: EvidenceFailureReason }
  | { ok: false; reason: 'invalid_not_relevant'; index: number };

type EvidenceCheck =
  | { ok: true; evidence: NonNullable<ExpertLabel['evidence']> }
  | { ok: false; span: number; detail: EvidenceFailureReason };

/** Chunk ids that exist in the tenant in any state; only asked for ids that are not servable, to tell the two reasons apart. */
async function tenantChunkIds(admin: Client, tenantKey: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await admin.from('document_chunks').select('id,tenant_key').in('id', ids).eq('tenant_key', tenantKey);
  if (error) throw new Error('review_label_chunks_read_failed');
  return new Set(
    ((data ?? []) as unknown as Row[]).filter((row) => row.tenant_key === tenantKey).map((row) => String(row.id).toLowerCase()),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * D-18: every span must name a current, ready chunk of a current, ready document in the item's tenant, its document id must be that
 * chunk's document, and its quote must be a substring of the chunk text after normalizeQuoteText. Document name and section are
 * taken from the database. Failures name the span index and a reason, never chunk text.
 */
async function checkEvidence(admin: Client, tenantKey: string, label: ExpertLabel): Promise<EvidenceCheck> {
  const spans = label.evidence ?? [];
  const servable = await fetchServableChunks(
    admin,
    tenantKey,
    spans.map((span) => span.chunk_id),
  );
  const missing = [
    ...new Set(spans.map((span) => span.chunk_id.toLowerCase()).filter((chunkId) => UUID_RE.test(chunkId) && !servable.has(chunkId))),
  ];
  const inTenant = await tenantChunkIds(admin, tenantKey, missing);

  const evidence: NonNullable<ExpertLabel['evidence']> = [];
  for (const [index, span] of spans.entries()) {
    const chunkId = span.chunk_id.toLowerCase();
    const chunk = servable.get(chunkId);
    if (!chunk) return { ok: false, span: index, detail: inTenant.has(chunkId) ? 'chunk_not_servable' : 'chunk_not_in_tenant' };
    if (chunk.document_id !== span.document_id.toLowerCase()) return { ok: false, span: index, detail: 'document_mismatch' };
    const quote = normalizeQuoteText(span.quote);
    if (quote === '') return { ok: false, span: index, detail: 'quote_empty' };
    if (!normalizeQuoteText(chunk.text).includes(quote)) return { ok: false, span: index, detail: 'quote_not_found' };
    evidence.push({
      chunk_id: chunkId,
      document_id: chunk.document_id,
      document_name: chunk.document_name.slice(0, 512) || span.document_name,
      section: chunk.section.slice(0, 512),
      quote: span.quote,
    });
  }
  return { ok: true, evidence };
}

function isExportedError(error: unknown): boolean {
  const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : '';
  return message.includes('review_item_exported');
}

/**
 * Reads the item through RLS, refuses an exported item, checks the evidence under the item's own tenant (admin client restricted to
 * that tenant_key) and the not-relevant ids against the snapshot, then writes with the caller's SSR client so RLS and the guard
 * trigger (labelled_by, client status) decide. A relabel replaces the earlier label; a skip clears it.
 */
export async function validateAndSaveLabel(ssr: Client, admin: Client, id: string, request: LabelRequest, expertId: string): Promise<SaveLabelResult> {
  const item = await readVisibleItem(ssr, id);
  if (!item) return { ok: false, reason: 'not_found' };
  const tenantKey = item.tenant_key;
  if (typeof tenantKey !== 'string' || !parseTenantKey(tenantKey)) return { ok: false, reason: 'not_found' };
  if (item.status === 'exported') return { ok: false, reason: 'exported' };

  let label: ExpertLabel | null = null;
  let triage: string[] = [];
  if (request.status === 'labelled') {
    const snapshot = new Set(snapshotRefs(item.candidates).map((ref) => ref.chunkId.toLowerCase()));
    const notRelevant = request.label.not_relevant_chunk_ids ?? [];
    const outside = notRelevant.findIndex((chunkId) => !snapshot.has(chunkId.toLowerCase()));
    if (outside >= 0) return { ok: false, reason: 'invalid_not_relevant', index: outside };

    const checked = await checkEvidence(admin, tenantKey, request.label);
    if (!checked.ok) return { ok: false, reason: 'invalid_evidence', span: checked.span, detail: checked.detail };
    label = { ...request.label, evidence: checked.evidence };
    triage = [...request.label.triage];
  }

  const labelledAt = new Date().toISOString();
  const { data, error } = await ssr
    .from('rag_review_items')
    .update({ status: request.status, triage, label, labelled_at: labelledAt })
    .eq('id', String(item.id))
    .select('id,status,triage,labelled_at')
    .maybeSingle();
  if (error) {
    if (isExportedError(error)) return { ok: false, reason: 'exported' };
    throw new Error('review_label_write_failed');
  }
  if (!data) return { ok: false, reason: 'not_found' };

  console.log('[Review] label', { expert: expertId, item: hashForLog(String(item.id)), status: request.status, triage });
  const row = data as unknown as Row;
  return {
    ok: true,
    item_id: String(item.id),
    status: request.status,
    triage,
    label,
    labelled_at: typeof row.labelled_at === 'string' ? row.labelled_at : labelledAt,
  };
}
