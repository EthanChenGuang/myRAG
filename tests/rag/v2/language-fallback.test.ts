import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests, setDefaultPipelineForTests } from '@/lib/rag/config';
import { getRagDeps, resetRagDepsForTests } from '@/lib/rag/deps';
import { runRetrieval } from '@/lib/rag';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { LANGUAGES_NOT_CONFIGURED } from '@/lib/rag/lang/resolve';
import { resetLanguageSettingsForTests, setLanguageSettingsTrapForTests } from '@/lib/rag/lang/settings';
import { resetLanguageStartupCheckForTests, verifyLanguageSettingsAtStartup } from '@/lib/rag/lang/startup';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetV2ReadinessForTests, resolveEffectivePipeline } from '@/lib/rag/v2/readiness';
import { hit } from '../fusion/helpers';
import { SEMANTIC_QUERY, adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps } from '../helpers/pipeline-fakes';

const PROFILES = ['chat', 'embed', 'eval', 'voice'] as const;
type TestProfile = (typeof PROFILES)[number];
const LANGUAGE_VARIABLES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;
const STARTUP_LINE = '[RAG Languages] not configured — serving legacy';
const LEGACY_SEARCH_RPCS = ['match_document_chunks', 'match_documents_by_workspace', 'match_chunks_by_profile'];

const saved = Object.fromEntries(['RAG_PIPELINE', ...LANGUAGE_VARIABLES].map((name) => [name, process.env[name]]));

function setVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setLanguages(configured: boolean): void {
  setVariable('RAG_SUPPORTED_LANGUAGES', configured ? 'zh,en,it' : undefined);
  setVariable('RAG_PRIMARY_LANGUAGE', configured ? 'en' : undefined);
  resetLanguageSettingsForTests();
  resetRagConfigForTests();
}

function setPipeline(value: 'legacy' | 'v2' | undefined): void {
  setVariable('RAG_PIPELINE', value);
  resetRagConfigForTests();
}

function resetAll(): void {
  resetRagDepsForTests();
  resetRagConfigForTests();
  setDefaultPipelineForTests(null);
  resetV2ReadinessForTests();
  resetLanguageSettingsForTests();
  setLanguageSettingsTrapForTests(null);
  resetLanguageStartupCheckForTests();
  resetRetrievalBackendForTests();
}

function restoreVariables(): void {
  for (const [name, value] of Object.entries(saved)) setVariable(name, value);
}

const scope = mintScope('single', null, null);

function install(): { rpcCalls: { fn: string }[]; backendCalls: () => number } {
  resetActiveChunkingProfilesForTests();
  const { embedder } = fakeEmbedder();
  const rpc = fakeRpcClient({ rows: rows(3) });
  // The pipeline variable is read by the deps reader only; the sub-switches stay off so v2 is a single dense leg.
  const base = getRagDeps().ragEnv;
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => ({ ...base(), RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false' }),
  });
  let count = 0;
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search() {
      count += 1;
      return { dense: [hit('chunk-1', { similarity: 0.9, documentId: 'doc-1' })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  return { rpcCalls: rpc.calls, backendCalls: () => count };
}

const run = (profile: TestProfile) => runRetrieval({ scope, query: SEMANTIC_QUERY, profile, signal: new AbortController().signal });

const fallbackOf = (result: { stages: { name: string; detail?: string }[] }) =>
  result.stages.filter((stage) => stage.name === 'pipeline_fallback').map((stage) => stage.detail);
const comparable = (result: Awaited<ReturnType<typeof run>>) => ({
  status: result.status,
  reason: result.reason,
  candidates: result.candidates,
  context: result.context,
  usedDocuments: result.usedDocuments,
  sourceImages: result.sourceImages,
});
const legacySearchCalls = (calls: { fn: string }[]) => calls.filter((call) => LEGACY_SEARCH_RPCS.includes(call.fn)).length;
const hybridRpcCalls = (calls: { fn: string }[]) => calls.filter((call) => call.fn === 'hybrid_search_chunks').length;

async function explicitLegacy(profile: TestProfile, languages: boolean) {
  setPipeline('legacy');
  setLanguages(languages);
  install();
  const result = await run(profile);
  uninstallDeps();
  resetRetrievalBackendForTests();
  return result;
}

describe('language fallback with the Phase 3.2 reader', () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    uninstallDeps();
    restoreVariables();
    resetAll();
    vi.restoreAllMocks();
  });

  it('the language state comes from the Phase 3.2 reader', () => {
    setLanguages(false);
    expect(getRagDeps().languagesConfigured()).toBe(false);
    setLanguages(true);
    expect(getRagDeps().languagesConfigured()).toBe(true);
    setLanguages(false);
    expect(getRagDeps().languagesConfigured()).toBe(false);
  });

  it('languages unset and pipeline unset serves legacy with one startup log', async () => {
    const warn = vi.mocked(console.warn);
    for (const profile of PROFILES) {
      const baseline = await explicitLegacy(profile, false);
      expect(baseline.status, profile).not.toBe('error');

      setDefaultPipelineForTests('v2');
      setPipeline(undefined);
      setLanguages(false);
      const fake = install();
      const result = await run(profile);
      expect(comparable(result), profile).toEqual(comparable(baseline));
      expect(fallbackOf(result), profile).toEqual([LANGUAGES_NOT_CONFIGURED]);
      expect(fake.backendCalls(), profile).toBe(0);
      expect(hybridRpcCalls(fake.rpcCalls), profile).toBe(0);
      expect(resolveEffectivePipeline()).toEqual({ pipeline: 'legacy', source: 'default', fallback: LANGUAGES_NOT_CONFIGURED });
      uninstallDeps();
      resetRetrievalBackendForTests();
      setDefaultPipelineForTests(null);
    }

    setDefaultPipelineForTests('v2');
    setPipeline(undefined);
    setLanguages(false);
    resetLanguageStartupCheckForTests();
    warn.mockClear();
    verifyLanguageSettingsAtStartup();
    verifyLanguageSettingsAtStartup();
    const fake = install();
    for (let index = 0; index < 5; index += 1) await run(PROFILES[index % PROFILES.length]);
    expect(fake.backendCalls()).toBe(0);
    expect(warn.mock.calls.filter((call) => call[0] === STARTUP_LINE)).toHaveLength(1);
  });

  it('languages unset with explicit v2 reports languages_not_configured', async () => {
    setDefaultPipelineForTests('v2');
    setPipeline('v2');
    setLanguages(false);
    for (const profile of PROFILES) {
      const fake = install();
      const result = await run(profile);
      expect(result, profile).toMatchObject({ status: 'error', reason: LANGUAGES_NOT_CONFIGURED });
      expect(fallbackOf(result), profile).toEqual([]);
      expect(legacySearchCalls(fake.rpcCalls), profile).toBe(0);
      expect(hybridRpcCalls(fake.rpcCalls), profile).toBe(0);
      expect(fake.backendCalls(), profile).toBe(0);
      uninstallDeps();
      resetRetrievalBackendForTests();
    }
  });

  it('languages set and pipeline unset runs v2', async () => {
    setDefaultPipelineForTests('v2');
    setPipeline(undefined);
    setLanguages(true);
    for (const profile of PROFILES) {
      const fake = install();
      const result = await run(profile);
      expect(fake.backendCalls(), profile).toBe(1);
      expect(legacySearchCalls(fake.rpcCalls), profile).toBe(0);
      expect(fallbackOf(result), profile).toEqual([]);
      expect(result.status, profile).not.toBe('error');
      uninstallDeps();
      resetRetrievalBackendForTests();
    }
    expect(resolveEffectivePipeline()).toEqual({ pipeline: 'v2', source: 'default', fallback: 'none' });
  });

  it('explicit legacy never reads the languages', async () => {
    let reads = 0;
    setDefaultPipelineForTests('v2');
    for (const languages of [false, true]) {
      setPipeline('legacy');
      setLanguages(languages);
      setLanguageSettingsTrapForTests(() => {
        reads += 1;
        throw new Error('the language settings were read on an explicit legacy request');
      });
      const fake = install();
      for (const profile of PROFILES) {
        const result = await run(profile);
        expect(result.status, profile).not.toBe('error');
        expect(fallbackOf(result), profile).toEqual([]);
      }
      expect(fake.backendCalls()).toBe(0);
      expect(resolveEffectivePipeline()).toEqual({ pipeline: 'legacy', source: 'explicit', fallback: 'none' });
      setLanguageSettingsTrapForTests(null);
      uninstallDeps();
      resetRetrievalBackendForTests();
    }
    expect(reads).toBe(0);
  });

  it('one decision point', () => {
    setDefaultPipelineForTests('v2');
    for (const pipeline of [undefined, 'legacy', 'v2'] as const) {
      for (const languages of [false, true]) {
        setPipeline(pipeline);
        setLanguages(languages);
        resetLanguageStartupCheckForTests();
        const label = `RAG_PIPELINE=${pipeline ?? '(unset)'} languages=${languages ? 'set' : 'unset'}`;
        const expected = pipeline === undefined ? 'default' : 'explicit';

        const resolver = resolveEffectivePipeline();
        const config = loadRagConfig(getRagDeps().ragEnv());
        const startup = verifyLanguageSettingsAtStartup();
        expect(resolver.source, label).toBe(expected);
        expect(config.pipelineSource, label).toBe(expected);
        expect(startup?.retrieval.source, label).toBe(expected);

        const blocked = pipeline === 'v2' && !languages;
        const servedLegacy = pipeline === undefined && !languages;
        expect(config.pipelineBlocked, label).toBe(blocked ? LANGUAGES_NOT_CONFIGURED : null);
        expect(startup?.retrieval.pipeline === LANGUAGES_NOT_CONFIGURED, label).toBe(blocked);
        expect(startup?.retrieval.servedLegacyBecauseUnset, label).toBe(servedLegacy);
        expect(resolver.fallback === LANGUAGES_NOT_CONFIGURED, label).toBe(servedLegacy);
        expect(resolver.pipeline, label).toBe(pipeline === 'legacy' || servedLegacy ? 'legacy' : 'v2');
      }
    }
  });
});
