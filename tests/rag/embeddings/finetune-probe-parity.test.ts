import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { checkFinetuneProbe, resetFinetuneProbeCacheForTests } from '@/lib/rag/embeddings/finetune-slot';
import { startFakeEmbeddingEndpoints, type FakeEmbeddingEndpoints } from '../../helpers/fake-embedding-endpoints';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = 'ft-probe-parity-v1';

/** The fake model both sides share: a deterministic vector of the exact string the model sees (prompt + text). */
function hashVector(input: string): number[] {
  const out: number[] = [];
  for (let block = 0; block < 32; block += 1) {
    for (const byte of createHash('sha256').update(`${input}\u0000${block}`, 'utf8').digest()) out.push((byte - 127.5) / 127.5);
  }
  return out;
}

const PROBE_PY = `
import hashlib, json, sys
import numpy as np
from rag_eval.finetune import train
from rag_eval.finetune.config import load_finetune_config


def hash_vector(value):
    out = []
    for block in range(32):
        out.extend((byte - 127.5) / 127.5 for byte in hashlib.sha256(f"{value}\\u0000{block}".encode("utf-8")).digest())
    return out


class HashModel:
    def encode(self, texts, prompt=None, normalize_embeddings=False, **_):
        rows = np.asarray([hash_vector(f"{prompt or ''}{text}") for text in texts], dtype=np.float64)
        return rows / np.linalg.norm(rows, axis=1, keepdims=True) if normalize_embeddings else rows


base = next(m for m in load_finetune_config().base_models if m.default)
probe = train.probe_set(HashModel(), base)
json.dump({"base_model": base.id, "probe": probe.model_dump(mode="json")}, sys.stdout)
`;

interface PythonProbe {
  base_model: string;
  probe: { texts: string[]; vectors: number[][]; query_prompt: string; document_prompt: string };
}

let fake: FakeEmbeddingEndpoints;
let built: PythonProbe;

function installRegistry(row: Record<string, unknown>): void {
  const client: RpcClient = {
    rpc: (fn) => {
      const response: RpcResponse = { data: fn === 'rag_finetune_list_models' ? [row] : [], error: null };
      const pending: RpcRequest = {
        abortSignal: () => pending,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return pending;
    },
  };
  setRagDepsForTests({ adminClient: () => client as never, now: () => 1_000_000 });
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-probe-parity-'));
  const script = path.join(dir, 'probe_card.py');
  fs.writeFileSync(script, PROBE_PY);
  const run = spawnSync('uv', ['run', '--frozen', '--directory', path.join(REPO_ROOT, 'eval'), 'python', script], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0) throw new Error(`probe card build failed: ${run.stderr}`);
  built = JSON.parse(run.stdout) as PythonProbe;
  fake = await startFakeEmbeddingEndpoints();
  fake.setFtEncoder(hashVector);
}, 120_000);

afterAll(async () => {
  await fake?.stop();
});

afterEach(() => {
  resetRagDepsForTests();
  resetFinetuneProbeCacheForTests();
  vi.restoreAllMocks();
});

describe('fine-tune probe parity between training (Python) and serving (TypeScript)', () => {
  it('a probe card computed by train.probe_set for the default base model passes checkFinetuneProbe on an endpoint serving the same model', async () => {
    const { probe } = built;
    expect(probe.query_prompt).not.toBe(probe.document_prompt);
    installRegistry({
      id: VERSION,
      status: 'bound',
      bound_slot: 'ft-a-1024',
      dims: 1024,
      query_prompt: probe.query_prompt,
      document_prompt: probe.document_prompt,
      probe,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await checkFinetuneProbe('a', {
      config: () => ({
        baseUrl: fake.urls.ft,
        model: VERSION,
        queryPrompt: probe.query_prompt,
        documentPrompt: probe.document_prompt,
        apiKey: '',
        retries: 0,
        backoffMs: 0,
      }),
    });
    expect(result.reason).toBe('match');
    expect(result.ok).toBe(true);
    expect(result.minCosine).toBeGreaterThanOrEqual(0.999);
  });
});
