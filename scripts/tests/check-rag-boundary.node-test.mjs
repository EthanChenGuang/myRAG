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

test('exports the Phase 3.1 ledger, budget and cache rule ids', () => {
  const ids = RULES.map((r) => r.id);
  for (const id of ['ledger-table-write', 'ledger-rpc', 'budget-rpc', 'cache-rpc', 'backfill-rpc']) {
    assert.ok(ids.includes(id), `missing rule ${id}`);
  }
});

test('ledger-table-write: mutating ledger tables fails anywhere under src, including ledger.ts', () => {
  const write = "await admin.from('ingestion_jobs').update({ status: 'done' });\n";
  assert.deepEqual(rulesFor({ 'src/app/api/x/route.ts': write }), ['src/app/api/x/route.ts:ledger-table-write']);
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/ledger.ts': write }), ['src/lib/rag/ingest/ledger.ts:ledger-table-write']);
  const tables = {
    'src/lib/a.ts': "await admin.from('ingestion_batches').insert(rows);\n",
    'src/lib/b.ts': 'await admin.from(`rag_parse_cache`).delete().eq("id", id);\n',
    'src/lib/c.ts': "await admin.from('rag_parse_budget_usage').upsert(row);\n",
    'src/lib/d.ts': "await admin.from('rag_embed_batches').update({ n: 1 }).eq('id', id);\n",
  };
  const out = rulesFor(tables);
  assert.equal(out.length, 4);
  assert.ok(out.every((entry) => entry.endsWith(':ledger-table-write')));
});

test('ledger-table-write: select on ledger tables passes', () => {
  assert.deepEqual(
    rulesFor({ 'src/lib/a.ts': "await admin.from('ingestion_jobs').select('id');\n" }),
    [],
  );
});

test('ledger-rpc: ingestion_job RPCs fail outside ledger.ts and pass inside', () => {
  const outside = "await db.rpc('rag_claim_ingestion_jobs', args);\n";
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/enqueue.ts': outside }), ['src/lib/rag/ingest/enqueue.ts:ledger-rpc']);
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/ledger.ts': outside }), []);
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/ledger.ts': 'await db.rpc(`rag_claim_ingestion_jobs_${n}`, args);\n' }), []);
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "await db.rpc('increment_counter', {});\n" }), []);
});

test('budget-rpc: budget RPCs fail outside cloud-budget.ts', () => {
  const names = ['rag_reserve_parse_budget', 'rag_settle_parse_budget', 'rag_release_parse_budget', 'rag_reserve_batch_budget'];
  const files = {};
  names.forEach((name, i) => {
    files[`src/lib/x${i}.ts`] = `await db.rpc('${name}', args);\n`;
  });
  const out = rulesFor(files);
  assert.equal(out.length, names.length);
  assert.ok(out.every((entry) => entry.endsWith(':budget-rpc')));
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/ingest/guard/cloud-budget.ts': "await db.rpc('rag_reserve_parse_budget', args);\n" }),
    [],
  );
});

test('cache-rpc: parse-cache RPCs fail outside parse-cache.ts', () => {
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': "await db.rpc('rag_parse_cache_put', args);\n" }), ['src/lib/a.ts:cache-rpc']);
  assert.deepEqual(rulesFor({ 'src/lib/b.ts': "await db.rpc('rag_set_document_parse_cache', args);\n" }), ['src/lib/b.ts:cache-rpc']);
  assert.deepEqual(rulesFor({ 'src/lib/c.ts': 'await db.rpc(`rag_parse_cache_get_${id}`, args);\n' }), ['src/lib/c.ts:cache-rpc']);
  assert.deepEqual(rulesFor({ 'src/lib/rag/ingest/parse-cache.ts': "await db.rpc('rag_parse_cache_put', args);\n" }), []);
});

test('rerank-http: vendor hosts and /rerank fetch fail outside src/lib/rag/rerank/', () => {
  const cohere = "await fetch('https://api.cohere.com/v2/rerank', opts);\n";
  const voyage = "await fetch('https://api.voyageai.com/v1/rerank', opts);\n";
  const template = 'await fetch(`${base}/rerank`, opts);\n';
  assert.deepEqual(rulesFor({ 'src/app/api/x/route.ts': cohere }), ['src/app/api/x/route.ts:rerank-http']);
  assert.deepEqual(rulesFor({ 'scripts/tools/x.mjs': voyage }), ['scripts/tools/x.mjs:rerank-http']);
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': template }), ['src/lib/a.ts:rerank-http']);
  assert.deepEqual(rulesFor({ 'src/lib/rag/rerank/cohere.ts': cohere }), []);
  assert.deepEqual(rulesFor({ 'tests/fake/cohere.mts': cohere }), []);
  assert.deepEqual(rulesFor({ 'eval/harness/fake-rerank.mts': voyage }), []);
});

test('backfill-rpc: batch RPCs fail outside src/lib/rag/ingest/backfill/', () => {
  const calls = [
    "await db.rpc('rag_enqueue_backfill_jobs', args);\n",
    "await db.rpc('rag_existing_file_hashes', args);\n",
    'await db.rpc(`rag_embed_batch_run_${id}`, args);\n',
    "await db.rpc('finish_ingestion_batch', args);\n",
  ];
  const files = {};
  calls.forEach((code, i) => {
    files[`src/lib/out${i}.ts`] = code;
  });
  const out = rulesFor(files);
  assert.equal(out.length, calls.length);
  assert.ok(out.every((entry) => entry.endsWith(':backfill-rpc')));
  assert.deepEqual(
    rulesFor({ 'src/lib/rag/ingest/backfill/run.ts': calls[0] }),
    [],
  );
});

test('lakera-http: the Lakera host and /v2/guard fail outside src/lib/rag/security/lakera.ts', () => {
  const direct = "await fetch('https://api.lakera.ai/v2/guard', opts);\n";
  const regional = "const host = 'https://eu.api.lakera.ai';\n";
  const template = 'await fetch(`${base}/v2/guard`, opts);\n';
  assert.ok(RULES.some((r) => r.id === 'lakera-http'));
  assert.deepEqual(rulesFor({ 'src/app/api/x/route.ts': direct }), ['src/app/api/x/route.ts:lakera-http']);
  assert.deepEqual(rulesFor({ 'scripts/tools/x.mjs': regional }), ['scripts/tools/x.mjs:lakera-http']);
  assert.deepEqual(rulesFor({ 'src/lib/a.ts': template }), ['src/lib/a.ts:lakera-http']);
  assert.deepEqual(rulesFor({ 'voice-agent/src/x.ts': "const u = 'https://ap-southeast-1.api.lakera.ai/v2/guard';\n" }), [
    'voice-agent/src/x.ts:lakera-http',
  ]);
  assert.deepEqual(rulesFor({ 'src/lib/rag/security/config.ts': regional }), ['src/lib/rag/security/config.ts:lakera-http']);
  assert.deepEqual(rulesFor({ 'src/lib/rag/security/lakera.ts': direct + regional + template }), []);
  assert.deepEqual(rulesFor({ 'tests/rag/security/lakera.test.ts': direct }), []);
  assert.deepEqual(rulesFor({ 'tests/fixtures/security/x.mts': regional }), []);
  assert.deepEqual(rulesFor({ 'eval/harness/x.mts': direct }), []);
  assert.deepEqual(rulesFor({ 'src/lib/b.ts': '// docs: https://api.lakera.ai/v2/guard\nconst x = 1;\n' }), []);
});

const ADAPTER = 'src/lib/rag/query/langchain/index.ts';
const LC_STATIC = "import { BaseRetriever } from '@langchain/core/retrievers';\nexport const a = BaseRetriever;\n";
const onlyRule = (files, id) => rulesFor(files).filter((v) => v.endsWith(`:${id}`)).sort();

test('exports the Phase 6 LangChain and zod rule ids and the adapter allow-list', () => {
  const ids = RULES.map((r) => r.id);
  for (const id of ['langchain-import', 'langchain-adapter-reach', 'zod-v4']) assert.ok(ids.includes(id), `missing rule ${id}`);
  assert.equal(boundary.LANGCHAIN_DIR, 'src/lib/rag/query/langchain/');
  assert.ok(Array.isArray(boundary.LANGCHAIN_ADAPTER_ALLOWED_IMPORTS) && boundary.LANGCHAIN_ADAPTER_ALLOWED_IMPORTS.length > 0);
});

test('langchain-import: static, dynamic and require imports fail outside the adapter in every scan root', () => {
  const files = {
    'src/lib/rag/v2/x.ts': LC_STATIC,
    'tests/x.test.ts': LC_STATIC,
    'src/app/x.ts': "export async function f() { return await import('@langchain/classic/retrievers/ensemble'); }\n",
    'scripts/x.cjs': "const { ChatOpenAI } = require('@langchain/openai');\nmodule.exports = ChatOpenAI;\n",
    'eval/harness/x.mts': LC_STATIC,
    'voice-agent/src/x.ts': "export * from '@langchain/core/messages';\n",
    'src/lib/y.ts': "import { Document } from 'langchain/document';\n",
  };
  assert.deepEqual(onlyRule(files, 'langchain-import'), [
    'eval/harness/x.mts:langchain-import',
    'scripts/x.cjs:langchain-import',
    'src/app/x.ts:langchain-import',
    'src/lib/rag/v2/x.ts:langchain-import',
    'src/lib/y.ts:langchain-import',
    'tests/x.test.ts:langchain-import',
    'voice-agent/src/x.ts:langchain-import',
  ]);
});

test('langchain-import: the adapter directory, look-alike packages, comments and the self-test dir pass', () => {
  assert.deepEqual(onlyRule({ [ADAPTER]: LC_STATIC }, 'langchain-import'), []);
  assert.deepEqual(onlyRule({ 'src/lib/rag/query/langchain/retrievers/x.ts': LC_STATIC }, 'langchain-import'), []);
  assert.deepEqual(onlyRule({ 'src/lib/a.ts': "import x from '@langchainx/core';\nimport y from 'langchain-utils';\n" }, 'langchain-import'), []);
  assert.deepEqual(onlyRule({ 'src/lib/b.ts': "// import { A } from '@langchain/core';\nexport const b = 1;\n" }, 'langchain-import'), []);
  assert.deepEqual(onlyRule({ 'scripts/tests/fixture.mjs': LC_STATIC }, 'langchain-import'), []);
  assert.deepEqual(onlyRule({ 'src/lib/rag/query/langchainish/x.ts': LC_STATIC }, 'langchain-import'), [
    'src/lib/rag/query/langchainish/x.ts:langchain-import',
  ]);
});

test('langchain-adapter-reach: backend, embedding, reranker, Supabase, tenant, v2 and openai imports fail', () => {
  const forbidden = [
    "import { search } from '../../backend/pgvector';\n",
    "import { embedText } from '../../embeddings/openai';\n",
    "import { rerank } from '../../rerank/cohere';\n",
    "import { scopeKey } from '../../tenant/scope';\n",
    "import { createClient } from '@supabase/supabase-js';\n",
    "import { getSupabaseAdmin } from '@/lib/supabase';\n",
    "import { runV2 } from '../../v2/port';\n",
    "import OpenAI from 'openai';\n",
    "import { QueryTransformer } from '../transformer';\n",
    "export async function f() { return import('../../backend/pgvector'); }\n",
    "const { env } = require('@/lib/env');\n",
    "import '../../v2/port';\n",
  ];
  for (const code of forbidden) {
    assert.deepEqual(onlyRule({ [ADAPTER]: code }, 'langchain-adapter-reach'), [`${ADAPTER}:langchain-adapter-reach`], code);
  }
});

test('langchain-adapter-reach: @langchain packages, the adapter dir, port types, prompts, a type-only transformer and contracts pass', () => {
  const allowed = [
    "import { ChatOpenAI } from '@langchain/openai';\n",
    "import { capture } from './capture';\n",
    "import { fake } from './retrievers/fake';\n",
    "import type { SearchPort } from '../port-types';\n",
    "import { searchPortOf } from '../port-types';\n",
    "import { render } from '../prompts/render';\n",
    "import type { QueryTransformer } from '../transformer';\n",
    "import { type QueryTransformer } from '../transformer';\n",
    "import { CondensedQuerySchema } from '@/lib/rag-eval/contracts.generated';\n",
    "import schema from '../../../../../rag-sidecar/schemas/CondensedQuery.schema.json';\n",
  ];
  for (const code of allowed) {
    assert.deepEqual(onlyRule({ [ADAPTER]: code }, 'langchain-adapter-reach'), [], code);
  }
  assert.deepEqual(onlyRule({ 'src/lib/rag/query/llm.ts': "import OpenAI from 'openai';\n" }, 'langchain-adapter-reach'), []);
});

test('zod-v4: zod/v4 and zod/mini fail in app code, zod and zod/v3 pass', () => {
  const files = {
    'src/lib/a.ts': "import { z } from 'zod/v4';\n",
    'src/lib/b.ts': "import { z } from 'zod/mini';\n",
    'src/lib/c.ts': "import * as core from 'zod/v4/core';\n",
    'scripts/d.cjs': "const { z } = require('zod/v4');\n",
  };
  assert.deepEqual(onlyRule(files, 'zod-v4'), [
    'scripts/d.cjs:zod-v4',
    'src/lib/a.ts:zod-v4',
    'src/lib/b.ts:zod-v4',
    'src/lib/c.ts:zod-v4',
  ]);
  assert.deepEqual(onlyRule({ 'src/lib/e.ts': "import { z } from 'zod/v3';\nimport { z as z2 } from 'zod';\n" }, 'zod-v4'), []);
  assert.deepEqual(onlyRule({ 'src/lib/f.ts': "import { z } from 'zod-v4-compat';\n" }, 'zod-v4'), []);
});
