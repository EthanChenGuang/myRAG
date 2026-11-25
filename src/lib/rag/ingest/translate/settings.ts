import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient } from '../../backend/supabase-rpc';
import { getRagDeps } from '../../deps';
import { getActiveProfile } from '../../embeddings/active-profile';
import { getLanguageSettings } from '../../lang/settings';
import { registryOrder } from '../../lang/registry';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';

/**
 * Per-tenant translation targets (XLG-04, D-28 to D-31, D-50). Every call names the workspace tenant key the route guard admitted; the
 * setter also names the verified actor, and the SQL function checks it again, so the database stays the final authority. Targets are a
 * subset of the deployment's supported languages (D-01); in monolingual mode there is nothing to translate into. Saving never starts a
 * translation run and never calls a model or the embedder (D-29). Only fixed reason words leave this module, never a database message.
 */
export type TranslationSettingsFailure =
  | 'target_not_supported'
  | 'languages_not_configured'
  | 'invalid_targets'
  | 'forbidden'
  | 'invalid_argument'
  | 'unavailable';

export type TranslationSettingsError = { ok: false; reason: TranslationSettingsFailure; detail?: string };

export interface TranslationCoverageRow {
  language: string;
  /** Eligible chunks whose translation matches the current source text. */
  done: number;
  /** Eligible chunks for this target. */
  total: number;
  /** Chunks skipped because a protected token was lost (D-29); null until the producer records gaps. */
  gaps: number | null;
}

export interface TranslationSettingsView {
  tenantKey: string;
  enabled: boolean;
  targets: string[];
  supportedLanguages: string[];
  languagesConfigured: boolean;
  monolingual: boolean;
  coverage: TranslationCoverageRow[];
  /** True when the active embedding profile lacks vectors for some translations (D-28); null when it cannot be read. */
  stale: boolean | null;
  deploymentSwitch: 'off' | 'on';
  updatedAt: string | null;
}

export type TranslationSettingsResult = { ok: true; settings: TranslationSettingsView } | TranslationSettingsError;
export type TranslationCoverageResult = { ok: true; coverage: TranslationCoverageRow[] } | TranslationSettingsError;

export interface TranslationScopeInput {
  tenantKey: string;
  signal: AbortSignal;
}

export interface SetTranslationSettingsInput extends TranslationScopeInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  enabled: boolean;
  targets: readonly string[];
}

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | TranslationSettingsError;
type CountClient = Pick<SupabaseClient, 'from'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const MAX_TRANSLATION_TARGETS = 16;

async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      if (response.error.code === '42501' || /^not_admin\b/.test(response.error.message ?? '')) return { ok: false, reason: 'forbidden' };
      if (/^translation_settings_refused: invalid_targets/.test(response.error.message ?? '')) return { ok: false, reason: 'invalid_targets' };
      console.error('[Translation] settings call failed', { rpc, code: response.error.code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, rows: (Array.isArray(response.data) ? response.data : []) as Row[] };
  } catch (error) {
    console.error('[Translation] settings call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function timeOf(value: unknown): string | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function codes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : [];
}

/** The supported languages in registry order, and whether the deployment can translate at all. */
function supportedSet(): { configured: boolean; monolingual: boolean; languages: string[] } {
  const settings = getLanguageSettings();
  const languages = settings.configured ? registryOrder(settings.languages ?? []) : [];
  return { configured: settings.configured && languages.length > 0, monolingual: settings.monolingual || languages.length === 1, languages };
}

/**
 * D-01 and D-31: the targets to store, de-duplicated and in registry order, or the refusal. Any target needs configured languages; in
 * monolingual mode no target is allowed; every target must be a supported language; enabling needs at least one target.
 */
export function validateTranslationTargets(
  enabled: boolean,
  targets: readonly string[],
): { ok: true; targets: string[] } | TranslationSettingsError {
  const supported = supportedSet();
  const unique = [...new Set(targets)];
  if (unique.length > 0 && !supported.configured) return { ok: false, reason: 'languages_not_configured' };
  if (unique.length > 0 && supported.monolingual) return { ok: false, reason: 'target_not_supported', detail: 'monolingual' };
  const allowed = new Set(supported.languages);
  const outside = unique.filter((code) => !allowed.has(code));
  if (outside.length > 0) return { ok: false, reason: 'target_not_supported' };
  const ordered = registryOrder(unique);
  if (enabled && ordered.length === 0) return { ok: false, reason: 'invalid_argument', detail: 'enabled_without_targets' };
  return { ok: true, targets: ordered };
}

function adminCounts(): CountClient | null {
  try {
    return getRagDeps().adminClient() as CountClient | null;
  } catch {
    return null;
  }
}

async function headCount(client: CountClient, table: string, filters: Record<string, string>, signal: AbortSignal): Promise<number | null> {
  let builder = client.from(table).select('*', { count: 'exact', head: true });
  for (const [column, value] of Object.entries(filters)) builder = builder.eq(column, value);
  const { count: total, error } = await builder.abortSignal(signal);
  return error || typeof total !== 'number' ? null : total;
}

/** D-28: translations are embedded with the active global profile only, so after a flip some lack a vector until re-embedded. */
async function translationsStale(tenantKey: string, signal: AbortSignal): Promise<boolean | null> {
  const client = adminCounts();
  if (!client) return null;
  try {
    const translations = await headCount(client, 'chunk_translations', { tenant_key: tenantKey }, signal);
    if (translations === null) return null;
    if (translations === 0) return false;
    const profile = await getActiveProfile();
    const embedded = await headCount(client, 'chunk_translation_embeddings', { tenant_key: tenantKey, profile_id: profile.id }, signal);
    return embedded === null ? null : embedded < translations;
  } catch (error) {
    console.error('[Translation] stale check failed', { error: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}

/** Per saved target: eligible chunks, those with an up-to-date translation, in the order the targets are stored. */
export async function translationCoverage(input: TranslationScopeInput): Promise<TranslationCoverageResult> {
  if (!TENANT_KEY.test(input.tenantKey)) return { ok: false, reason: 'invalid_argument' };
  const result = await call('rag_translation_coverage', { p_tenant_key: input.tenantKey }, input.signal);
  if (!result.ok) return result;
  return {
    ok: true,
    coverage: result.rows
      .filter((row) => typeof row.language === 'string')
      .map((row) => ({ language: String(row.language), done: count(row.translated), total: count(row.eligible), gaps: null })),
  };
}

async function view(row: Row | undefined, input: TranslationScopeInput): Promise<TranslationSettingsResult> {
  const coverage = await translationCoverage(input);
  if (!coverage.ok) return coverage;
  const supported = supportedSet();
  return {
    ok: true,
    settings: {
      tenantKey: input.tenantKey,
      enabled: row?.enabled === true,
      targets: codes(row?.target_languages),
      supportedLanguages: supported.languages,
      languagesConfigured: supported.configured,
      monolingual: supported.configured && supported.monolingual,
      coverage: coverage.coverage,
      stale: await translationsStale(input.tenantKey, input.signal),
      deploymentSwitch: currentIngestConfig().docTranslation,
      updatedAt: timeOf(row?.updated_at),
    },
  };
}

export async function getTranslationSettings(input: TranslationScopeInput): Promise<TranslationSettingsResult> {
  if (!TENANT_KEY.test(input.tenantKey)) return { ok: false, reason: 'invalid_argument' };
  const result = await call('rag_translation_settings_get', { p_tenant_key: input.tenantKey }, input.signal);
  if (!result.ok) return result;
  return view(result.rows[0], input);
}

/** Validates the targets against the supported set, stores them with the actor, and answers the saved settings. Translates nothing. */
export async function setTranslationSettings(input: SetTranslationSettingsInput): Promise<TranslationSettingsResult> {
  if (!UUID.test(input.actorUserId) || !TENANT_KEY.test(input.tenantKey)) return { ok: false, reason: 'invalid_argument' };
  if (input.targets.length > MAX_TRANSLATION_TARGETS) return { ok: false, reason: 'invalid_argument' };
  const checked = validateTranslationTargets(input.enabled, input.targets);
  if (!checked.ok) return checked;
  const result = await call(
    'rag_translation_settings_set',
    { p_actor: input.actorUserId, p_tenant_key: input.tenantKey, p_targets: checked.targets, p_enabled: input.enabled },
    input.signal,
  );
  if (!result.ok) return result;
  console.log('[Translation] settings saved', { targets: checked.targets.length, enabled: input.enabled });
  return view(result.rows[0], input);
}
