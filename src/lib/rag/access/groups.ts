import type { TenantScope } from '../tenant/scope';
import {
  badResponse,
  callAccessRows,
  callAccessRpc,
  count,
  refused,
  required,
  rowId,
  tenantKeyOf,
  text,
  timestamp,
  uuidOf,
  type AccessServiceDeps,
  type Row,
} from './errors';

export type AccessGroupSource = 'manual' | 'connector';

export interface AccessGroup {
  id: string;
  key: string;
  name: string;
  source: AccessGroupSource;
  createdAt: string | null;
}

export interface AccessGroupListItem extends AccessGroup {
  memberCount: number;
  documentCount: number;
}

export interface AccessGroupPage {
  groups: AccessGroupListItem[];
  /** Pass back to read the next page; null when this page was not full. */
  nextCursor: string | null;
}

export interface AccessGroupImpact {
  onlyCount: number;
  sharedCount: number;
  memberCount: number;
  mappingCount: number;
}

export interface AccessGroupDeleteResult {
  fellBack: number;
  relabelled: number;
}

export interface AccessGroupMember {
  userId: string;
  displayName: string;
  email: string | null;
  addedAt: string | null;
  source: string | null;
}

export interface AccessMemberCandidate {
  userId: string;
  displayName: string;
  email: string | null;
  alreadyMember: boolean;
}

export interface AccessGroupRef {
  id: string;
  name: string;
}

export interface MyAccessGroups {
  isAdmin: boolean;
  ownGroups: AccessGroupRef[];
  assignableGroups: AccessGroupRef[];
}

export const ACCESS_GROUP_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ACCESS_GROUP_NAME_MAX = 200;
export const ACCESS_GROUPS_PAGE_SIZE = 50;
export const ACCESS_CANDIDATES_MAX = 20;
const CURSOR_MAX = 400;
const QUERY_MAX = 200;

function keyOf(rpc: string, value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!ACCESS_GROUP_KEY_RE.test(key)) throw refused(rpc, 'invalid_key');
  if (key === 'all') throw refused(rpc, 'reserved_key');
  return key;
}

function nameOf(rpc: string, value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > ACCESS_GROUP_NAME_MAX) throw refused(rpc, 'invalid_name');
  return name;
}

function cursorOf(rpc: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > CURSOR_MAX || !/^[A-Za-z0-9+/=]+$/.test(value)) throw refused(rpc, 'invalid_cursor');
  return value;
}

function limitOf(value: unknown, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : max;
  return Math.min(Math.max(n, 1), max);
}

function sourceOf(rpc: string, value: unknown): AccessGroupSource {
  if (value === 'manual' || value === 'connector') return value;
  throw badResponse(rpc);
}

function parseGroup(rpc: string, row: Row): AccessGroup {
  return {
    id: rowId(rpc, row.id),
    key: required(rpc, row, 'key'),
    name: required(rpc, row, 'name'),
    source: sourceOf(rpc, row.source),
    createdAt: timestamp(row, 'created_at'),
  };
}

function single<T>(rpc: string, rows: Row[], parse: (_row: Row) => T): T {
  const row = rows[0];
  if (!row) throw badResponse(rpc);
  return parse(row);
}

function refsOf(rpc: string, value: unknown): AccessGroupRef[] {
  if (value === null || value === undefined) return [];
  const list = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(list)) throw badResponse(rpc);
  return list.map((item) => {
    if (typeof item !== 'object' || item === null) throw badResponse(rpc);
    const entry = item as Row;
    return { id: rowId(rpc, entry.id), name: required(rpc, entry, 'name') };
  });
}

/** Creates a group in the caller's tenant. The actor is the admin the route guard verified. */
export async function createGroup(scope: TenantScope, input: { key: string; name: string; actorId: string }, deps: AccessServiceDeps): Promise<AccessGroup> {
  const rpc = 'rag_access_group_create';
  const tenantKey = tenantKeyOf(scope);
  const key = keyOf(rpc, input.key);
  const name = nameOf(rpc, input.name);
  const actor = uuidOf(rpc, input.actorId, 'actor_required');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_key: key, p_name: name, p_actor: actor });
  return single(rpc, rows, (row) => parseGroup(rpc, row));
}

export async function renameGroup(scope: TenantScope, input: { groupId: string; name: string; actorId: string }, deps: AccessServiceDeps): Promise<AccessGroup> {
  const rpc = 'rag_access_group_rename';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const name = nameOf(rpc, input.name);
  const actor = uuidOf(rpc, input.actorId, 'actor_required');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId, p_name: name, p_actor: actor });
  return single(rpc, rows, (row) => parseGroup(rpc, row));
}

export async function listGroups(scope: TenantScope, input: { cursor?: string | null; limit?: number }, deps: AccessServiceDeps): Promise<AccessGroupPage> {
  const rpc = 'rag_access_groups_list';
  const tenantKey = tenantKeyOf(scope);
  const cursor = cursorOf(rpc, input.cursor);
  const limit = limitOf(input.limit, ACCESS_GROUPS_PAGE_SIZE);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_cursor: cursor, p_limit: limit });
  const groups = rows.map((row) => ({ ...parseGroup(rpc, row), memberCount: count(row, 'member_count'), documentCount: count(row, 'document_count') }));
  const last = rows[rows.length - 1];
  return { groups, nextCursor: rows.length === limit && last ? text(last, 'cursor') : null };
}

export async function groupImpact(scope: TenantScope, input: { groupId: string }, deps: AccessServiceDeps): Promise<AccessGroupImpact> {
  const rpc = 'rag_access_group_impact';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId });
  return single(rpc, rows, (row) => ({
    onlyCount: count(row, 'only_count'),
    sharedCount: count(row, 'shared_count'),
    memberCount: count(row, 'member_count'),
    mappingCount: count(row, 'mapping_count'),
  }));
}

/**
 * Deletes a group once the caller confirms the number of documents restricted to it alone (from groupImpact). A changed count raises
 * count_required with the current count on the error.
 */
export async function deleteGroup(
  scope: TenantScope,
  input: { groupId: string; expectedOnlyCount: number; actorId: string },
  deps: AccessServiceDeps,
): Promise<AccessGroupDeleteResult> {
  const rpc = 'rag_access_group_delete';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const expected = input.expectedOnlyCount;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) throw refused(rpc, 'count_required');
  const actor = uuidOf(rpc, input.actorId, 'actor_required');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId, p_expected_only_count: expected, p_actor: actor });
  return single(rpc, rows, (row) => ({ fellBack: count(row, 'fell_back'), relabelled: count(row, 'relabelled') }));
}

function parseMember(rpc: string, row: Row): AccessGroupMember {
  const userId = rowId(rpc, row.user_id);
  return { userId, displayName: text(row, 'display_name') ?? userId, email: text(row, 'email'), addedAt: timestamp(row, 'added_at'), source: text(row, 'source') };
}

export async function listMembers(scope: TenantScope, input: { groupId: string }, deps: AccessServiceDeps): Promise<AccessGroupMember[]> {
  const rpc = 'rag_access_group_members_list';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId });
  return rows.map((row) => parseMember(rpc, row));
}

export async function addMember(
  scope: TenantScope,
  input: { groupId: string; userId: string; actorId: string },
  deps: AccessServiceDeps,
): Promise<{ groupId: string; userId: string; addedAt: string | null }> {
  const rpc = 'rag_access_member_add';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const userId = uuidOf(rpc, input.userId, 'not_a_workspace_member');
  const actor = uuidOf(rpc, input.actorId, 'actor_required');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId, p_user_id: userId, p_actor: actor });
  return single(rpc, rows, (row) => ({ groupId: rowId(rpc, row.group_id), userId: rowId(rpc, row.user_id), addedAt: timestamp(row, 'added_at') }));
}

/** True when the member was removed; an unknown group or a user who was not a member raises not_found. */
export async function removeMember(scope: TenantScope, input: { groupId: string; userId: string; actorId: string }, deps: AccessServiceDeps): Promise<boolean> {
  const rpc = 'rag_access_member_remove';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const userId = uuidOf(rpc, input.userId, 'not_found');
  const actor = uuidOf(rpc, input.actorId, 'actor_required');
  const data = await callAccessRpc(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId, p_user_id: userId, p_actor: actor });
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null && typeof (value as Row)[rpc] === 'boolean') return (value as Row)[rpc] as boolean;
  throw badResponse(rpc);
}

/** Up to 20 workspace members matching the query; below 2 characters the answer is empty without a database call. */
export async function memberCandidates(
  scope: TenantScope,
  input: { groupId: string; query: string; limit?: number },
  deps: AccessServiceDeps,
): Promise<AccessMemberCandidate[]> {
  const rpc = 'rag_access_member_candidates';
  const tenantKey = tenantKeyOf(scope);
  const groupId = uuidOf(rpc, input.groupId, 'not_found');
  const query = typeof input.query === 'string' ? input.query.trim().slice(0, QUERY_MAX) : '';
  if (query.length < 2) return [];
  const limit = limitOf(input.limit, ACCESS_CANDIDATES_MAX);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_group_id: groupId, p_query: query, p_limit: limit });
  return rows.map((row) => {
    const userId = rowId(rpc, row.user_id);
    return { userId, displayName: text(row, 'display_name') ?? userId, email: text(row, 'email'), alreadyMember: row.already_member === true };
  });
}

/** The caller's own groups and the groups they may assign at upload (D-16). The user id is the verified session's, never a body field. */
export async function myGroups(scope: TenantScope, input: { userId: string }, deps: AccessServiceDeps): Promise<MyAccessGroups> {
  const rpc = 'rag_access_my_groups';
  const tenantKey = tenantKeyOf(scope);
  const userId = uuidOf(rpc, input.userId, 'unknown_user');
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_user_id: userId });
  const row = rows[0];
  if (!row) return { isAdmin: false, ownGroups: [], assignableGroups: [] };
  return { isAdmin: row.is_admin === true, ownGroups: refsOf(rpc, row.own_groups), assignableGroups: refsOf(rpc, row.assignable_groups) };
}
