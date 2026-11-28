import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { expect, vi } from 'vitest';
import { loadPinnedEvalEnv } from '../../eval/harness/eval-env.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
export const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
export const SNAPSHOT_DIR = path.join(REPO_ROOT, 'tests/fixtures/characterization');
export const INTERNAL_API_KEY = 'test-internal-api-key-placeholder';

export interface RouteFixture {
  edge: FakeEdge;
  fixtureUserId: string;
  loadRoute<T = Record<string, (...args: any[]) => Promise<Response>>>(routePath: string): Promise<T>;
  close(): Promise<void>;
}

export interface GoldenQuestion {
  id: string;
  question: string;
}

export function readGoldenQuestions(): GoldenQuestion[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const item = JSON.parse(line) as { id: string; question: string };
      return { id: item.id, question: item.question };
    });
}

export function expectCharacterization(name: string, actual: unknown): void {
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  if (process.env.UPDATE_CHARACTERIZATION === '1') {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  expect(fs.existsSync(file), `characterization snapshot ${name}.json is missing; rerun with UPDATE_CHARACTERIZATION=1`).toBe(true);
  expect(actual).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function systemTextOf(params: Record<string, any>): string {
  if (typeof params.system === 'string') return params.system;
  const messages: Array<{ role: string; content: unknown }> = Array.isArray(params.messages) ? params.messages : [];
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n\n---SYSTEM-MESSAGE---\n\n');
}

export interface RouteFixtureOptions {
  deploymentMode: DeploymentMode;
  /** Two users, a personal document each and an organization document (multi-tenant only). Also lets the edge answer filename lookups. */
  twoTenant?: boolean;
  /** Lets the edge answer filename lookups (the chat route resolves @mentions that way) without the two-tenant corpus. */
  documentFilenameFilter?: boolean;
  /** Extra rows inserted into the fixture database before the fake edge starts. */
  seed?: (db: PGlite) => Promise<void>;
  /**
   * Applied after the pinned eval env and the fixture process env, restored on close. `undefined` removes the variable
   * for the fixture's life (an unset pipeline or unset languages).
   */
  env?: Record<string, string | undefined>;
}

export async function startRouteFixture(options: RouteFixtureOptions): Promise<RouteFixture> {
  const { deploymentMode } = options;
  if (options.twoTenant && deploymentMode !== 'multi-tenant') {
    throw new Error('[Route Fixture] twoTenant needs the multi-tenant deployment mode');
  }
  const fixture = options.twoTenant
    ? await createTwoTenantDatabase({ corpusDir: CORPUS_DIR })
    : await createFixtureDatabase({ deploymentMode, corpusDir: CORPUS_DIR });
  if (options.seed) {
    try {
      await options.seed(fixture.db);
    } catch (error) {
      await fixture.db.close().catch(() => undefined);
      throw error;
    }
  }
  let edge: FakeEdge;
  try {
    edge = await startFakeEdge({ db: fixture.db, documentFilenameFilter: options.twoTenant === true || options.documentFilenameFilter === true });
  } catch (error) {
    await fixture.db.close().catch(() => undefined);
    throw error;
  }

  const env = process.env as Record<string, string | undefined>;
  const previous = { ...env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_')) delete env[name];
  }
  Object.assign(env, loadPinnedEvalEnv());
  Object.assign(env, fixtureProcessEnv(edge.url));
  env.NODE_ENV = 'test';
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = deploymentMode;
  env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
  env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS = '*';
  env.EMBED_RATE_LIMIT = '100000';
  env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
  const overrides = options.env ?? {};
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  // Phase 4.1: `auto` models a keyless install unless the caller sets the key, so the fake edge's key must not choose Cohere.
  if (env.RAG_RERANKER?.trim().toLowerCase() === 'auto' && !Object.prototype.hasOwnProperty.call(overrides, 'COHERE_API_KEY')) {
    env.COHERE_API_KEY = '';
  }

  return {
    edge,
    fixtureUserId: fixture.fixtureUserId ?? FIXTURE_USER_ID,
    async loadRoute<T>(routePath: string): Promise<T> {
      vi.resetModules();
      return (await import(/* @vite-ignore */ `@/app/api/${routePath}/route`)) as T;
    },
    async close() {
      await edge.close();
      await fixture.db.close().catch(() => undefined);
      for (const name of Object.keys(env)) {
        if (!(name in previous)) delete env[name];
      }
      Object.assign(env, previous);
    },
  };
}
