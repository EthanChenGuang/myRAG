import crypto from 'node:crypto';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { BackendId } from '@/lib/rag/backend/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { RetrievalResult } from '@/lib/rag/types';
import type { CanaryEnv, CanaryTenant } from './factory';

/** A generated placeholder for the voice token secret (64 hex characters, above MIN_VOICE_SECRET_LENGTH); never a real secret. */
export const CANARY_VOICE_SECRET = crypto.randomBytes(32).toString('hex');

/** The two backend switches of one request; undefined means the variable is unset (its default, pgvector). */
export interface EntryConfig {
  backend?: BackendId;
  voiceBackend?: BackendId;
}

export interface EntrySelection {
  backend: string;
  fallbackReason: string | null;
  tenantValidationDropped: number;
  degraded: boolean;
  /** Hits per leg as the search stage counted them. */
  legs: { dense: number; lexical: number };
}

export interface EntryOutcome {
  /** Set when the entry point refused the request before retrieval; result is then null. */
  refused: { status: number | string; reason: string } | null;
  scope: TenantScope | null;
  result: RetrievalResult | null;
  /** The search stage's backend fields, read from its trace record. */
  selection: EntrySelection | null;
  /** Candidate chunk ids and contents, in result order. */
  ids: string[];
  contents: string[];
  /** Every admin RPC name the request called, in order. */
  rpcCalls: string[];
}

export interface VoiceRequestOptions {
  /** Sent instead of a token minted for the tenant (tampered or foreign tokens). */
  token?: string;
  secret?: string;
}

function refusedOutcome(status: number | string, reason: string): EntryOutcome {
  return { refused: { status, reason }, scope: null, result: null, selection: null, ids: [], contents: [], rpcCalls: [] };
}

export async function mintCanaryVoiceToken(_scope: TenantScope, _secret: string = CANARY_VOICE_SECRET): Promise<string> {
  return 'stub.token';
}

export async function voiceRequest(
  _env: CanaryEnv,
  _tenant: Pick<CanaryTenant, 'scope'>,
  _question: string,
  _config: EntryConfig,
  _options: VoiceRequestOptions = {},
): Promise<EntryOutcome> {
  return refusedOutcome('stub', 'not_implemented');
}

export async function embedRequest(
  _env: CanaryEnv,
  _configuredTenant: string | undefined,
  _rawBody: unknown,
  _question: string,
  _config: EntryConfig,
): Promise<EntryOutcome> {
  return refusedOutcome('stub', 'not_implemented');
}

export async function chatRequest(_scope: TenantScope, _question: string, _config: EntryConfig): Promise<EntryOutcome> {
  return refusedOutcome('stub', 'not_implemented');
}

export interface FilterIgnoringReader<T> {
  client: T;
  rawIds(): Set<string>;
  reset(): void;
}

export async function filterIgnoringReader(
  _env: CanaryEnv,
  _foreign: Pick<CanaryTenant, 'tenantKey'>,
): Promise<FilterIgnoringReader<unknown> & { uninstall(): void }> {
  return { client: null, rawIds: () => new Set(), reset: () => undefined, uninstall: () => undefined };
}

export function filterIgnoringRpc(inner: RpcClient, _foreignTenantKey: string): FilterIgnoringReader<RpcClient> {
  return { client: inner, rawIds: () => new Set(), reset: () => undefined };
}
