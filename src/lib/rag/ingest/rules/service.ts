import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { checkTenantLinePattern, type TenantLineFindingCode } from '../../patterns/tenant-line-pattern';
import {
  BoilerplateRuleSchema,
  SectionRuleSetSchema,
  type BoilerplateRule,
  type SectionRuleSet,
} from '@/lib/rag-eval/contracts.generated';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import { INGEST_SOURCES } from '../types';
import { invalidateTenantRules } from './load';

/**
 * Admin service for tenant section rule sets and boilerplate rules (TPL-01, TPL-02, TPL-08; D-11, D-12, D-18). Every call names the actor
 * the route guard verified and the tenant key it admitted; the 1002 functions check the actor again (rag_upload_approval_keys). Before any
 * write the payload is parsed with the generated contract, the limits are repeated and every pattern passes the save-time check of
 * tenant-line-pattern (static rules and the time-boxed probe in the worker). Nothing here compiles or runs a pattern. Only the fixed reason
 * words leave this module, never a database message; logs carry rpc names and codes only.
 */

export const RULE_FAILURE_REASONS = [
  'not_admin',
  'not_found',
  'limit_reached',
  'name_exists',
  'invalid_tenant_pattern',
  'invalid_argument',
  'unavailable',
] as const;
export type RuleFailureReason = (typeof RULE_FAILURE_REASONS)[number];

export const RULE_LIMIT_NAMES = ['rule_sets', 'boilerplate_rules', 'heading_patterns', 'binding'] as const;
export type RuleLimitName = (typeof RULE_LIMIT_NAMES)[number];

/** D-12 limits, also enforced in SQL (1002) and by the generated contracts. */
export const TENANT_RULE_LIMITS = {
  maxRuleSets: 10,
  maxBoilerplateRules: 40,
  maxHeadingPatterns: 60,
  maxNameLength: 80,
  maxPatternLength: 200,
} as const;

export type RuleFailure =
  | { ok: false; reason: Exclude<RuleFailureReason, 'limit_reached' | 'invalid_tenant_pattern'> }
  | { ok: false; reason: 'limit_reached'; limit: RuleLimitName | null }
  | { ok: false; reason: 'invalid_tenant_pattern'; patternIndex: number; findings: TenantLineFindingCode[] };

export interface RuleAdminInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export interface StoredSectionRuleSet {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  ruleSet: SectionRuleSet;
}

export interface StoredBoilerplateRule {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  rule: BoilerplateRule;
}

export type ListSectionRuleSetsResult = { ok: true; items: StoredSectionRuleSet[] } | RuleFailure;
export type SectionRuleSetResult = { ok: true; item: StoredSectionRuleSet } | RuleFailure;
export type ListBoilerplateRulesResult = { ok: true; items: StoredBoilerplateRule[] } | RuleFailure;
export type BoilerplateRuleResult = { ok: true; item: StoredBoilerplateRule } | RuleFailure;
export type DeleteRuleResult = { ok: true; id: string } | RuleFailure;

type EffectiveSwitches = { pipeline: string; sectionRules?: string; pageBoilerplate?: string };

/** RAG_SECTION_RULES as the effective ingest configuration has it: on, and the unified pipeline it needs. */
export function sectionRulesEnabled(): boolean {
  const config = currentIngestConfig() as EffectiveSwitches;
  return config.pipeline === 'unified' && config.sectionRules === 'on';
}

/** RAG_PAGE_BOILERPLATE as the effective ingest configuration has it: any mode but off, and the unified pipeline it needs. */
export function pageBoilerplateEnabled(): boolean {
  const config = currentIngestConfig() as EffectiveSwitches;
  return config.pipeline === 'unified' && typeof config.pageBoilerplate === 'string' && config.pageBoilerplate !== 'off';
}

const LOG = '[RAG Admin]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SQL_WORDS = new Set<RuleFailureReason>(['not_admin', 'not_found', 'limit_reached', 'name_exists']);

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | RuleFailure;

function failureOf(message: string | undefined, code: string | undefined, details: string | undefined): RuleFailure {
  const word = /^[a-z_]+/.exec(message ?? '')?.[0] as RuleFailureReason | undefined;
  if (word === 'limit_reached') {
    const limit = (RULE_LIMIT_NAMES as readonly string[]).includes(details ?? '') ? (details as RuleLimitName) : null;
    return { ok: false, reason: 'limit_reached', limit };
  }
  if (word !== undefined && SQL_WORDS.has(word)) return { ok: false, reason: word as 'not_admin' | 'not_found' | 'name_exists' };
  if (code === '22023') return { ok: false, reason: 'invalid_argument' };
  return { ok: false, reason: 'unavailable' };
}

async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const error = response.error as { message?: string; code?: string; details?: string };
      const failure = failureOf(error.message, error.code, error.details);
      if (failure.reason === 'unavailable') console.error(`${LOG} tenant rule call failed`, { rpc, code: error.code ?? null });
      return failure;
    }
    return { ok: true, rows: rpcRows(response.data) as Row[] };
  } catch (error) {
    console.error(`${LOG} tenant rule call failed`, { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function validInput(input: RuleAdminInput): boolean {
  return typeof input.actorUserId === 'string' && UUID.test(input.actorUserId) && typeof input.tenantKey === 'string' && TENANT_KEY.test(input.tenantKey);
}

function validSource(source: string | undefined): boolean {
  return source === undefined || (INGEST_SOURCES as readonly string[]).includes(source);
}

function timeOf(value: unknown): string | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function nonNull(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const key of keys) if (row[key] !== null && row[key] !== undefined) out[key] = row[key];
  return out;
}

function storedSectionRuleSetOf(row: Row): StoredSectionRuleSet | null {
  const rules = row.rules;
  const createdAt = timeOf(row.created_at);
  const updatedAt = timeOf(row.updated_at);
  if (typeof row.id !== 'string' || typeof row.version !== 'number' || createdAt === null || updatedAt === null) return null;
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) return null;
  const parsed = SectionRuleSetSchema.safeParse({ ...nonNull(row, ['name', 'doc_type', 'source', 'enabled']), ...(rules as Row) });
  return parsed.success ? { id: row.id, version: row.version, createdAt, updatedAt, ruleSet: parsed.data } : null;
}

function storedBoilerplateRuleOf(row: Row): StoredBoilerplateRule | null {
  const createdAt = timeOf(row.created_at);
  const updatedAt = timeOf(row.updated_at);
  if (typeof row.id !== 'string' || typeof row.version !== 'number' || createdAt === null || updatedAt === null) return null;
  const parsed = BoilerplateRuleSchema.safeParse(
    nonNull(row, ['name', 'kind', 'pattern', 'flags', 'max_length', 'min_page_share', 'doc_type', 'source', 'enabled']),
  );
  return parsed.success ? { id: row.id, version: row.version, createdAt, updatedAt, rule: parsed.data } : null;
}

function many<T>(result: Call, map: (_row: Row) => T | null): { ok: true; items: T[] } | RuleFailure {
  if (!result.ok) return result;
  const items: T[] = [];
  for (const row of result.rows) {
    const item = map(row);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  return { ok: true, items };
}

function one<T>(result: Call, map: (_row: Row) => T | null): { ok: true; item: T } | RuleFailure {
  if (!result.ok) return result;
  const item = result.rows.length === 1 ? map(result.rows[0] as Row) : null;
  return item === null ? { ok: false, reason: 'unavailable' } : { ok: true, item };
}

function deleted(result: Call): DeleteRuleResult {
  if (!result.ok) return result;
  const first = result.rows[0];
  const id = typeof first === 'string' ? first : first && typeof first === 'object' ? Object.values(first)[0] : null;
  return typeof id === 'string' && UUID.test(id) ? { ok: true, id } : { ok: false, reason: 'unavailable' };
}

function headingCount(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const headings = (value as Row).headings;
  return Array.isArray(headings) ? headings.length : null;
}

function actorArgs(input: RuleAdminInput): { p_actor: string; p_tenant_key: string } {
  return { p_actor: input.actorUserId.toLowerCase(), p_tenant_key: input.tenantKey };
}

function afterWrite<T extends { ok: boolean }>(input: RuleAdminInput, result: T): T {
  if (result.ok) invalidateTenantRules(input.tenantKey);
  return result;
}

// --- Section rule sets ---------------------------------------------------------------------------------------------------------------

/** The tenant's rule sets in creation order; a non-admin actor gets an empty list. */
export async function listSectionRuleSets(input: RuleAdminInput): Promise<ListSectionRuleSetsResult> {
  if (!validInput(input)) return { ok: false, reason: 'invalid_argument' };
  return many(await call('rag_section_rule_sets_list', actorArgs(input), input.signal), storedSectionRuleSetOf);
}

/**
 * Creates a rule set, or replaces the one with the given id (its version rises by one). Order: shape and limits, every heading pattern
 * through the save-time check, then the rpc; a refused pattern makes no rpc.
 */
export async function saveSectionRuleSet(input: RuleAdminInput, ruleSet: unknown, id?: string): Promise<SectionRuleSetResult> {
  if (!validInput(input) || (id !== undefined && !UUID.test(id))) return { ok: false, reason: 'invalid_argument' };
  const count = headingCount(ruleSet);
  if (count !== null && count > TENANT_RULE_LIMITS.maxHeadingPatterns) return { ok: false, reason: 'limit_reached', limit: 'heading_patterns' };
  const parsed = SectionRuleSetSchema.safeParse(ruleSet);
  if (!parsed.success || !validSource(parsed.data.source)) return { ok: false, reason: 'invalid_argument' };
  const body = parsed.data;
  for (const [index, heading] of body.headings.entries()) {
    const checked = await checkTenantLinePattern('heading', heading.pattern, heading.flags, { signal: input.signal });
    if (!checked.ok) return { ok: false, reason: 'invalid_tenant_pattern', patternIndex: index, findings: checked.findings.map((f) => f.code) };
  }
  const result = one(
    await call('rag_section_rule_set_upsert', { ...actorArgs(input), p_rule_set: body, p_id: id?.toLowerCase() ?? null }, input.signal),
    storedSectionRuleSetOf,
  );
  return afterWrite(input, result);
}

export async function deleteSectionRuleSet(input: RuleAdminInput, id: string): Promise<DeleteRuleResult> {
  if (!validInput(input) || typeof id !== 'string' || !UUID.test(id)) return { ok: false, reason: 'invalid_argument' };
  return afterWrite(input, deleted(await call('rag_section_rule_set_delete', { ...actorArgs(input), p_id: id.toLowerCase() }, input.signal)));
}

// --- Boilerplate rules ---------------------------------------------------------------------------------------------------------------

/** The tenant's boilerplate rules in creation order; a non-admin actor gets an empty list. */
export async function listBoilerplateRules(input: RuleAdminInput): Promise<ListBoilerplateRulesResult> {
  if (!validInput(input)) return { ok: false, reason: 'invalid_argument' };
  return many(await call('rag_boilerplate_rules_list', actorArgs(input), input.signal), storedBoilerplateRuleOf);
}

function shapeOk(rule: BoilerplateRule): boolean {
  if (rule.kind === 'line') return rule.pattern !== undefined && rule.flags !== undefined && rule.max_length === undefined && rule.min_page_share === undefined;
  return rule.pattern === undefined && rule.flags === undefined && rule.max_length !== undefined && rule.min_page_share !== undefined;
}

/** Creates a rule, or replaces the one with the given id. A line rule's pattern passes the save-time check first; a fragment rule has none. */
export async function saveBoilerplateRule(input: RuleAdminInput, rule: unknown, id?: string): Promise<BoilerplateRuleResult> {
  if (!validInput(input) || (id !== undefined && !UUID.test(id))) return { ok: false, reason: 'invalid_argument' };
  const parsed = BoilerplateRuleSchema.safeParse(rule);
  if (!parsed.success || !shapeOk(parsed.data) || !validSource(parsed.data.source)) return { ok: false, reason: 'invalid_argument' };
  const body = parsed.data;
  if (body.kind === 'line' && body.pattern !== undefined && body.flags !== undefined) {
    const checked = await checkTenantLinePattern('boilerplate_line', body.pattern, body.flags, { signal: input.signal });
    if (!checked.ok) return { ok: false, reason: 'invalid_tenant_pattern', patternIndex: 0, findings: checked.findings.map((f) => f.code) };
  }
  const result = one(
    await call('rag_boilerplate_rule_upsert', { ...actorArgs(input), p_rule: body, p_id: id?.toLowerCase() ?? null }, input.signal),
    storedBoilerplateRuleOf,
  );
  return afterWrite(input, result);
}

export async function deleteBoilerplateRule(input: RuleAdminInput, id: string): Promise<DeleteRuleResult> {
  if (!validInput(input) || typeof id !== 'string' || !UUID.test(id)) return { ok: false, reason: 'invalid_argument' };
  return afterWrite(input, deleted(await call('rag_boilerplate_rule_delete', { ...actorArgs(input), p_id: id.toLowerCase() }, input.signal)));
}
