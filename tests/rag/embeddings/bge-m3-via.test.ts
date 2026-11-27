import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BGE_M3_OPENROUTER_BASE_URL,
  BGE_M3_OPENROUTER_UPSTREAM,
  BGE_M3_SIDECAR_REVISION,
  createBgeM3Provider,
} from '@/lib/rag/embeddings/bge-m3';
import { main, parseEmbeddingArgs } from '@/lib/rag/embeddings/cli';
import { EmbeddingProfileMismatch } from '@/lib/rag/embeddings/mrl';
import type { EmbedOptions, EmbeddingProvider } from '@/lib/rag/embeddings/types';
import {
  ROUTE_MAX_COMPONENT_DELTA,
  ROUTE_MIN_COSINE,
  ROUTE_PROBE_TEXTS,
  cosine,
  referenceFrom,
  sha256Text,
  verifyBgeM3Route,
} from '@/lib/rag/embeddings/verify-route';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';

const DEEPINFRA_KEY = 'test-deepinfra-key-placeholder';
const OPENROUTER_KEY = 'test-openrouter-key-placeholder';

interface Call {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

let server: http.Server;
let root: string;
const calls: Call[] = [];
let upstream: string | null = 'DeepInfra';

function rawVector(text: string): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.codePointAt(0)!) % 1_000_003;
  return Array.from({ length: 1024 }, (_, index) => 2 * Math.sin(seed + index * 0.7) + 0.01);
}

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    calls.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
    if (request.url?.startsWith('/sidecar')) {
      const sidecarInputs = body.inputs as string[];
      const sidecarJson = { model: 'BAAI/bge-m3', revision: BGE_M3_SIDECAR_REVISION, vectors: sidecarInputs.map(rawVector) };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sidecarJson));
      return;
    }
    const inputs = body.input as string[];
    const json: Record<string, unknown> = {
      object: 'list',
      model: 'BAAI/bge-m3',
      data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: rawVector(text) })),
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    };
    if (request.url?.startsWith('/openrouter') && upstream !== null) json.provider = upstream;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  calls.length = 0;
  upstream = 'DeepInfra';
  delete process.env.RAG_BGE_M3_VIA;
  resetRagConfigForTests();
});

function opts(): EmbedOptions {
  return { dims: 1024, signal: new AbortController().signal };
}

function provider(via?: 'deepinfra' | 'openrouter', openrouterKey = OPENROUTER_KEY): EmbeddingProvider {
  return createBgeM3Provider({
    serving: () => 'hosted',
    ...(via ? { via: () => via } : {}),
    config: () => ({ apiKey: DEEPINFRA_KEY, baseUrl: `${root}/deepinfra`, timeoutMs: 5000 }),
    openrouter: () => ({ apiKey: openrouterKey, baseUrl: `${root}/openrouter`, timeoutMs: 5000 }),
  });
}

describe('RAG_BGE_M3_VIA', () => {
  it('defaults to deepinfra in the RAG config and refuses unknown values with a warning', () => {
    expect(loadRagConfig({}).bgeM3Via).toBe('deepinfra');
    expect(loadRagConfig({ RAG_BGE_M3_VIA: 'openrouter' }).bgeM3Via).toBe('openrouter');
    const bogus = loadRagConfig({ RAG_BGE_M3_VIA: 'together' });
    expect(bogus.bgeM3Via).toBe('deepinfra');
    expect(bogus.warnings.join(' ')).toContain('RAG_BGE_M3_VIA');
  });

  it('deepinfra sends no provider pin and records host deepinfra', async () => {
    const output = await provider('deepinfra').embedDocuments(['alpha'], opts());
    expect(output.host).toBe('deepinfra');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/deepinfra/embeddings');
    expect(calls[0]!.authorization).toBe(`Bearer ${DEEPINFRA_KEY}`);
    expect(calls[0]!.body.provider).toBeUndefined();
  });

  it('openrouter uses the OpenRouter key, pins the DeepInfra upstream and records host openrouter', async () => {
    const output = await provider('openrouter').embedDocuments(['alpha', 'beta'], opts());
    expect(output.host).toBe('openrouter');
    expect(output.model).toBe('BAAI/bge-m3');
    expect(output.vectors).toHaveLength(2);
    expect(calls[0]!.path).toBe('/openrouter/embeddings');
    expect(calls[0]!.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(calls[0]!.body.model).toBe('BAAI/bge-m3');
    expect(calls[0]!.body.provider).toEqual({ order: [BGE_M3_OPENROUTER_UPSTREAM], allow_fallbacks: false });
  });

  it('openrouter vectors match the deepinfra ones for the same answer', async () => {
    const a = await provider('deepinfra').embedDocuments(['gamma'], opts());
    const b = await provider('openrouter').embedDocuments(['gamma'], opts());
    expect(cosine(a.vectors[0]!, b.vectors[0]!)).toBeCloseTo(1, 12);
  });

  it('refuses an answer from another upstream as a model mismatch', async () => {
    upstream = 'Together';
    await expect(provider('openrouter').embedDocuments(['alpha'], opts())).rejects.toBeInstanceOf(EmbeddingProfileMismatch);
  });

  it('refuses an OpenRouter answer that does not name its upstream', async () => {
    upstream = null;
    await expect(provider('openrouter').embedDocuments(['alpha'], opts())).rejects.toBeInstanceOf(EmbeddingProfileMismatch);
  });

  it('a DeepInfra answer needs no provider field', async () => {
    upstream = null;
    expect((await provider('deepinfra').embedDocuments(['alpha'], opts())).host).toBe('deepinfra');
  });

  it('names the OpenRouter key when it is missing and makes no call', async () => {
    await expect(provider('openrouter', '').embedDocuments(['alpha'], opts())).rejects.toThrow('OPENROUTER_API_KEY not configured');
    expect(calls).toHaveLength(0);
  });

  it('reads the route from RAG_BGE_M3_VIA through the RAG config on every call', async () => {
    const p = provider();
    process.env.RAG_BGE_M3_VIA = 'openrouter';
    expect((await p.embedDocuments(['alpha'], opts())).host).toBe('openrouter');
    process.env.RAG_BGE_M3_VIA = 'deepinfra';
    expect((await p.embedDocuments(['alpha'], opts())).host).toBe('deepinfra');
  });

  it('sidecar serving with RAG_BGE_M3_VIA=openrouter makes zero OpenRouter and DeepInfra calls', async () => {
    process.env.RAG_BGE_M3_VIA = 'openrouter';
    const p = createBgeM3Provider({
      serving: () => 'sidecar',
      sidecar: () => ({ url: `${root}/sidecar`, secret: 'test-sidecar-secret-placeholder', timeoutMs: 5000 }),
      config: () => ({ apiKey: DEEPINFRA_KEY, baseUrl: `${root}/deepinfra`, timeoutMs: 5000 }),
      openrouter: () => ({ apiKey: OPENROUTER_KEY, baseUrl: `${root}/openrouter`, timeoutMs: 5000 }),
    });
    const output = await p.embedDocuments(['alpha', 'beta'], opts());
    expect(output.host).toBe('sidecar');
    expect(output.vectors).toHaveLength(2);
    expect(calls.map((call) => call.path)).toEqual(['/sidecar/v1/embed']);
    expect(calls.filter((call) => call.path.startsWith('/openrouter'))).toHaveLength(0);
    expect(calls.filter((call) => call.path.startsWith('/deepinfra'))).toHaveLength(0);
  });

  it('a failing sidecar with RAG_BGE_M3_VIA=openrouter still makes zero OpenRouter calls', async () => {
    process.env.RAG_BGE_M3_VIA = 'openrouter';
    const p = createBgeM3Provider({
      serving: () => 'sidecar',
      sidecar: () => ({ url: '', secret: '' }),
      openrouter: () => ({ apiKey: OPENROUTER_KEY, baseUrl: `${root}/openrouter`, timeoutMs: 5000 }),
    });
    await expect(p.embedDocuments(['alpha'], opts())).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('with RAG_BGE_M3_VIA unset the hosted call goes to DeepInfra as before, with no provider pin', async () => {
    delete process.env.RAG_BGE_M3_VIA;
    upstream = null;
    const output = await provider().embedDocuments(['alpha'], opts());
    expect(output.host).toBe('deepinfra');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/deepinfra/embeddings');
    expect(calls[0]!.authorization).toBe(`Bearer ${DEEPINFRA_KEY}`);
    expect(calls[0]!.body.provider).toBeUndefined();
  });

  it('the default OpenRouter base URL is the public endpoint', () => {
    expect(BGE_M3_OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});

function fixedProvider(vectorFor: (text: string) => number[], host: string): EmbeddingProvider {
  const embed = async (texts: string[]) => ({ vectors: texts.map(vectorFor), model: 'BAAI/bge-m3', host, usage: { tokens: texts.length } });
  return {
    id: 'bge-m3',
    model: 'BAAI/bge-m3',
    maxInputTokens: 4096,
    supportedDims: [1024],
    normalize: true,
    embedDocuments: (texts) => embed(texts),
    embedQuery: (text) => embed([text]),
    embedQueries: (texts) => embed(texts),
  };
}

function failingProvider(status: number): EmbeddingProvider {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error(`upstream said something with text ${status}`), { status });
  };
  return { ...fixedProvider(rawVector, 'deepinfra'), embedDocuments: fail, embedQuery: fail, embedQueries: fail };
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

/** Cosine stays above 0.999 but below 0.9999: the old bar passed this, D-26 does not. */
function slightlyOff(text: string): number[] {
  return unit(rawVector(text)).map((x, index) => x + (index % 2 === 0 ? 0.0009 : -0.0009));
}

/** Cosine above 0.9999 but one component off by more than 1e-3. */
function oneComponentOff(text: string): number[] {
  const base = unit(rawVector(text));
  base[7] = base[7]! + 0.004;
  return base;
}

function skewed(text: string): number[] {
  return rawVector(text).map((x, index) => (index % 2 === 0 ? x : -x));
}

describe('verify-route bge-m3', () => {
  const signal = new AbortController().signal;

  it('matches when both routes return the same vectors', async () => {
    const report = await verifyBgeM3Route({
      signal,
      providers: { openrouter: fixedProvider(rawVector, 'openrouter'), deepinfra: fixedProvider(rawVector, 'deepinfra') },
    });
    expect(report.verdict).toBe('match');
    expect(report.comparison?.against).toBe('deepinfra');
    expect(report.comparison?.cosines).toHaveLength(ROUTE_PROBE_TEXTS.length);
    expect(report.comparison!.minCosine).toBeGreaterThanOrEqual(ROUTE_MIN_COSINE);
    expect(report.comparison!.maxComponentDelta).toBeLessThanOrEqual(ROUTE_MAX_COMPONENT_DELTA);
  });

  it('uses the D-26 tolerance: cosine 0.9999 and every component within 1e-3', () => {
    expect(ROUTE_MIN_COSINE).toBe(0.9999);
    expect(ROUTE_MAX_COMPONENT_DELTA).toBe(1e-3);
  });

  it('reports a mismatch when the cosine is below 0.9999 even if above 0.999', async () => {
    const c = cosine(unit(rawVector(ROUTE_PROBE_TEXTS[0]!)), slightlyOff(ROUTE_PROBE_TEXTS[0]!));
    expect(c).toBeGreaterThan(0.999);
    expect(c).toBeLessThan(0.9999);
    const report = await verifyBgeM3Route({
      signal,
      providers: { openrouter: fixedProvider(slightlyOff, 'openrouter'), deepinfra: fixedProvider((t) => unit(rawVector(t)), 'deepinfra') },
    });
    expect(report.verdict).toBe('mismatch');
  });

  it('reports a mismatch when one component differs by more than 1e-3 while the cosine passes', async () => {
    const c = cosine(unit(rawVector(ROUTE_PROBE_TEXTS[0]!)), oneComponentOff(ROUTE_PROBE_TEXTS[0]!));
    expect(c).toBeGreaterThanOrEqual(0.9999);
    const report = await verifyBgeM3Route({
      signal,
      providers: { openrouter: fixedProvider(oneComponentOff, 'openrouter'), deepinfra: fixedProvider((t) => unit(rawVector(t)), 'deepinfra') },
    });
    expect(report.comparison!.maxComponentDelta).toBeGreaterThan(1e-3);
    expect(report.verdict).toBe('mismatch');
    expect(report.maxComponentDeltaRequired).toBe(1e-3);
  });

  it('reports a mismatch when the vectors differ', async () => {
    const report = await verifyBgeM3Route({
      signal,
      providers: { openrouter: fixedProvider(skewed, 'openrouter'), deepinfra: fixedProvider(rawVector, 'deepinfra') },
    });
    expect(report.verdict).toBe('mismatch');
  });

  it('does not compare when DeepInfra cannot be reached, keeping only the status', async () => {
    const report = await verifyBgeM3Route({
      signal,
      providers: { openrouter: fixedProvider(rawVector, 'openrouter'), deepinfra: failingProvider(402) },
    });
    expect(report.verdict).toBe('not_compared');
    expect(report.sides.find((side) => side.route === 'deepinfra')).toEqual({ route: 'deepinfra', status: 'unavailable', reason: 'http_402' });
  });

  it('compares with a reference file instead of calling DeepInfra', async () => {
    const reference = referenceFrom({ route: 'deepinfra', status: 'ok', host: 'deepinfra', dims: 1024, vectors: ROUTE_PROBE_TEXTS.map(rawVector) });
    expect(reference.entries[0]!.textSha256).toBe(sha256Text(ROUTE_PROBE_TEXTS[0]!));
    const report = await verifyBgeM3Route({
      signal,
      reference,
      providers: { openrouter: fixedProvider(rawVector, 'openrouter'), deepinfra: failingProvider(500) },
    });
    expect(report.verdict).toBe('match');
    expect(report.comparison?.against).toBe('reference:deepinfra');
    expect(report.sides.map((side) => side.route)).toEqual(['openrouter']);
  });

  it('parses the command and prints routes, cosines and the verdict, never a vector', async () => {
    expect(parseEmbeddingArgs(['verify-route', 'bge-m3'])).toEqual({ ok: true, command: 'verify-route', reference: null, writeReference: null, out: null });
    expect(parseEmbeddingArgs(['verify-route', 'qwen3']).ok).toBe(false);
    expect(parseEmbeddingArgs(['verify-route', 'bge-m3', '--bogus', 'x']).ok).toBe(false);
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const code = await main(['verify-route', 'bge-m3'], io, signal, {
      routeProviders: { openrouter: fixedProvider(rawVector, 'openrouter'), deepinfra: failingProvider(402) },
    });
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('verify-route openrouter: ok host=openrouter dims=1024');
    expect(text).toContain('verify-route deepinfra: unavailable (http_402)');
    expect(text).toContain('not compared');
    expect(text).not.toMatch(/-?\d\.\d{8,}/);
    lines.length = 0;
    const matched = await main(['verify-route', 'bge-m3'], io, signal, {
      routeProviders: { openrouter: fixedProvider(rawVector, 'openrouter'), deepinfra: fixedProvider(rawVector, 'deepinfra') },
    });
    expect(matched).toBe(0);
    expect(lines.join('\n')).toContain('verdict: match');
  });
});
