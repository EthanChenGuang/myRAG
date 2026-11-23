import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile } from '@/lib/rag/types';
import { SEMANTIC_QUERY, adminWithRpc, fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

function recordingRpc() {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inner = fakeRpcClient({ rows: [] });
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return inner.client.rpc(fn, args);
    },
  };
  return { client, calls };
}

beforeEach(() => {
  uninstallDeps();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('text search runs on the server-side admin client', () => {
  test.each<Profile>(['chat', 'embed', 'eval'])('profile %s searches through the admin client with ids from the scope', async (profile) => {
    const rpc = recordingRpc();
    installDeps({ embedder: fakeEmbedder().embedder, ragEnv: () => ({}), adminClient: adminWithRpc(rpc.client as never) });

    const result = await runRetrieval({
      scope: mintScope('org', USER_A, ORG_O),
      query: SEMANTIC_QUERY,
      profile,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('empty');
    expect(rpc.calls.length).toBeGreaterThan(0);
    for (const call of rpc.calls) {
      expect(call.fn).toBe('match_documents_by_workspace');
      expect(call.args).toMatchObject({ p_org_id: ORG_O, p_user_id: USER_A });
    }
  });

  test('without an admin client the search fails closed instead of using another client', async () => {
    installDeps({ embedder: fakeEmbedder().embedder, ragEnv: () => ({}), adminClient: () => null });

    const result = await runRetrieval({
      scope: mintScope('single', null, null),
      query: SEMANTIC_QUERY,
      profile: 'chat',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('error');
    expect(result.reason).toBe('search_failed');
  });

  test('the pipeline module has no path to the anonymous Supabase client', () => {
    const root = path.resolve(__dirname, '../../src/lib/rag');
    for (const file of ['pipeline.ts', 'deps.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source, file).not.toMatch(/anonClient|getSupabase\(/);
    }
  });
});
