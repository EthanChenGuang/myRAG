import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as boundary from '../ci/check-rag-boundary.mjs';
import { ALLOWLIST, RULES, checkBoundary, stripComments } from '../ci/check-rag-boundary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-rag-boundary.mjs');

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-boundary-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

function rulesFor(files) {
  const root = makeRoot(files);
  return checkBoundary(root).map((v) => `${v.file}:${v.rule}`);
}

function ruleIds(files) {
  const root = makeRoot(files);
  return checkBoundary(root).map((v) => v.rule);
}

test('exports a rule list with unique ids and an allow-list naming every exemption', () => {
  const ids = RULES.map((r) => r.id);
  assert.ok(ids.length >= 7);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'embeddings-call',
    'retrieval-rpc',
    'retired-module',
    'deep-import',
    'vector-or-rerank-client',
    'mint-scope',
    'voice-agent-rpc',
  ]) {
    assert.ok(ids.includes(id), `missing rule ${id}`);
  }
  const allowed = ALLOWLIST.map((a) => a.path);
  assert.ok(allowed.includes('tests/'));
  assert.ok(allowed.includes('eval/harness/'));
  assert.ok(allowed.includes('scripts/tests/'));
  assert.ok(allowed.includes('scripts/rag/reprocess-documents.js'));
});

test('embeddings-call: flagged outside src/lib/rag and allowed inside', () => {
  const code = "const r = await openai.embeddings.create({ input: 'x' });\n";
  assert.deepEqual(rulesFor({ 'src/app/x/route.ts': code }), ['src/app/x/route.ts:embeddings-call']);
  assert.deepEqual(rulesFor({ 'src/lib/rag/embeddings/x.ts': code }), []);
});

test('embeddings-call: a mention inside a comment is ignored', () => {
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': '// openai.embeddings.create( is banned here\nexport const a = 1;\n' }), []);
});

test('retrieval-rpc: single-line, multi-line double-quote and template-literal forms', () => {
  const files = {
    'src/lib/a.ts': "const r = await db.rpc('match_document_chunks', args);\n",
    'src/lib/b.ts': 'const r = await db.rpc(\n  "hybrid_search",\n  args,\n);\n',
    'src/lib/c.ts': 'const r = await db.rpc(`search_chunks_by_keywords`, args);\n',
  };
  const out = rulesFor(files).sort();
  assert.deepEqual(out, [
    'src/lib/a.ts:retrieval-rpc',
    'src/lib/b.ts:retrieval-rpc',
    'src/lib/c.ts:retrieval-rpc',
  ]);
  assert.deepEqual(rulesFor({ 'src/lib/rag/backend/x.ts': files['src/lib/a.ts'] }), []);
});

test('retrieval-rpc: unrelated rpc names are not flagged under src', () => {
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "await db.rpc('increment_counter', {});\n" }), []);
});

test('retired-module: alias and relative imports fail', () => {
  const files = {
    'src/app/a.ts': "import { x } from '@/lib/enhanced-rag-retrieval';\n",
    'src/app/b.ts': "import { y } from '../lib/reranker-local';\n",
    'src/app/c.ts': "import { z } from '@/lib/thinking-rag-enhancer';\n",
    'src/lib/d.ts': "import { w } from './bm25-scorer';\n",
  };
  assert.deepEqual(rulesFor(files).sort(), [
    'src/app/a.ts:retired-module',
    'src/app/b.ts:retired-module',
    'src/app/c.ts:retired-module',
    'src/lib/d.ts:retired-module',
  ]);
});

test('retired-module: same file names inside src/lib/rag stay legal', () => {
  assert.deepEqual(rulesFor({ 'src/lib/rag/rerank/a.ts': "import { x } from './reranker-local';\n" }), []);
});

test('deep-import: a path below @/lib/rag fails, the public index passes', () => {
  assert.deepEqual(
    rulesFor({ 'src/app/a.ts': "import { x } from '@/lib/rag/legacy/enhanced-retrieval';\n" }),
    ['src/app/a.ts:deep-import'],
  );
  assert.deepEqual(rulesFor({ 'src/app/b.ts': "import { x } from '@/lib/rag';\n" }), []);
  assert.deepEqual(rulesFor({ 'src/app/c.ts': "import { x } from '@/lib/rag/index';\n" }), []);
});

test('vector-or-rerank-client: client packages and AI SDK embed/embedMany/rerank fail', () => {
  const files = {
    'src/lib/a.ts': "import weaviate from 'weaviate-client';\n",
    'src/lib/b.ts': "import { QdrantClient } from '@qdrant/js-client-rest';\n",
    'src/lib/c.ts': "import { CohereClient } from 'cohere-ai';\n",
    'src/lib/d.ts': "import { VoyageAIClient } from 'voyageai';\n",
    'src/lib/e.ts': "import { embed } from 'ai';\n",
    'src/lib/f.ts': "import { streamText, embedMany } from 'ai';\n",
    'src/lib/g.ts': "import {\n  rerank,\n} from 'ai';\n",
  };
  const out = rulesFor(files).sort();
  assert.equal(out.length, 7);
  assert.ok(out.every((entry) => entry.endsWith(':vector-or-rerank-client')));
});

test('vector-or-rerank-client: streamText from ai is fine, and the rule is inactive inside src/lib/rag', () => {
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "import { streamText } from 'ai';\n" }), []);
  assert.deepEqual(rulesFor({ 'src/lib/rag/embeddings/a.ts': "import { embedMany } from 'ai';\n" }), []);
});

test('mint-scope: only the mintScope binding is restricted outside src/lib/rag/tenant', () => {
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/context/x.ts': "import { mintScope } from '../tenant/scope';\n" }),
    ['src/lib/rag/context/x.ts:mint-scope'],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/tenant/voice.ts': "import { mintScope, type TenantScope } from './scope';\n" }),
    [],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/context/y.ts': "import { isTenantScope, scopeKey } from '../tenant/scope';\n" }),
    [],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/context/z.ts': "import {\n  scopeKey,\n  mintScope as mint,\n} from '../tenant/scope';\n" }),
    ['src/lib/rag/context/z.ts:mint-scope'],
  );
});

test('mint-scope: re-exports and require destructuring of mintScope are caught too', () => {
  const out = ruleIds({
    'src/lib/rag/index.ts': "export { mintScope } from './tenant/scope';\n",
    'scripts/x.js': "const { mintScope } = require('../src/lib/rag/tenant/scope');\n",
  });
  assert.deepEqual(out.filter((r) => r === 'mint-scope').length, 2);
});

test('exempt paths: tests/, eval/harness/ and the offline re-embed script are skipped', () => {
  const bad = "import { mintScope } from '@/lib/rag/tenant/scope';\nawait db.rpc('match_documents', {});\nawait o.embeddings.create({});\n";
  assert.deepEqual(
    rulesFor({
      'tests/rag/a.test.ts': bad,
      'eval/harness/b.mts': bad,
      'scripts/rag/reprocess-documents.js': bad,
    }),
    [],
  );
  assert.ok(rulesFor({ 'scripts/rag/other-script.js': bad }).length >= 3);
});

test('voice-agent/src: any .rpc( and embeddings.create( fail', () => {
  const out = rulesFor({
    'voice-agent/src/a.ts': "await supabase.rpc('anything', {});\n",
    'voice-agent/src/b.ts': 'await o.embeddings.create({});\n',
  }).sort();
  assert.deepEqual(out, ['voice-agent/src/a.ts:voice-agent-rpc', 'voice-agent/src/b.ts:embeddings-call']);
});

test('node_modules, .next and dist are not scanned', () => {
  assert.deepEqual(
    rulesFor({
      'src/node_modules/p/a.ts': 'await o.embeddings.create({});\n',
      'src/.next/a.ts': 'await o.embeddings.create({});\n',
      'scripts/dist/a.js': 'await o.embeddings.create({});\n',
    }),
    [],
  );
});

test('violations carry file, 1-based line and rule id', () => {
  const root = makeRoot({ 'src/lib/a.ts': "const a = 1;\n\nawait db.rpc('match_x', {});\n" });
  const [v] = checkBoundary(root);
  assert.equal(v.file, 'src/lib/a.ts');
  assert.equal(v.line, 3);
  assert.equal(v.rule, 'retrieval-rpc');
});

test('CLI exits 1 with file:line and rule on violations and 0 on a clean root', () => {
  const bad = makeRoot({ 'src/app/x/route.ts': 'await o.embeddings.create({});\n' });
  const failed = spawnSync(process.execPath, [SCRIPT, '--root', bad], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /src\/app\/x\/route\.ts:1 \[embeddings-call\]/);
  const clean = makeRoot({ 'src/app/x/route.ts': "import { x } from '@/lib/rag';\n" });
  const passed = spawnSync(process.execPath, [SCRIPT, '--root', clean], { encoding: 'utf8' });
  assert.equal(passed.status, 0);
});

test('the real tree has no boundary violations', () => {
  assert.deepEqual(checkBoundary(ROOT), []);
});

test('exports the Phase 3 rule ids alongside the Phase 2 rules', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['chunk-writer', 'document-insert', 'writer-rpc', 'doc-type-branching']) {
    assert.ok(ids.includes(id), `missing rule ${id}`);
  }
});

test('chunk-writer: insert, update and upsert on document_chunks fail outside src/lib/rag/ingest', () => {
  const files = {
    'src/app/api/x/route.ts': "await admin.from('document_chunks').insert(rows);\n",
    'src/app/api/y/route.ts': 'await admin\n  .from("document_chunks")\n  .update({ status: \'ready\' })\n  .eq(\'id\', id);\n',
    'src/lib/z.ts': 'await admin.from(`document_chunks`).upsert(rows);\n',
  };
  assert.deepEqual(rulesFor(files).sort(), [
    'src/app/api/x/route.ts:chunk-writer',
    'src/app/api/y/route.ts:chunk-writer',
    'src/lib/z.ts:chunk-writer',
  ]);
});

test('chunk-writer: reads and deletes pass, and so does the same write inside src/lib/rag/ingest', () => {
  const write = "await admin.from('document_chunks').insert(rows);\n";
  assert.deepEqual(rulesFor({ 'src/app/api/x/route.ts': "await admin.from('document_chunks').select('id');\n" }), []);
  assert.deepEqual(rulesFor({ 'src/app/api/x/route.ts': "await admin.from('document_chunks').delete().eq('id', id);\n" }), []);
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/writer.ts': write }), []);
  assert.deepEqual(rulesFor({ 'src/lib/rag/context/x.ts': write }), ['src/lib/rag/context/x.ts:chunk-writer']);
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "// admin.from('document_chunks').insert(rows) is banned here\nexport const a = 1;\n" }), []);
});

test('document-insert: insert on documents fails, update passes, and the ingest module is exempt', () => {
  assert.deepEqual(
    rulesFor({ 'src/lib/foo.ts': "await admin.from('documents').insert({ id });\n" }),
    ['src/lib/foo.ts:document-insert'],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/bar.ts': 'await admin\n  .from("documents")\n  .insert([row]);\n' }),
    ['src/lib/bar.ts:document-insert'],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/baz.ts': "await admin.from('documents').upsert({ id });\n" }),
    ['src/lib/baz.ts:document-insert'],
  );
  assert.deepEqual(rulesFor({ 'src/lib/foo.ts': "await admin.from('documents').update({ metadata }).eq('id', id);\n" }), []);
  assert.deepEqual(rulesFor({ 'src/lib/foo.ts': "await admin.from('documents').select('id');\n" }), []);
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/writer.ts': "await admin.from('documents').insert({ id });\n" }), []);
});

test('writer-rpc: each ingest writer RPC fails outside src/lib/rag/ingest and passes inside', () => {
  const names = [
    'rag_begin_document_version',
    'rag_write_chunks',
    'rag_publish_document_version',
    'rag_set_document_fields',
    'rag_save_ingest_state',
  ];
  const outside = {};
  names.forEach((name, i) => {
    outside[`src/app/api/n${i}/route.ts`] = i % 2 ? `await db.rpc(\n  "${name}",\n  args,\n);\n` : `await db.rpc('${name}', args);\n`;
  });
  const out = rulesFor(outside).sort();
  assert.equal(out.length, names.length);
  assert.ok(out.every((entry) => entry.endsWith(':writer-rpc')));
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/writer.ts': "await db.rpc('rag_write_chunks', args);\n" }), []);
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "await db.rpc('rag_unrelated_function', {});\n" }), []);
});

test('doc-type-branching: comparison and switch forms fail in src outside src/lib/rag/ingest/profiles', () => {
  const files = {
    'src/lib/rag/ingest/stages/extract.ts': "if (doc.doc_type === 'invoice_receipt') run();\n",
    'src/lib/a.ts': "if (docType === 'contract_legal') run();\n",
    'src/lib/b.ts': "if (row.doc_type !== 'general') run();\n",
    'src/lib/c.ts': "if (docType !== 'general') run();\n",
    'src/lib/d.ts': "switch (docType) {\n  case 'general':\n    break;\n}\n",
    'src/lib/e.ts': "switch (doc.doc_type) {\n  default:\n    break;\n}\n",
    'src/components/x.tsx': "export function X({ docType }) {\n  switch (docType) {\n    default:\n      return null;\n  }\n}\n",
    'src/lib/f.ts': "if ('invoice_receipt' === doc.doc_type) run();\n",
  };
  const out = rulesFor(files).sort();
  assert.equal(out.length, Object.keys(files).length);
  assert.ok(out.every((entry) => entry.endsWith(':doc-type-branching')));
});

test('doc-type-branching: the profiles module, assignments, object keys and non-src paths pass', () => {
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/ingest/profiles/resolve.ts': "if (doc.doc_type === 'invoice_receipt') run();\n" }),
    [],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/a.ts': "const docType = pick();\nconst row = { doc_type: 'general', docType };\nlet t = docType;\nt = other;\n" }),
    [],
  );
  assert.deepEqual(rulesFor({ 'scripts/x.js': "if (doc.doc_type === 'invoice_receipt') run();\n" }), []);
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "// docType === 'general' is handled by profiles\nexport const a = 1;\n" }), []);
});

test('mint-scope: scopeKey and assertTenantScope stay importable by ingest code, mintScope does not', () => {
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/ingest/x.ts': "import { scopeKey, assertTenantScope } from '../tenant/scope';\n" }),
    [],
  );
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/ingest/x.ts': "import { mintScope } from '../tenant/scope';\n" }),
    ['src/lib/rag/ingest/x.ts:mint-scope'],
  );
});

test('LEGACY_WRITERS: exported, and every entry names its rules, reason and removal owner', () => {
  const list = boundary.LEGACY_WRITERS;
  assert.ok(Array.isArray(list), 'LEGACY_WRITERS must be exported as an array');
  assert.equal(typeof boundary.legacyWriterProblems, 'function');
  assert.deepEqual(boundary.legacyWriterProblems(list), []);
  const paths = list.map((e) => e.path);
  for (const p of ['src/app/api/process-document/route.ts', 'src/app/api/ai-to-rag/route.ts', 'src/lib/supabase.ts']) {
    assert.ok(paths.includes(p), `missing legacy writer ${p}`);
  }
  for (const entry of list) {
    assert.ok(typeof entry.removedBy === 'string' && entry.removedBy.trim().length > 0, `${entry.path} has no removedBy`);
  }
});

test('legacyWriterProblems: an entry without removedBy, reason, a known rule or a path is reported', () => {
  assert.equal(typeof boundary.legacyWriterProblems, 'function');
  const good = { path: 'src/a.ts', rules: ['chunk-writer'], reason: 'legacy', removedBy: 'a plan' };
  assert.deepEqual(boundary.legacyWriterProblems([good]), []);
  const missing = boundary.legacyWriterProblems([{ ...good, removedBy: undefined }]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /removedBy/);
  assert.equal(boundary.legacyWriterProblems([{ ...good, removedBy: '   ' }]).length, 1);
  assert.equal(boundary.legacyWriterProblems([{ ...good, reason: '' }]).length, 1);
  assert.equal(boundary.legacyWriterProblems([{ ...good, rules: ['no-such-rule'] }]).length, 1);
  assert.equal(boundary.legacyWriterProblems([{ ...good, rules: [] }]).length, 1);
  assert.equal(boundary.legacyWriterProblems([{ ...good, path: '' }]).length, 1);
});

test('LEGACY_WRITERS: the exemption is per path and per rule', () => {
  const list = boundary.LEGACY_WRITERS;
  assert.ok(Array.isArray(list), 'LEGACY_WRITERS must be exported as an array');
  const entry = list.find((e) => e.rules.includes('chunk-writer'));
  assert.ok(entry, 'a legacy chunk writer entry is required');
  const write = "await admin.from('document_chunks').insert(rows);\n";
  assert.deepEqual(rulesFor({ [entry.path]: write }), []);
  assert.deepEqual(rulesFor({ [entry.path]: "await db.rpc('rag_write_chunks', args);\n" }), [`${entry.path}:writer-rpc`]);
  assert.deepEqual(rulesFor({ 'src/lib/not-listed.ts': write }), ['src/lib/not-listed.ts:chunk-writer']);
});

test('LEGACY_WRITERS: every entry still exempts a real violation on the tree, so removed writers must leave the list', () => {
  const list = boundary.LEGACY_WRITERS;
  assert.ok(Array.isArray(list), 'LEGACY_WRITERS must be exported as an array');
  for (const entry of list) {
    const file = path.join(ROOT, entry.path);
    assert.ok(fs.existsSync(file), `${entry.path} no longer exists; remove its LEGACY_WRITERS entry`);
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const hits = entry.rules.flatMap((id) => RULES.find((r) => r.id === id).find(text));
    assert.ok(hits.length > 0, `${entry.path} no longer violates ${entry.rules.join(', ')}; remove its LEGACY_WRITERS entry`);
  }
});
