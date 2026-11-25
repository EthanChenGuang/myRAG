import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LanguageValidationResult } from '../../config/rag/validate-language-settings.cjs';
import { resetLanguageRegistryForTests, setLanguageRegistryForTests } from '@/lib/rag/lang/registry';
import { resetLanguageSettingsForTests, validateConfiguredLanguages } from '@/lib/rag/lang/settings';
import {
  RERANK_PROVIDER_IDS,
  parseRerankProviderId,
  rerankerSupportedLanguages,
  resetRerankerLanguagesForTests,
  setRerankerLanguagesForTests,
} from '@/lib/rag/rerank/languages';
import { expectedResult, loadLangCases, registryForCase, shippedRegistry, type LangCase } from './helpers/lang-cases';

/**
 * D-07: every entry point of validateLanguageSettings runs the same case file.
 * The script adapters (plan 03.2-09) never read the active embedding profile, so they report
 * verifiedAgainstActiveProfile false; every other field equals the app adapter's result.
 */
interface EntryPointAdapter {
  name: string;
  readsActiveProfile: boolean;
  validate(entry: LangCase): LanguageValidationResult | Promise<LanguageValidationResult>;
  cleanup(): void;
}

const ENV_NAMES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE', 'RAG_RERANKER'] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function setEnv(name: string, value: string | null): void {
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}

const appAdapter: EntryPointAdapter = {
  name: 'app (src/lib/rag/lang/settings.ts)',
  readsActiveProfile: true,
  validate(entry) {
    setEnv('RAG_SUPPORTED_LANGUAGES', entry.supported);
    setEnv('RAG_PRIMARY_LANGUAGE', entry.primary);
    if (entry.context.registryChange) setLanguageRegistryForTests(registryForCase(entry));
    const reranker = entry.context.reranker;
    if (reranker) {
      const id = parseRerankProviderId(reranker.id);
      if (id === null) throw new Error(`case ${entry.name}: unknown reranker ${reranker.id}`);
      setEnv('RAG_RERANKER', id);
      setRerankerLanguagesForTests(id, reranker.supportedLanguages);
    } else {
      setEnv('RAG_RERANKER', 'none');
    }
    return validateConfiguredLanguages({ embeddingProfile: entry.context.embeddingProfile });
  },
  cleanup() {
    for (const name of ENV_NAMES) setEnv(name, savedEnv[name] ?? null);
    resetLanguageRegistryForTests();
    resetLanguageSettingsForTests();
    resetRerankerLanguagesForTests();
  },
};

const requireScript = createRequire(import.meta.url);

interface ScriptLanguageContext {
  RERANK_PROVIDER_IDS: readonly string[];
  rerankerDeclaration(
    raw: string | undefined,
    registry: unknown,
    overrides?: Record<string, readonly string[]>,
  ): { id: string; supportedLanguages: string[] } | null;
}

interface ScriptValidateOptions {
  root: string;
  env: Record<string, string>;
  registry: unknown;
  rerankerOverrides: Record<string, readonly string[]>;
}

const scriptContext = requireScript('../../scripts/rag/language-settings-context.js') as ScriptLanguageContext;
const tempRoots: string[] = [];

/**
 * The case's context as a script sees it: a project root whose config/rag/embedding-model-languages.json names the
 * case's profile as the default profile (absent for a null profile), RAG_RERANKER, and the case's declarations.
 */
function scriptInputs(entry: LangCase): ScriptValidateOptions {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-lang-entry-'));
  tempRoots.push(root);
  const profile = entry.context.embeddingProfile;
  if (profile) {
    fs.mkdirSync(path.join(root, 'config', 'rag'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'rag', 'embedding-model-languages.json'),
      JSON.stringify({
        schema_version: 1,
        default_profile: { id: profile.id, provider: 'fixture', model: 'fixture-model' },
        models: [{ provider: 'fixture', model: 'fixture-model', supported_languages: profile.supportedLanguages }],
      }),
    );
  }
  const reranker = entry.context.reranker;
  return {
    root,
    env: { RAG_RERANKER: reranker ? reranker.id : 'none' },
    registry: registryForCase(entry),
    rerankerOverrides: reranker ? { [reranker.id]: reranker.supportedLanguages } : {},
  };
}

function cleanupTempRoots(): void {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

const configServer = requireScript('../../scripts/config-server.js') as {
  validateLanguagesRequest(body: unknown, options: ScriptValidateOptions): LanguageValidationResult;
};

const configServerAdapter: EntryPointAdapter = {
  name: 'config server (scripts/config-server.js)',
  readsActiveProfile: false,
  validate(entry) {
    const body = {
      languages: entry.supported === null ? [] : entry.supported.split(','),
      primary: entry.primary ?? undefined,
    };
    return configServer.validateLanguagesRequest(body, scriptInputs(entry));
  },
  cleanup: cleanupTempRoots,
};

export const ENTRY_POINT_ADAPTERS: EntryPointAdapter[] = [appAdapter, configServerAdapter];

describe.each(ENTRY_POINT_ADAPTERS)('$name', (adapter) => {
  afterEach(() => adapter.cleanup());

  for (const entry of loadLangCases()) {
    it(entry.name, async () => {
      const expected = expectedResult(entry);
      expect(await adapter.validate(entry)).toEqual(
        adapter.readsActiveProfile ? expected : { ...expected, verifiedAgainstActiveProfile: false },
      );
    });
  }
});

describe('script reranker declarations', () => {
  afterEach(() => resetLanguageRegistryForTests());

  it('name the same providers as the app', () => {
    expect([...scriptContext.RERANK_PROVIDER_IDS].sort()).toEqual([...RERANK_PROVIDER_IDS].sort());
  });

  it.each(RERANK_PROVIDER_IDS)('%s declares the same languages in the scripts and the app', (id) => {
    const registry = shippedRegistry();
    expect(scriptContext.rerankerDeclaration(id, registry)).toEqual({
      id,
      supportedLanguages: [...rerankerSupportedLanguages(id)],
    });
  });

  it('follow a registry change the same way in the scripts and the app', () => {
    const registry = shippedRegistry();
    const pack = registry.packs.find((candidate) => candidate.code === 'it') as Record<string, unknown>;
    (pack.fixtures as Record<string, unknown>).golden_slices = false;
    pack.segmentation = null;
    setLanguageRegistryForTests(registry as never);
    for (const id of RERANK_PROVIDER_IDS) {
      expect(scriptContext.rerankerDeclaration(id, registry)?.supportedLanguages).toEqual([...rerankerSupportedLanguages(id)]);
    }
  });

  it('apply no reranker rule for none or an unknown value, as the app does', () => {
    for (const raw of ['none', '', 'auto', 'unknown']) {
      expect(scriptContext.rerankerDeclaration(raw, shippedRegistry())).toBe(parseRerankProviderId(raw));
    }
  });
});
