import { afterEach, describe, expect, it } from 'vitest';
import type { LanguageValidationResult } from '../../config/rag/validate-language-settings.cjs';
import { resetLanguageRegistryForTests, setLanguageRegistryForTests } from '@/lib/rag/lang/registry';
import { resetLanguageSettingsForTests, validateConfiguredLanguages } from '@/lib/rag/lang/settings';
import { expectedResult, loadLangCases, registryForCase, type LangCase } from './helpers/lang-cases';

/**
 * D-07: every entry point of validateLanguageSettings runs the same case file.
 * Plan 03.2-09 appends the scripts/init-env.js and scripts/config-server.js adapters.
 */
interface EntryPointAdapter {
  name: string;
  validate(entry: LangCase): LanguageValidationResult | Promise<LanguageValidationResult>;
  cleanup(): void;
}

const ENV_NAMES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function setEnv(name: string, value: string | null): void {
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}

const appAdapter: EntryPointAdapter = {
  name: 'app (src/lib/rag/lang/settings.ts)',
  validate(entry) {
    setEnv('RAG_SUPPORTED_LANGUAGES', entry.supported);
    setEnv('RAG_PRIMARY_LANGUAGE', entry.primary);
    if (entry.context.registryChange) setLanguageRegistryForTests(registryForCase(entry));
    return validateConfiguredLanguages({
      reranker: entry.context.reranker,
      embeddingProfile: entry.context.embeddingProfile,
    });
  },
  cleanup() {
    for (const name of ENV_NAMES) setEnv(name, savedEnv[name] ?? null);
    resetLanguageRegistryForTests();
    resetLanguageSettingsForTests();
  },
};

export const ENTRY_POINT_ADAPTERS: EntryPointAdapter[] = [appAdapter];

describe.each(ENTRY_POINT_ADAPTERS)('$name', (adapter) => {
  afterEach(() => adapter.cleanup());

  for (const entry of loadLangCases()) {
    it(entry.name, async () => {
      expect(await adapter.validate(entry)).toEqual(expectedResult(entry));
    });
  }
});
