import { ChunkingDecisionSchema } from '@/lib/rag-eval/contracts.generated';
import { RetrievalBackendError, rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { refreshActiveChunkingProfiles } from './active';

export interface ChunkingOpOptions {
  signal?: AbortSignal;
}

export interface ChunkingProfileRecord {
  id: string;
  docType: string;
  childTokens: number;
  parentMode: string;
  parentTokens: number | null;
  status: string;
  preset: string;
  previousActiveId: string | null;
  isActive: boolean;
  createdAt: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
}

export interface ChunkingCoverageRow {
  docType: string;
  profileId: string;
  isActive: boolean;
  currentReadyDocuments: number;
  documentsWithChildren: number;
  missingDocuments: number;
}

export interface ChunkingProfileState {
  docType: string;
  profileId: string;
  openGaps: number;
  evidence: 'none' | 'passed' | 'failed';
}

export interface CreateChunkingProfileInput {
  id: string;
  docType: string;
  childTokens: number;
  parentMode: 'none' | 'structure' | 'fixed';
  parentTokens: number | null;
  preset: '128/512' | '256/1024' | '256/2048' | 'custom';
}

/** A gate of the activation or rollback function said no. `reason` is the gate's own word; `detail` is the message the function raised (counts only). */
export class ChunkingActivationRefused extends Error {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail: string) {
    super(`[RAG Chunking] activation refused: ${reason}`);
    this.name = 'ChunkingActivationRefused';
    this.reason = reason;
    this.detail = detail;
  }
}

/** The input was rejected before any database call. */
export class ChunkingInputError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(`[RAG Chunking] ${message}`);
    this.name = 'ChunkingInputError';
    this.issues = issues;
  }
}

const REFUSAL = /^chunking_activation_refused:([a-z_]+)/;

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function count(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

async function call(fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Row[]> {
  const admin = getRagDeps().adminClient();
  if (!admin) throw new RetrievalBackendError(fn, 'admin_unavailable');
  let request = (admin as unknown as RpcClient).rpc(fn, args);
  if (signal) request = request.abortSignal(signal);
  const response = await request;
  signal?.throwIfAborted();
  if (response.error) {
    const refusal = REFUSAL.exec(response.error.message);
    if (refusal) throw new ChunkingActivationRefused(refusal[1] as string, response.error.message);
    throw new RetrievalBackendError(fn, response.error.code ?? null);
  }
  return rpcRows(response.data).map(asRow).filter((row): row is Row => row !== null);
}

function firstRow(rows: Row[], fn: string): Row {
  const row = rows[0];
  if (!row) throw new RetrievalBackendError(fn, 'empty_response');
  return row;
}

/** Every chunking profile, legacy included, as the registry lists it. */
export async function listChunkingProfiles(options: ChunkingOpOptions = {}): Promise<ChunkingProfileRecord[]> {
  const rows = await call('rag_list_chunking_profiles', {}, options.signal);
  return rows.map((row) => ({
    id: text(row, 'id') ?? '',
    docType: text(row, 'doc_type') ?? '',
    childTokens: count(row, 'child_tokens'),
    parentMode: text(row, 'parent_mode') ?? 'none',
    parentTokens: row.parent_tokens === null || row.parent_tokens === undefined ? null : count(row, 'parent_tokens'),
    status: text(row, 'status') ?? '',
    preset: text(row, 'preset') ?? 'custom',
    previousActiveId: text(row, 'previous_active_id'),
    isActive: row.is_active === true,
    createdAt: text(row, 'created_at'),
    activatedAt: text(row, 'activated_at'),
    activatedBy: text(row, 'activated_by'),
  }));
}

/** Per doc type and profile: the current ready documents, those with children in the profile and those missing. Counts only. */
export async function getChunkingCoverage(options: ChunkingOpOptions = {}): Promise<ChunkingCoverageRow[]> {
  const rows = await call('rag_chunking_coverage', {}, options.signal);
  return rows.map((row) => ({
    docType: text(row, 'doc_type') ?? '',
    profileId: text(row, 'profile_id') ?? '',
    isActive: row.is_active === true,
    currentReadyDocuments: count(row, 'current_ready_documents'),
    documentsWithChildren: count(row, 'documents_with_children'),
    missingDocuments: count(row, 'missing_documents'),
  }));
}

/** Per profile: the open gaps of its latest build run and whether the recorded decision passed. */
export async function getChunkingProfileState(options: ChunkingOpOptions = {}): Promise<ChunkingProfileState[]> {
  const rows = await call('rag_chunking_profile_state', {}, options.signal);
  return rows.map((row) => {
    const evidence = text(row, 'evidence');
    return {
      docType: text(row, 'doc_type') ?? '',
      profileId: text(row, 'profile_id') ?? '',
      openGaps: count(row, 'open_gaps'),
      evidence: evidence === 'passed' || evidence === 'failed' ? evidence : 'none',
    };
  });
}

export async function createChunkingProfile(
  input: CreateChunkingProfileInput,
  options: ChunkingOpOptions = {},
): Promise<{ profileId: string; docType: string; status: string }> {
  const rows = await call(
    'rag_create_chunking_profile',
    {
      p_id: input.id,
      p_doc_type: input.docType,
      p_child_tokens: input.childTokens,
      p_parent_mode: input.parentMode,
      p_parent_tokens: input.parentTokens,
      p_preset: input.preset,
    },
    options.signal,
  );
  const row = firstRow(rows, 'rag_create_chunking_profile');
  return { profileId: text(row, 'profile_id') ?? input.id, docType: text(row, 'doc_type') ?? input.docType, status: text(row, 'status') ?? 'building' };
}

/** Stores a ChunkingDecision as the profile's eval evidence. The decision is checked against the generated schema before any call. */
export async function recordChunkingDecision(decision: unknown, options: ChunkingOpOptions = {}): Promise<{ profileId: string; docType: string }> {
  const parsed = ChunkingDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    throw new ChunkingInputError(
      'the decision does not match the ChunkingDecision schema',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const rows = await call('rag_record_chunking_decision', { p_profile_id: parsed.data.profile_id, p_decision: parsed.data }, options.signal);
  const row = firstRow(rows, 'rag_record_chunking_decision');
  return { profileId: text(row, 'profile_id') ?? parsed.data.profile_id, docType: text(row, 'doc_type') ?? parsed.data.doc_type };
}

/**
 * Flips the pointer of the profile's doc type through the gate. A gate that says no raises ChunkingActivationRefused with its reason; a
 * success refreshes the cached pointer. `docType` is needed when the id exists for more than one doc type, and always for `legacy`.
 */
export async function activateChunkingProfile(
  profileId: string,
  options: ChunkingOpOptions & { docType?: string; actor?: string | null } = {},
): Promise<{ activated: string; previous: string | null; docType: string; changed: boolean }> {
  const rows = await call(
    'rag_activate_chunking_profile',
    { p_profile_id: profileId, p_actor: options.actor ?? null, p_doc_type: options.docType ?? null },
    options.signal,
  );
  const row = firstRow(rows, 'rag_activate_chunking_profile');
  const activated = text(row, 'activated_profile');
  const docType = text(row, 'doc_type');
  if (!activated || !docType) throw new RetrievalBackendError('rag_activate_chunking_profile', 'malformed_response');
  await refreshActiveChunkingProfiles();
  options.signal?.throwIfAborted();
  return { activated, previous: text(row, 'previous_profile'), docType, changed: row.changed === true };
}

/** Restores the previous profile of the doc type (legacy when there is none) and refreshes the cached pointer. */
export async function rollbackChunkingProfile(
  docType: string,
  options: ChunkingOpOptions & { actor?: string | null } = {},
): Promise<{ restored: string; rolledBack: string; docType: string }> {
  const rows = await call('rag_rollback_chunking_profile', { p_doc_type: docType, p_actor: options.actor ?? null }, options.signal);
  const row = firstRow(rows, 'rag_rollback_chunking_profile');
  const restored = text(row, 'restored_profile');
  const rolledBack = text(row, 'rolled_back_profile');
  if (!restored || !rolledBack) throw new RetrievalBackendError('rag_rollback_chunking_profile', 'malformed_response');
  await refreshActiveChunkingProfiles();
  options.signal?.throwIfAborted();
  return { restored, rolledBack, docType: text(row, 'doc_type') ?? docType };
}
