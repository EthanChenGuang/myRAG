import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BundleError,
  decodeF32,
  encodeF32,
  readBundleManifest,
  readKeptQueries,
  readVectorSet,
  vectorFileBase,
  withStagedSets,
} from '@/lib/rag/finetune/bundle-io';
import { main } from '@/lib/rag/finetune/cli';

const SAMPLES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/contracts/samples.json'), 'utf8')) as {
  samples: Record<string, Record<string, unknown>>;
};
const MANIFEST = SAMPLES.samples.DatasetManifest;
const TENANT = 's:default';

const dirs: string[] = [];
function bundle(manifest: unknown = MANIFEST): string {
  // null writes no manifest
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bundle-'));
  dirs.push(dir);
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

function pair(id: string, split: 'train' | 'dev' | 'test', tenant = TENANT): Record<string, unknown> {
  return {
    pair_id: id,
    tenant_key: tenant,
    language: 'en',
    positive_language: 'en',
    anchor: `neutral synthetic question ${id}`,
    positive_chunk_id: `chunk-${id}`,
    positive: 'A neutral synthetic sentence.',
    negatives: [],
    source: 'synthetic',
    split,
    weight: 1,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundle manifest', () => {
  it('reads a manifest that validates as DatasetManifest', () => {
    expect(readBundleManifest(bundle()).tenant_keys).toEqual([TENANT]);
  });

  it('refuses a missing bundle, a missing manifest and a manifest that fails the schema', () => {
    const codeOf = (dir: string) => {
      try {
        readBundleManifest(dir);
        return 'accepted';
      } catch (error) {
        return error instanceof BundleError ? error.code : String(error);
      }
    };
    expect(codeOf(path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`))).toBe('bundle_missing');
    expect(codeOf(bundle(null))).toBe('manifest_missing');
    expect(codeOf(bundle({ ...MANIFEST, purpose: 'everyone' }))).toBe('manifest_invalid');
    expect(codeOf(bundle({ ...MANIFEST, tenant_keys: ['not-a-key'] }))).toBe('manifest_invalid');
    expect(codeOf(bundle({ ...MANIFEST, extra: true }))).toBe('manifest_invalid');
  });
});

describe('f32 vector files', () => {
  const matrix = [
    [0.5, -1.25, 3, 0],
    [1e-3, 2, -0.75, 4.5],
    [-8, 0.125, 0.25, 1],
  ];

  it('round-trips a 3x4 matrix, row-major little-endian', () => {
    const buffer = encodeF32(matrix, 4);
    expect(buffer.length).toBe(3 * 4 * 4);
    expect(buffer.readFloatLE(4)).toBe(-1.25);
    expect(buffer.readFloatLE(4 * 4)).toBeCloseTo(1e-3, 7);
    expect(decodeF32(buffer, 4).map((row) => Array.from(row))).toEqual(matrix.map((row) => row.map((x) => Math.fround(x))));
  });

  it('writes f32, rows and a header whose sha256 matches the file', async () => {
    const dir = bundle();
    const base = vectorFileBase('chunks', TENANT, 'openai-3-small-1536');
    expect(base).toBe('vectors/s_default.openai-3-small-1536');
    await withStagedSets(async (stage) => {
      const set = stage(base, { tenantKey: TENANT, profileId: 'openai-3-small-1536', model: 'text-embedding-3-small', dims: 4 });
      matrix.forEach((row, index) => set.append(row, { chunk_id: `c-${index}`, row_index: index }));
    }, dir);
    const data = fs.readFileSync(path.join(dir, `${base}.f32`));
    const { header, vectors } = readVectorSet(dir, base);
    expect(header.sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'));
    expect(header).toMatchObject({ tenant_key: TENANT, rows: 3, dims: 4, dtype: 'float32-le' });
    expect(vectors.map((row) => Array.from(row))).toEqual(matrix.map((row) => row.map((x) => Math.fround(x))));
    expect(fs.readFileSync(path.join(dir, `${base}.rows.jsonl`), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(fs.statSync(path.join(dir, `${base}.f32`)).mode & 0o777).toBe(0o600);
  });

  it('a tampered f32 file fails the sha256 check', async () => {
    const dir = bundle();
    const base = vectorFileBase('queries', TENANT, 'p1');
    await withStagedSets(async (stage) => {
      stage(base, { tenantKey: TENANT, profileId: 'p1', model: 'm', dims: 4 }).append(matrix[0], { query_id: 'q' });
    }, dir);
    const file = path.join(dir, `${base}.f32`);
    const data = fs.readFileSync(file);
    data.writeFloatLE(9, 0);
    fs.writeFileSync(file, data);
    expect(() => readVectorSet(dir, base)).toThrowError(/sha256_mismatch/);
  });

  it('a failure before commit leaves no file behind', async () => {
    const dir = bundle();
    await expect(
      withStagedSets(async (stage) => {
        stage('vectors/x.p1', { tenantKey: TENANT, profileId: 'p1', model: 'm', dims: 4 }).append(matrix[0], {});
        throw new Error('provider failed');
      }, dir),
    ).rejects.toThrow('provider failed');
    expect(fs.readdirSync(path.join(dir, 'vectors'))).toEqual([]);
  });
});

describe('kept queries', () => {
  it('reads train/dev, test and mined rows in file order and refuses a foreign tenant', () => {
    const dir = bundle();
    fs.writeFileSync(path.join(dir, 'queries.kept.jsonl'), `${JSON.stringify(pair('q1', 'train'))}\n${JSON.stringify(pair('q2', 'dev'))}\n`);
    fs.writeFileSync(path.join(dir, 'queries.test.kept.jsonl'), `${JSON.stringify(pair('q3', 'test'))}\n`);
    fs.writeFileSync(path.join(dir, 'pairs.mined.jsonl'), `${JSON.stringify({ ...pair('q4', 'train'), source: 'mined', weight: 2 })}\n`);
    const manifest = readBundleManifest(dir);
    expect(readKeptQueries(dir, manifest).map((query) => query.pairId)).toEqual(['q1', 'q2', 'q3', 'q4']);
    fs.appendFileSync(path.join(dir, 'pairs.mined.jsonl'), `${JSON.stringify(pair('q5', 'train', 'u:00000000-0000-4000-8000-0000000000b1'))}\n`);
    expect(() => readKeptQueries(dir, manifest)).toThrowError(/rows_foreign_tenant/);
  });
});

describe('rag:finetune CLI switch', () => {
  it('refuses with RAG_FINETUNE unset', async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    for (const value of [undefined, 'ON', 'true']) {
      lines.length = 0;
      const env: Record<string, string> = value === undefined ? {} : { RAG_FINETUNE: value };
      const code = await main(['export-vectors', '--bundle', bundle()], io, undefined, env);
      expect(code).not.toBe(0);
      expect(lines.join('\n')).toContain('RAG_FINETUNE is off');
    }
  });

  it('parses its arguments and refuses unknown ones', async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    expect(await main(['export-vectors'], io, undefined, { RAG_FINETUNE: 'on' })).toBe(2);
    expect(await main(['export-vectors', '--bundle', 'x', '--tenant', 's:default'], io, undefined, { RAG_FINETUNE: 'on' })).toBe(2);
    expect(await main(['train'], io, undefined, { RAG_FINETUNE: 'on' })).toBe(2);
  });
});
