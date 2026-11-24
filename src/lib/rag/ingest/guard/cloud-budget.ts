import type { RpcClient } from '../../backend/supabase-rpc';

export type CloudKind = 'parse' | 'vlm';
export type CloudRefusal = 'cloud_not_allowed' | 'over_page_cap' | 'budget_exhausted' | 'batch_budget_exhausted';
export type CloudGate = { ok: true } | { ok: false; reason: CloudRefusal };

export interface Reservation {
  jobId: string;
  attemptNo: number;
  kind: CloudKind;
  pages: number;
}

export type ReserveResult = { ok: true; handle: Reservation | null } | { ok: false; reason: CloudRefusal };

export interface PremiumContext {
  jobId?: string;
  attemptNo?: number;
  pages: number;
  estUsd?: number;
  routing: 'fixed' | 'tiered';
  queued: boolean;
}

export interface GuardConfig {
  parserAllowCloud: boolean;
  premiumPageBudget: number;
  premiumMaxPagesPerDoc: number;
}

export interface GuardDeps {
  db: () => RpcClient | null;
  config: () => GuardConfig;
}

export interface MonthlyUsageRow {
  tenant_key: string;
  month: string;
  pages_reserved: number;
  pages_used: number;
  vlm_pages_used: number;
}

export class CloudRefused extends Error {
  readonly reason: CloudRefusal;

  constructor(reason: CloudRefusal) {
    super(`[Ingest] cloud call refused (${reason})`);
    this.name = 'CloudRefused';
    this.reason = reason;
  }
}

export class CloudGuardError extends Error {
  readonly rpc: string;
  readonly code: string | null;

  constructor(rpc: string, code: string | null) {
    super(`[Ingest] cloud guard ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'CloudGuardError';
    this.rpc = rpc;
    this.code = code;
  }
}

export interface GuardCallOptions {
  signal?: AbortSignal;
  deps?: Partial<GuardDeps>;
}

export function setCloudGuardDepsForTests(_partial: Partial<GuardDeps>): void {}

export function resetCloudGuardDepsForTests(): void {}

export function assertCloudAllowed(_kind: CloudKind, _options: GuardCallOptions = {}): CloudGate {
  return { ok: true };
}

export async function reservePremium(_context: PremiumContext, _options: GuardCallOptions = {}): Promise<ReserveResult> {
  return { ok: true, handle: null };
}

export async function reserveVlm(_context: PremiumContext, _options: GuardCallOptions = {}): Promise<ReserveResult> {
  return { ok: true, handle: null };
}

export async function settle(_handle: Reservation, _pagesSent: number, _options: GuardCallOptions = {}): Promise<boolean> {
  return false;
}

export async function release(_handle: Reservation, _options: GuardCallOptions = {}): Promise<boolean> {
  return false;
}

export async function readMonthlyUsage(_tenantKey?: string, _options: GuardCallOptions = {}): Promise<MonthlyUsageRow[]> {
  return [];
}
