import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('backfill sources', () => {
  test('lists folder and bucket refs and rejects unsafe manifest lines', async () => {
    const { listSource } = await import('@/lib/rag/ingest/backfill/sources');
    const root = await mkdtemp(path.join(os.tmpdir(), 'bf-src-'));
    await writeFile(path.join(root, 'a.txt'), 'alpha');
    const folder: string[] = [];
    for await (const item of listSource({ kind: 'folder', ref: root })) folder.push(item.sourceKey);
    expect(folder).toEqual(['a.txt']);

    const buckets: string[] = [];
    for await (const item of listSource({
      kind: 'bucket',
      ref: 'bf-fixture',
      deps: {
        storage: {
          from: () => ({
            list: async () => ({
              data: [{ name: 'one.pdf', id: 'obj-one', metadata: { size: 12 } }],
              error: null,
            }),
            download: async () => ({ data: null, error: null }),
          }),
        },
      },
    })) {
      buckets.push(item.sourceKey);
    }
    expect(buckets).toEqual(['one.pdf']);

    const rejected: string[] = [];
    const manifest = path.join(root, 'bad.jsonl');
    await writeFile(manifest, `${JSON.stringify({ source_key: 'x', path: '/a', url: 'https://a.test' })}\n`);
    for await (const _ of listSource({
      kind: 'manifest',
      ref: manifest,
      deps: { onManifestReject: (reason) => rejected.push(reason) },
    })) {
      /* none */
    }
    expect(rejected).toHaveLength(1);
  });
});