import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import type { MonitorAlert } from '@/lib/rag-eval/contracts.generated';
import type { BackfillSourceDeps } from '../ingest/backfill/sources';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface MonitorCliDeps {
  env?: Record<string, string | undefined>;
  createClient?: (url: string, key: string) => SupabaseClient;
  fetch?: typeof fetch;
  lookupHost?: BackfillSourceDeps['lookupHost'];
  now?: Date;
}

export type ParsedMonitorArgs =
  | { command: 'daily' }
  | { command: 'record-change'; keys: string[]; reason: string; beforeHash?: string; afterHash?: string }
  | { command: 'test-alert'; tenant: string }
  | { command: 'invalid'; message: string };

export const USAGE = [
  'usage: npm run rag:monitor [-- daily]',
  '       npm run rag:monitor -- record-change --keys <NAME,NAME> --reason <text> [--before-hash <sha256>] [--after-hash <sha256>]',
  '       npm run rag:monitor -- test-alert --tenant <tenant key>',
  '  daily          aggregate the retrieval log, evaluate the alert rules and deliver new and pending alerts (default)',
  '  record-change  record a setting change made in the host environment (names only; reason 10 to 500 characters)',
  '  test-alert     deliver a synthetic alert with neutral ids through the configured channels; nothing is stored',
].join('\n');

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TENANT_KEY_RE = /^(?:s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_KEYS = 64;
const REASON_MIN = 10;
const REASON_MAX = 500;
const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const PREFIX = '[Monitor]';

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function invalid(message: string): ParsedMonitorArgs {
  return { command: 'invalid', message };
}

/** Each option at most once, with a value; null when anything else is given. */
function options(args: string[], allowed: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || value === undefined || out.has(flag)) return null;
    out.set(flag, value);
  }
  return out;
}

export function parseMonitorArgs(argv: string[]): ParsedMonitorArgs {
  const [command = 'daily', ...rest] = argv;
  if (command === 'daily') return rest.length === 0 ? { command: 'daily' } : invalid('daily takes no option');
  if (command === 'test-alert') {
    const opts = options(rest, ['--tenant']);
    const tenant = opts?.get('--tenant');
    if (!opts || tenant === undefined) return invalid('test-alert takes --tenant <tenant key>');
    if (!TENANT_KEY_RE.test(tenant)) return invalid('--tenant must be s:default, u:<uuid> or o:<uuid>');
    return { command: 'test-alert', tenant };
  }
  if (command === 'record-change') {
    const opts = options(rest, ['--keys', '--reason', '--before-hash', '--after-hash']);
    if (!opts || !opts.has('--keys') || !opts.has('--reason')) return invalid('record-change takes --keys and --reason');
    const keys = [...new Set(opts.get('--keys')!.split(',').map((key) => key.trim()).filter((key) => key !== ''))];
    if (keys.length === 0 || keys.length > MAX_KEYS || !keys.every((key) => ENV_NAME_RE.test(key))) {
      return invalid(`--keys must be 1 to ${MAX_KEYS} environment variable names, comma-separated`);
    }
    const reason = opts.get('--reason')!.trim();
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) return invalid(`--reason must be ${REASON_MIN} to ${REASON_MAX} characters`);
    const beforeHash = opts.get('--before-hash');
    const afterHash = opts.get('--after-hash');
    for (const hash of [beforeHash, afterHash]) {
      if (hash !== undefined && !SHA256_RE.test(hash)) return invalid('--before-hash and --after-hash must be sha256 hex strings');
    }
    return { command: 'record-change', keys, reason, ...(beforeHash ? { beforeHash } : {}), ...(afterHash ? { afterHash } : {}) };
  }
  return invalid('unknown subcommand');
}

function serviceClient(url: string, key: string): SupabaseClient {
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function clientFor(env: Record<string, string | undefined>, deps: MonitorCliDeps, io: CliIo): SupabaseClient | null {
  const missing = REQUIRED_ENV.filter((name) => (env[name]?.trim() ?? '') === '');
  if (missing.length > 0) {
    io.err(`${PREFIX} set ${missing.join(' and ')} to run with the service role`);
    return null;
  }
  return (deps.createClient ?? serviceClient)(env.NEXT_PUBLIC_SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim());
}

function counts(label: string, c: Record<string, number>): string {
  return `${label} delivered ${c.delivered ?? 0}, failed ${c.failed ?? 0}, pending ${c.pending ?? 0}, disabled ${c.disabled ?? 0}`;
}

async function daily(env: Record<string, string | undefined>, deps: MonitorCliDeps, io: CliIo): Promise<number> {
  const client = clientFor(env, deps, io);
  if (!client) return 2;
  const { runDaily } = await import('./daily');
  const { deliverStoredAlerts } = await import('./deliver');
  const { monitorSettings } = await import('./config');
  const { readLangfuseConfig } = await import('../trace/config');
  const now = deps.now ?? new Date();
  try {
    const result = await runDaily(client, { source: 'cli', env, now });
    if (!result.ran) {
      if (result.reason === 'log_off') {
        io.out(`${PREFIX} the retrieval log is off (RAG_RETRIEVAL_LOG); nothing to monitor`);
        return 0;
      }
      if (result.reason === 'switched_off') {
        io.out(`${PREFIX} RAG_MONITOR is off; nothing to do`);
        return 0;
      }
      io.err(`${PREFIX} eval/config/monitor-alerts.json is not valid; nothing was run`);
      return 1;
    }
    io.out(
      `${PREFIX} daily ${result.day}: days_aggregated ${result.daysAggregated}, groups_checked ${result.groupsChecked}, alerts_opened ${result.alertsOpened}, alerts_updated ${result.alertsUpdated}, alerts_suppressed ${result.alertsSuppressed}`,
    );
    const delivery = await deliverStoredAlerts(client, {
      settings: monitorSettings(env),
      langfuse: readLangfuseConfig(env),
      fetch: deps.fetch,
      lookupHost: deps.lookupHost,
      now,
    });
    io.out(`${PREFIX} delivery: alerts ${delivery.alerts}, banner ${delivery.banner}`);
    io.out(`${PREFIX} ${counts('webhook', delivery.channels.webhook)}`);
    io.out(`${PREFIX} ${counts('langfuse', delivery.channels.langfuse)}`);
    if (delivery.writeFailures > 0) {
      io.err(`${PREFIX} ${delivery.writeFailures} delivery states were not stored; the next run retries them`);
      return 1;
    }
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const operation = (error as { operation?: unknown } | null)?.operation;
    io.err(`${PREFIX} daily run failed${typeof operation === 'string' ? ` (${operation}${typeof code === 'string' ? ` ${code}` : ''})` : ''}`);
    return 1;
  }
}

async function recordChange(
  parsed: Extract<ParsedMonitorArgs, { command: 'record-change' }>,
  env: Record<string, string | undefined>,
  deps: MonitorCliDeps,
  io: CliIo,
): Promise<number> {
  const client = clientFor(env, deps, io);
  if (!client) return 2;
  const { buildChangeRecord, insertChangeRecord } = await import('../config-gate/gate-core');
  const { RAG_AFFECTING_NAMES, ragSettingsHash } = await import('../config-gate/settings-hash');
  const current = ragSettingsHash(env, RAG_AFFECTING_NAMES);
  const row = buildChangeRecord({
    actor: 'cli',
    source: 'cli',
    gateResult: 'skipped',
    changedKeys: parsed.keys,
    beforeHash: parsed.beforeHash ?? current,
    afterHash: parsed.afterHash ?? current,
    overrideReason: parsed.reason,
  });
  const inserted = await insertChangeRecord(client, row);
  if (!inserted.ok) {
    io.err(`${PREFIX} the change record could not be written`);
    return 1;
  }
  io.out(`${PREFIX} change recorded ${inserted.id}: keys ${row.changed_keys.length}`);
  return 0;
}

function yesterday(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** A synthetic alert with neutral ids and counts; it is delivered but never stored. */
function syntheticAlert(tenant: string, now: Date): MonitorAlert {
  const stamp = now.toISOString();
  return {
    id: randomUUID(),
    tenant_key: tenant,
    rule: 'refusal_rate',
    kind: 'rate',
    language: 'und',
    day: yesterday(now),
    window_days: 1,
    severity: 'warning',
    status: 'open',
    observed: { count: 1, n: 10, value: 0.1 },
    baseline: null,
    band: {
      alert: null,
      budget: null,
      drop: null,
      measured_delta: null,
      measured_ratio: null,
      measured_value: null,
      measured_z: null,
      min_abs_delta: null,
      min_z: null,
      ratio: null,
      warn: null,
    },
    sample_trace_ids: [],
    config_changes: [],
    delivered: {},
    suggestion: null,
    dedup_key: 'test_alert',
    acknowledged_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
}

async function testAlert(
  parsed: Extract<ParsedMonitorArgs, { command: 'test-alert' }>,
  env: Record<string, string | undefined>,
  deps: MonitorCliDeps,
  io: CliIo,
): Promise<number> {
  const { MonitorAlertSchema } = await import('@/lib/rag-eval/contracts.generated');
  const { deliverAlerts } = await import('./deliver');
  const { monitorSettings } = await import('./config');
  const { readLangfuseConfig } = await import('../trace/config');
  const now = deps.now ?? new Date();
  const alert = MonitorAlertSchema.parse(syntheticAlert(parsed.tenant, now));
  const [report] = await deliverAlerts([alert], {
    settings: monitorSettings(env),
    langfuse: readLangfuseConfig(env),
    fetch: deps.fetch,
    lookupHost: deps.lookupHost,
    now,
  });
  io.out(`${PREFIX} test-alert ${alert.id}`);
  io.out(`${PREFIX} banner: not stored (a test alert is never stored)`);
  let failed = false;
  for (const channel of ['webhook', 'langfuse'] as const) {
    const state = report?.delivered[channel]?.state ?? 'disabled';
    if (state === 'failed') failed = true;
    io.out(`${PREFIX} ${channel}: ${state}`);
  }
  return failed ? 1 : 0;
}

/**
 * The rag:monitor CLI (D-16, D-20, D-21). Prints counts, ids and channel outcomes only: never a URL, secret, reason or text.
 * Exit codes: 0 done, 1 the database or a channel failed, 2 the arguments or the environment were wrong. With RAG_MONITOR off,
 * daily and test-alert print one notice and return 0 without a query; record-change records a host change in either case.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: MonitorCliDeps = {}): Promise<number> {
  const parsed = parseMonitorArgs(argv);
  if (parsed.command === 'invalid') {
    io.err(`${PREFIX} ${parsed.message}`);
    io.err(USAGE);
    return 2;
  }
  const env = deps.env ?? process.env;
  if (parsed.command === 'record-change') return recordChange(parsed, env, deps, io);
  if (!monitorOn(env)) {
    io.out(`${PREFIX} RAG_MONITOR is off; nothing to do`);
    return 0;
  }
  if (parsed.command === 'test-alert') return testAlert(parsed, env, deps, io);
  return daily(env, deps, io);
}

/** The RAG_MONITOR rule of monitorSettings, read without loading the app environment module (which needs unrelated keys). */
function monitorOn(env: Record<string, string | undefined>): boolean {
  return (env.RAG_MONITOR ?? '').trim().toLowerCase() === 'true';
}

async function run(argv: string[], io: CliIo): Promise<number> {
  try {
    return await main(argv, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    io.err(/^[A-Z][A-Z0-9_]* is required/.test(message) ? `${PREFIX} ${message.slice(0, 200)}` : `${PREFIX} failed`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  run(process.argv.slice(2), consoleIo).then((code) => process.exit(code));
}
