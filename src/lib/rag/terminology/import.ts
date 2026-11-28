import {
  DictionaryCandidateSchema,
  type TerminologyEntry,
  type TerminologyImportReport,
  type TerminologyValidationIssue,
} from '@/lib/rag-eval/contracts.generated';
import { normalizeLexical } from '../lexical/tokenize';
import {
  SHARED,
  UNAVAILABLE,
  callTerminologyRpc,
  count,
  errorsOf,
  invalidateLayer,
  layerOf,
  loadLayer,
  storedCandidate,
  terminologyEnabledLanguages,
  text,
  withoutDuplicates,
  type TerminologyAdminEntry,
  type TerminologyAdminFailed,
} from './admin';
import {
  TERMINOLOGY_CSV_MAX_BYTES,
  TERMINOLOGY_CSV_MAX_ROWS,
  parseTerminologyCsv,
  serializeTerminologyCsv,
  type TerminologyCsvError,
  type TerminologyCsvRow,
} from './csv';
import { terminologyParams } from './expand';
import { validateEntries } from './validate';

export type TerminologyImportMode = 'merge' | 'replace';
export type TerminologyImportFormat = 'csv' | 'dictionary_candidates_jsonl';

export interface TerminologyImportInput {
  /** The admin the route guard verified; the SQL checks admin_users and the layer again. */
  actorUserId: string;
  /** 'shared', or the tenant key of the workspace scope the route resolved. */
  layerKey: string;
  mode: TerminologyImportMode;
  format: TerminologyImportFormat;
  content: string;
  dryRun: boolean;
  /** Apply: the layer version the dry run reported (D-05). */
  expectedVersion?: number | null;
  /** dictionary_candidates_jsonl: the tenant key of the resolved workspace; a row naming any other tenant is rejected (D-25a). */
  workspaceTenantKey?: string | null;
  signal: AbortSignal;
}

export type TerminologyImportResult =
  | { ok: true; report: TerminologyImportReport; layerVersion: number; entriesSha256: string | null }
  | { ok: false; reason: 'invalid_file'; errors: TerminologyCsvError[] }
  | (TerminologyAdminFailed & { report?: TerminologyImportReport });

export type TerminologyExportResult = { ok: true; csv: string; layerVersion: number; rows: number } | TerminologyAdminFailed;

type Issue = TerminologyValidationIssue;
type ParsedFile = { ok: true; rows: TerminologyCsvRow[]; candidates: boolean } | { ok: false; errors: TerminologyCsvError[]; limit: boolean };

/** D-23: the diff key, also the uniqueness key of rag_term_apply_import. */
export function importKey(entry: { language: string; target_language: string | null; canonical: string }): string {
  return `${entry.language}\u001f${entry.target_language ?? ''}\u001f${entry.canonical.toLowerCase()}`;
}

/**
 * D-25a: Phase 5.1.1 DictionaryCandidate JSONL → import rows. observed_term becomes the variant, canonical_term the canonical, relation
 * the kind; a translation takes its target language from canonical_language and is never guessed (a missing one reaches the validator
 * as a translation pair without a target, which it reports as invalid_translation). Candidates with the same key merge their variants.
 */
function parseCandidates(content: string, workspaceTenantKey: string | null | undefined): ParsedFile {
  if (Buffer.byteLength(content, 'utf8') > TERMINOLOGY_CSV_MAX_BYTES) return { ok: false, errors: [{ row: 0, message: 'The file is larger than 1 MB.' }], limit: true };
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  if (lines.length > TERMINOLOGY_CSV_MAX_ROWS) {
    return { ok: false, errors: [{ row: 0, message: `The file has more than ${TERMINOLOGY_CSV_MAX_ROWS} rows.` }], limit: true };
  }
  const errors: TerminologyCsvError[] = [];
  const rows: TerminologyCsvRow[] = [];
  const byKey = new Map<string, TerminologyCsvRow>();
  lines.forEach((line, index) => {
    const row = index + 1;
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push({ row, message: 'The line is not valid JSON.' });
      return;
    }
    const parsed = DictionaryCandidateSchema.safeParse(value);
    if (!parsed.success) {
      errors.push({ row, message: 'The line is not a dictionary candidate.' });
      return;
    }
    const candidate = parsed.data;
    if (!workspaceTenantKey || candidate.tenant_key !== workspaceTenantKey) {
      errors.push({ row, message: 'tenant_key does not match the workspace of this import.' });
      return;
    }
    const translation = candidate.relation === 'translation';
    const mapped: TerminologyCsvRow = {
      canonical: candidate.canonical_term,
      variants: [candidate.observed_term],
      language: candidate.language,
      kind: candidate.relation,
      mode: 'one_way',
      enabled: true,
      note: null,
      source_language: translation ? candidate.language : null,
      target_language: translation ? (candidate.canonical_language ?? null) : null,
    };
    const key = `${mapped.kind}\u001f${importKey(mapped)}`;
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.variants.includes(mapped.variants[0]!)) seen.variants.push(mapped.variants[0]!);
      return;
    }
    byKey.set(key, mapped);
    rows.push(mapped);
  });
  return errors.length > 0 ? { ok: false, errors, limit: false } : { ok: true, rows, candidates: true };
}

function parseFile(input: TerminologyImportInput): ParsedFile {
  if (input.format === 'dictionary_candidates_jsonl') return parseCandidates(input.content, input.workspaceTenantKey);
  const parsed = parseTerminologyCsv(input.content);
  if (parsed.limit || parsed.errors.length > 0) return { ok: false, errors: parsed.errors, limit: parsed.limit };
  return { ok: true, rows: parsed.rows, candidates: false };
}

function rowOfEntry(entry: TerminologyAdminEntry): TerminologyCsvRow {
  return {
    canonical: entry.canonical,
    variants: [...entry.variants],
    language: entry.language,
    kind: entry.kind,
    mode: entry.mode,
    enabled: entry.enabled,
    note: entry.note,
    source_language: entry.source_language,
    target_language: entry.target_language,
  };
}

function candidateOf(row: TerminologyCsvRow, layer: TerminologyEntry['layer'], id: string | null): TerminologyEntry {
  return {
    id,
    layer,
    canonical: row.canonical,
    variants: [...row.variants],
    language: row.language as TerminologyEntry['language'],
    kind: row.kind,
    mode: row.mode,
    enabled: row.enabled,
    note: row.note,
    source_language: row.source_language as TerminologyEntry['source_language'],
    target_language: row.target_language as TerminologyEntry['target_language'],
    suppresses_entry_id: null,
  };
}

function sameEntry(candidate: TerminologyEntry, existing: TerminologyAdminEntry): boolean {
  const variants = candidate.variants ?? [];
  return (
    candidate.canonical === existing.canonical &&
    variants.length === existing.variants.length &&
    variants.every((variant, index) => variant === existing.variants[index]) &&
    candidate.language === existing.language &&
    candidate.kind === existing.kind &&
    candidate.mode === existing.mode &&
    candidate.enabled === existing.enabled &&
    (candidate.note ?? null) === existing.note &&
    (candidate.source_language ?? null) === existing.source_language &&
    (candidate.target_language ?? null) === existing.target_language
  );
}

function issue(row: number, code: Issue['code'], message: string): Issue {
  return { row, code, severity: 'error', message };
}

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function rowJson(entry: TerminologyEntry): Record<string, unknown> {
  const variants = entry.variants ?? [];
  return {
    canonical: entry.canonical,
    variants,
    normalized_variants: variants.map((variant) => normalizeLexical(variant)),
    language: entry.language,
    kind: entry.kind,
    mode: entry.mode,
    enabled: entry.enabled,
    note: entry.note,
    source_language: entry.source_language,
    target_language: entry.target_language,
  };
}

/**
 * D-23 import: a dry run validates every row (validateEntries with the enabled languages of the Phase 3.2 settings module, D-24, D-35)
 * and reports the diff keyed by (language, target_language, lower(canonical)) without writing; an apply re-validates against the layer
 * as it is now and writes all rows or none through rag_term_apply_import with the version the dry run saw (D-05).
 */
export async function importTerminology(input: TerminologyImportInput): Promise<TerminologyImportResult> {
  const file = parseFile(input);
  if (!file.ok) return file.limit ? { ok: false, reason: 'limit' } : { ok: false, reason: 'invalid_file', errors: file.errors };

  const layer = layerOf(input.layerKey);
  const current = await loadLayer(input.actorUserId, input.layerKey, input.signal);
  if (!current.ok) return current;
  let shared: TerminologyEntry[] | undefined;
  if (layer === 'workspace') {
    let loaded = await loadLayer(input.actorUserId, SHARED, input.signal);
    if (!loaded.ok && loaded.reason === 'version_conflict') loaded = await loadLayer(input.actorUserId, SHARED, input.signal);
    if (!loaded.ok) return loaded.reason === 'version_conflict' ? UNAVAILABLE : loaded;
    shared = loaded.layer.entries.map(storedCandidate);
  }

  const stored = current.layer.entries.filter((entry) => entry.suppresses_entry_id === null);
  const existingByKey = new Map(stored.map((entry) => [importKey(entry), entry]));
  const issues: Issue[] = [];
  const firstRowOfKey = new Map<string, number>();
  const candidates = file.rows.map((source, index) => {
    const row = index + 1;
    const key = importKey(source);
    const existing = existingByKey.get(key) ?? null;
    const seenAt = firstRowOfKey.get(key);
    if (seenAt !== undefined) issues.push(issue(row, 'duplicate', `This row repeats row ${seenAt} (same language, target language and canonical).`));
    else firstRowOfKey.set(key, row);
    // D-25a: a candidate adds its variants to a stored entry instead of replacing the entry.
    const merged =
      file.candidates && existing
        ? { ...rowOfEntry(existing), variants: [...existing.variants, ...source.variants.filter((variant) => !existing.variants.includes(variant))] }
        : source;
    return { key, existing, candidate: candidateOf(merged, layer, seenAt === undefined ? (existing?.id ?? null) : null) };
  });

  const context = {
    layer,
    current: input.mode === 'replace' ? [] : stored.map(storedCandidate),
    shared,
    enabledLanguages: terminologyEnabledLanguages(),
    minHanChars: terminologyParams().min_han_chars,
  };
  issues.push(...validateEntries(candidates.map((item) => item.candidate), context));

  const cleaned = candidates.map((item) => ({ ...item, candidate: withoutDuplicates(item.candidate) }));
  let create = 0;
  let update = 0;
  let unchanged = 0;
  for (const item of cleaned) {
    if (!item.existing) create += 1;
    else if (sameEntry(item.candidate, item.existing)) unchanged += 1;
    else update += 1;
  }
  const keys = new Set(cleaned.map((item) => item.key));
  const remove = input.mode === 'replace' ? stored.filter((entry) => !keys.has(importKey(entry))).length : 0;
  const report: TerminologyImportReport = {
    applied: false,
    create,
    update,
    unchanged,
    delete: remove,
    issues: sortIssues(issues),
    layer_version_seen: current.layer.version,
  };

  if (input.dryRun) return { ok: true, report, layerVersion: current.layer.version, entriesSha256: null };
  if (errorsOf(issues).length > 0) return { ok: false, reason: 'invalid', issues: report.issues, report };
  if (typeof input.expectedVersion !== 'number' || input.expectedVersion !== current.layer.version) {
    return { ok: false, reason: 'version_conflict', currentVersion: current.layer.version };
  }

  const written = await callTerminologyRpc(
    'rag_term_apply_import',
    {
      p_actor: input.actorUserId,
      p_layer_key: input.layerKey,
      p_rows: cleaned.map((item) => rowJson(item.candidate)),
      p_mode: input.mode,
      p_expected_version: input.expectedVersion,
    },
    input.signal,
  );
  if (!written.ok) return written;
  const result = written.rows[0];
  if (!result) {
    console.error('[RAG Admin] terminology call failed', { rpc: 'rag_term_apply_import', code: 'empty_result' });
    return UNAVAILABLE;
  }
  invalidateLayer(input.layerKey);
  return {
    ok: true,
    report: {
      ...report,
      applied: true,
      create: count(result, 'created'),
      update: count(result, 'updated'),
      unchanged: count(result, 'unchanged'),
      delete: count(result, 'deleted'),
    },
    layerVersion: count(result, 'layer_version'),
    entriesSha256: text(result, 'entries_sha256'),
  };
}

/** D-23 export of one layer (suppression rows are not entries and stay out), formula-safe, in a stable order. */
export async function exportTerminology(input: { actorUserId: string; layerKey: string; signal: AbortSignal }): Promise<TerminologyExportResult> {
  const current = await loadLayer(input.actorUserId, input.layerKey, input.signal);
  if (!current.ok) return current;
  const rows = current.layer.entries
    .filter((entry) => entry.suppresses_entry_id === null)
    .map(rowOfEntry)
    .sort((a, b) => {
      const ka = importKey(a);
      const kb = importKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return { ok: true, csv: serializeTerminologyCsv(rows), layerVersion: current.layer.version, rows: rows.length };
}
