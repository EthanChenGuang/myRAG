import type { TenantScope } from '../tenant/scope';
import {
  badResponse,
  callAccessRows,
  callAccessRpc,
  count,
  refused,
  rowId,
  stringArray,
  tenantKeyOf,
  text,
  uuidOf,
  type AccessServiceDeps,
  type Row,
} from './errors';

export const CONNECTOR_PROVIDERS = ['google-drive', 'dropbox', 'notion', 'sharepoint-online', 'one-drive'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];
export type ConnectorMapKind = 'group' | 'team' | 'workspace';
export type SharingRuleKind = 'domain' | 'anyone' | 'public';

/** One sharing entry read at the source (plan 30 contract). User principals carry the member id from matchConnectorMembers, never an address. */
export type ConnectorPrincipal =
  | { kind: 'user'; memberId: string | null }
  | { kind: ConnectorMapKind | 'domain'; id: string }
  | { kind: 'anyone' | 'public' };

export interface ApplyConnectorAccessInput {
  documentId: string;
  provider: ConnectorProvider;
  principals: readonly ConnectorPrincipal[];
  /** The member who owns the synced copy; the fallback audience. */
  ownerId: string;
  /** source_error when the sharing could not be read: the document falls back closed. */
  status: 'ok' | 'source_error';
}

export type ConnectorAccessReason = 'source_mapped' | 'owner_only' | 'unmapped_source' | 'source_error';

export interface ConnectorAccessResult {
  keys: string[];
  failClosed: boolean;
  reason: ConnectorAccessReason;
}

export interface ConnectorMapRow {
  /** Null for a source group seen at a sync that has no mapping yet. */
  id: string | null;
  provider: ConnectorProvider;
  kind: ConnectorMapKind;
  externalPrincipalId: string;
  groupId: string | null;
  /** Documents whose last sync left this source group unmapped. */
  documents: number;
}

export interface ConnectorMapPage {
  rows: ConnectorMapRow[];
  total: number;
}

export type SetConnectorMapInput =
  | { id: string; groupId: string }
  | { id?: undefined | null; provider: ConnectorProvider | string; kind: ConnectorMapKind | string; externalPrincipalId: string; groupId: string };

export interface ConnectorMapOutcome {
  id: string;
  groupId: string;
  outcome: 'created' | 'changed' | 'unchanged';
}

export interface SharingRuleRow {
  id: string;
  provider: ConnectorProvider;
  kind: SharingRuleKind;
  domain: string | null;
  enabled: boolean;
  documents: number;
}

export type SetSharingRuleInput =
  | { id: string; enabled: boolean }
  | { id?: undefined | null; provider: ConnectorProvider | string; kind: SharingRuleKind | string; domain?: string | null };

export interface SharingRuleOutcome {
  id: string;
  enabled: boolean;
  outcome: 'created' | 'enabled' | 'disabled' | 'unchanged';
}

export interface ConnectorFailClosedCount {
  connectionId: string;
  documents: number;
}

export const CONNECTOR_MAX_PRINCIPALS = 5000;
export const CONNECTOR_MAX_ADDRESSES = 5000;
const MAP_KINDS: readonly string[] = ['group', 'team', 'workspace'];
const RULE_KINDS: readonly string[] = ['domain', 'anyone', 'public'];
const PRINCIPAL_ID_MAX = 512;
const ADDRESS_MAX = 320;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function providerOf(rpc: string, value: unknown): ConnectorProvider {
  if (typeof value === 'string' && (CONNECTOR_PROVIDERS as readonly string[]).includes(value)) return value as ConnectorProvider;
  throw refused(rpc, 'invalid_argument');
}

function returnedProvider(rpc: string, value: unknown): ConnectorProvider {
  if (typeof value === 'string' && (CONNECTOR_PROVIDERS as readonly string[]).includes(value)) return value as ConnectorProvider;
  throw badResponse(rpc);
}

function principalIdOf(rpc: string, value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id === '' || id.length > PRINCIPAL_ID_MAX) throw refused(rpc, 'invalid_argument');
  return id;
}

function principalsOf(rpc: string, value: unknown): Row[] {
  if (!Array.isArray(value) || value.length > CONNECTOR_MAX_PRINCIPALS) throw refused(rpc, 'invalid_argument');
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw refused(rpc, 'invalid_argument');
    const principal = item as Record<string, unknown>;
    const kind = principal.kind;
    if (kind === 'user') {
      const member = principal.memberId;
      return { kind, member_id: member === null || member === undefined ? null : uuidOf(rpc, member) };
    }
    if (kind === 'anyone' || kind === 'public') return { kind };
    if (typeof kind === 'string' && (MAP_KINDS.includes(kind) || kind === 'domain')) return { kind, id: principalIdOf(rpc, principal.id) };
    throw refused(rpc, 'invalid_argument');
  });
}

/**
 * D-20, A-10: turns a synced document's source sharing into its access label in one audited, fail-closed call (actor kind connector). The Nango
 * sync calls this instead of any rag_ function.
 */
export async function applyConnectorAccess(scope: TenantScope, input: ApplyConnectorAccessInput, deps: AccessServiceDeps): Promise<ConnectorAccessResult> {
  const rpc = 'rag_connector_apply_access';
  const tenantKey = tenantKeyOf(scope);
  const documentId = uuidOf(rpc, input.documentId, 'not_found');
  const provider = providerOf(rpc, input.provider);
  const principals = principalsOf(rpc, input.principals);
  const owner = uuidOf(rpc, input.ownerId, 'unknown_user');
  if (input.status !== 'ok' && input.status !== 'source_error') throw refused(rpc, 'invalid_argument');
  const rows = await callAccessRows(deps, rpc, {
    p_tenant_key: tenantKey,
    p_document_id: documentId,
    p_provider: provider,
    p_principals: principals,
    p_owner: owner,
    p_status: input.status,
  });
  const row = rows[0];
  const reason = row ? text(row, 'reason') : null;
  if (!row || (reason !== 'source_mapped' && reason !== 'owner_only' && reason !== 'unmapped_source' && reason !== 'source_error')) throw badResponse(rpc);
  const result: ConnectorAccessResult = { keys: stringArray(row.keys), failClosed: row.fail_closed === true, reason };
  if (result.failClosed) console.warn('[RAG Access] connector document fell back', { provider, reason });
  return result;
}

/** Matches source addresses to members of the caller's tenant; the answer is aligned with the input (a member id or null), never an address. */
export async function matchConnectorMembers(scope: TenantScope, addresses: readonly string[], deps: AccessServiceDeps): Promise<Array<string | null>> {
  const rpc = 'rag_connector_match_members';
  const tenantKey = tenantKeyOf(scope);
  if (!Array.isArray(addresses) || addresses.length > CONNECTOR_MAX_ADDRESSES) throw refused(rpc, 'invalid_argument');
  if (addresses.length === 0) return [];
  const list = addresses.map((address) => (typeof address === 'string' ? address.trim().slice(0, ADDRESS_MAX) : ''));
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_addresses: list });
  const result: Array<string | null> = list.map(() => null);
  for (const row of rows) {
    const idx = Number(row.idx);
    if (!Number.isInteger(idx) || idx < 1 || idx > list.length) throw badResponse(rpc);
    if (result[idx - 1] === null) result[idx - 1] = rowId(rpc, row.user_id);
  }
  return result;
}

/** The connector mapping list, 50 rows per page by offset. */
export async function listConnectorMap(scope: TenantScope, input: { offset?: number }, deps: AccessServiceDeps): Promise<ConnectorMapPage> {
  const rpc = 'rag_connector_map_list';
  const tenantKey = tenantKeyOf(scope);
  const offset = input?.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw refused(rpc, 'invalid_argument');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_offset: offset });
  const total = rows[0] ? count(rows[0], 'total') : 0;
  return {
    total,
    rows: rows.map((row) => {
      const kind = text(row, 'kind');
      const externalPrincipalId = text(row, 'external_principal_id');
      if (kind === null || !MAP_KINDS.includes(kind) || externalPrincipalId === null) throw badResponse(rpc);
      return {
        id: row.id === null || row.id === undefined ? null : rowId(rpc, row.id),
        provider: returnedProvider(rpc, row.provider),
        kind: kind as ConnectorMapKind,
        externalPrincipalId,
        groupId: row.group_id === null || row.group_id === undefined ? null : rowId(rpc, row.group_id),
        documents: count(row, 'documents'),
      };
    }),
  };
}

/** Creates a mapping (provider, kind, source id) or points an existing one at another group. Relabels nothing until the next sync. */
export async function setConnectorMap(scope: TenantScope, input: SetConnectorMapInput, actorId: string, deps: AccessServiceDeps): Promise<ConnectorMapOutcome> {
  const rpc = 'rag_connector_map_set';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'unknown_group');
  const actor = uuidOf(rpc, actorId, 'actor_required');
  let args: Row;
  if (input.id !== undefined && input.id !== null) {
    args = { p_id: uuidOf(rpc, input.id, 'not_found'), p_provider: null, p_kind: null, p_external_principal_id: null };
  } else {
    const create = input as Extract<SetConnectorMapInput, { provider: unknown }>;
    const kind = typeof create.kind === 'string' && MAP_KINDS.includes(create.kind) ? create.kind : null;
    if (kind === null) throw refused(rpc, 'invalid_argument');
    args = { p_id: null, p_provider: providerOf(rpc, create.provider), p_kind: kind, p_external_principal_id: principalIdOf(rpc, create.externalPrincipalId) };
  }
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, ...args, p_group_id: groupId, p_actor: actor });
  const row = rows[0];
  const outcome = row ? text(row, 'outcome') : null;
  if (!row || (outcome !== 'created' && outcome !== 'changed' && outcome !== 'unchanged')) throw badResponse(rpc);
  return { id: rowId(rpc, row.id), groupId: rowId(rpc, row.group_id), outcome };
}

/** Removes a mapping of the caller's tenant; an unknown id raises not_found. */
export async function deleteConnectorMap(scope: TenantScope, input: { id: string }, actorId: string, deps: AccessServiceDeps): Promise<boolean> {
  const rpc = 'rag_connector_map_delete';
  const tenantKey = tenantKeyOf(scope);
  const id = uuidOf(rpc, input.id, 'not_found');
  const actor = uuidOf(rpc, actorId, 'actor_required');
  const data = await callAccessRpc(deps, rpc, { p_tenant_key: tenantKey, p_id: id, p_actor: actor });
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null && typeof (value as Row)[rpc] === 'boolean') return (value as Row)[rpc] as boolean;
  throw badResponse(rpc);
}

export async function listSharingRules(scope: TenantScope, deps: AccessServiceDeps): Promise<SharingRuleRow[]> {
  const rpc = 'rag_connector_rules_list';
  const tenantKey = tenantKeyOf(scope);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey });
  return rows.map((row) => {
    const kind = text(row, 'kind');
    if (kind === null || !RULE_KINDS.includes(kind)) throw badResponse(rpc);
    return {
      id: rowId(rpc, row.id),
      provider: returnedProvider(rpc, row.provider),
      kind: kind as SharingRuleKind,
      domain: text(row, 'domain'),
      enabled: row.enabled === true,
      documents: count(row, 'documents'),
    };
  });
}

/** Creates a sharing rule (always off) or turns an existing one on or off. A domain rule needs a valid domain; other kinds take none. */
export async function setSharingRule(scope: TenantScope, input: SetSharingRuleInput, actorId: string, deps: AccessServiceDeps): Promise<SharingRuleOutcome> {
  const rpc = 'rag_connector_rule_set';
  const tenantKey = tenantKeyOf(scope);
  const actor = uuidOf(rpc, actorId, 'actor_required');
  let args: Row;
  if (input.id !== undefined && input.id !== null) {
    const change = input as Extract<SetSharingRuleInput, { enabled: unknown }>;
    if (typeof change.enabled !== 'boolean') throw refused(rpc, 'invalid_argument');
    args = { p_id: uuidOf(rpc, change.id, 'not_found'), p_provider: null, p_kind: null, p_domain: null, p_enabled: change.enabled };
  } else {
    const create = input as Extract<SetSharingRuleInput, { provider: unknown }>;
    const provider = providerOf(rpc, create.provider);
    const kind = typeof create.kind === 'string' && RULE_KINDS.includes(create.kind) ? create.kind : null;
    if (kind === null) throw refused(rpc, 'invalid_argument');
    const raw = create.domain === undefined || create.domain === null ? null : String(create.domain).trim().toLowerCase();
    const domain = raw === '' ? null : raw;
    if (kind === 'domain' && (domain === null || domain.length > 253 || !DOMAIN_RE.test(domain))) throw refused(rpc, 'bad_domain');
    if (kind !== 'domain' && domain !== null) throw refused(rpc, 'bad_domain');
    args = { p_id: null, p_provider: provider, p_kind: kind, p_domain: domain, p_enabled: false };
  }
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, ...args, p_actor: actor });
  const row = rows[0];
  const outcome = row ? text(row, 'outcome') : null;
  if (!row || (outcome !== 'created' && outcome !== 'enabled' && outcome !== 'disabled' && outcome !== 'unchanged')) throw badResponse(rpc);
  return { id: rowId(rpc, row.id), enabled: row.enabled === true, outcome };
}

/** Per connection, the number of documents left with the fallback audience (connector card, sync banner). */
export async function connectorFailClosedCounts(scope: TenantScope, deps: AccessServiceDeps): Promise<ConnectorFailClosedCount[]> {
  const rpc = 'rag_connector_fail_closed_counts';
  const tenantKey = tenantKeyOf(scope);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey });
  return rows.map((row) => {
    const connectionId = text(row, 'connection_id');
    if (connectionId === null) throw badResponse(rpc);
    return { connectionId, documents: count(row, 'documents') };
  });
}
