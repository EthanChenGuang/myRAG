import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBgeM3Provider, BGE_M3_APP_INPUT_TOKEN_LIMIT } from '@/lib/rag/embeddings/bge-m3';
import type { BgeM3Config } from '@/lib/rag/embeddings/bge-m3';
import { catalogEntry } from '@/lib/rag/embeddings/catalog';
import { EmbeddingProfileMismatch } from '@/lib/rag/embeddings/mrl';
import { estimateCostUsd, priceFor } from '@/lib/rag/embeddings/prices';
import {
  getEmbeddingProvider,
  getEmbeddingProviderFor,
  maxInputTokensFor,
  resetEmbeddingProvidersForTests,
  validateProfileShape,
} from '@/lib/rag/embeddings/registry';
import { BGE_M3_MODEL_ID, EmbeddingInputError, canonicalModelId } from '@/lib/rag/embeddings/types';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const KEY = 'test-deepinfra-key-placeholder-0123';
const PREFIX = '/v1/openai';

interface Call {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Reply {
  status?: number;
  json?: unknown;
}

type Responder = (body: Record<string, unknown>) => Reply;

let server: http.Server;
let baseUrl: string;
const calls: Call[] = [];
let responder: Responder | null = null;

/** A deterministic, deliberately unnormalized 1024-component vector for one text. */
function rawVector(text: string, dims = 1024, scale = 3): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.codePointAt(0)!) % 1_000_003;
  return Array.from({ length: dims }, (_, index) => scale * Math.sin(seed + index * 0.7) + 0.01);
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
}

/** The default host answer: rows in reverse order so only the index field gives the input order. */
function defaultReply(body: Record<string, unknown>): Reply {
  const inputs = body.input as string[];
  const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: rawVector(text) })).reverse();
  return { json: { object: 'list', data, model: 'BAAI/bge-m3', usage: { prompt_tokens: inputs.length, total_tokens: inputs.length } } };
}

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ path: request.url ?? '', headers: request.headers, body });
    if (request.url !== `${PREFIX}/embeddings` || request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const reply = (responder ?? defaultReply)(body);
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PREFIX}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  calls.length = 0;
  responder = null;
  resetEmbeddingProvidersForTests();
});

function provider(overrides: Partial<BgeM3Config> = {}) {
  return createBgeM3Provider({ config: () => ({ apiKey: KEY, baseUrl, timeoutMs: 5000, ...overrides }) });
}

function opts() {
  return { dims: 1024, signal: new AbortController().signal };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('BGE-M3 hosted provider (EMB-11, D-26)', () => {
  it('posts model BAAI/bge-m3 with float encoding, the bearer key, no dimension and no instruction for documents', async () => {
    const out = await provider().embedDocuments(['alpha passage', 'beta passage'], opts());
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`${PREFIX}/embeddings`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toEqual({ model: 'BAAI/bge-m3', input: ['alpha passage', 'beta passage'], encoding_format: 'float' });
    expect(out.model).toBe('BAAI/bge-m3');
    expect(out.host).toBe('deepinfra');
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0]).toHaveLength(1024);
  });

  it('sends a query exactly as given, with no instruction prefix, alone and in a batch', async () => {
    await provider().embedQuery('gamma question', opts());
    await provider().embedQueries!(['gamma question', 'delta question'], opts());
    expect(calls.map((call) => call.body.input)).toEqual([['gamma question'], ['gamma question', 'delta question']]);
    for (const call of calls) expect(Object.keys(call.body).sort()).toEqual(['encoding_format', 'input', 'model']);
  });

  it('sends text as UTF-8 without normalization', async () => {
    const decomposed = 'café 中文 Ａ';
    await provider().embedDocuments([decomposed], opts());
    expect(calls[0].body.input).toEqual([decomposed]);
  });

  it('returns vectors in input order by the response index field', async () => {
    const texts = ['first text', 'second text', 'third text'];
    const out = await provider().embedDocuments(texts, opts());
    texts.forEach((text, position) => {
      const expected = unit(rawVector(text));
      expect(out.vectors[position][0]).toBeCloseTo(expected[0], 9);
      expect(out.vectors[position][513]).toBeCloseTo(expected[513], 9);
    });
  });

  it('L2-normalizes every vector in double precision', async () => {
    const out = await provider().embedDocuments(['one text', 'two text'], opts());
    for (const vector of out.vectors) expect(Math.abs(norm(vector) - 1)).toBeLessThan(1e-6);
  });

  it('splits more than 128 inputs into several requests and keeps the order', async () => {
    const texts = Array.from({ length: 300 }, (_, index) => `short text ${index}`);
    const out = await provider().embedDocuments(texts, opts());
    expect(calls.map((call) => (call.body.input as string[]).length)).toEqual([128, 128, 44]);
    expect(out.vectors[250][7]).toBeCloseTo(unit(rawVector(texts[250]))[7], 9);
    expect(out.usage.tokens).toBe(300);
  });

  it('raises the mismatch error when the host answers with another model', async () => {
    responder = (body) => {
      const reply = defaultReply(body);
      (reply.json as { model: string }).model = 'BAAI/bge-large-en-v1.5';
      return reply;
    };
    const error = await rejection(provider().embedDocuments(['x text'], opts()));
    expect(error).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((error as EmbeddingProfileMismatch).kind).toBe('model');
  });

  it('raises the mismatch error when a vector is not 1024 components', async () => {
    responder = (body) => ({
      json: { data: (body.input as string[]).map((text, index) => ({ index, embedding: rawVector(text, 768) })), model: 'BAAI/bge-m3' },
    });
    const error = await rejection(provider().embedDocuments(['x text'], opts()));
    expect(error).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((error as EmbeddingProfileMismatch).kind).toBe('dims');
  });

  it('refuses a profile dimension other than 1024 before any request', async () => {
    const error = await rejection(provider().embedDocuments(['x text'], { dims: 512, signal: new AbortController().signal }));
    expect(error).toBeInstanceOf(EmbeddingProfileMismatch);
    expect(calls).toHaveLength(0);
  });

  it('never returns a zero vector', async () => {
    responder = (body) => ({
      json: { data: (body.input as string[]).map((_text, index) => ({ index, embedding: new Array(1024).fill(0) })), model: 'BAAI/bge-m3' },
    });
    const error = await rejection(provider().embedDocuments(['x text'], opts()));
    expect(error).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((error as EmbeddingProfileMismatch).kind).toBe('zero_norm');
  });

  it('rejects an empty input list and an empty string before any request', async () => {
    for (const texts of [[], [''], ['valid text', '']]) {
      const error = await rejection(provider().embedDocuments(texts, opts()));
      expect(error).toBeInstanceOf(EmbeddingInputError);
      expect((error as EmbeddingInputError).code).toBe('embedding_input_empty');
    }
    const query = await rejection(provider().embedQuery('', opts()));
    expect((query as EmbeddingInputError).code).toBe('embedding_input_empty');
    expect(calls).toHaveLength(0);
  });

  it('accepts an input at half the model limit in cl100k_base tokens and refuses one token more, never truncating', async () => {
    expect(BGE_M3_APP_INPUT_TOKEN_LIMIT).toBe(4096);
    const atLimit = 'word'.repeat(1) + ' word'.repeat(BGE_M3_APP_INPUT_TOKEN_LIMIT - 1);
    expect(countTokens(atLimit)).toBe(BGE_M3_APP_INPUT_TOKEN_LIMIT);
    await provider().embedDocuments([atLimit], opts());
    expect(calls[0].body.input).toEqual([atLimit]);

    calls.length = 0;
    const tooLong = `${atLimit} word`;
    const error = await rejection(provider().embedDocuments(['short text', tooLong], opts()));
    expect(error).toBeInstanceOf(EmbeddingInputError);
    expect((error as EmbeddingInputError).code).toBe('embedding_input_too_long');
    expect(calls).toHaveLength(0);
  });

  it('maps a host answer about an over-long input to embedding_input_too_long without the vendor text', async () => {
    responder = () => ({
      status: 400,
      json: { error: { message: `input exceeds the maximum context length of 8192 tokens for ${KEY}` } },
    });
    const error = await rejection(provider().embedDocuments(['dense text'], opts()));
    expect(error).toBeInstanceOf(EmbeddingInputError);
    expect((error as EmbeddingInputError).code).toBe('embedding_input_too_long');
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('reports another host failure with the host and status only', async () => {
    responder = () => ({ status: 401, json: { error: { message: `bad key ${KEY}` } } });
    const error = await rejection(provider().embedDocuments(['dense text'], opts()));
    expect((error as { status?: number }).status).toBe(401);
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('raises the Qwen configuration error when DEEPINFRA_API_KEY is missing', async () => {
    const error = await rejection(provider({ apiKey: '' }).embedDocuments(['x text'], opts()));
    expect((error as Error).message).toBe('[Embedding Profile] DEEPINFRA_API_KEY not configured');
    expect(calls).toHaveLength(0);
  });
});

describe('BGE-M3 in the registry, catalog and prices', () => {
  it('is served for provider bge-m3 by the provider lookup and the model-aware lookup', () => {
    const base = getEmbeddingProvider('bge-m3');
    expect(base.id).toBe('bge-m3');
    expect(base.model).toBe(BGE_M3_MODEL_ID);
    expect(base.supportedDims).toEqual([1024]);
    expect(getEmbeddingProviderFor('bge-m3', 'BAAI/bge-m3')).toBe(base);
    expect(canonicalModelId('baai/BGE-M3')).toBe('BAAI/bge-m3');
  });

  it('accepts a 1024 halfvec profile and refuses any other dimension', () => {
    expect(validateProfileShape({ provider: 'bge-m3', dims: 1024, storage: 'halfvec' })).toEqual({ ok: true });
    expect(validateProfileShape({ provider: 'bge-m3', model: 'BAAI/bge-m3', dims: 1024, storage: 'halfvec' })).toEqual({ ok: true });
    expect(validateProfileShape({ provider: 'bge-m3', dims: 768, storage: 'halfvec' })).toMatchObject({ ok: false, reason: 'dims_unsupported' });
  });

  it('holds the catalog facts of D-25', () => {
    expect(catalogEntry('bge-m3', 'BAAI/bge-m3')).toMatchObject({
      provider: 'bge-m3',
      model: 'BAAI/bge-m3',
      nativeDims: 1024,
      supportedDims: [1024],
      sendsOutputDimension: false,
      maxInputTokens: 8192,
      inputTypes: [],
      usdPerMillionTokens: 0.01,
      tokensAreEstimates: true,
      servingModes: ['hosted'],
      hostedEndpoint: { host: 'api.deepinfra.com', apiKeyEnv: 'DEEPINFRA_API_KEY', baseUrlEnv: 'DEEPINFRA_BASE_URL' },
    });
    expect([...(catalogEntry('bge-m3', 'BAAI/bge-m3')?.supportedLanguages ?? [])].sort()).toEqual(['en', 'it', 'zh']);
  });

  it('limits chunks to the app-side input limit', () => {
    expect(maxInputTokensFor('bge-m3')).toBe(BGE_M3_APP_INPUT_TOKEN_LIMIT);
  });

  it('prices the hosted model at 0.01 USD per million tokens, as an estimate', () => {
    expect(priceFor('bge-m3')).toEqual({ provider: 'bge-m3', model: 'BAAI/bge-m3', usdPerMillionTokens: 0.01, tokensAreEstimates: true });
    expect(estimateCostUsd('bge-m3', 2_000_000)).toEqual({ usd: 0.02, estimated: true });
  });
});
