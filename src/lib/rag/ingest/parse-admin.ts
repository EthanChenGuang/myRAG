import type { RpcClient } from '../backend/supabase-rpc';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { getIngestDeps } from './deps';
import { DOC_TYPE_IDS } from './profiles/doc-type-defaults';
import { getProcessingProfile, type DocType } from './profiles/load';
import { queueConfigFromProcessEnv } from './queue-config';

export const PARSE_TIERS = ['native', 'fast', 'structured', 'premium'] as const;
export type ParseTierName = (typeof PARSE_TIERS)[number];

export interface TierBoundsPair {
  min_tier: ParseTierName;
  max_tier: ParseTierName;
}

export interface TierOverrideView extends TierBoundsPair {
  updated_by: string | null;
  updated_at: string | null;
}

export interface TierBoundsItem {
  docType: DocType;
  profile: TierBoundsPair | null;
  override: TierOverrideView | null;
  effective: TierBoundsPair | null;
}

export interface BudgetTenantUsage {
  tenantKey: string;
  reserved: number;
  used: number;
  vlmUsed: number;
}

export interface BudgetView {
  month: string;
  budgetPages: number;
  maxPagesPerDoc: number;
  tenants: BudgetTenantUsage[];
}

/** Stable failure of a parse administration call; the message never carries database text. */
export class ParseAdminError extends Error {
  readonly rpc: string;
  readonly code: string | null;

  constructor(rpc: string, code: string | null) {
    super(`[Parse Admin] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'ParseAdminError';
    this.rpc = rpc;
    this.code = code;
  }
}

type Row = Record<string, unknown>;

async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Row[]> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) throw new ParseAdminError(rpc, 'no_db');
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new ParseAdminError(rpc, response.error.code ?? null);
  const data = response.data as unknown;
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]).filter((row): row is Row => typeof row === 'object' && row !== null);
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

function tierOf(value: unknown): ParseTierName | null {
  return (PARSE_TIERS as readonly unknown[]).includes(value) ? (value as ParseTierName) : null;
}

/**
 * This UTC month's reserved, used and L3 (vlm) pages of one tenant, with the configured monthly budget and per-document cap. A tenant with
 * no usage row yet reads as zeros. Only the given tenant is asked for, and a row of any other tenant is dropped.
 */
export async function readBudgetView(scope: TenantScope, signal: AbortSignal): Promise<BudgetView> {
  const tenantKey = scopeKey(scope).toLowerCase();
  const rows = (await call('rag_parse_budget_month', { p_tenant_key: tenantKey }, signal)).filter(
    (row) => typeof row.tenant_key === 'string' && row.tenant_key.toLowerCase() === tenantKey,
  );
  const first = rows[0];
  const month = typeof first?.month === 'string' && /^\d{4}-\d{2}/.test(first.month)
    ? first.month.slice(0, 7)
    : new Date(getIngestDeps().now()).toISOString().slice(0, 7);
  const config = queueConfigFromProcessEnv();
  return {
    month,
    budgetPages: config.premiumPageBudget,
    maxPagesPerDoc: config.premiumMaxPagesPerDoc,
    tenants: [
      {
        tenantKey,
        reserved: count(first?.pages_reserved),
        used: count(first?.pages_used),
        vlmUsed: count(first?.vlm_pages_used),
      },
    ],
  };
}

function viewOf(row: Row): TierOverrideView | null {
  const min = tierOf(row.min_tier);
  const max = tierOf(row.max_tier);
  if (!min || !max) return null;
  return { min_tier: min, max_tier: max, updated_by: typeof row.updated_by === 'string' ? row.updated_by : null, updated_at: iso(row.updated_at) };
}

function profileBounds(docType: DocType): TierBoundsPair | null {
  const profile = getProcessingProfile(docType);
  if (!profile.min_tier || !profile.max_tier) return null;
  return { min_tier: profile.min_tier, max_tier: profile.max_tier };
}

function itemOf(docType: DocType, override: TierOverrideView | null): TierBoundsItem {
  const profile = profileBounds(docType);
  return {
    docType,
    profile,
    override,
    effective: override ? { min_tier: override.min_tier, max_tier: override.max_tier } : profile,
  };
}

/** Every document type with its profile bounds, the D-13 override when one is set, and the bounds in effect. */
export async function listTierBounds(signal: AbortSignal): Promise<TierBoundsItem[]> {
  const rows = await call('rag_get_parse_tier_overrides', {}, signal);
  const overrides = new Map<string, TierOverrideView>();
  for (const row of rows) {
    const view = viewOf(row);
    const key = row.doc_type;
    if (view && typeof key === 'string') overrides.set(key, view);
  }
  return [...DOC_TYPE_IDS].sort().map((docType) => itemOf(docType, overrides.get(docType) ?? null));
}

export interface SetTierOverrideInput {
  docType: DocType;
  minTier: ParseTierName | null;
  maxTier: ParseTierName | null;
  /** The id of the admin the route guard verified. */
  actorUserId: string;
  signal: AbortSignal;
}

/** Stores the override (both bounds) or clears it (both null) through the audited SQL function, and returns the bounds now in effect. */
export async function setTierOverride(input: SetTierOverrideInput): Promise<TierBoundsItem> {
  const rows = await call(
    'rag_set_parse_tier_override',
    { p_doc_type: input.docType, p_min_tier: input.minTier, p_max_tier: input.maxTier, p_actor: input.actorUserId },
    input.signal,
  );
  const stored = input.minTier === null && input.maxTier === null ? null : rows[0] ? viewOf(rows[0]) : null;
  if (input.minTier !== null && stored === null) throw new ParseAdminError('rag_set_parse_tier_override', 'no_row');
  return itemOf(input.docType, stored);
}
