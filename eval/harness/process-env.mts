import type { DeploymentMode } from './pglite-supabase.mts';
import { loadPinnedEvalEnv } from './eval-env.mts';
import { fixtureProcessEnv } from './fake-edge.mts';
import { RUN_CONFIG_FIXTURE_KEY_TOKEN } from './run-config.mts';

type MutableEnv = Record<string, string | undefined>;

/**
 * The process environment of an in-process eval run: every RAG_ variable is replaced by the pinned eval values and the
 * Supabase and OpenAI endpoints point at the fake edge. It must run before the first import of a module that reads
 * `@/lib/env`, which keeps the values it saw at import time.
 */
export function applyFixtureProcessEnv(options: {
  edgeUrl: string;
  deploymentMode: DeploymentMode;
  extra?: Record<string, string>;
  vendorEmbeddingRoutes?: boolean;
  /** --env-overlay runs: set the fixture pins (fake-edge endpoints, deployment mode, embedder) again after `extra`. */
  reapplyFixturePins?: boolean;
}): void {
  const env = process.env as MutableEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_')) delete env[name];
  }
  Object.assign(env, loadPinnedEvalEnv());
  const fixture = fixtureProcessEnv(options.edgeUrl, { vendorEmbeddingRoutes: options.vendorEmbeddingRoutes === true });
  Object.assign(env, fixture);
  const pin = (): void => {
    env.NODE_ENV = 'test';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = options.deploymentMode;
    env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  };
  pin();
  const extra = options.extra ?? {};
  Object.assign(env, extra);
  if (options.reapplyFixturePins === true) {
    Object.assign(env, fixture);
    pin();
  }
  for (const name of ['COHERE_API_KEY', 'VOYAGE_API_KEY'] as const) {
    if (extra[name] === RUN_CONFIG_FIXTURE_KEY_TOKEN) env[name] = fixture[name];
  }
  // Phase 4.1 D-12: `auto` is judged keyless unless the run asks for the hosted path, so the fake edge's key must not choose it.
  if (env.RAG_RERANKER === 'auto' && extra.COHERE_API_KEY === undefined) env.COHERE_API_KEY = '';
}
