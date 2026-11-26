import { SupersessionRulesSchema, type SupersessionRules } from '@/lib/rag-eval/contracts.generated';
import rawRules from '../../../../../config/rag/supersession-rules.json';
import type { RpcClient } from '../../backend/supabase-rpc';
import { loadIngestConfig } from '../config';
import { getIngestDeps } from '../deps';
import type { PostPublishEvent } from '../post-publish';
import { directionFor, hasVersionMarker, normalizeTitle, titleOf, titleSimilarity, titleYear, versionMarkersFor } from './title';

/**
 * Supersession candidates after publish (DATA-19, D-41). Rules only, no model: a published document is compared with the tenant's current
 * ready documents of the same doc type (a) by title once year and version markers are removed and (b) by stored content that overlaps
 * strongly while its numbers differ. A match is raised as a pending candidate through rag_supersession_raise; nothing changes a document
 * until an admin confirms. With RAG_SUPERSESSION_DETECT=off the hook is not registered. Logs carry ids and counts only.
 */

export const SUPERSESSION_HOOK = 'supersession';

let rulesOverride: SupersessionRules | null = null;
let loadedRules: SupersessionRules | null = null;

/** The thresholds in config/rag/supersession-rules.json, validated once with the generated schema. */
export function supersessionRules(): SupersessionRules {
  if (rulesOverride) return rulesOverride;
  if (!loadedRules) loadedRules = SupersessionRulesSchema.parse(rawRules);
  return loadedRules;
}

export function setSupersessionRulesForTests(rules: unknown | null): void {
  rulesOverride = rules === null ? null : SupersessionRulesSchema.parse(rules);
}

export interface SupersessionDocument {
  documentId: string;
  lineageId: string | null;
  filename: string;
  docType: string | null;
  language: string | null;
  docDate: string | null;
  effectiveFrom: string | null;
  contentHash: string | null;
  /** Stored content cut to the rules' limit, or null when it was not loaded. */
  content: string | null;
}

export interface SupersessionSignals {
  title_match: boolean;
  content_overlap_percent: number;
  conflicting_numbers: number;
}

export type SupersessionDirection = 'document_newer' | 'candidate_newer';

export interface DetectedCandidate {
  candidateDocumentId: string;
  signals: SupersessionSignals;
  direction: SupersessionDirection | null;
}

const NUMBER = /\d+(?:[.,]\d+)*/gu;
const SENTENCE_BREAK = /(?:[!?;\n。！？；]|\.(?!\d))+/u;

interface Sentences {
  /** Sentence template (numbers masked) to the numbers of its first occurrence. */
  numbers: Map<string, string[]>;
}

function sentencesOf(text: string, rules: SupersessionRules): Sentences {
  const numbers = new Map<string, string[]>();
  const bounded = text.slice(0, rules.overlap_max_chars_per_document).normalize('NFKC').toLowerCase();
  for (const raw of bounded.split(SENTENCE_BREAK)) {
    const sentence = raw.replace(/\s+/gu, ' ').trim();
    const template = sentence.replace(NUMBER, '#');
    if (template.length < rules.overlap_min_sentence_chars || numbers.has(template)) continue;
    numbers.set(template, sentence.match(NUMBER) ?? []);
  }
  return { numbers };
}

/**
 * Share of sentences the two texts have in common once numbers are masked (percent of the shorter text's distinct sentences), and how
 * many numbers differ within those shared sentences.
 */
export function contentOverlap(a: string, b: string, rules: SupersessionRules = supersessionRules()): { percent: number; conflictingNumbers: number } {
  const left = sentencesOf(a, rules).numbers;
  const right = sentencesOf(b, rules).numbers;
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return { percent: 0, conflictingNumbers: 0 };
  let shared = 0;
  let conflictingNumbers = 0;
  for (const [template, leftNumbers] of left) {
    const rightNumbers = right.get(template);
    if (!rightNumbers) continue;
    shared += 1;
    for (let index = 0; index < Math.max(leftNumbers.length, rightNumbers.length); index += 1) {
      if (leftNumbers[index] !== rightNumbers[index]) conflictingNumbers += 1;
    }
  }
  return { percent: Math.min(100, Math.round((100 * shared) / smaller)), conflictingNumbers };
}

function factsOf(document: SupersessionDocument, rules: SupersessionRules) {
  return {
    year: titleYear(titleOf(document.filename), versionMarkersFor(document.language), rules.year_pattern),
    docDate: document.docDate,
    effectiveFrom: document.effectiveFrom,
  };
}

/** The normalized title the title rule compares, or null: an empty title, one without any version marker, or one too short never matches. */
function normalizedTitleOf(document: SupersessionDocument, rules: SupersessionRules): string | null {
  const title = titleOf(document.filename);
  const markers = versionMarkersFor(document.language);
  if (!hasVersionMarker(title, markers)) return null;
  const normalized = normalizeTitle(title, markers);
  return normalized !== null && normalized.length >= rules.title_min_chars ? normalized : null;
}

/** Signals and direction of one pair; the direction is relative to `document` (the published one). */
export function pairSignals(
  document: SupersessionDocument,
  other: SupersessionDocument,
  rules: SupersessionRules = supersessionRules(),
): { signals: SupersessionSignals; direction: SupersessionDirection | null; titleRule: boolean; overlapRule: boolean } {
  const ownTitle = normalizedTitleOf(document, rules);
  const otherTitle = normalizedTitleOf(other, rules);
  const titleMatch = ownTitle !== null && otherTitle !== null && titleSimilarity(ownTitle, otherTitle) >= rules.title_similarity_min;
  const sameContent = document.contentHash !== null && document.contentHash === other.contentHash;
  const overlap =
    document.content !== null && other.content !== null && !sameContent
      ? contentOverlap(document.content, other.content, rules)
      : { percent: 0, conflictingNumbers: 0 };
  const overlapRule = overlap.percent >= rules.content_overlap_min_percent && overlap.conflictingNumbers >= rules.min_conflicting_numbers;
  const newer = directionFor(factsOf(document, rules), factsOf(other, rules));
  return {
    signals: { title_match: titleMatch, content_overlap_percent: overlap.percent, conflicting_numbers: overlap.conflictingNumbers },
    direction: newer === 'a' ? 'document_newer' : newer === 'b' ? 'candidate_newer' : null,
    titleRule: titleMatch && !sameContent,
    overlapRule,
  };
}

/**
 * The pending candidates the rules raise for a published document against its peers: same doc type, another lineage, not the same
 * content. Pure: the caller loads the documents within the rules' bounds.
 */
export function detectSupersessionCandidates(
  document: SupersessionDocument,
  peers: readonly SupersessionDocument[],
  rules: SupersessionRules = supersessionRules(),
): DetectedCandidate[] {
  const found: DetectedCandidate[] = [];
  for (const peer of peers) {
    if (peer.documentId === document.documentId) continue;
    if (peer.docType !== document.docType) continue;
    if (document.lineageId !== null && peer.lineageId === document.lineageId) continue;
    const pair = pairSignals(document, peer, rules);
    if (pair.titleRule || pair.overlapRule) found.push({ candidateDocumentId: peer.documentId, signals: pair.signals, direction: pair.direction });
  }
  return found;
}

// --- Hook ---------------------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function dateText(row: Row, key: string): string | null {
  const value = row[key];
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : null;
}

function documentOf(row: Row): SupersessionDocument | null {
  const documentId = text(row, 'document_id');
  if (documentId === null) return null;
  return {
    documentId,
    lineageId: text(row, 'lineage_id'),
    filename: text(row, 'filename') ?? '',
    docType: text(row, 'doc_type'),
    language: text(row, 'language'),
    docDate: dateText(row, 'doc_date'),
    effectiveFrom: dateText(row, 'effective_from'),
    contentHash: text(row, 'content_hash'),
    content: text(row, 'content'),
  };
}

/** The "Replaces…" intent the route stored on the version (metadata.supersession_replaces); written by server code only. */
export interface ReplacesIntent {
  documentId: string;
  actor: string | null;
  confirm: boolean;
}

export function replacesIntentOf(value: unknown): ReplacesIntent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Row;
  const documentId = text(record, 'document_id');
  if (documentId === null || !UUID.test(documentId)) return null;
  const actor = text(record, 'actor');
  return { documentId: documentId.toLowerCase(), actor: actor !== null && UUID.test(actor) ? actor.toLowerCase() : null, confirm: record.confirm === true };
}

function reasonOf(message: string | undefined): string {
  return /^[a-z_]+/u.exec(message ?? '')?.[0] ?? 'unknown';
}

async function rpcRows(db: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ rows: Row[] } | { reason: string }> {
  signal.throwIfAborted();
  const response = await db.rpc(fn, args).abortSignal(signal);
  if (response.error) return { reason: reasonOf(response.error.message) };
  return { rows: (Array.isArray(response.data) ? response.data : response.data ? [response.data] : []) as Row[] };
}

async function raise(
  db: RpcClient,
  tenantKey: string,
  documentId: string,
  candidate: DetectedCandidate,
  origin: 'detected' | 'uploader',
  signal: AbortSignal,
): Promise<string | null> {
  const result = await rpcRows(
    db,
    'rag_supersession_raise',
    {
      p_tenant_key: tenantKey,
      p_document_id: documentId,
      p_candidate_document_id: candidate.candidateDocumentId,
      p_signals: candidate.signals,
      p_direction: candidate.direction,
      p_origin: origin,
    },
    signal,
  );
  if ('reason' in result) {
    console.warn('[Ingest] supersession candidate not raised', { documentId, candidateDocumentId: candidate.candidateDocumentId, origin, reason: result.reason });
    return null;
  }
  const id = result.rows[0] ? text(result.rows[0], 'candidate_id') : null;
  return id;
}

/** Runs the detector for one published version. Never throws on a refusal: each is logged with its reason word and ids. */
export async function runSupersessionDetection(event: PostPublishEvent, signal: AbortSignal): Promise<{ raised: number; confirmed: number }> {
  const db = getIngestDeps().db();
  if (!db) return { raised: 0, confirmed: 0 };
  const rules = supersessionRules();
  const loaded = await rpcRows(
    db,
    'rag_supersession_peers',
    {
      p_tenant_key: event.tenantKey,
      p_document_id: event.documentId,
      p_limit: rules.max_title_candidates,
      p_text_documents: rules.overlap_max_documents,
      p_max_chars: rules.overlap_max_chars_per_document,
    },
    signal,
  );
  if ('reason' in loaded) {
    console.warn('[Ingest] supersession peers unavailable', { documentId: event.documentId, reason: loaded.reason });
    return { raised: 0, confirmed: 0 };
  }
  const selfRow = loaded.rows.find((row) => row.is_self === true);
  const self = selfRow ? documentOf(selfRow) : null;
  if (!selfRow || !self) return { raised: 0, confirmed: 0 };
  const peers = loaded.rows.filter((row) => row.is_self !== true).map(documentOf).filter((doc): doc is SupersessionDocument => doc !== null);

  let raised = 0;
  let confirmed = 0;
  const replaces = replacesIntentOf(selfRow.replaces);
  if (replaces && replaces.documentId !== self.documentId.toLowerCase()) {
    const target = peers.find((peer) => peer.documentId.toLowerCase() === replaces.documentId);
    const signals = target ? pairSignals(self, target, rules).signals : { title_match: false, content_overlap_percent: 0, conflicting_numbers: 0 };
    const candidateId = await raise(db, event.tenantKey, self.documentId, { candidateDocumentId: replaces.documentId, signals, direction: 'document_newer' }, 'uploader', signal);
    if (candidateId !== null) {
      raised += 1;
      if (replaces.confirm && replaces.actor !== null) {
        const decision = await rpcRows(db, 'rag_confirm_supersession', { p_candidate_id: candidateId, p_actor: replaces.actor, p_older_document_id: null }, signal);
        if ('reason' in decision) console.warn('[Ingest] uploader supersession left pending', { documentId: self.documentId, candidateId, reason: decision.reason });
        else confirmed += 1;
      }
    }
  }

  const others = replaces ? peers.filter((peer) => peer.documentId.toLowerCase() !== replaces.documentId) : peers;
  for (const candidate of detectSupersessionCandidates(self, others, rules)) {
    if ((await raise(db, event.tenantKey, self.documentId, candidate, 'detected', signal)) !== null) raised += 1;
  }
  if (raised > 0) console.log('[Ingest] supersession candidates raised', { documentId: self.documentId, raised, confirmed });
  return { raised, confirmed };
}

/** Whether the process runs the detector (RAG_SUPERSESSION_DETECT=on). A config that cannot be read counts as off. */
export function supersessionDetectOn(): boolean {
  try {
    return loadIngestConfig(getIngestDeps().ingestEnv()).supersessionDetect === 'on';
  } catch {
    return false;
  }
}

type Register = (name: string, run: (event: PostPublishEvent, signal: AbortSignal) => Promise<void>, options: { timeoutMs: number }) => void;

/** Registers the detector as a post-publish hook with the rules' time budget. */
export function registerSupersessionHook(register: Register): void {
  register(
    SUPERSESSION_HOOK,
    async (event, signal) => {
      await runSupersessionDetection(event, signal);
    },
    { timeoutMs: supersessionRules().hook_timeout_ms },
  );
}
