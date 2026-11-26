import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LanguageValidationResult } from '../../config/rag/validate-language-settings.cjs';
import { resetLanguageRegistryForTests, setLanguageRegistryForTests } from '@/lib/rag/lang/registry';
import { ProfileUnavailableError } from '@/lib/rag/embeddings/active-profile';
import {
  resetLanguageSettingsForTests,
  setActiveEmbeddingProfileReaderForTests,
  validateConfiguredLanguages,
  validateConfiguredLanguagesAgainstActiveProfile,
} from '@/lib/rag/lang/settings';
import {
  RERANK_PROVIDER_IDS,
  parseRerankProviderId,
  rerankerSupportedLanguages,
  resetRerankerLanguagesForTests,
  setRerankerLanguagesForTests,
} from '@/lib/rag/rerank/languages';
import {
  expectedResult,
  loadActiveProfileCases,
  loadLangCases,
  registryForCase,
  shippedRegistry,
  type ActiveProfileCase,
  type LangCase,
} from './helpers/lang-cases';

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

const initEnv = requireScript('../../scripts/init-env.js') as {
  validateLanguageChoice(
    candidate: { supported: string | null; primary: string | null },
    options: ScriptValidateOptions,
  ): LanguageValidationResult;
};

const initEnvAdapter: EntryPointAdapter = {
  name: 'init-env (scripts/init-env.js)',
  readsActiveProfile: false,
  validate(entry) {
    return initEnv.validateLanguageChoice({ supported: entry.supported, primary: entry.primary }, scriptInputs(entry));
  },
  cleanup: cleanupTempRoots,
};

export const ENTRY_POINT_ADAPTERS: EntryPointAdapter[] = [appAdapter, initEnvAdapter, configServerAdapter];

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

/**
 * Phase 3.2.1 (03.2.1-01): the entry points with the active embedding profile. The app reads the registry pointer and the
 * catalog declaration of the profile's model; the scripts read config/rag/embedding-model-languages.json, whose
 * default_profile stands for the active profile when the database is reachable and is the shipped default when it is not.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIPPED_DECLARATIONS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'config', 'rag', 'embedding-model-languages.json'), 'utf8'),
) as { default_profile: { id: string; provider: string; model: string } };

function scriptRootFor(entry: ActiveProfileCase): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-lang-active-'));
  tempRoots.push(root);
  const declarations = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'rag', 'embedding-model-languages.json'), 'utf8'));
  if (entry.database === 'reachable') declarations.default_profile = entry.activeProfile;
  fs.mkdirSync(path.join(root, 'config', 'rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'rag', 'embedding-model-languages.json'), JSON.stringify(declarations));
  return root;
}

interface ActiveProfileAdapter {
  name: string;
  readsActiveProfile: boolean;
  validate(entry: ActiveProfileCase): Promise<LanguageValidationResult>;
}

const ACTIVE_PROFILE_ADAPTERS: ActiveProfileAdapter[] = [
  {
    name: 'app (src/lib/rag/lang/settings.ts)',
    readsActiveProfile: true,
    async validate(entry) {
      setEnv('RAG_SUPPORTED_LANGUAGES', entry.supported);
      setEnv('RAG_PRIMARY_LANGUAGE', entry.primary);
      setEnv('RAG_RERANKER', 'none');
      setActiveEmbeddingProfileReaderForTests(async () => {
        if (entry.database === 'unreachable') throw new ProfileUnavailableError('read_failed');
        return entry.activeProfile;
      });
      return validateConfiguredLanguagesAgainstActiveProfile();
    },
  },
  {
    name: 'init-env (scripts/init-env.js)',
    readsActiveProfile: false,
    async validate(entry) {
      return initEnv.validateLanguageChoice(
        { supported: entry.supported, primary: entry.primary },
        { root: scriptRootFor(entry), env: { RAG_RERANKER: 'none' }, registry: shippedRegistry(), rerankerOverrides: {} },
      );
    },
  },
  {
    name: 'config server (scripts/config-server.js)',
    readsActiveProfile: false,
    async validate(entry) {
      const body = { languages: entry.supported === null ? [] : entry.supported.split(','), primary: entry.primary ?? undefined };
      return configServer.validateLanguagesRequest(body, {
        root: scriptRootFor(entry),
        env: { RAG_RERANKER: 'none' },
        registry: shippedRegistry(),
        rerankerOverrides: {},
      });
    },
  },
];

describe.each(ACTIVE_PROFILE_ADAPTERS)('$name with the active embedding profile', (adapter) => {
  afterEach(() => {
    setActiveEmbeddingProfileReaderForTests(null);
    appAdapter.cleanup();
    cleanupTempRoots();
  });

  for (const entry of loadActiveProfileCases()) {
    it(entry.name, async () => {
      expect(await adapter.validate(entry)).toEqual(
        adapter.readsActiveProfile ? entry.expect : { ...entry.expect, verifiedAgainstActiveProfile: false },
      );
    });
  }
});

describe('the default embedding profile declaration', () => {
  it('is the same in the scripts and the app, read from the shipped declarations file', async () => {
    const script = requireScript('../../scripts/rag/language-settings-context.js') as {
      defaultEmbeddingDeclaration(root: string): { id: string; supportedLanguages: string[] } | null;
    };
    const { defaultEmbeddingProfileDeclaration } = await import('@/lib/rag/embeddings/catalog');
    expect(script.defaultEmbeddingDeclaration(REPO_ROOT)).toEqual(defaultEmbeddingProfileDeclaration());
    expect(SHIPPED_DECLARATIONS.default_profile.id).toBe('openai-3-small-1536');
  });
});
