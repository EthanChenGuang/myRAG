import type { SupabaseClient } from '@supabase/supabase-js';
import { queryFingerprint, toLanguageCode } from '../feedback-loop/query-codes';
import { detectLanguageWithConfidence } from '../lang/detect';
import { maskPII } from '../trace/mask';

/** D-51 limits: CLI files, stored questions and Config UI batches (UI-SPEC 6.10.3). */
export const IMPORT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 20_000,
  maxQuestionChars: 2000,
  maxBatchBytes: 60 * 1024,
  maxBatchRows: 2000,
} as const;

export type QuestionFileFormat = 'csv' | 'jsonl';

export type ParseResult = { ok: true; values: Array<string | null> } | { ok: false; reason: 'column_not_found' | 'too_many_rows' };

export interface PreparedQuestion {
  queryMasked: string;
  fingerprint: string;
  language: string;
}

export interface PreparedQuestions {
  rows: PreparedQuestion[];
  read: number;
  empty: number;
  truncated: number;
  rejectedPii: number;
  duplicatesInFile: number;
}

/** The only output of an import: counts and language codes, never question text. */
export interface ImportCounts {
  read: number;
  added: number;
  duplicates: number;
  rejected_pii: number;
  truncated: number;
  empty: number;
  by_language: Record<string, number>;
}

export class QuestionsImportError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
  ) {
    super(`[Monitor] questions import ${operation} failed (${code})`);
    this.name = 'QuestionsImportError';
  }
}

type ImportAdmin = Pick<SupabaseClient, 'from' | 'rpc'>;

const TENANT_KEY_RE = /^(?:s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UNDETERMINED = 'und';
const LOOKUP_CHUNK = 200;
const ENQUEUE_CHUNK = 500;
const DAY_MS = 86_400_000;

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks; CRLF and LF both end a record. */
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
    index += 1;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((row) => !(row.length === 1 && row[0] === ''));
}

/** CSV with a header row or JSON lines; a malformed line or a non-string value is an empty row (null), never echoed. */
export function parseQuestionFile(text: string, options: { format: QuestionFileFormat; column: string }): ParseResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const values: Array<string | null> = [];
  if (options.format === 'csv') {
    const [header, ...rows] = csvRecords(body);
    const columnIndex = (header ?? []).map((name) => name.trim()).indexOf(options.column);
    if (columnIndex < 0) return { ok: false, reason: 'column_not_found' };
    if (rows.length > IMPORT_LIMITS.maxRows) return { ok: false, reason: 'too_many_rows' };
    for (const row of rows) values.push(row[columnIndex] ?? null);
    return { ok: true, values };
  }
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length > IMPORT_LIMITS.maxRows) return { ok: false, reason: 'too_many_rows' };
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      values.push(null);
      continue;
    }
    const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)[options.column] : undefined;
    values.push(typeof value === 'string' ? value : null);
  }
  return { ok: true, values };
}

/**
 * D-51: mask, reject a row the masker still changes, cap at 2000 characters, detect the language, fingerprint with the retrieval
 * log's function (on the masked text, as the log does) and drop in-file duplicates. Pure; returns rows and counts.
 */
export function prepareQuestions(
  values: readonly unknown[],
  options: { fingerprint?: (masked: string) => string } = {},
): PreparedQuestions {
  const fingerprint = options.fingerprint ?? queryFingerprint;
  const prepared: PreparedQuestions = { rows: [], read: values.length, empty: 0, truncated: 0, rejectedPii: 0, duplicatesInFile: 0 };
  const seen = new Set<string>();
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') {
      prepared.empty += 1;
      continue;
    }
    const masked = maskPII(text);
    if (maskPII(masked) !== masked) {
      prepared.rejectedPii += 1;
      continue;
    }
    const key = fingerprint(masked);
    if (seen.has(key)) {
      prepared.duplicatesInFile += 1;
      continue;
    }
    seen.add(key);
    let queryMasked = masked;
    if (Array.from(masked).length > IMPORT_LIMITS.maxQuestionChars) {
      queryMasked = Array.from(masked).slice(0, IMPORT_LIMITS.maxQuestionChars).join('');
      prepared.truncated += 1;
    }
    const language = toLanguageCode(detectLanguageWithConfidence(masked).language) ?? UNDETERMINED;
    prepared.rows.push({ queryMasked, fingerprint: key, language });
  }
  return prepared;
}

/** Monday 00:00 UTC of the week holding `now`: the mining window of an import. */
function importWeek(now: Date): string {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * DAY_MS).toISOString();
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'unknown';
}

async function existingFingerprints(admin: ImportAdmin, tenantKey: string, fingerprints: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let start = 0; start < fingerprints.length; start += LOOKUP_CHUNK) {
    const chunk = fingerprints.slice(start, start + LOOKUP_CHUNK);
    const { data, error } = await admin.from('rag_review_items').select('query_fingerprint').eq('tenant_key', tenantKey).in('query_fingerprint', chunk);
    if (error) throw new QuestionsImportError('lookup', codeOf(error));
    for (const row of (data ?? []) as Array<{ query_fingerprint?: unknown }>) {
      if (typeof row.query_fingerprint === 'string') known.add(row.query_fingerprint);
    }
  }
  return known;
}

/**
 * Enqueues prepared questions for one tenant through rag_review_items_enqueue with source historical and reason representative
 * (D-41), sampling weight 1, stratum historical|<language>|import and the import week as the mining window; no log row. A question
 * already in the tenant's queue (any window) is a duplicate. A dry run reads the queue and writes nothing. Counts only.
 */
export async function importQuestions(
  admin: ImportAdmin,
  input: { tenantKey: string; prepared: PreparedQuestions; dryRun: boolean; now?: Date },
): Promise<ImportCounts> {
  const { tenantKey, prepared, dryRun } = input;
  if (!TENANT_KEY_RE.test(tenantKey)) throw new QuestionsImportError('tenant', 'invalid_tenant_key');
  const known = await existingFingerprints(
    admin,
    tenantKey,
    prepared.rows.map((row) => row.fingerprint),
  );
  const fresh = prepared.rows.filter((row) => !known.has(row.fingerprint));
  const byLanguage: Record<string, number> = {};
  for (const row of fresh) byLanguage[row.language] = (byLanguage[row.language] ?? 0) + 1;

  let added = fresh.length;
  if (!dryRun && fresh.length > 0) {
    const window = importWeek(input.now ?? new Date());
    added = 0;
    for (let start = 0; start < fresh.length; start += ENQUEUE_CHUNK) {
      const rows = fresh.slice(start, start + ENQUEUE_CHUNK).map((row) => ({
        query_masked: row.queryMasked,
        query_fingerprint: row.fingerprint,
        language: row.language,
        reasons: ['representative'],
        mining_window: window,
        stratum: `historical|${row.language}|import`,
        sampling_weight: 1,
      }));
      const { data, error } = await admin.rpc('rag_review_items_enqueue', { p_tenant_key: tenantKey, p_source: 'historical', p_rows: rows });
      if (error) throw new QuestionsImportError('enqueue', codeOf(error));
      added += typeof data === 'number' && Number.isFinite(data) ? data : 0;
    }
  }

  return {
    read: prepared.read,
    added,
    duplicates: prepared.duplicatesInFile + (prepared.rows.length - added),
    rejected_pii: prepared.rejectedPii,
    truncated: prepared.truncated,
    empty: prepared.empty,
    by_language: byLanguage,
  };
}
