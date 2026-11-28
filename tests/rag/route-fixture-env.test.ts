import { afterEach, describe, expect, it } from 'vitest';
import { loadPinnedEvalEnv } from '../../eval/harness/eval-env.mts';
import { startRouteFixture, type RouteFixture } from '../helpers/route-fixture';

const PROBE = 'RAG_ROUTE_FIXTURE_ENV_PROBE';

describe('route fixture env option', () => {
  let fixture: RouteFixture | null = null;

  afterEach(async () => {
    await fixture?.close();
    fixture = null;
    delete process.env[PROBE];
  });

  it('sets a variable for the fixture life and removes it on close', async () => {
    delete process.env[PROBE];
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { [PROBE]: 'on', RAG_PIPELINE: 'legacy' } });
    expect(process.env[PROBE]).toBe('on');
    expect(process.env.RAG_PIPELINE).toBe('legacy');
    await fixture.close();
    fixture = null;
    expect(PROBE in process.env).toBe(false);
  });

  it('undefined removes a pinned variable for the fixture life and restores the previous value on close', async () => {
    expect(loadPinnedEvalEnv().RAG_SUPPORTED_LANGUAGES).toBeDefined();
    const before = process.env.RAG_SUPPORTED_LANGUAGES;
    process.env.RAG_SUPPORTED_LANGUAGES = 'en';
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { RAG_SUPPORTED_LANGUAGES: undefined } });
    expect('RAG_SUPPORTED_LANGUAGES' in process.env).toBe(false);
    await fixture.close();
    fixture = null;
    expect(process.env.RAG_SUPPORTED_LANGUAGES).toBe('en');
    if (before === undefined) delete process.env.RAG_SUPPORTED_LANGUAGES;
    else process.env.RAG_SUPPORTED_LANGUAGES = before;
  });

  it('without the option the fixture applies the pin unchanged', async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    const pinned = loadPinnedEvalEnv();
    expect(process.env.RAG_PIPELINE).toBe(pinned.RAG_PIPELINE);
    expect(process.env.RAG_RERANKER).toBe(pinned.RAG_RERANKER);
  });

  it('auto without a key setting models a keyless install', async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { RAG_RERANKER: 'auto' } });
    expect(process.env.COHERE_API_KEY ?? '').toBe('');
  });

  it('an explicit provider keeps the fake edge placeholder key', async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { RAG_RERANKER: 'cohere' } });
    expect(process.env.COHERE_API_KEY).toMatch(/placeholder/);
  });

  it('auto with an explicit key setting keeps that key', async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'single-tenant',
      env: { RAG_RERANKER: 'auto', COHERE_API_KEY: 'cohere-test-placeholder-key' },
    });
    expect(process.env.COHERE_API_KEY).toBe('cohere-test-placeholder-key');
  });
});
