import { IngestFingerprintPartsSchema, type IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';
import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import { getLanguagePack } from '../../lang/registry';
import type { LanguageSettings } from '../../lang/settings';
import {
  EMBEDDING_PROFILE_VERSION,
  FINGERPRINT_CHUNKING_PROFILE_ID,
  buildIngestFingerprint,
  languagePackVersions,
  ocrEngineCodes,
  ocrLanguagesUsed,
} from '../fingerprint';
import { loadProcessingProfiles } from '../profiles/load';
import { isTenantKey } from '../writer';

type PartName = NonNullable<IngestFingerprintParts['assumed_defaults']>[number];

/** The order of the contract's part names; assumed_defaults is listed in it so equal assumptions give equal fingerprints. */
const PART_ORDER: readonly PartName[] = IngestFingerprintPartsSchema.shape.assumed_defaults.unwrap().element.options;
const UNKNOWN = 'unknown';
const PART_TEXT_MAX = 128;
const UNCONFIGURED: LanguageSettings = { configured: false, languages: [], primary: null, monolingual: false };
/** The switch states before Phase 3.2: the defaults of RAG_LANGUAGE_AWARE_INGEST, RAG_TABLE_HEADER_REPEAT, RAG_TABLE_ROW_SERIALIZATION, RAG_CAPTION_LANGUAGE. */
const DEFAULT_SWITCHES: IngestFingerprintParts['switches'] = {
  language_aware_ingest: 'off',
  table_header_repeat: 'profile',
  table_row_serialization: 'false',
  caption_language: 'en',
};

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export class FingerprintBackfillError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FingerprintBackfillError';
  }
}

/** One row of rag_fingerprint_backfill_page: the stored columns a fingerprint is rebuilt from, nothing parsed or embedded. */
export interface BackfillRow {
  id: string;
  tenant_key: string;
  doc_type: string;
  parser_used: string | null;
  parser_version: string | null;
  processing_profile_id: string | null;
  processing_profile_version: number | null;
  chunking_profile_ids: string[];
  lexical_version: number | null;
  embedding_text_version: number | null;
  embedding_profile_ids: string[];
  has_legacy_vectors: boolean;
  ocr_languages: unknown;
}

export interface FingerprintBackfillOptions {
  db: RpcClient;
  tenantKey?: string | null;
  pageSize?: number;
  dryRun?: boolean;
  /** Stop after this many pages (an interrupted run); the next run continues with the documents still without a fingerprint. */
  maxPages?: number;
  /** The profile new versions are embedded with; preferred when a document has vectors in several. Defaults to the legacy profile. */
  embeddingProfileId?: string;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

export interface FingerprintBackfillReport {
  dryRun: boolean;
  /** Documents updated (or, on a dry run, that would be) per tenant key. */
  tenants: Record<string, number>;
  updated: number;
  /** Documents that gained a fingerprint from another writer between the read and the write. */
  skipped: number;
  pages: number;
  complete: boolean;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, PART_TEXT_MAX);
}

function count(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

/** The OCR languages a queued run recorded in its settings snapshot; null when there is none or it names an unknown language. */
function snapshotLanguages(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const codes = value.filter((entry): entry is string => typeof entry === 'string');
  if (codes.length !== value.length || codes.some((code) => getLanguagePack(code) === null || getLanguagePack(code) === undefined)) return null;
  return [...new Set(codes)];
}

function asRow(raw: unknown): BackfillRow {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    tenant_key: String(row.tenant_key),
    doc_type: text(row.doc_type) ?? 'general',
    parser_used: text(row.parser_used),
    parser_version: text(row.parser_version),
    processing_profile_id: text(row.processing_profile_id),
    processing_profile_version: count(row.processing_profile_version),
    chunking_profile_ids: strings(row.chunking_profile_ids),
    lexical_version: count(row.lexical_version),
    embedding_text_version: count(row.embedding_text_version),
    embedding_profile_ids: strings(row.embedding_profile_ids),
    has_legacy_vectors: row.has_legacy_vectors === true,
    ocr_languages: row.ocr_languages ?? null,
  };
}

function embeddingProfileOf(row: BackfillRow, preferred: string): { id: string; assumed: boolean } {
  const legacy = LEGACY_PROFILE.id;
  if (preferred === legacy && row.has_legacy_vectors) return { id: legacy, assumed: false };
  if (row.embedding_profile_ids.includes(preferred)) return { id: preferred, assumed: false };
  if (row.has_legacy_vectors) return { id: legacy, assumed: false };
  const first = row.embedding_profile_ids[0];
  if (first !== undefined) return { id: first, assumed: false };
  return { id: preferred, assumed: true };
}

/**
 * D-10 backfill: the parts of a document published before this phase, from stored columns only. A part with no stored source takes the value
 * the defaults gave at the time (this phase's switches, the profile's OCR languages for inline runs that wrote no ledger row) and is listed in
 * assumed_defaults.
 */
export function partsFromStoredRow(row: BackfillRow, options: { embeddingProfileId: string }): IngestFingerprintParts {
  const assumed = new Set<PartName>();
  const profiles = loadProcessingProfiles().profiles;

  const parserUsed = row.parser_used ?? UNKNOWN;
  if (row.parser_used === null) assumed.add('parser_used');
  const parserVersion = row.parser_version ?? UNKNOWN;
  if (row.parser_version === null) assumed.add('parser_version');

  let profile = row.processing_profile_id === null ? undefined : profiles.find((candidate) => candidate.id === row.processing_profile_id);
  let profileId = row.processing_profile_id;
  if (profileId === null) {
    const byType = new Map(profiles.map((candidate) => [candidate.doc_type as string, candidate]));
    profile = byType.get(row.doc_type) ?? byType.get('general');
    profileId = profile?.id ?? UNKNOWN;
    assumed.add('processing_profile_id');
  }
  let profileVersion = row.processing_profile_version;
  if (profileVersion === null || profileVersion < 1) {
    profileVersion = profile?.version ?? 1;
    assumed.add('processing_profile_version');
  }

  const recorded = snapshotLanguages(row.ocr_languages);
  const ocrLanguages = recorded ?? [...(profile?.parser.ocr_languages ?? [])];
  if (recorded === null) {
    assumed.add('ocr_engine_codes');
    assumed.add('language_pack_versions');
  }

  let chunkingProfileId: string = FINGERPRINT_CHUNKING_PROFILE_ID;
  if (row.chunking_profile_ids.length === 0) assumed.add('chunking_profile_id');
  else if (!row.chunking_profile_ids.includes(FINGERPRINT_CHUNKING_PROFILE_ID)) chunkingProfileId = row.chunking_profile_ids[0] as string;

  const lexicalVersion = row.lexical_version ?? 0;
  if (row.lexical_version === null) assumed.add('lexical_version');
  const embeddingTextVersion = row.embedding_text_version ?? 0;
  if (row.embedding_text_version === null) assumed.add('embedding_text_version');

  const embedding = embeddingProfileOf(row, options.embeddingProfileId);
  if (embedding.assumed) assumed.add('embedding_profile_id');
  assumed.add('switches');

  return IngestFingerprintPartsSchema.parse({
    parser_used: parserUsed,
    parser_version: parserVersion,
    processing_profile_id: profileId,
    processing_profile_version: profileVersion,
    ocr_engine_codes: ocrEngineCodes(parserUsed, ocrLanguages),
    chunking_profile_id: chunkingProfileId,
    lexical_version: lexicalVersion,
    embedding_text_version: embeddingTextVersion,
    embedding_profile_id: embedding.id,
    embedding_profile_version: EMBEDDING_PROFILE_VERSION,
    language_pack_versions: languagePackVersions(ocrLanguagesUsed(parserUsed, ocrLanguages), UNCONFIGURED, DEFAULT_SWITCHES.language_aware_ingest),
    switches: DEFAULT_SWITCHES,
    assumed_defaults: PART_ORDER.filter((name) => assumed.has(name)),
  });
}

async function call(db: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
  signal?.throwIfAborted();
  let request = db.rpc(fn, args);
  if (signal) request = request.abortSignal(signal);
  const response = await request;
  signal?.throwIfAborted();
  if (response.error) throw new FingerprintBackfillError(`rpc_failed:${fn}`);
  return response.data;
}

function wrote(data: unknown): boolean {
  if (data === true) return true;
  const first = rpcRows(data)[0];
  return typeof first === 'object' && first !== null && (first as Record<string, unknown>).rag_fingerprint_backfill_write === true;
}

/**
 * npm run rag:fingerprint -- backfill: pages through current documents without a fingerprint in id order and stamps each from its stored
 * columns. Zero parser, sidecar or embedding calls. The write only lands while the document still has no fingerprint, so a rerun or a
 * concurrent publish never rewrites a finished one; an interrupted run is continued by running it again.
 */
export async function runFingerprintBackfill(options: FingerprintBackfillOptions): Promise<FingerprintBackfillReport> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new FingerprintBackfillError('invalid_page_size');
  const tenantKey = options.tenantKey ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) throw new FingerprintBackfillError('invalid_tenant_key');
  const dryRun = options.dryRun === true;
  const embeddingProfileId = options.embeddingProfileId ?? LEGACY_PROFILE.id;

  const report: FingerprintBackfillReport = { dryRun, tenants: {}, updated: 0, skipped: 0, pages: 0, complete: false };
  let after: string | null = null;
  for (;;) {
    if (options.maxPages !== undefined && report.pages >= options.maxPages) break;
    const rows: BackfillRow[] = rpcRows(await call(options.db, 'rag_fingerprint_backfill_page', { p_tenant_key: tenantKey, p_limit: pageSize, p_after: after }, options.signal)).map(asRow);
    report.pages += 1;
    for (const row of rows) {
      const parts = partsFromStoredRow(row, { embeddingProfileId });
      if (dryRun) {
        report.tenants[row.tenant_key] = (report.tenants[row.tenant_key] ?? 0) + 1;
        continue;
      }
      const data = await call(
        options.db,
        'rag_fingerprint_backfill_write',
        { p_tenant_key: row.tenant_key, p_document_id: row.id, p_fingerprint: buildIngestFingerprint(parts), p_parts: parts },
        options.signal,
      );
      if (wrote(data)) {
        report.updated += 1;
        report.tenants[row.tenant_key] = (report.tenants[row.tenant_key] ?? 0) + 1;
      } else {
        report.skipped += 1;
      }
    }
    const last: BackfillRow | undefined = rows[rows.length - 1];
    if (rows.length < pageSize || last === undefined) {
      report.complete = true;
      break;
    }
    after = last.id;
    options.onProgress?.(`page ${report.pages}: ${rows.length} documents`);
  }
  return report;
}
