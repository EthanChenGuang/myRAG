import { AttributeDefinitionSchema, type AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import { ATTRIBUTE_KEY_PATTERN } from './validate';

/**
 * Attribute definitions per tenant (TPL-03, D-12, D-22): the admin service over the service-role functions of migration 1003 and the
 * per-tenant schema loader the pipeline reads. Admin calls name the actor the route guard verified and the one tenant key it admitted; the
 * SQL functions check the actor again (rag_upload_approval_keys). Only fixed reason words leave this module, never a database message.
 * Logs carry codes only.
 */
export type AttributeType = AttributeDefinition['type'];

const ATTRIBUTE_TYPES: readonly AttributeType[] = ['text', 'text_list', 'code'];

export type AttributeAdminFailure =
  | 'not_admin'
  | 'not_found'
  | 'limit_reached'
  | 'invalid_attribute_type'
  | 'unknown_placeholder'
  | 'invalid_argument'
  | 'unavailable';

export type AttributeAdminError = { ok: false; reason: AttributeAdminFailure };

export interface AttributeAdminInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export interface AttributeDefinitionInput {
  key: string;
  type: AttributeType;
  filterable?: boolean;
  in_header?: boolean;
  in_identifier_index?: boolean;
  soft?: boolean;
}

export type AttributeDefinitionEntry = AttributeDefinition & { updatedAt: string };

export type ListAttributeDefinitionsResult = { ok: true; items: AttributeDefinitionEntry[] } | AttributeAdminError;
export type UpsertAttributeDefinitionResult = { ok: true; item: AttributeDefinitionEntry } | AttributeAdminError;
export type DeleteAttributeDefinitionResult = { ok: true; key: string } | AttributeAdminError;

export interface LoadAttributeSchemaOptions {
  signal: AbortSignal;
  /** Bypasses the cache (the import command reads the schema it validates against fresh). */
  fresh?: boolean;
}

export type LoadAttributeSchemaResult = { ok: true; definitions: readonly AttributeDefinition[] } | { ok: false; reason: 'unavailable' };

/** RAG_DOC_ATTRIBUTES, effective: true only under the unified pipeline with the switch on (plan 03.3-02). */
export function docAttributesEnabled(config: IngestConfig = currentIngestConfig()): boolean {
  return config.docAttributes;
}

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | AttributeAdminError;

const LOG_ADMIN = '[RAG Admin]';
const LOG_INGEST = '[Ingest]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SQL_REASONS = new Set<AttributeAdminFailure>([
  'not_admin',
  'not_found',
  'limit_reached',
  'invalid_attribute_type',
  'unknown_placeholder',
  'invalid_argument',
]);

function failureOf(message: string | undefined): AttributeAdminError {
  const word = /^[a-z_]+(?=$|[^a-z_])/.exec(message ?? '')?.[0] as AttributeAdminFailure | undefined;
  return { ok: false, reason: word !== undefined && SQL_REASONS.has(word) ? word : 'unavailable' };
}

const invalidArgument: AttributeAdminError = { ok: false, reason: 'invalid_argument' };

async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const failure = failureOf(response.error.message);
      if (failure.reason === 'unavailable') console.error(`${LOG_ADMIN} attribute definition call failed`, { rpc, code: response.error.code ?? null });
      return failure;
    }
    return { ok: true, rows: rpcRows(response.data) as Row[] };
  } catch (error) {
    console.error(`${LOG_ADMIN} attribute definition call failed`, { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function normalizedInput(input: AttributeAdminInput): { actor: string; tenantKey: string } | null {
  if (typeof input.actorUserId !== 'string' || typeof input.tenantKey !== 'string') return null;
  const actor = input.actorUserId.toLowerCase();
  const tenantKey = input.tenantKey.toLowerCase();
  return UUID.test(actor) && TENANT_KEY.test(tenantKey) ? { actor, tenantKey } : null;
}

function definitionOf(row: Row): AttributeDefinition | null {
  const parsed = AttributeDefinitionSchema.safeParse({
    key: row.key,
    type: row.type,
    filterable: row.filterable,
    in_header: row.in_header,
    in_identifier_index: row.in_identifier_index,
    soft: row.soft,
  });
  if (!parsed.success) return null;
  for (const flag of ['filterable', 'in_header', 'in_identifier_index', 'soft'] as const) if (typeof row[flag] !== 'boolean') return null;
  return parsed.data;
}

function entryOf(row: Row): AttributeDefinitionEntry | null {
  const definition = definitionOf(row);
  const raw = row.updated_at;
  const time = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
  if (definition === null || time === null || Number.isNaN(time.getTime())) return null;
  return { ...definition, updatedAt: time.toISOString() };
}

function malformed(rpc: string): AttributeAdminError {
  console.error(`${LOG_ADMIN} attribute definition row malformed`, { rpc });
  return { ok: false, reason: 'unavailable' };
}

/** Every definition of the admitted tenant in key order; a non-admin actor gets an empty list from SQL. */
export async function listAttributeDefinitions(input: AttributeAdminInput): Promise<ListAttributeDefinitionsResult> {
  const scope = normalizedInput(input);
  if (!scope) return invalidArgument;
  const result = await call('rag_attribute_definitions_list', { p_actor: scope.actor, p_tenant_key: scope.tenantKey }, input.signal);
  if (!result.ok) return result;
  const items: AttributeDefinitionEntry[] = [];
  for (const row of result.rows) {
    const entry = entryOf(row);
    if (entry === null) return malformed('rag_attribute_definitions_list');
    items.push(entry);
  }
  return { ok: true, items };
}

/** Creates a key or changes its flags; the type of a stored key never changes. */
export async function upsertAttributeDefinition(input: AttributeAdminInput, definition: AttributeDefinitionInput): Promise<UpsertAttributeDefinitionResult> {
  const scope = normalizedInput(input);
  if (!scope || typeof definition !== 'object' || definition === null) return invalidArgument;
  const { key, type } = definition;
  if (typeof key !== 'string' || !ATTRIBUTE_KEY_PATTERN.test(key)) return invalidArgument;
  if (typeof type !== 'string' || !ATTRIBUTE_TYPES.includes(type)) return invalidArgument;
  const flags = {
    filterable: definition.filterable ?? false,
    in_header: definition.in_header ?? false,
    in_identifier_index: definition.in_identifier_index ?? false,
    soft: definition.soft ?? false,
  };
  if (Object.values(flags).some((flag) => typeof flag !== 'boolean')) return invalidArgument;
  if (flags.in_identifier_index && type !== 'code') return { ok: false, reason: 'invalid_attribute_type' };
  const result = await call(
    'rag_attribute_definition_upsert',
    {
      p_actor: scope.actor,
      p_tenant_key: scope.tenantKey,
      p_key: key,
      p_type: type,
      p_filterable: flags.filterable,
      p_in_header: flags.in_header,
      p_in_identifier_index: flags.in_identifier_index,
      p_soft: flags.soft,
    },
    input.signal,
  );
  if (!result.ok) return result;
  invalidate(scope.tenantKey);
  const entry = result.rows.length === 1 ? entryOf(result.rows[0] as Row) : null;
  return entry === null ? malformed('rag_attribute_definition_upsert') : { ok: true, item: entry };
}

/** Removes one key. Values stored on documents under it stay until an import replaces them; readers use only loaded keys. */
export async function deleteAttributeDefinition(input: AttributeAdminInput, key: string): Promise<DeleteAttributeDefinitionResult> {
  const scope = normalizedInput(input);
  if (!scope || typeof key !== 'string' || !ATTRIBUTE_KEY_PATTERN.test(key)) return invalidArgument;
  const result = await call('rag_attribute_definition_delete', { p_actor: scope.actor, p_tenant_key: scope.tenantKey, p_key: key }, input.signal);
  if (!result.ok) return result;
  invalidate(scope.tenantKey);
  const deleted = result.rows[0];
  return typeof deleted === 'string' && deleted === key ? { ok: true, key } : malformed('rag_attribute_definition_delete');
}

// --- Per-tenant schema cache ---------------------------------------------------------------------------------------------------------

const CACHE_MAX_TENANTS = 256;
const CACHE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 5_000;

interface CacheEntry {
  value: LoadAttributeSchemaResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const generations = new Map<string, number>();
const UNAVAILABLE: LoadAttributeSchemaResult = Object.freeze({ ok: false, reason: 'unavailable' }) as LoadAttributeSchemaResult;

function invalidate(tenantKey: string): void {
  cache.delete(tenantKey);
  generations.set(tenantKey, (generations.get(tenantKey) ?? 0) + 1);
}

function store(tenantKey: string, entry: CacheEntry): void {
  cache.delete(tenantKey);
  cache.set(tenantKey, entry);
  while (cache.size > CACHE_MAX_TENANTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function resetAttributeSchemaCacheForTests(): void {
  cache.clear();
  generations.clear();
}

async function readSchema(tenantKey: string, signal: AbortSignal): Promise<LoadAttributeSchemaResult> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return UNAVAILABLE;
  try {
    signal.throwIfAborted();
    const response = await db.rpc('rag_attribute_definitions_for', { p_tenant_key: tenantKey }).abortSignal(signal);
    if (response.error) {
      console.error(`${LOG_INGEST} attribute schema read failed`, { code: response.error.code ?? null });
      return UNAVAILABLE;
    }
    const definitions: AttributeDefinition[] = [];
    for (const row of rpcRows(response.data) as Row[]) {
      const definition = typeof row === 'object' && row !== null ? definitionOf(row) : null;
      if (definition === null) {
        console.error(`${LOG_INGEST} attribute schema row malformed`);
        return UNAVAILABLE;
      }
      definitions.push(Object.freeze(definition));
    }
    return Object.freeze({ ok: true, definitions: Object.freeze(definitions) }) as LoadAttributeSchemaResult;
  } catch (error) {
    console.error(`${LOG_INGEST} attribute schema read failed`, { error: error instanceof Error ? error.name : 'unknown' });
    return UNAVAILABLE;
  }
}

/**
 * The tenant's attribute definitions, from a least-recently-used map keyed by the tenant key only (256 tenants, 60 s; 5 s after a failed
 * load). An entry loaded for one tenant is never served to another; writers invalidate only their tenant's entry.
 */
export async function loadAttributeSchema(scope: TenantScope, options: LoadAttributeSchemaOptions): Promise<LoadAttributeSchemaResult> {
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope).toLowerCase();
  const now = getIngestDeps().now();
  if (options.fresh !== true) {
    const hit = cache.get(tenantKey);
    if (hit && hit.expiresAt > now) {
      cache.delete(tenantKey);
      cache.set(tenantKey, hit);
      return hit.value;
    }
  }
  const generation = generations.get(tenantKey) ?? 0;
  const value = await readSchema(tenantKey, options.signal);
  if (options.signal.aborted) return value;
  if ((generations.get(tenantKey) ?? 0) === generation) {
    store(tenantKey, { value, expiresAt: now + (value.ok ? CACHE_TTL_MS : FAILURE_TTL_MS) });
  }
  return value;
}
