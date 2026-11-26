import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';
import { terminologyGlossary } from '@/lib/rag/terminology/glossary';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import type { TermEntry } from '@/lib/rag/terminology/matcher';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { uninstallDeps } from '../helpers/pipeline-fakes';

/** D-37 placeholders; D-36: pipeline and switches set explicitly. */
let nextId = 0;
function entry(canonical: string, variants: string[], extra: Partial<TermEntry> = {}): TermEntry {
  nextId += 1;
  return {
    entryId: `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`,
    layer: 'shared',
    canonical,
    variants,
    normalizedVariants: variants.map((variant) => normalizeLexical(variant)),
    language: 'any',
    kind: 'synonym',
    mode: 'one_way',
    sourceLanguage: null,
    targetLanguage: null,
    ...extra,
  };
}

function dbRow(value: TermEntry, versions = { shared: 1, tenant: 0 }) {
  return {
    entry_id: value.entryId,
    layer: value.layer,
    canonical: value.canonical,
    variants: value.variants,
    normalized_variants: value.normalizedVariants,
    language: value.language,
    kind: value.kind,
    mode: value.mode,
    source_language: value.sourceLanguage,
    target_language: value.targetLanguage,
    shared_version: versions.shared,
    tenant_version: versions.tenant,
  };
}

interface TermClientOptions {
  rows?: (tenantKey: string) => unknown[];
  fail?: boolean;
  delayMs?: number;
}

function termClient(options: TermClientOptions = {}) {
  const calls: Array<{ fn: string; tenantKey: string }> = [];
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      const tenantKey = String(args.p_tenant_key);
      calls.push({ fn, tenantKey });
      let signal: AbortSignal | undefined;
      const response = (): RpcResponse =>
        options.fail ? { data: null, error: { code: 'P0001', message: 'synthetic failure' } } : { data: options.rows?.(tenantKey) ?? [], error: null };
      const request: RpcRequest = {
        abortSignal(next) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          const settled = new Promise<RpcResponse>((resolve) => {
            const timer = setTimeout(() => resolve(response()), options.delayMs ?? 0);
            signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}


const ON = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_TERMINOLOGY: 'true' };
const TEXT = '关于术语甲的问题';
const TIMEOUT_MS = 40;

function configFor(env: Record<string, string>) {
  resetRagConfigForTests();
  return loadRagConfig(env);
}

function orgScope(index: number): TenantScope {
  return mintScope('org', null, `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
}

const zhEntry = entry('术语甲乙丙', ['术语甲'], { language: 'zh' });
const translationPair = entry('term alpha beta', ['术语甲'], { kind: 'translation', language: 'zh', sourceLanguage: 'zh', targetLanguage: 'en' });

describe('terminologyGlossary (D-20, D-22)', () => {
  const logs: unknown[][] = [];

  beforeEach(() => {
    uninstallDeps();
    invalidateTerminologyCache('all');
    resetV2StartupForTests();
    logs.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallDeps();
    invalidateTerminologyCache('all');
    vi.restoreAllMocks();
  });

  it('switch off: null, and no load', async () => {
    const rpc = termClient({ rows: () => [dbRow(zhEntry)] });
    const result = await terminologyGlossary(mintScope('single', null, null), TEXT, {
      config: configFor({ ...ON, RAG_TERMINOLOGY: 'false' }),
      client: rpc.client,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result).toBeNull();
    expect(rpc.calls).toHaveLength(0);
  });

  it('switch on: the matches and the effective version', async () => {
    const rpc = termClient({ rows: () => [dbRow(zhEntry, { shared: 4, tenant: 2 })] });
    const result = await terminologyGlossary(mintScope('single', null, null), TEXT, { config: configFor(ON), client: rpc.client, timeoutMs: TIMEOUT_MS });
    expect(result?.version).toBe('s4.w2');
    expect(result?.matches).toHaveLength(1);
    expect(result?.matches[0]).toMatchObject({ canonical: '术语甲乙丙', surface: normalizeLexical('术语甲'), kind: 'synonym' });
  });

  it('never returns a translation pair', async () => {
    const rpc = termClient({ rows: () => [dbRow(translationPair), dbRow(zhEntry)] });
    const result = await terminologyGlossary(mintScope('single', null, null), TEXT, { config: configFor(ON), client: rpc.client, timeoutMs: TIMEOUT_MS });
    expect(result?.matches.map((row) => row.kind)).toEqual(['synonym']);
    const onlyPair = termClient({ rows: () => [dbRow(translationPair)] });
    invalidateTerminologyCache('all');
    const none = await terminologyGlossary(mintScope('single', null, null), TEXT, { config: configFor(ON), client: onlyPair.client, timeoutMs: TIMEOUT_MS });
    expect(none?.matches).toEqual([]);
  });

  it('a failing load returns null and does not throw', async () => {
    const rpc = termClient({ fail: true });
    await expect(
      terminologyGlossary(mintScope('single', null, null), TEXT, { config: configFor(ON), client: rpc.client, timeoutMs: TIMEOUT_MS }),
    ).resolves.toBeNull();
    const throwing: RpcClient = {
      rpc() {
        throw new Error('synthetic client failure');
      },
    };
    await expect(terminologyGlossary(orgScope(9), TEXT, { config: configFor(ON), client: throwing, timeoutMs: TIMEOUT_MS })).resolves.toBeNull();
  });

  it('a load slower than the timeout returns null', async () => {
    vi.useFakeTimers();
    const rpc = termClient({ rows: () => [dbRow(zhEntry)], delayMs: TIMEOUT_MS * 10 });
    const pending = terminologyGlossary(mintScope('single', null, null), TEXT, { config: configFor(ON), client: rpc.client, timeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
    expect(rpc.calls).toHaveLength(1);
  });

  it('shares the stage cache: a stage run then a glossary call for the same tenant load once', async () => {
    const rpc = termClient({ rows: () => [dbRow(zhEntry)] });
    setRagDepsForTests({ adminClient: () => rpc.client as never });
    const scope = mintScope('single', null, null);
    const config = configFor(ON);
    const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(scope) });
    const signal = new AbortController().signal;
    await runQueryStages({ input: { scope, query: TEXT, profile: 'eval', signal }, scope, config, profile: 'eval', signal, collector });
    const recorded = collector.stages().length;
    const result = await terminologyGlossary(scope, TEXT, { config, timeoutMs: TIMEOUT_MS });
    expect(result?.matches).toHaveLength(1);
    expect(rpc.calls).toHaveLength(1);
    expect(collector.stages()).toHaveLength(recorded);
  });

  it('two tenants load twice and never see each other\'s entries', async () => {
    const first = orgScope(1);
    const second = orgScope(2);
    const rpc = termClient({
      rows: (tenantKey) => (tenantKey === scopeKey(first) ? [dbRow(zhEntry)] : [dbRow(entry('term gamma delta', ['termalpha']))]),
    });
    setRagDepsForTests({ adminClient: () => rpc.client as never });
    const config = configFor(ON);
    const a = await terminologyGlossary(first, `${TEXT} termalpha`, { config, timeoutMs: TIMEOUT_MS });
    const b = await terminologyGlossary(second, `${TEXT} termalpha`, { config, timeoutMs: TIMEOUT_MS });
    expect(rpc.calls.map((call) => call.tenantKey)).toEqual([scopeKey(first), scopeKey(second)]);
    expect(a?.matches.map((row) => row.canonical)).toEqual(['术语甲乙丙']);
    expect(b?.matches.map((row) => row.canonical)).toEqual(['term gamma delta']);
  });

  it('writes no log line', async () => {
    const rpc = termClient({ rows: () => [dbRow(zhEntry)] });
    await terminologyGlossary(mintScope('single', null, null), TEXT, { config: configFor(ON), client: rpc.client, timeoutMs: TIMEOUT_MS });
    await terminologyGlossary(orgScope(5), TEXT, { config: configFor(ON), client: termClient({ fail: true }).client, timeoutMs: TIMEOUT_MS });
    expect(logs).toEqual([]);
  });
});
