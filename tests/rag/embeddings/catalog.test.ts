import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_MODEL_CATALOG,
  catalogEntry,
  defaultEmbeddingProfileDeclaration,
  defaultModelFor,
  embeddingProfileDeclaration,
} from '@/lib/rag/embeddings/catalog';
import type { EmbeddingModelEntry } from '@/lib/rag/embeddings/catalog';
import { canonicalModelId } from '@/lib/rag/embeddings/types';

const EXPECTED_MODELS = [
  'openai:text-embedding-3-small',
  'voyage:voyage-4-large',
  'voyage:voyage-law-2',
  'voyage:voyage-finance-2',
  'qwen3:Qwen/Qwen3-Embedding-8B',
  'bge-m3:BAAI/bge-m3',
];

function entry(provider: string, model: string): EmbeddingModelEntry {
  const found = catalogEntry(provider, model);
  if (!found) throw new Error(`missing catalog entry ${provider}:${model}`);
  return found;
}

describe('embedding model catalog (EMB-06, D-01)', () => {
  it('lists exactly the five Phase 3.1.1 models plus BGE-M3 (Phase 3.2.1) and is frozen', () => {
    expect(EMBEDDING_MODEL_CATALOG.map((item) => `${item.provider}:${item.model}`).sort()).toEqual([...EXPECTED_MODELS].sort());
    expect(Object.isFrozen(EMBEDDING_MODEL_CATALOG)).toBe(true);
    for (const item of EMBEDDING_MODEL_CATALOG) expect(Object.isFrozen(item)).toBe(true);
  });

  it('holds the vendor facts for voyage-law-2 and voyage-finance-2', () => {
    expect(entry('voyage', 'voyage-law-2')).toMatchObject({
      nativeDims: 1024,
      supportedDims: [1024],
      sendsOutputDimension: false,
      maxInputTokens: 16000,
      maxTokensPerRequest: 120000,
      inputTypes: ['query', 'document'],
      usdPerMillionTokens: 0.12,
      tokensAreEstimates: true,
    });
    expect(entry('voyage', 'voyage-finance-2')).toMatchObject({
      nativeDims: 1024,
      supportedDims: [1024],
      sendsOutputDimension: false,
      maxInputTokens: 32000,
      maxTokensPerRequest: 120000,
      usdPerMillionTokens: 0.12,
    });
  });

  it('keeps voyage-4-large flexible with output_dimension', () => {
    expect(entry('voyage', 'voyage-4-large')).toMatchObject({
      supportedDims: [256, 512, 1024, 2048],
      sendsOutputDimension: true,
      maxInputTokens: 32000,
      maxTokensPerRequest: 120000,
      usdPerMillionTokens: 0.12,
    });
  });

  it('keeps the Phase 3 OpenAI and Qwen3 facts', () => {
    expect(entry('openai', 'text-embedding-3-small')).toMatchObject({ supportedDims: [1536], usdPerMillionTokens: 0.02, tokensAreEstimates: false });
    expect(entry('qwen3', 'Qwen/Qwen3-Embedding-8B')).toMatchObject({
      nativeDims: 4096,
      supportedDims: [256, 512, 1024, 1536, 2048, 4096],
      usdPerMillionTokens: 0.01,
    });
  });

  it('returns undefined for a pair that is not in the catalog', () => {
    expect(catalogEntry('voyage', 'voyage-9')).toBeUndefined();
    expect(catalogEntry('openai', 'voyage-law-2')).toBeUndefined();
    expect(catalogEntry('cohere', 'embed-v4.0')).toBeUndefined();
  });

  it('finds a model by a host-specific spelling', () => {
    expect(catalogEntry('voyage', 'mongodb/voyage-law-2')?.model).toBe('voyage-law-2');
  });

  it('names the default model of each provider', () => {
    expect(defaultModelFor('openai')).toBe('text-embedding-3-small');
    expect(defaultModelFor('voyage')).toBe('voyage-4-large');
    expect(defaultModelFor('qwen3')).toBe('Qwen/Qwen3-Embedding-8B');
    expect(defaultModelFor('cohere')).toBeUndefined();
  });

  it('declares languages as lower-case codes; domain models only the languages the vendor names', () => {
    for (const item of EMBEDDING_MODEL_CATALOG) {
      expect(item.supportedLanguages.length).toBeGreaterThan(0);
      for (const code of item.supportedLanguages) expect(code).toMatch(/^[a-z]{2,3}$/);
    }
    expect([...entry('voyage', 'voyage-law-2').supportedLanguages]).toEqual(['en', 'zh']);
    expect([...entry('voyage', 'voyage-finance-2').supportedLanguages]).toEqual(['en']);
    for (const [provider, model] of [
      ['openai', 'text-embedding-3-small'],
      ['voyage', 'voyage-4-large'],
      ['qwen3', 'Qwen/Qwen3-Embedding-8B'],
    ]) {
      expect(entry(provider, model).supportedLanguages).toEqual(expect.arrayContaining(['zh', 'en', 'it']));
    }
  });

  it('pairs servingModes with hostedEndpoint and sidecarPath', () => {
    for (const item of EMBEDDING_MODEL_CATALOG) {
      expect(item.servingModes.length).toBeGreaterThan(0);
      expect(item.hostedEndpoint !== null).toBe(item.servingModes.includes('hosted'));
      expect(item.sidecarPath !== null).toBe(item.servingModes.includes('sidecar'));
      expect([...item.servingModes]).toEqual(['hosted']);
    }
    expect(entry('openai', 'text-embedding-3-small').hostedEndpoint).toEqual({ host: 'api.openai.com', apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: null });
    expect(entry('voyage', 'voyage-law-2').hostedEndpoint).toEqual({ host: 'api.voyageai.com', apiKeyEnv: 'VOYAGE_API_KEY', baseUrlEnv: 'VOYAGE_BASE_URL' });
    expect(entry('qwen3', 'Qwen/Qwen3-Embedding-8B').hostedEndpoint).toEqual({
      host: 'api.deepinfra.com',
      apiKeyEnv: 'DEEPINFRA_API_KEY',
      baseUrlEnv: 'DEEPINFRA_BASE_URL',
    });
  });

  it('names only environment variables, never key values, in hostedEndpoint', () => {
    for (const item of EMBEDDING_MODEL_CATALOG) {
      const endpoint = item.hostedEndpoint;
      if (!endpoint) continue;
      expect(endpoint.apiKeyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
      if (endpoint.baseUrlEnv !== null) expect(endpoint.baseUrlEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(endpoint.host).toMatch(/^[a-z0-9.-]+$/);
    }
  });

  it('records the date the vendor facts were read', () => {
    for (const item of EMBEDDING_MODEL_CATALOG) expect(item.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DECLARATIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rag', 'embedding-model-languages.json'), 'utf8')) as {
  schema_version: number;
  default_profile: { id: string; provider: string; model: string };
  models: { provider: string; model: string; supported_languages: string[] }[];
};
const REGISTRY_CODES = (
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rag', 'language-packs.json'), 'utf8')) as { packs: { code: string }[] }
).packs.map((pack) => pack.code);

describe('language declarations of the catalog models (Phase 3.2 D-07, Phase 3.2.1)', () => {
  it('come from config/rag/embedding-model-languages.json, one entry per catalog model and no other', () => {
    expect(DECLARATIONS.schema_version).toBe(1);
    const fileModels = DECLARATIONS.models.map((model) => `${model.provider}:${model.model}`);
    expect(new Set(fileModels).size).toBe(fileModels.length);
    expect([...fileModels].sort()).toEqual(EMBEDDING_MODEL_CATALOG.map((item) => `${item.provider}:${item.model}`).sort());
    for (const declared of DECLARATIONS.models) {
      expect([...entry(declared.provider, declared.model).supportedLanguages]).toEqual(declared.supported_languages);
    }
  });

  it('declare a non-empty set of language-pack codes on every model', () => {
    for (const item of EMBEDDING_MODEL_CATALOG) {
      expect(item.supportedLanguages.length, `${item.provider}:${item.model}`).toBeGreaterThan(0);
      for (const code of item.supportedLanguages) expect(REGISTRY_CODES, `${item.provider}:${item.model}`).toContain(code);
    }
  });

  it('declare the three shipped languages on every model an unscoped profile can use', () => {
    for (const [provider, model] of [
      ['openai', 'text-embedding-3-small'],
      ['voyage', 'voyage-4-large'],
      ['qwen3', 'Qwen/Qwen3-Embedding-8B'],
      ['bge-m3', 'BAAI/bge-m3'],
    ]) {
      expect([...entry(provider, model).supportedLanguages].sort()).toEqual(['en', 'it', 'zh']);
    }
  });

  it('name a catalog model for the default profile, the legacy profile', () => {
    expect(DECLARATIONS.default_profile).toEqual({ id: 'openai-3-small-1536', provider: 'openai', model: 'text-embedding-3-small' });
    expect(defaultEmbeddingProfileDeclaration()).toEqual({ id: 'openai-3-small-1536', supportedLanguages: ['zh', 'en', 'it'] });
  });

  it('give a profile the declaration of its model, and none for a model outside the catalog', () => {
    expect(embeddingProfileDeclaration({ id: 'voyage-finance-2-1024', provider: 'voyage', model: 'mongodb/voyage-finance-2' })).toEqual({
      id: 'voyage-finance-2-1024',
      supportedLanguages: ['en'],
    });
    expect(embeddingProfileDeclaration({ id: 'other-1024', provider: 'voyage', model: 'voyage-9' })).toEqual({
      id: 'other-1024',
      supportedLanguages: [],
    });
  });
});

describe('canonicalModelId for Voyage catalog models', () => {
  it('maps the mongodb/ prefix of every Voyage model', () => {
    expect(canonicalModelId('mongodb/voyage-law-2')).toBe('voyage-law-2');
    expect(canonicalModelId('mongodb/voyage-finance-2')).toBe('voyage-finance-2');
    expect(canonicalModelId('mongodb/voyage-4-large')).toBe('voyage-4-large');
  });
});
