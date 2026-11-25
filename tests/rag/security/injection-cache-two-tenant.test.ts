import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { readSecurityConfig } from '@/lib/rag/security/config';
import type { Detector, DetectorClassifyOptions, DetectorOutcome } from '@/lib/rag/security/detectors';
import * as injectionCheck from '@/lib/rag/security/injection-check';
import type { PromptGuardClassifier } from '@/lib/rag/security/injection-check';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import type { RetrievalResult } from '@/lib/rag/types';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps, type FakeRow } from '../helpers/pipeline-fakes';

/** A-9: verdicts are cached per tenant scope, so byte-identical text in two tenants is classified once per tenant. */

const TEXT = 'The report covers the inventory of the warehouse and the totals.';
const ROWS: FakeRow[] = [{ chunk_id: 'c1', document_id: 'doc-1', content: TEXT, similarity: 0.9, metadata: null }];

const tenantA = mintScope('personal', TWO_TENANT_IDS.userA, null);
const tenantB = mintScope('org', TWO_TENANT_IDS.userB, TWO_TENANT_IDS.orgO);

const resetDetectors = () => injectionCheck.resetInjectionDetectorsForTests?.();

/** Answers from a script, one verdict per call in call order; the log records each call's texts. */
function scriptedPromptGuard(verdicts: boolean[]): { classifier: PromptGuardClassifier; log: string[][] } {
  const log: string[][] = [];
  const classifier: PromptGuardClassifier = async (items) => {
    const flagged = verdicts[log.length] ?? false;
    log.push(items.map((item) => item.text));
    return {
      ok: true,
      modelId: 'fake/prompt-guard',
      revision: 'fake-revision',
      results: items.map((item) => ({ id: item.id, label: flagged ? ('MALICIOUS' as const) : ('BENIGN' as const), score: flagged ? 0.99 : 0.01, windows: 1 })),
    };
  };
  return { classifier, log };
}

function scriptedLakera(verdicts: boolean[]): { detector: Detector; log: Array<{ texts: string[]; tenant: TenantScope }> } {
  const log: Array<{ texts: string[]; tenant: TenantScope }> = [];
  const detector: Detector = {
    id: 'lakera',
    version: 'fake-lakera-v1',
    async classify(items: readonly string[], opts: DetectorClassifyOptions): Promise<DetectorOutcome[]> {
      const flagged = verdicts[log.length] ?? false;
      log.push({ texts: [...items], tenant: opts.scope });
      return items.map(() => ({ kind: 'verdict', verdict: { flagged, at: 0 } }));
    },
  };
  return { detector, log };
}

function run(scope: TenantScope): Promise<RetrievalResult> {
  return runRetrieval({ scope, query: 'report inventory', profile: 'eval', options: { ragMode: 'strict', webSearchEnabled: false }, signal: new AbortController().signal });
}

function kept(result: RetrievalResult): number {
  return result.kept.length;
}

beforeEach(() => {
  resetDetectors();
  for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
});

afterEach(() => {
  resetDetectors();
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('tenant-keyed verdict cache (A-9)', () => {
  test('identical text in a personal and an organization scope is classified once per tenant', async () => {
    const pg = scriptedPromptGuard([false, false]);
    installDeps({
      searchRpc: fakeRpcClient({ rows: ROWS }).client,
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({}),
      securityConfig: () => readSecurityConfig({ RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_PROMPT_GUARD: 'true' }),
      promptGuardClassifier: pg.classifier,
    });

    await run(tenantA);
    await run(tenantB);
    expect(pg.log).toEqual([[TEXT], [TEXT]]);
  });

  test('a repeat from tenant A is a cache hit with no call', async () => {
    const pg = scriptedPromptGuard([false]);
    installDeps({
      searchRpc: fakeRpcClient({ rows: ROWS }).client,
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({}),
      securityConfig: () => readSecurityConfig({ RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_PROMPT_GUARD: 'true' }),
      promptGuardClassifier: pg.classifier,
    });

    await run(tenantA);
    const repeat = await run(tenantA);
    expect(pg.log).toHaveLength(1);
    expect(repeat.stages.find((entry) => entry.name === 'injection_check')?.counts).toMatchObject({ prompt_guard_cache_hit: 1, prompt_guard_cache_miss: 0 });
  });

  test('tenant B follows its own verdict when the classifier answers differently per tenant', async () => {
    const pg = scriptedPromptGuard([true, false]);
    installDeps({
      searchRpc: fakeRpcClient({ rows: ROWS }).client,
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({}),
      securityConfig: () => readSecurityConfig({ RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_PROMPT_GUARD: 'true' }),
      promptGuardClassifier: pg.classifier,
    });

    const firstA = await run(tenantA);
    const firstB = await run(tenantB);
    const againA = await run(tenantA);
    const againB = await run(tenantB);

    expect(pg.log).toHaveLength(2);
    expect(kept(firstA)).toBe(0);
    expect(firstA.reason).toBe('injection_filtered');
    expect(kept(firstB)).toBe(1);
    expect(kept(againA)).toBe(0);
    expect(kept(againB)).toBe(1);
  });

  test('Lakera verdicts are tenant-keyed too, and each call carries its own tenant scope', async () => {
    const lakera = scriptedLakera([true, false]);
    installDeps({
      searchRpc: fakeRpcClient({ rows: ROWS }).client,
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({}),
      securityConfig: () =>
        readSecurityConfig({ RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_LAKERA: 'true', LAKERA_GUARD_API_KEY: 'lakera-placeholder-key' }),
      lakeraDetector: () => lakera.detector,
    });

    const firstA = await run(tenantA);
    const firstB = await run(tenantB);
    await run(tenantA);
    await run(tenantB);

    expect(lakera.log.map((entry) => entry.tenant)).toEqual([tenantA, tenantB]);
    expect(kept(firstA)).toBe(0);
    expect(kept(firstB)).toBe(1);
  });
});
