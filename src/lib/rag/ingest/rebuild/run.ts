import { createHash } from 'node:crypto';
import { GateResultSchema } from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { backfillScope } from '../../tenant/backfill-scope';
import type { TenantScope } from '../../tenant/scope';
import { HIDDEN_TEXT_SANITIZED_KEY, isArtifactName, loadArtifact, versionPrefix } from '../artifacts';
import { optionsOf } from '../change-doc-type';
import { getIngestDeps } from '../deps';
import { enqueueIngest } from '../enqueue';
import { coverageProposal, savedFingerprintValues } from '../fingerprint/impact';
import { afterPublish } from '../post-publish';
import { DOC_TYPE_IDS } from '../profiles/doc-type-defaults';
import type { DocType } from '../profiles/load';
import { queueConfigFromProcessEnv } from '../queue-config';
import { runRechunkBatch, type RechunkReport } from '../rechunk/run';
import { INGEST_SOURCES, type IngestSource } from '../types';
import {
  isRebuildableMechanism,
  planRebuild,
  rebuildSettingsHash,
  selectAffected,
  type ProfileBuild,
  type RebuildCandidate,
  type RebuildPlan,
  type RebuildableMechanism,
} from './plan';

type Row = Record<string, unknown>;

/** A refusal of the run's gate (D-12, UI-SPEC 8.2): the route answers 409 with the code and the reason. */
export class RebuildRefused extends Error {
  constructor(
    readonly code: 'activation_refused' | 'rollback_refused' | 'evidence_refused' | 'progress_refused',
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'RebuildRefused';
  }
}

export class RebuildNotFound extends Error {
  constructor() {
    super('rebuild run not found');
    this.name = 'RebuildNotFound';
  }
}

export class RebuildInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RebuildInputError';
  }
}

/** A database or environment failure; the code only, never the database message. */
export class RebuildUnavailable extends Error {
  constructor(
    readonly rpc: string,
    readonly code: string,
  ) {
    super(`[Rebuild] ${rpc} failed (${code})`);
    this.name = 'RebuildUnavailable';
  }
}

export type RebuildRunState = 'running' | 'complete' | 'incomplete' | 'activated' | 'rolled_back';
export type RebuildActivation = 'rebuild_batch' | 'chunking_profiles' | 'embedding_profiles' | 'none';

export interface RebuildRunRow {
  id: string;
  mechanism: string;
  activation: RebuildActivation;
  state: RebuildRunState;
  total: number;
  done: number;
  gaps: number;
  plan: Row;
  evidencePassed: boolean | null;
  startedAt: string | null;
  activatedAt: string | null;
  rolledBackAt: string | null;
}

export interface RebuildDeps {
  db?: RpcClient | null;
  /** The saved settings the selection compares against. Default: the running app's values. */
  saved?: Record<string, string>;
  ingestAsync?: () => boolean;
  /** The tenant scope a document is re-ingested under. Default: the operator backfill scope resolver. */
  scopeFor?: (tenantKey: string, signal: AbortSignal) => Promise<TenantScope | null>;
  signal?: AbortSignal;
}

export interface StartRebuildInput {
  mechanism: string;
  dryRun?: boolean;
  startedBy: string | null;
  /** Time budget of this call; work left over continues on the next start of the same run. */
  deadlineMs?: number;
}

export type StartRebuildStatus = 'dry_run' | 'nothing' | 'command' | 'started';

export interface StartRebuildResult {
  status: StartRebuildStatus;
  mechanism: RebuildableMechanism;
  affected: number;
  withoutFingerprint: number;
  plan: RebuildPlan;
  run?: RebuildRunRow;
  resumed?: boolean;
  /** True while documents of the run are still to be submitted: call start again to continue. */
  more?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANDIDATE_PAGE = 500;
const ITEM_PAGE = 100;
/** Backfill priority: a rebuild never overtakes live uploads (Phase 3.1 D-23). */
const REBUILD_PRIORITY = 10;
const STATES: readonly RebuildRunState[] = ['running', 'complete', 'incomplete', 'activated', 'rolled_back'];
const ACTIVATIONS: readonly RebuildActivation[] = ['rebuild_batch', 'chunking_profiles', 'embedding_profiles', 'none'];

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(row: Row, key: string): number {
  const value = typeof row[key] === 'string' ? Number(row[key]) : row[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function objectOf(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

function dbOf(deps: RebuildDeps): RpcClient {
  const db = deps.db === undefined ? (getIngestDeps().db() as RpcClient | null) : deps.db;
  if (!db) throw new RebuildUnavailable('admin_client', 'unavailable');
  return db;
}

const REFUSAL = /^(activation_refused|rollback_refused|evidence_refused|progress_refused): ([a-z_]+)/;
const INPUT_ERRORS = new Set(['invalid_evidence', 'invalid_mechanism', 'invalid_settings_hash', 'invalid_activation', 'invalid_items', 'invalid_state', 'nothing_to_rebuild', 'item_not_open']);

function errorOf(fn: string, error: { message?: string; code?: string }): Error {
  const message = error.message ?? '';
  const refused = REFUSAL.exec(message);
  if (refused) return new RebuildRefused(refused[1] as RebuildRefused['code'], refused[2] as string);
  if (message === 'not_found') return new RebuildNotFound();
  if (INPUT_ERRORS.has(message)) return new RebuildInputError(message);
  return new RebuildUnavailable(fn, error.code ?? 'rpc_failed');
}

async function call(db: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(fn, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw errorOf(fn, response.error);
  return rpcRows(response.data).filter((row): row is Row => objectOf(row) !== null);
}

function runOf(row: Row): RebuildRunRow | null {
  const id = text(row, 'id');
  const state = text(row, 'state') as RebuildRunState | null;
  const activation = text(row, 'activation') as RebuildActivation | null;
  if (id === null || !UUID.test(id) || state === null || !STATES.includes(state) || activation === null || !ACTIVATIONS.includes(activation)) return null;
  return {
    id,
    mechanism: text(row, 'mechanism') ?? 'unknown',
    activation,
    state,
    total: count(row, 'total'),
    done: count(row, 'done'),
    gaps: count(row, 'gaps'),
    plan: objectOf(row.plan) ?? {},
    evidencePassed: typeof row.evidence_passed === 'boolean' ? row.evidence_passed : null,
    startedAt: text(row, 'started_at'),
    activatedAt: text(row, 'activated_at'),
    rolledBackAt: text(row, 'rolled_back_at'),
  };
}

/** Run rows, newest first: counts and state only, no document id or tenant key. Rows that do not parse are left out. */
export async function listRebuildRuns(deps: RebuildDeps = {}, limit = 50): Promise<RebuildRunRow[]> {
  const signal = deps.signal ?? new AbortController().signal;
  const rows = await call(dbOf(deps), 'rag_rebuild_list', { p_run_id: null, p_limit: limit }, signal);
  return rows.map(runOf).filter((run): run is RebuildRunRow => run !== null);
}

export async function getRebuildRun(runId: string, deps: RebuildDeps = {}): Promise<RebuildRunRow | null> {
  if (!UUID.test(runId)) return null;
  const signal = deps.signal ?? new AbortController().signal;
  const db = dbOf(deps);
  const [first] = await call(db, 'rag_rebuild_list', { p_run_id: runId.toLowerCase(), p_limit: 1 }, signal);
  const run = first ? runOf(first) : null;
  if (run && run.mechanism === 'reparse' && (run.state === 'running' || run.state === 'complete' || run.state === 'incomplete')) {
    await call(db, 'rag_rebuild_progress', { p_run_id: run.id, p_document_id: null, p_state: null, p_new_document_id: null, p_job_id: null, p_reason: null }, signal);
    const [settled] = await call(db, 'rag_rebuild_list', { p_run_id: run.id, p_limit: 1 }, signal);
    return settled ? runOf(settled) : run;
  }
  return run;
}

async function loadCandidates(db: RpcClient, signal: AbortSignal): Promise<RebuildCandidate[]> {
  const candidates: RebuildCandidate[] = [];
  let after: string | null = null;
  for (;;) {
    const rows = await call(db, 'rag_rebuild_candidates', { p_doc_types: null, p_after: after, p_limit: CANDIDATE_PAGE }, signal);
    for (const row of rows) {
      const documentId = text(row, 'id');
      const tenantKey = text(row, 'tenant_key');
      if (documentId === null || tenantKey === null) continue;
      candidates.push({ documentId, tenantKey, docType: text(row, 'doc_type') ?? 'general', fingerprint: text(row, 'ingest_fingerprint'), parts: row.parts ?? null });
    }
    if (rows.length < CANDIDATE_PAGE) return candidates;
    after = candidates[candidates.length - 1]?.documentId ?? null;
    if (after === null) return candidates;
  }
}

async function defaultScopeFor(tenantKey: string, signal: AbortSignal): Promise<TenantScope | null> {
  const result = await backfillScope(tenantKey, { signal });
  return result.ok ? result.scope : null;
}

function isDocType(value: string | null): boolean {
  return value !== null && (DOC_TYPE_IDS as readonly string[]).includes(value);
}

function sourceOf(value: string | null): IngestSource | null {
  return INGEST_SOURCES.find((source) => source === value) ?? null;
}

type Submitted = { state: 'queued'; newDocumentId: string; jobId: string } | { state: 'gap'; reason: string };

/**
 * Re-ingests one document from its stored original through the queue as a new version of its lineage (Phase 3 D-18), as a job of the run's
 * held batch. A version whose hidden spans were removed is never re-parsed from its original (F-17) and becomes a gap, as does a document
 * that is no longer the current ready version or whose original is missing.
 */
async function submitReparse(db: RpcClient, item: { documentId: string; tenantKey: string; batchId: string }, scope: TenantScope, signal: AbortSignal): Promise<Submitted> {
  const [row] = await call(db, 'rag_get_document_for_type_change', { p_document_id: item.documentId, p_tenant_key: item.tenantKey }, signal);
  if (!row) return { state: 'gap', reason: 'not_found' };
  if (row.is_current !== true || row.status !== 'ready') return { state: 'gap', reason: 'not_current' };
  if (objectOf(row.metadata)?.[HIDDEN_TEXT_SANITIZED_KEY] === true) return { state: 'gap', reason: 'sanitized_original' };
  const lineageId = text(row, 'lineage_id');
  const version = typeof row.version === 'number' && Number.isInteger(row.version) ? row.version : null;
  const originalPath = text(row, 'original_path');
  const source = sourceOf(text(row, 'source'));
  const sourceKey = text(row, 'source_key');
  if (lineageId === null || version === null || originalPath === null || source === null || sourceKey === null) return { state: 'gap', reason: 'original_unavailable' };
  let prefix: string;
  try {
    prefix = versionPrefix(item.tenantKey, lineageId, version);
  } catch {
    return { state: 'gap', reason: 'original_unavailable' };
  }
  const name = originalPath.startsWith(prefix) ? originalPath.slice(prefix.length) : '';
  if (!isArtifactName(name)) return { state: 'gap', reason: 'original_unavailable' };
  const original = await loadArtifact({ identity: { tenantKey: item.tenantKey }, document: { lineageId, version }, signal, state: { artifacts: {} } }, name);
  if (original === null) return { state: 'gap', reason: 'original_unavailable' };

  const queued = await enqueueIngest(
    {
      scope,
      source,
      sourceKey,
      filename: text(row, 'filename') ?? sourceKey,
      mimeType: original.contentType || 'application/octet-stream',
      file: original.bytes,
      ...(isDocType(text(row, 'doc_type')) ? { docType: text(row, 'doc_type') as DocType } : {}),
      options: optionsOf(row),
      // A forced new version parsed from the original: the unchanged file hash must not skip it.
      typeChange: { reuseParseOfVersion: null, reusedParser: null },
      signal,
    },
    { batchId: item.batchId, holdPublish: true, priority: REBUILD_PRIORITY },
  );
  if (queued.status === 'queued' && queued.jobId && queued.documentId) return { state: 'queued', newDocumentId: queued.documentId, jobId: queued.jobId };
  return { state: 'gap', reason: queued.status === 'skipped_duplicate' ? 'duplicate' : (queued.reason ?? 'enqueue_failed') };
}

/** Submits the pending items of a reparse run until the deadline; returns whether items are left. */
async function submitPending(db: RpcClient, runId: string, deps: RebuildDeps, signal: AbortSignal, deadline: number | null): Promise<boolean> {
  const scopeFor = deps.scopeFor ?? defaultScopeFor;
  const scopes = new Map<string, TenantScope | null>();
  let after: string | null = null;
  for (;;) {
    const rows = await call(db, 'rag_rebuild_items_page', { p_run_id: runId, p_state: 'pending', p_after: after, p_limit: ITEM_PAGE }, signal);
    if (rows.length === 0) return false;
    for (const row of rows) {
      if (deadline !== null && Date.now() > deadline) return true;
      const documentId = text(row, 'document_id') as string;
      const tenantKey = text(row, 'tenant_key') as string;
      const batchId = text(row, 'batch_id');
      after = documentId;
      let outcome: Submitted;
      if (batchId === null) {
        outcome = { state: 'gap', reason: 'batch_missing' };
      } else {
        if (!scopes.has(tenantKey)) scopes.set(tenantKey, await scopeFor(tenantKey, signal));
        const scope = scopes.get(tenantKey) ?? null;
        try {
          outcome = scope === null ? { state: 'gap', reason: 'tenant_unavailable' } : await submitReparse(db, { documentId, tenantKey, batchId }, scope, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn('[Rebuild] document could not be submitted', { runId, error: error instanceof Error ? error.name : 'unknown' });
          outcome = { state: 'gap', reason: 'submit_failed' };
        }
      }
      await call(
        db,
        'rag_rebuild_progress',
        {
          p_run_id: runId,
          p_document_id: documentId,
          p_state: outcome.state,
          p_new_document_id: outcome.state === 'queued' ? outcome.newDocumentId : null,
          p_job_id: outcome.state === 'queued' ? outcome.jobId : null,
          p_reason: outcome.state === 'gap' ? outcome.reason : null,
        },
        signal,
      );
    }
  }
}

/** child_tokens of the legacy chunking profile per doc type, from the registry (0406). */
async function legacyChildTokens(db: RpcClient, signal: AbortSignal): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const row of await call(db, 'rag_list_chunking_profiles', {}, signal)) {
    const typeId = text(row, 'doc_type');
    if (text(row, 'id') === 'legacy' && typeId && count(row, 'child_tokens') > 0) sizes[typeId] = count(row, 'child_tokens');
  }
  return sizes;
}

/** Creates the building profile of each doc type unless it exists (a resumed run), with the legacy size and parent_mode none. */
async function ensureProfiles(db: RpcClient, profiles: readonly ProfileBuild[], signal: AbortSignal): Promise<void> {
  const existing = new Set((await call(db, 'rag_list_chunking_profiles', {}, signal)).map((row) => `${text(row, 'id')}|${text(row, 'doc_type')}`));
  for (const profile of profiles) {
    if (existing.has(`${profile.profileId}|${profile.docType}`)) continue;
    await call(
      db,
      'rag_create_chunking_profile',
      {
        p_id: profile.profileId,
        p_doc_type: profile.docType,
        p_child_tokens: profile.childTokens,
        p_parent_mode: profile.parentMode,
        p_parent_tokens: profile.parentTokens,
        p_preset: profile.preset,
      },
      signal,
    );
  }
}

/**
 * D-11 rechunk: builds each profile side by side through the rechunk job (stored parse.md, zero parser calls) until the deadline, and
 * reports the summed counts on the run. Activation stays with `rag:chunking activate` and its completeness and eval gates (D-12).
 */
async function buildProfiles(db: RpcClient, runId: string, profiles: readonly ProfileBuild[], deps: RebuildDeps, signal: AbortSignal, deadline: number | null): Promise<boolean> {
  await ensureProfiles(db, profiles, signal);
  const reports: RechunkReport[] = [];
  let more = false;
  for (const profile of profiles) {
    let report: RechunkReport;
    do {
      const left = deadline === null ? undefined : Math.max(deadline - Date.now(), 1);
      report = await runRechunkBatch({
        db,
        profileId: profile.profileId,
        docType: profile.docType,
        signal,
        ...(left !== undefined ? { deadlineMs: left } : {}),
        ...(deps.scopeFor ? { scopeFor: deps.scopeFor } : {}),
      });
    } while (report.more && (deadline === null || Date.now() < deadline));
    reports.push(report);
    if (report.more) {
      more = true;
      break;
    }
  }
  const total = reports.reduce((sum, report) => sum + report.docsTotal, 0);
  const done = reports.reduce((sum, report) => sum + report.docsDone, 0);
  const gaps = reports.reduce((sum, report) => sum + report.gaps.length + (report.status === 'failed' ? 1 : 0), 0);
  const finished = !more && reports.length === profiles.length;
  await call(db, 'rag_rebuild_report', { p_run_id: runId, p_total: total, p_done: done, p_gaps: gaps, p_finished: finished }, signal);
  return more;
}

function startedRun(row: Row | undefined): { run: RebuildRunRow; resumed: boolean } {
  const id = row ? text(row, 'run_id') : null;
  if (!row || id === null) throw new RebuildUnavailable('rag_rebuild_start', 'bad_response');
  return {
    run: {
      id,
      mechanism: 'unknown',
      activation: 'none',
      state: (text(row, 'state') as RebuildRunState) ?? 'running',
      total: count(row, 'total'),
      done: count(row, 'done'),
      gaps: count(row, 'gaps'),
      plan: {},
      evidencePassed: null,
      startedAt: null,
      activatedAt: null,
      rolledBackAt: null,
    },
    resumed: row.resumed === true,
  };
}

/**
 * D-11: computes which current documents the saved settings leave on previous settings for the mechanism and starts the rebuild of exactly
 * those, or returns the open run of the same mechanism and settings (it continues from the documents not yet submitted). Nothing is written
 * by a dry run, by a mechanism that runs as a command, or by reparse while RAG_INGEST_ASYNC is off.
 */
export async function startRebuild(input: StartRebuildInput, deps: RebuildDeps = {}): Promise<StartRebuildResult> {
  if (!isRebuildableMechanism(input.mechanism)) throw new RebuildInputError('invalid_mechanism');
  const mechanism = input.mechanism;
  const signal = deps.signal ?? new AbortController().signal;
  const db = dbOf(deps);
  const proposal = coverageProposal(deps.saved ?? savedFingerprintValues());
  const settingsHash = rebuildSettingsHash(mechanism, proposal);
  const selection = selectAffected(await loadCandidates(db, signal), mechanism, proposal);
  const ingestAsync = deps.ingestAsync ? deps.ingestAsync() : queueConfigFromProcessEnv().ingestAsync;
  const legacy = mechanism === 'rechunk' && selection.documents.length > 0 ? await legacyChildTokens(db, signal) : undefined;
  const plan = planRebuild(mechanism, selection, { ingestAsync, settingsHash, ...(legacy ? { legacyChildTokens: legacy } : {}) });
  const base = { mechanism, affected: selection.documents.length, withoutFingerprint: selection.withoutFingerprint, plan };
  if (input.dryRun) return { status: 'dry_run', ...base };
  if (plan.kind === 'nothing') return { status: 'nothing', ...base };
  if (plan.kind !== 'held_batch' && plan.kind !== 'chunking_profile') return { status: 'command', ...base };

  const deadline = input.deadlineMs !== undefined ? Date.now() + input.deadlineMs : null;
  const started = await call(
    db,
    'rag_rebuild_start',
    {
      p_mechanism: mechanism,
      p_settings_hash: settingsHash,
      p_activation: plan.activation,
      p_plan:
        plan.kind === 'chunking_profile'
          ? { kind: plan.kind, affected: plan.affected, profiles: plan.profiles.map((profile) => ({ id: profile.profileId, doc_type: profile.docType })) }
          : { kind: plan.kind, affected: plan.affected },
      p_items: plan.kind === 'held_batch' ? plan.documents.map((document) => ({ tenant_key: document.tenantKey, document_id: document.documentId })) : null,
      p_total: plan.affected,
      p_started_by: input.startedBy,
    },
    signal,
  );
  const { run, resumed } = startedRun(started[0]);
  const more =
    plan.kind === 'held_batch'
      ? await submitPending(db, run.id, deps, signal, deadline)
      : run.state === 'complete'
        ? false
        : await buildProfiles(db, run.id, plan.profiles, deps, signal, deadline);
  const current = (await getRebuildRun(run.id, { ...deps, db, signal })) ?? run;
  console.log('[Rebuild] run started', { runId: current.id, mechanism, resumed, total: current.total, more });
  return { status: 'started', ...base, run: current, resumed, more };
}

/** The evidence a gate report carries: a GateResult (rag_eval.gate gate.json), stored as its verdict, offender count and hash. */
export function evidenceFromReport(report: unknown): { passed: boolean; offenders: number; report_sha256: string } {
  const parsed = GateResultSchema.safeParse(report);
  if (!parsed.success) throw new RebuildInputError('invalid_evidence');
  return {
    passed: parsed.data.passed,
    offenders: parsed.data.offenders.length,
    report_sha256: createHash('sha256').update(canonicalJson(parsed.data)).digest('hex'),
  };
}

export async function recordRebuildEvidence(runId: string, report: unknown, deps: RebuildDeps = {}): Promise<{ passed: boolean }> {
  if (!UUID.test(runId)) throw new RebuildNotFound();
  const evidence = evidenceFromReport(report);
  const signal = deps.signal ?? new AbortController().signal;
  await call(dbOf(deps), 'rag_rebuild_record_evidence', { p_run_id: runId.toLowerCase(), p_evidence: evidence }, signal);
  console.log('[Rebuild] evidence recorded', { runId, passed: evidence.passed });
  return { passed: evidence.passed };
}

async function runHooks(rows: Row[], outcome: string): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const documentId = text(row, 'document_id');
    const tenantKey = text(row, 'tenant_key');
    if (text(row, 'outcome') !== outcome || documentId === null || tenantKey === null) continue;
    ids.push(documentId);
    await afterPublish({ documentId, tenantKey });
  }
  return ids;
}

/** D-12: publishes the held versions of a complete reparse run with passing evidence, then runs the post-publish hooks for each. */
export async function activateRebuild(runId: string, actor: string | null, deps: RebuildDeps = {}): Promise<{ published: string[]; superseded: number }> {
  if (!UUID.test(runId)) throw new RebuildNotFound();
  const signal = deps.signal ?? new AbortController().signal;
  const rows = await call(dbOf(deps), 'rag_rebuild_activate', { p_run_id: runId.toLowerCase(), p_actor: actor }, signal);
  const published = await runHooks(rows, 'published');
  const superseded = rows.filter((row) => text(row, 'outcome') === 'superseded').length;
  console.log('[Rebuild] run activated', { runId, published: published.length, superseded });
  return { published, superseded };
}

/** D-12: makes the replaced versions of an activated run current again, with their vectors, and runs the post-publish hooks for each. */
export async function rollbackRebuild(runId: string, actor: string | null, deps: RebuildDeps = {}): Promise<{ restored: string[]; superseded: number }> {
  if (!UUID.test(runId)) throw new RebuildNotFound();
  const signal = deps.signal ?? new AbortController().signal;
  const rows = await call(dbOf(deps), 'rag_rebuild_rollback', { p_run_id: runId.toLowerCase(), p_actor: actor }, signal);
  const restored = await runHooks(rows, 'restored');
  const superseded = rows.filter((row) => text(row, 'outcome') === 'superseded').length;
  console.log('[Rebuild] run rolled back', { runId, restored: restored.length, superseded });
  return { restored, superseded };
}
