import { createHash } from 'node:crypto';
import type { HiddenTextReport } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import { PARSE_ARTIFACT, PARSE_CHUNKS_ARTIFACT, HIDDEN_TEXT_SANITIZED_KEY, rewriteSanitizedArtifacts, versionPrefix, type ArtifactContext } from '../ingest/artifacts';
import { loadIngestConfig, type IngestConfig, type IngestEnvInput } from '../ingest/config';
import { getIngestDeps } from '../ingest/deps';
import { getObjectStore } from '../ingest/object-store';
import { hiddenTextReason, mergedReport, untrustedLinkReason } from '../ingest/stages/scan-injection';
import { isTenantKey } from '../ingest/writer';
import { hiddenTextMimeType, removeHiddenSpans, requestHiddenTextReport } from './hidden-text';
import { parseLinkAllowlist } from './link-allowlist';
import { checkLinks, linkCheckerVersion, loadLinkRules } from './link-check';
import { mergeQuarantineMetadata, type QuarantineReason } from './quarantine-reasons';
import { findZeroWidth, loadHiddenTextRules, stripZeroWidth } from './zero-width';

export type RescanCheck = 'hidden_text' | 'links';
export const RESCAN_CHECKS: readonly RescanCheck[] = ['hidden_text', 'links'];

export interface RescanInput {
  check: RescanCheck;
  /** Limit the run to one tenant (`s:default`, `u:<uuid>`, `o:<uuid>`); every tenant when absent. */
  tenantKey?: string | null;
  /** Run the checks and report, write nothing. */
  dryRun?: boolean;
}

export interface RescanDeps {
  db?: RpcClient | null;
  env?: IngestEnvInput;
  signal?: AbortSignal;
  pageSize?: number;
}

export interface RescanReport {
  check: RescanCheck;
  mode: 'flag' | 'quarantine';
  dryRun: boolean;
  /** Current, ready documents read. */
  checked: number;
  /** Recorded clean for the current rules, or a version whose own quarantine for this check an admin reviewed and released. */
  skipped: number;
  /** Documents the check found something in, in id order. */
  affectedIds: string[];
  quarantined: number;
  flagged: number;
  /** Documents the check could not run on (checker or stored parse output unavailable); left as they were. */
  unavailable: number;
  /** Quarantined documents whose stored parse output could not be rewritten. */
  artifactsFailed: number;
}

export type RescanFailure = 'check_off' | 'invalid_check' | 'invalid_tenant' | 'unavailable';
export type RescanResult = { ok: true; report: RescanReport } | { ok: false; reason: RescanFailure };

type Row = Record<string, unknown>;

interface Candidate {
  id: string;
  tenantKey: string;
  lineageId: string;
  version: number;
  filename: string;
  originalPath: string | null;
  content: string;
  hiddenTextCheck: string | null;
  rescan: Record<string, unknown>;
  released: boolean;
  releasedKinds: string[];
  releasedTargets: string[];
}

interface Evaluation {
  /** Found something under the check. */
  found: boolean;
  /** The fields rag_set_document_fields writes; null when nothing is written (the document stays as it is). */
  fields: Record<string, unknown> | null;
  quarantine: boolean;
  /** Sanitized parse output to store after the quarantine (hidden text only). */
  sanitized?: { parseText: string; parseChunks: unknown[] | null; hadChunks: boolean };
}

const TAG = '[RAG Rescan]';
const DEFAULT_PAGE = 50;
const MAX_CHECK_MS = 65_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class RescanRpcError extends Error {
  constructor(readonly rpc: string) {
    super(`${rpc} failed`);
  }
}

async function rpc(db: RpcClient, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(name, args).abortSignal(signal);
  if (response.error) throw new RescanRpcError(name);
  return (Array.isArray(response.data) ? response.data : []) as Row[];
}

const str = (row: Row, key: string): string | null => (typeof row[key] === 'string' ? (row[key] as string) : null);
const strings = (row: Row, key: string): string[] => (Array.isArray(row[key]) ? (row[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);

function candidateOf(row: Row): Candidate | null {
  const id = str(row, 'id');
  const tenantKey = str(row, 'tenant_key');
  const lineageId = str(row, 'lineage_id');
  const version = row.version;
  if (!id || !UUID.test(id) || !tenantKey || !isTenantKey(tenantKey) || !lineageId || typeof version !== 'number') return null;
  const rescan = row.rescan !== null && typeof row.rescan === 'object' && !Array.isArray(row.rescan) ? (row.rescan as Record<string, unknown>) : {};
  return {
    id,
    tenantKey,
    lineageId,
    version,
    filename: str(row, 'filename') ?? '',
    originalPath: str(row, 'original_path'),
    content: str(row, 'content') ?? '',
    hiddenTextCheck: str(row, 'hidden_text_check'),
    rescan,
    released: row.released === true,
    releasedKinds: strings(row, 'released_kinds'),
    releasedTargets: strings(row, 'released_targets'),
  };
}

/** The key a clean result is recorded under: a change of the rules (or, for links, of the allowlist) makes every document due again. */
function checkKey(check: RescanCheck, config: IngestConfig): string {
  if (check === 'hidden_text') return `hidden-text/${loadHiddenTextRules().rules_version}`;
  const allowlist = [...parseLinkAllowlist(config.outputLinkAllowlist, config.siteUrl)].sort().join(',');
  return `${linkCheckerVersion(loadLinkRules())}/${createHash('sha256').update(allowlist).digest('hex').slice(0, 16)}`;
}

function recordedClean(candidate: Candidate, check: RescanCheck, key: string): boolean {
  const entry = candidate.rescan[check];
  return entry !== null && typeof entry === 'object' && (entry as Row).key === key && (entry as Row).outcome === 'clean';
}

function artifactContext(candidate: Candidate, signal: AbortSignal): ArtifactContext {
  return { identity: { tenantKey: candidate.tenantKey }, document: { lineageId: candidate.lineageId, version: candidate.version }, signal, state: { artifacts: {} } };
}

/** The version's parse output: parse.md (and chunks.json) of its own prefix, or documents.content for a version that stored none. */
async function parseOutput(candidate: Candidate, signal: AbortSignal): Promise<{ text: string; chunks: unknown[] | null; stored: boolean }> {
  const prefix = versionPrefix(candidate.tenantKey, candidate.lineageId, candidate.version);
  const store = getObjectStore();
  const parse = await store.get(`${prefix}${PARSE_ARTIFACT}`, { signal });
  if (!parse) return { text: candidate.content, chunks: null, stored: false };
  const chunksObject = await store.get(`${prefix}${PARSE_CHUNKS_ARTIFACT}`, { signal });
  let chunks: unknown[] | null = null;
  if (chunksObject) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(chunksObject.bytes)) as unknown;
      chunks = Array.isArray(parsed) ? parsed : null;
    } catch {
      chunks = null;
    }
  }
  return { text: new TextDecoder().decode(parse.bytes), chunks, stored: true };
}

type SidecarAnswer = { kind: 'report'; report: HiddenTextReport } | { kind: 'unsupported' } | { kind: 'unavailable' };

/** The sidecar report for the stored original of a PDF or Word version. The original is read only under the version's own prefix. */
async function sidecarReport(candidate: Candidate, signal: AbortSignal, onlyPdf: boolean): Promise<SidecarAnswer> {
  const byName = hiddenTextMimeType('', candidate.filename);
  if (byName === null || (onlyPdf && byName !== 'application/pdf')) return { kind: 'unsupported' };
  const prefix = versionPrefix(candidate.tenantKey, candidate.lineageId, candidate.version);
  if (!candidate.originalPath || !candidate.originalPath.startsWith(prefix)) return { kind: 'unavailable' };
  const original = await getObjectStore().get(candidate.originalPath, { signal });
  if (!original) return { kind: 'unavailable' };
  const mimeType = hiddenTextMimeType(original.contentType, candidate.filename) ?? byName;
  const outcome = await requestHiddenTextReport({ bytes: original.bytes, mimeType, filename: candidate.filename }, { signal, timeoutMs: MAX_CHECK_MS });
  signal.throwIfAborted();
  return outcome.ok ? { kind: 'report', report: outcome.report } : { kind: 'unavailable' };
}

function mapChunks(chunks: unknown[] | null, map: (text: string) => string): unknown[] | null {
  if (!chunks) return null;
  return chunks.map((chunk) => {
    if (chunk === null || typeof chunk !== 'object') return chunk;
    const entry = { ...(chunk as Row) };
    for (const key of ['text', 'contextualized_text', 'table_header']) if (typeof entry[key] === 'string') entry[key] = map(entry[key] as string);
    if (Array.isArray(entry.headings)) entry.headings = (entry.headings as unknown[]).map((heading) => (typeof heading === 'string' ? map(heading) : heading));
    return entry;
  });
}

function quarantineFields(reasons: QuarantineReason[], extra: Record<string, unknown>, rescanEntry: Record<string, unknown>): Record<string, unknown> {
  const quarantine = mergeQuarantineMetadata(null, { reasons, ruleIds: [], snippets: [], quarantinedAt: new Date().toISOString() });
  return { status: 'quarantined', metadata: { quarantine: { ...quarantine, origin: 'rescan' }, ...extra, security_rescan: rescanEntry } };
}

/** The hidden-text check of the stage (zero-width count plus the sidecar report of the stored original), on a published version. */
async function evaluateHiddenText(candidate: Candidate, config: IngestConfig, rescanEntry: (outcome: string) => Record<string, unknown>, signal: AbortSignal): Promise<Evaluation | 'unavailable'> {
  const rules = loadHiddenTextRules();
  const mode = config.hiddenTextCheck;
  const parse = await parseOutput(candidate, signal);
  const finding = findZeroWidth(parse.text);
  const sidecar = await sidecarReport(candidate, signal, false);
  if (sidecar.kind === 'unavailable' && mode === 'quarantine') return 'unavailable';
  const report = sidecar.kind === 'report' ? sidecar.report : null;

  if (mode === 'flag') {
    const merged = mergedReport(report, finding, rules.rules_version);
    const found = merged.status === 'hidden_found';
    const outcome = found ? 'flagged' : merged.status === 'clean' ? 'clean' : 'not_checked';
    return { found, quarantine: false, fields: { hidden_text_check: merged.status, metadata: { hidden_text_report: merged, security_rescan: rescanEntry(outcome) } } };
  }

  const spans = report?.status === 'hidden_found' ? (report.spans ?? []).map((span) => span.text) : [];
  const removal = removeHiddenSpans(stripZeroWidth(parse.text), spans);
  const unlocated = spans.length > 0 ? removal.unlocated.length + (report?.dropped ?? 0) : 0;
  const reason = hiddenTextReason(report, finding, finding.total >= rules.zero_width_threshold, unlocated, rules);
  if (!reason) {
    const check = report?.status === 'clean' ? 'clean' : 'not_checked';
    return { found: false, quarantine: false, fields: { hidden_text_check: check, metadata: { security_rescan: rescanEntry(check) } } };
  }
  const sanitizedChunks = mapChunks(parse.chunks, (text) => removeHiddenSpans(stripZeroWidth(text), spans).text);
  return {
    found: true,
    quarantine: true,
    fields: { ...quarantineFields([reason], parse.stored ? { [HIDDEN_TEXT_SANITIZED_KEY]: true } : {}, rescanEntry('quarantined')), hidden_text_check: 'hidden_found' },
    ...(parse.stored ? { sanitized: { parseText: removal.text, parseChunks: sanitizedChunks, hadChunks: parse.chunks !== null } } : {}),
  };
}

/** The link check of the stage on a published version; targets released on this version or an earlier one of its lineage are skipped. */
async function evaluateLinks(
  candidate: Candidate,
  config: IngestConfig,
  db: RpcClient,
  rescanEntry: (outcome: string) => Record<string, unknown>,
  signal: AbortSignal,
): Promise<Evaluation | 'unavailable'> {
  const rules = loadLinkRules();
  const mode = config.ingestLinkCheck;
  const parse = await parseOutput(candidate, signal);
  // As in the stage: PDF link annotations are read from the hidden-text report, so only while that check is on.
  let annotationTargets: string[] = [];
  if (config.hiddenTextCheck !== 'off') {
    const sidecar = await sidecarReport(candidate, signal, true);
    if (sidecar.kind === 'unavailable' && mode === 'quarantine') return 'unavailable';
    if (sidecar.kind === 'report') annotationTargets = sidecar.report.link_targets ?? [];
  }
  const earlier = (await rpc(db, 'rag_released_link_targets', { p_document_id: candidate.id, p_tenant_key: candidate.tenantKey }, signal))
    .map((row) => str(row, 'target'))
    .filter((target): target is string => target !== null);
  const result = checkLinks(parse.text, {
    allowlist: parseLinkAllowlist(config.outputLinkAllowlist, config.siteUrl),
    annotationTargets,
    releasedTargets: [...new Set([...candidate.releasedTargets, ...earlier])],
    rules,
  });
  const found = (result.targets?.length ?? 0) > 0;
  if (!found) return { found: false, quarantine: false, fields: { metadata: { security_rescan: rescanEntry('clean') } } };
  if (mode === 'flag') return { found: true, quarantine: false, fields: { metadata: { link_check: result, security_rescan: rescanEntry('flagged') } } };
  const reason = untrustedLinkReason(result);
  return { found: true, quarantine: true, fields: quarantineFields(reason ? [reason] : [], { link_check: result }, rescanEntry('quarantined')) };
}

/**
 * D-47: re-runs one security check on the current, ready documents (all tenants, or one), only when called. It reads each version's stored
 * parse output and, for PDF and Word, its stored original, runs the same check functions as the scan_injection stage and writes through
 * the same rag_set_document_fields: under `quarantine` a finding quarantines the version (its chunks leave retrieval and the status
 * triggers empty the tenant's semantic cache) and its stored parse output is rewritten without the hidden spans; under `flag` the report
 * is recorded and nothing is quarantined; with the check `off` nothing runs. A version recorded clean for the current rules, or whose own
 * quarantine for this check an admin released, is skipped. A dry run writes nothing. Logs carry counts and ids only.
 *
 * A version quarantined here keeps the chunk rows it was published with; only its stored parse output is sanitized, so a later version
 * (type change, re-chunk, reparse) is built without the hidden spans.
 */
export async function rescanDocuments(input: RescanInput, deps: RescanDeps = {}): Promise<RescanResult> {
  if (!RESCAN_CHECKS.includes(input.check)) return { ok: false, reason: 'invalid_check' };
  const tenantKey = input.tenantKey ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, reason: 'invalid_tenant' };
  const config = loadIngestConfig(deps.env ?? getIngestDeps().ingestEnv());
  const mode = input.check === 'hidden_text' ? config.hiddenTextCheck : config.ingestLinkCheck;
  if (mode === 'off') return { ok: false, reason: 'check_off' };
  const db = deps.db === undefined ? getIngestDeps().db() : deps.db;
  if (!db) return { ok: false, reason: 'unavailable' };
  const signal = deps.signal ?? new AbortController().signal;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE;
  const dryRun = input.dryRun === true;

  let key: string;
  try {
    key = checkKey(input.check, config);
  } catch {
    console.error(`${TAG} rules unavailable`, { check: input.check });
    return { ok: false, reason: 'unavailable' };
  }
  const report: RescanReport = { check: input.check, mode, dryRun, checked: 0, skipped: 0, affectedIds: [], quarantined: 0, flagged: 0, unavailable: 0, artifactsFailed: 0 };
  const rescanEntry = (candidate: Candidate) => (outcome: string) => ({ ...candidate.rescan, [input.check]: { key, outcome, at: new Date().toISOString() } });

  try {
    let after: string | null = null;
    for (;;) {
      const rows = await rpc(db, 'rag_rescan_candidates', { p_tenant_key: tenantKey, p_after: after, p_limit: pageSize }, signal);
      for (const row of rows) {
        const candidate = candidateOf(row);
        if (!candidate) continue;
        after = candidate.id;
        report.checked += 1;
        const reviewed = candidate.released && candidate.releasedKinds.includes(input.check === 'hidden_text' ? 'hidden_text' : 'untrusted_link');
        if (recordedClean(candidate, input.check, key) || reviewed) {
          report.skipped += 1;
          continue;
        }
        let evaluation: Evaluation | 'unavailable';
        try {
          evaluation =
            input.check === 'hidden_text'
              ? await evaluateHiddenText(candidate, config, rescanEntry(candidate), signal)
              : await evaluateLinks(candidate, config, db, rescanEntry(candidate), signal);
        } catch (error) {
          if (signal.aborted || error instanceof RescanRpcError) throw error;
          evaluation = 'unavailable';
        }
        if (evaluation === 'unavailable') {
          report.unavailable += 1;
          console.warn(`${TAG} check could not run on a document`, { check: input.check, documentId: candidate.id });
          continue;
        }
        if (evaluation.found) report.affectedIds.push(candidate.id);
        if (dryRun || evaluation.fields === null) continue;
        await rpc(db, 'rag_set_document_fields', { p_document_id: candidate.id, p_tenant_key: candidate.tenantKey, p_fields: evaluation.fields }, signal);
        if (evaluation.quarantine) report.quarantined += 1;
        else if (evaluation.found) report.flagged += 1;
        if (evaluation.sanitized) {
          const ctx = artifactContext(candidate, signal);
          if (evaluation.sanitized.hadChunks) ctx.state.artifacts[PARSE_CHUNKS_ARTIFACT] = `${versionPrefix(candidate.tenantKey, candidate.lineageId, candidate.version)}${PARSE_CHUNKS_ARTIFACT}`;
          try {
            await rewriteSanitizedArtifacts(ctx, evaluation.sanitized);
          } catch {
            report.artifactsFailed += 1;
            console.error(`${TAG} stored parse output of a quarantined document was not rewritten`, { documentId: candidate.id });
          }
        }
      }
      if (rows.length < pageSize) break;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`${TAG} database call failed`, { rpc: error instanceof RescanRpcError ? error.rpc : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
  console.log(`${TAG} done`, {
    check: report.check,
    mode: report.mode,
    dryRun,
    checked: report.checked,
    skipped: report.skipped,
    affected: report.affectedIds.length,
    quarantined: report.quarantined,
    flagged: report.flagged,
    unavailable: report.unavailable,
  });
  return { ok: true, report };
}
