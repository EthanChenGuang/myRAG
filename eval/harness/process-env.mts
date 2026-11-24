import type { DeploymentMode } from './pglite-supabase.mts';
import { loadPinnedEvalEnv } from './eval-env.mts';
import { fixtureProcessEnv } from './fake-edge.mts';

type MutableEnv = Record<string, string | undefined>;

/**
 * The process environment of an in-process eval run: every RAG_ variable is replaced by the pinned eval values and the
 * Supabase and OpenAI endpoints point at the fake edge. It must run before the first import of a module that reads
 * `@/lib/env`, which keeps the values it saw at import time.
 */
export function applyFixtureProcessEnv(options: { edgeUrl: string; deploymentMode: DeploymentMode; extra?: Record<string, string> }): void {
  const env = process.env as MutableEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_')) delete env[name];
  }
  Object.assign(env, loadPinnedEvalEnv());
  Object.assign(env, fixtureProcessEnv(options.edgeUrl));
  env.NODE_ENV = 'test';
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = options.deploymentMode;
  env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  Object.assign(env, options.extra ?? {});
}
