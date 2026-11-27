import { z } from 'zod/v3';
import { resolveAccessScope, uploadAccessKeys, type UploadAccessChoice } from '../tenant/access';
import type { TenantScope } from '../tenant/scope';
import { ACCESS_GROUP_KEY_RE } from './groups';
import { callAccessRows, tenantKeyOf, text, type AccessServiceDeps } from './errors';

/** The one optional upload field (UI-SPEC decision 5): JSON {"everyone": true} or {"groupIds": [<uuid>, ...]}; absent means untouched. */
export const UPLOAD_ACCESS_FIELD = 'access';
export const UPLOAD_ACCESS_MAX_GROUPS = 50;
const FIELD_MAX_LENGTH = 4096;

const UploadAccessFieldSchema = z.union([
  z.object({ everyone: z.literal(true) }).strict(),
  z.object({ groupIds: z.array(z.string().uuid()).min(1).max(UPLOAD_ACCESS_MAX_GROUPS) }).strict(),
]);

export type UploadAccessField = z.infer<typeof UploadAccessFieldSchema>;

export type ParsedUploadAccessField = { ok: true; choice: UploadAccessChoice } | { ok: false };

/**
 * Reads the access field of a multipart form (a JSON string) or of a JSON body (an object). Absent, null or an empty string is the
 * untouched choice. Principal keys (all, g:…, u:…) are never accepted: groupIds must be UUIDs, and no other property is allowed.
 */
export function parseUploadAccessField(raw: unknown): ParsedUploadAccessField {
  if (raw === undefined || raw === null || raw === '') return { ok: true, choice: null };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > FIELD_MAX_LENGTH) return { ok: false };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false };
    }
  } else if (typeof raw !== 'object' || Array.isArray(raw) || (typeof Blob !== 'undefined' && raw instanceof Blob)) {
    return { ok: false };
  }
  const parsed = UploadAccessFieldSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  return { ok: true, choice: 'everyone' in parsed.data ? { everyone: true } : { groupIds: parsed.data.groupIds.map((id) => id.toLowerCase()) } };
}

export type UploadAccessCheck =
  | { ok: true; keys: string[] | null }
  | { ok: false; status: 400; error: 'invalid_access' | 'group_not_allowed' }
  | { ok: false; status: 503; error: 'access_unavailable' };

export interface CheckUploadAccessInput {
  /** The upload's tenant scope, resolved by the route from the verified session. */
  scope: TenantScope;
  raw: unknown;
  /** The verified session user; never a body value. */
  uploaderId: string;
  signal: AbortSignal;
  /** Test seam. */
  resolve?: typeof resolveAccessScope;
}

/**
 * D-16: the label an upload asks for, checked against the uploader's own access (a non-admin names only their groups, an admin any group of
 * the tenant) before anything is stored. Untouched resolves nothing; everyone needs no lookup. With RAG_DOC_ACCESS_GROUPS=off a group choice
 * is group_not_allowed (uploadAccessKeys, plan 07): the picker is not shown then.
 */
export async function checkUploadAccess(input: CheckUploadAccessInput): Promise<UploadAccessCheck> {
  const parsed = parseUploadAccessField(input.raw);
  if (!parsed.ok) {
    console.warn('[RAG Access] upload access refused', { reason: 'invalid_access' });
    return { ok: false, status: 400, error: 'invalid_access' };
  }
  const choice = parsed.choice;
  if (choice === null) return { ok: true, keys: null };
  if ('everyone' in choice) return { ok: true, keys: ['all'] };
  const resolved = await (input.resolve ?? resolveAccessScope)({
    scope: input.scope,
    identity: { kind: 'user', userId: input.uploaderId },
    signal: input.signal,
  });
  if (!resolved.ok) {
    console.warn('[RAG Access] upload access refused', { reason: resolved.reason });
    return { ok: false, status: 503, error: 'access_unavailable' };
  }
  const result = uploadAccessKeys(resolved.scope, choice);
  if (!result.ok) {
    console.warn('[RAG Access] upload access refused', { reason: result.reason, groups: choice.groupIds.length });
    return { ok: false, status: 400, error: 'group_not_allowed' };
  }
  return { ok: true, keys: result.keys };
}

export type GroupKeysResult = { ok: true; keys: string[] } | { ok: false; reason: 'invalid_key' | 'unknown_group'; key: string };

/**
 * Backfill --access-groups: the access keys (g:<id>) of the named group keys of this tenant, sorted. An empty list is everyone (['all']).
 * The first key that is malformed or names no group of the tenant is returned so the CLI can name it.
 */
export async function accessKeysForGroupKeys(scope: TenantScope, groupKeys: readonly string[], deps: AccessServiceDeps): Promise<GroupKeysResult> {
  const tenantKey = tenantKeyOf(scope);
  if (groupKeys.length === 0) return { ok: true, keys: ['all'] };
  const keys = new Set<string>();
  for (const raw of groupKeys) {
    const key = raw.trim().toLowerCase();
    if (!ACCESS_GROUP_KEY_RE.test(key) || key === 'all') return { ok: false, reason: 'invalid_key', key: raw };
    const rows = await callAccessRows(deps, 'rag_access_group_by_key', { p_tenant_key: tenantKey, p_key: key });
    const id = rows[0] ? text(rows[0], 'id') : null;
    if (!id) return { ok: false, reason: 'unknown_group', key: raw };
    keys.add(`g:${id.toLowerCase()}`);
  }
  return { ok: true, keys: [...keys].sort() };
}

