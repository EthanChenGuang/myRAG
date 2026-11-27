import { describe, expect, it, test } from 'vitest';
import { canaryBackends, canaryGuardProblems, type GuardFetch } from './factory';

const URLS = { QDRANT_URL: 'http://qdrant.canary.invalid:6333', WEAVIATE_URL: 'http://weaviate.canary.invalid:8080' };
const CI_ENV = { CI_BACKEND_CANARY: '1', RAG_CANARY_BACKENDS: 'pgvector,weaviate,qdrant', ...URLS };

function healthy(overrides: Record<string, number | 'throw'> = {}): { fetch: GuardFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const hit = Object.entries(overrides).find(([fragment]) => url.includes(fragment));
      if (hit?.[1] === 'throw') throw new TypeError('fetch failed');
      return { status: typeof hit?.[1] === 'number' ? hit[1] : 200 };
    },
  };
}

describe('canaryBackends', () => {
  it('is pgvector alone when RAG_CANARY_BACKENDS is unset or empty', () => {
    expect(canaryBackends({})).toEqual(['pgvector']);
    expect(canaryBackends({ RAG_CANARY_BACKENDS: '  ' })).toEqual(['pgvector']);
  });

  it('returns exactly the listed names', () => {
    expect(canaryBackends({ RAG_CANARY_BACKENDS: 'pgvector,weaviate,qdrant' })).toEqual(['pgvector', 'weaviate', 'qdrant']);
    expect(canaryBackends({ RAG_CANARY_BACKENDS: 'qdrant' })).toEqual(['qdrant']);
    expect(canaryBackends({ RAG_CANARY_BACKENDS: ' weaviate , pgvector ' })).toEqual(['weaviate', 'pgvector']);
  });

  it('throws on an unknown name', () => {
    expect(() => canaryBackends({ RAG_CANARY_BACKENDS: 'pgvector,milvus' })).toThrow(/unknown backend/);
    expect(() => canaryBackends({ RAG_CANARY_BACKENDS: 'pgvector,' })).toThrow(/unknown backend/);
  });
});

describe('canary guard (CI_BACKEND_CANARY=1)', () => {
  it('passes with all three backends, both URLs and both services ready', async () => {
    const probe = healthy();
    expect(await canaryGuardProblems(CI_ENV, probe.fetch)).toEqual([]);
    expect(probe.urls.sort()).toEqual([`${URLS.QDRANT_URL}/readyz`, `${URLS.WEAVIATE_URL}/v1/.well-known/ready`]);
  });

  it('fails when a backend is missing from RAG_CANARY_BACKENDS', async () => {
    for (const list of ['pgvector', 'pgvector,qdrant', 'pgvector,weaviate', '', 'weaviate,qdrant']) {
      const problems = await canaryGuardProblems({ ...CI_ENV, RAG_CANARY_BACKENDS: list }, healthy().fetch);
      expect(problems.some((line) => line.includes('must be exactly')), list).toBe(true);
    }
  });

  it('fails when a service URL is missing', async () => {
    expect(await canaryGuardProblems({ ...CI_ENV, QDRANT_URL: '' }, healthy().fetch)).toEqual(['QDRANT_URL is not set for the qdrant canary leg']);
    expect(await canaryGuardProblems({ ...CI_ENV, WEAVIATE_URL: undefined }, healthy().fetch)).toEqual([
      'WEAVIATE_URL is not set for the weaviate canary leg',
    ]);
  });

  it('fails when a health check answers non-200 or does not answer', async () => {
    expect(await canaryGuardProblems(CI_ENV, healthy({ '/readyz': 503 }).fetch)).toEqual(['qdrant health check /readyz answered 503']);
    expect(await canaryGuardProblems(CI_ENV, healthy({ '/v1/.well-known/ready': 'throw' }).fetch)).toEqual([
      'weaviate health check /v1/.well-known/ready failed (TypeError)',
    ]);
  });

  it('fails on an unknown backend name', async () => {
    const problems = await canaryGuardProblems({ ...CI_ENV, RAG_CANARY_BACKENDS: 'pgvector,weaviate,qdrant,milvus' }, healthy().fetch);
    expect(problems.some((line) => line.includes('unknown backend'))).toBe(true);
  });
});

describe('canary guard outside CI', () => {
  it('checks nothing when only pgvector runs', async () => {
    const probe = healthy();
    expect(await canaryGuardProblems({}, probe.fetch)).toEqual([]);
    expect(probe.urls).toEqual([]);
  });

  it('checks only the configured external legs', async () => {
    const probe = healthy();
    expect(await canaryGuardProblems({ RAG_CANARY_BACKENDS: 'pgvector,qdrant', QDRANT_URL: URLS.QDRANT_URL }, probe.fetch)).toEqual([]);
    expect(probe.urls).toEqual([`${URLS.QDRANT_URL}/readyz`]);
    expect(await canaryGuardProblems({ RAG_CANARY_BACKENDS: 'weaviate' }, healthy().fetch)).toEqual(['WEAVIATE_URL is not set for the weaviate canary leg']);
  });
});

// A plain test, never skipped: in the backend-canary job (CI_BACKEND_CANARY=1) a missing backend, URL or service fails the run.
test('the configured canary backends are all present and healthy', async () => {
  expect(await canaryGuardProblems()).toEqual([]);
});
