import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { checkBoundary } from '../../scripts/ci/check-rag-boundary.mjs';

// W-3 (04.1.1 verification): the terminology-rpc rule must also catch a rag_term_* name held in a string constant, not only a literal
// passed straight to .rpc() or .from(). Neutral placeholder code only.

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-boundary-term-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const terminologyHits = (root: string) => checkBoundary(root).filter((violation: { rule: string }) => violation.rule === 'terminology-rpc');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('terminology-rpc boundary rule', () => {
  test('catches a literal rag_term_ RPC outside the terminology module', () => {
    const root = tree({ 'src/lib/other/direct.ts': "export const run = (db: any) => db.rpc('rag_term_record_miss', {});\n" });
    expect(terminologyHits(root)).toHaveLength(1);
  });

  test('catches an RPC name held in a string constant', () => {
    const root = tree({
      'src/lib/other/constant.ts': [
        "const RECORDER = 'rag_term_record_miss';",
        'export const run = (db: any) => db.rpc(RECORDER, {});',
        '',
      ].join('\n'),
    });
    const hits = terminologyHits(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'src/lib/other/constant.ts', line: 1 });
  });

  test('catches exported, typed and double-quoted or template constants and a table name in a constant', () => {
    const root = tree({
      'src/lib/other/exported.ts': 'export const RPC: string = "rag_term_list_entries";\n',
      'src/lib/other/template.ts': 'export const NAMES = { table: `rag_term_entries` };\n',
    });
    expect(terminologyHits(root).map((hit: { file: string }) => hit.file).sort()).toEqual(['src/lib/other/exported.ts', 'src/lib/other/template.ts']);
  });

  test('allows the same constants inside src/lib/rag/terminology/ and ignores comments', () => {
    const root = tree({
      'src/lib/rag/terminology/inside.ts': "export const RECORDER = 'rag_term_record_miss';\n",
      'src/lib/other/comment.ts': "// the recorder is 'rag_term_record_miss'\nexport const value = 1;\n",
    });
    expect(terminologyHits(root)).toEqual([]);
  });

  test('the repository passes the rule', () => {
    expect(checkBoundary().filter((violation: { rule: string }) => violation.rule === 'terminology-rpc')).toEqual([]);
  });
});
