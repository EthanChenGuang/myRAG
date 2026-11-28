/**
 * The sidecar harness never lets tiktoken fetch cl100k_base from the network. Every child gets TIKTOKEN_CACHE_DIR; with a valid cache the
 * encoding loads with no connection, and with an empty cache the harness stops before spawning, with a message that says how to fill it.
 * A sentinel proxy counts any connection the child makes.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSidecarModule, type SpawnSidecarResult } from '../eval/harness/sidecar-worker.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CL100K_URL = 'https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken';
const CL100K_SHA256 = '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7';
const CL100K_CACHE_FILE = crypto.createHash('sha1').update(CL100K_URL).digest('hex');

function validCacheDir(): string | null {
  const dir = process.env.TIKTOKEN_CACHE_DIR || path.join(REPO_ROOT, '.cache', 'tiktoken');
  try {
    const bytes = fs.readFileSync(path.join(dir, CL100K_CACHE_FILE));
    return crypto.createHash('sha256').update(bytes).digest('hex') === CL100K_SHA256 ? dir : null;
  } catch {
    return null;
  }
}

describe('sidecar harness tiktoken cache', () => {
  let sentinel: net.Server;
  let proxyUrl: string;
  let connections = 0;
  let probeDir: string;
  let emptyCache: string;
  const savedCacheDir = process.env.TIKTOKEN_CACHE_DIR;
  const cacheDir = validCacheDir();

  before(async () => {
    sentinel = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(sentinel.address() as net.AddressInfo).port}`;
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktoken-probe-'));
    fs.writeFileSync(
      path.join(probeDir, 'tiktoken_probe.py'),
      "import tiktoken\nprint('tokens', len(tiktoken.get_encoding('cl100k_base').encode('hello world')))\n",
    );
    emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktoken-empty-'));
  });

  after(async () => {
    if (savedCacheDir === undefined) delete process.env.TIKTOKEN_CACHE_DIR;
    else process.env.TIKTOKEN_CACHE_DIR = savedCacheDir;
    await new Promise<void>((resolve) => sentinel.close(() => resolve()));
    fs.rmSync(probeDir, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  });

  function probeEnv(): Record<string, string> {
    return {
      PYTHONPATH: probeDir,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      UV_OFFLINE: '1',
      UV_FROZEN: '1',
    };
  }

  async function runProbe(): Promise<{ result: SpawnSidecarResult | null; thrown: unknown }> {
    try {
      return { result: await spawnSidecarModule('tiktoken_probe', [], probeEnv(), { timeoutMs: 120_000 }).done, thrown: null };
    } catch (error) {
      return { result: null, thrown: error };
    }
  }

  test('an empty cache stops the harness before any download, with a message naming TIKTOKEN_CACHE_DIR', async () => {
    process.env.TIKTOKEN_CACHE_DIR = emptyCache;
    connections = 0;
    try {
      const { result, thrown } = await runProbe();
      assert.equal(connections, 0, `the child tried the network: ${result?.stderr.slice(-800) ?? ''}`);
      assert.ok(thrown instanceof Error, 'the harness fails fast instead of spawning');
      assert.match(thrown.message, /TIKTOKEN_CACHE_DIR/);
      assert.match(thrown.message, /fill-tiktoken-cache/);
      assert.deepEqual(fs.readdirSync(emptyCache), [], 'nothing was downloaded into the cache');
    } finally {
      if (savedCacheDir === undefined) delete process.env.TIKTOKEN_CACHE_DIR;
      else process.env.TIKTOKEN_CACHE_DIR = savedCacheDir;
    }
  });

  test('a filled cache loads cl100k_base in the child with no connection', { skip: cacheDir ? false : 'no cl100k_base cache to test with' }, async () => {
    connections = 0;
    const { result, thrown } = await runProbe();
    assert.equal(thrown, null);
    assert.equal(connections, 0, `the child tried the network: ${result?.stderr.slice(-800) ?? ''}`);
    assert.equal(result?.exitCode, 0, result?.stderr.slice(-2000));
    assert.match(result?.stdout ?? '', /tokens 2/);
    assert.equal(result?.env.TIKTOKEN_CACHE_DIR, cacheDir);
  });
});
