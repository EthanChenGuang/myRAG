import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBgeM3Provider, BGE_M3_APP_INPUT_TOKEN_LIMIT, BGE_M3_SIDECAR_REVISION, EmbeddingSidecarUnavailableError } from '@/lib/rag/embeddings/bge-m3';
import type { BgeM3Config, BgeM3SidecarConfig } from '@/lib/rag/embeddings/bge-m3';
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
import { FAKE_BGE_M3_REVISION, fakeEmbedVector, startFakeSidecar, type FakeSidecar } from '../helpers/fake-sidecar';

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
      servingModes: ['hosted', 'sidecar'],
      sidecarPath: '/v1/embed',
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

describe('BGE-M3 served by the sidecar (EMB-11, D-26)', () => {
  let sidecar: FakeSidecar;

  beforeAll(async () => {
    sidecar = await startFakeSidecar();
  });

  afterAll(async () => {
    await sidecar.close();
  });

  afterEach(() => {
    sidecar.calls.length = 0;
    sidecar.embedRequests.length = 0;
    delete process.env.RAG_BGE_M3_SERVING;
  });

  function sidecarProvider(overrides: Partial<BgeM3SidecarConfig> = {}) {
    return createBgeM3Provider({
      config: () => ({ apiKey: KEY, baseUrl, timeoutMs: 5000 }),
      serving: () => 'sidecar',
      sidecar: () => ({ url: sidecar.url, secret: sidecar.secret, timeoutMs: 2000, ...overrides }),
    });
  }

  async function expectSidecarUnavailable(promise: Promise<unknown>, reason?: string): Promise<void> {
    const error = await rejection(promise);
    expect(error).toBeInstanceOf(EmbeddingSidecarUnavailableError);
    expect((error as EmbeddingSidecarUnavailableError).code).toBe('embedding_sidecar_unavailable');
    if (reason) expect((error as EmbeddingSidecarUnavailableError).reason).toBe(reason);
    expect(String((error as Error).message)).not.toContain(sidecar.secret);
    expect(calls, 'sidecar mode never falls back to the hosted API').toHaveLength(0);
  }

  it('pins the same revision the sidecar bakes', () => {
    expect(BGE_M3_SIDECAR_REVISION).toBe(FAKE_BGE_M3_REVISION);
  });

  it('posts the inputs to POST /v1/embed with the shared secret, normalizes, and records the sidecar as the host', async () => {
    const out = await sidecarProvider().embedDocuments(['alpha passage', 'beta passage'], opts());
    expect(sidecar.calls.map((call) => [call.method, call.path, call.secretOk])).toEqual([['POST', '/v1/embed', true]]);
    expect(sidecar.embedRequests).toEqual([{ model: 'BAAI/bge-m3', inputs: ['alpha passage', 'beta passage'] }]);
    expect(out.host).toBe('sidecar');
    expect(out.model).toBe('BAAI/bge-m3');
    expect(out.vectors).toHaveLength(2);
    for (const vector of out.vectors) {
      expect(vector).toHaveLength(1024);
      expect(Math.abs(norm(vector) - 1)).toBeLessThan(1e-6);
    }
    expect(out.vectors[1][5]).toBeCloseTo(unit(fakeEmbedVector('beta passage'))[5], 9);
    expect(calls).toHaveLength(0);
  });

  it('sends queries alone and in a batch the same way', async () => {
    await sidecarProvider().embedQuery('gamma question', opts());
    await sidecarProvider().embedQueries!(['gamma question', 'delta question'], opts());
    expect(sidecar.embedRequests.map((request) => request.inputs)).toEqual([['gamma question'], ['gamma question', 'delta question']]);
  });

  it('splits more than 32 inputs into requests of at most 32 and keeps the order', async () => {
    const texts = Array.from({ length: 70 }, (_, index) => `short text ${index}`);
    const out = await sidecarProvider().embedDocuments(texts, opts());
    expect(sidecar.embedRequests.map((request) => request.inputs.length)).toEqual([32, 32, 6]);
    expect(out.vectors[65][3]).toBeCloseTo(unit(fakeEmbedVector(texts[65]))[3], 9);
  });

  it('fails with the typed error and no hosted call when the sidecar answers an error', async () => {
    sidecar.enqueueEmbed({ status: 503, error: 'model_unavailable' });
    await expectSidecarUnavailable(sidecarProvider().embedDocuments(['dense text'], opts()), 'http_503');
  });

  it('fails with the typed error and no hosted call when the sidecar is slower than the timeout', async () => {
    sidecar.enqueueEmbed({ delayMs: 400 });
    await expectSidecarUnavailable(sidecarProvider({ timeoutMs: 100 }).embedDocuments(['dense text'], opts()), 'timeout');
  });

  it('fails with the typed error and no hosted call when the sidecar is unreachable', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expectSidecarUnavailable(sidecarProvider({ url: `http://127.0.0.1:${port}` }).embedDocuments(['dense text'], opts()), 'unreachable');
  });

  it('fails with the typed error and no request at all when the sidecar is not configured', async () => {
    await expectSidecarUnavailable(sidecarProvider({ url: '' }).embedDocuments(['dense text'], opts()), 'not_configured');
    await expectSidecarUnavailable(sidecarProvider({ secret: '' }).embedDocuments(['dense text'], opts()), 'not_configured');
    expect(sidecar.calls).toHaveLength(0);
  });

  it('fails with the typed error when the sidecar answers a malformed body or another revision', async () => {
    sidecar.enqueueEmbed({ body: { model: 'BAAI/bge-m3', revision: FAKE_BGE_M3_REVISION, dims: 1024, vectors: [] } });
    await expectSidecarUnavailable(sidecarProvider().embedDocuments(['dense text'], opts()), 'malformed');
    sidecar.enqueueEmbed({ body: { model: 'BAAI/bge-m3', revision: 'f'.repeat(40), dims: 1024, vectors: [fakeEmbedVector('x')] } });
    await expectSidecarUnavailable(sidecarProvider().embedDocuments(['dense text'], opts()), 'revision_mismatch');
  });

  it('checks the returned model and dimension', async () => {
    sidecar.enqueueEmbed({ body: { model: 'BAAI/bge-large-en-v1.5', revision: FAKE_BGE_M3_REVISION, dims: 1024, vectors: [fakeEmbedVector('x')] } });
    const model = await rejection(sidecarProvider().embedDocuments(['dense text'], opts()));
    expect(model).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((model as EmbeddingProfileMismatch).kind).toBe('model');
    sidecar.enqueueEmbed({ body: { model: 'BAAI/bge-m3', revision: FAKE_BGE_M3_REVISION, dims: 1024, vectors: [fakeEmbedVector('x', 768)] } });
    const dims = await rejection(sidecarProvider().embedDocuments(['dense text'], opts()));
    expect(dims).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((dims as EmbeddingProfileMismatch).kind).toBe('dims');
    expect(calls).toHaveLength(0);
  });

  it('maps the sidecar refusal of an over-long input to embedding_input_too_long, never truncating', async () => {
    sidecar.enqueueEmbed({ status: 422, error: 'embed_input_too_long: limit 8192 tokens' });
    const error = await rejection(sidecarProvider().embedDocuments(['dense text'], opts()));
    expect(error).toBeInstanceOf(EmbeddingInputError);
    expect((error as EmbeddingInputError).code).toBe('embedding_input_too_long');
    expect(calls).toHaveLength(0);
  });

  it('applies the same input checks as the hosted mode before any request', async () => {
    const tooLong = 'word' + ' word'.repeat(BGE_M3_APP_INPUT_TOKEN_LIMIT);
    const long = await rejection(sidecarProvider().embedDocuments([tooLong], opts()));
    expect((long as EmbeddingInputError).code).toBe('embedding_input_too_long');
    const overChars = await rejection(sidecarProvider().embedDocuments(['x'.repeat(20_001)], opts()));
    expect((overChars as EmbeddingInputError).code).toBe('embedding_input_too_long');
    const empty = await rejection(sidecarProvider().embedDocuments([''], opts()));
    expect((empty as EmbeddingInputError).code).toBe('embedding_input_empty');
    expect(sidecar.calls).toHaveLength(0);
  });

  it('passes a caller abort through unchanged', async () => {
    const controller = new AbortController();
    sidecar.enqueueEmbed({ delayMs: 300 });
    const pending = sidecarProvider().embedDocuments(['dense text'], { dims: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const error = await rejection(pending);
    expect(error).not.toBeInstanceOf(EmbeddingSidecarUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it('reads the serving mode from RAG_BGE_M3_SERVING through the RAG config', async () => {
    const provider = createBgeM3Provider({
      config: () => ({ apiKey: KEY, baseUrl, timeoutMs: 5000 }),
      sidecar: () => ({ url: sidecar.url, secret: sidecar.secret, timeoutMs: 2000 }),
    });
    process.env.RAG_BGE_M3_SERVING = 'sidecar';
    const served = await provider.embedDocuments(['epsilon text'], opts());
    expect(served.host).toBe('sidecar');
    expect(calls).toHaveLength(0);
    process.env.RAG_BGE_M3_SERVING = 'hosted';
    const hosted = await provider.embedDocuments(['epsilon text'], opts());
    expect(hosted.host).toBe('deepinfra');
    expect(sidecar.embedRequests).toHaveLength(1);
  });

  it('in hosted mode sends nothing to the sidecar', async () => {
    const provider = createBgeM3Provider({
      config: () => ({ apiKey: KEY, baseUrl, timeoutMs: 5000 }),
      serving: () => 'hosted',
      sidecar: () => ({ url: sidecar.url, secret: sidecar.secret, timeoutMs: 2000 }),
    });
    const out = await provider.embedDocuments(['zeta text'], opts());
    expect(out.host).toBe('deepinfra');
    expect(calls).toHaveLength(1);
    expect(sidecar.calls).toHaveLength(0);
  });
});
