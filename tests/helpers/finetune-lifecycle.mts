import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEmbeddingEndpoints, type FakeEmbeddingEndpoints } from './fake-embedding-endpoints';

// 06.1-17: shared wiring for the fine-tune lifecycle, canary and parity tests. Every endpoint is a local fake.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LEGACY = 'openai-3-small-1536';
export const SLOT_A = 'ft-a-1024';
export const SLOT_B = 'ft-b-1024';
export const QUERY_PROMPT = 'query: ';
export const DOCUMENT_PROMPT = 'passage: ';
export const PROBE_TEXTS = ['first neutral probe sentence about widgets', 'second neutral probe sentence about gadgets', 'third neutral probe sentence about gizmos'];
const ROLES = ['query', 'document', 'query'] as const;
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');

export type Row = Record<string, unknown>;

/** The passage a stored fixture chunk or a re-embed input carries, without the instruction prompt, section path, profile header and wrapper. */
function passageOf(input: string): string {
  let text = input.startsWith(QUERY_PROMPT) ? input.slice(QUERY_PROMPT.length) : input.startsWith(DOCUMENT_PROMPT) ? input.slice(DOCUMENT_PROMPT.length) : input;
  const wrapper = /Document: [^\n]*?\. Chunk \d+ of \d+\. Content: /.exec(text);
  if (wrapper) text = text.slice(wrapper.index + wrapper[0].length);
  return text;
}

/**
 * The fixture "fine-tuned" model behind the fake slot endpoint: the fixture n-gram embedder at the slot's 1024 dims over the passage.
 * The test's production model is the same embedder padded into the 1536-dim legacy column (installFixtureProductionModel), so the
 * existing profile comparison compares like with like and its gate can pass; a salt (other weights) changes every vector.
 */
export function slotModel(input: string): number[] {
  return embedText(passageOf(input), 1024);
}

function productionModel(text: string): number[] {
  return [...embedText(passageOf(text), 1024), ...new Array<number>(512).fill(0)];
}

/** Rewrites the legacy column with the fixture production model; the RAG deps embed legacy queries with it too (see Harness.resetCaches). */
export async function installFixtureProductionModel(db: PGlite): Promise<void> {
  const rows = await rowsOf(db, 'SELECT id, content FROM document_chunks');
  for (const row of rows) {
    await db.query('UPDATE document_chunks SET embedding = $2::vector WHERE id = $1', [row.id, `[${productionModel(String(row.content)).join(',')}]`]);
  }
}

export function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

export function corpusTenant(mode: DeploymentMode): string {
  return mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
}

export function modelCard(id: string, tenantKeys: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const vectors = PROBE_TEXTS.map((text, index) => unit(slotModel(`${ROLES[index] === 'query' ? QUERY_PROMPT : DOCUMENT_PROMPT}${text}`)));
  const slice = { n: 12, recall_at_10: 0.8, mrr_at_10: 0.6, ndcg_at_10: 0.65 };
  const model = { overall: slice, by_language: { en: slice }, by_pair: {}, by_source: { synthetic: slice } };
  return {
    id,
    base_model: 'example-org/example-embedding',
    base_revision: 'a'.repeat(40),
    dims: 1024,
    scope: 'deployment',
    tenant_keys: [...tenantKeys].sort(),
    dataset_manifest_sha256: 'b'.repeat(64),
    training_config_sha256: 'c'.repeat(64),
    query_prompt: QUERY_PROMPT,
    document_prompt: DOCUMENT_PROMPT,
    offline: { passed: true, noise_band: 0.01, reasons: [], deltas: [], models: { base: model, production: model, finetuned: model } },
    status: 'candidate',
    probe: { texts: PROBE_TEXTS, query_prompt: QUERY_PROMPT, document_prompt: DOCUMENT_PROMPT, vectors },
    artifact_uri: `s3://models-bucket/${id}`,
    ...overrides,
  };
}

/** One fake edge for the whole file; the PGlite behind it is swapped per deployment mode (the edge only calls query and transaction). */
export function switchableDb(): { handle: PGlite; use(db: PGlite): void } {
  let current: PGlite | null = null;
  const target = () => {
    if (!current) throw new Error('no database selected');
    return current;
  };
  const handle = {
    query: (...args: Parameters<PGlite['query']>) => target().query(...args),
    transaction: (...args: Parameters<PGlite['transaction']>) => target().transaction(...args),
  } as unknown as PGlite;
  return { handle, use: (db) => (current = db) };
}

export interface CliResult {
  code: number;
  text: string;
}

export interface Harness {
  edge: FakeEdge;
  endpoints: FakeEmbeddingEndpoints;
  workDir: string;
  env: typeof import('@/lib/env').env;
  rag: typeof import('@/lib/rag');
  activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  slot: typeof import('@/lib/rag/embeddings/finetune-slot');
  registry: typeof import('@/lib/rag/embeddings/registry');
  ingestDeps: typeof import('@/lib/rag/ingest/deps');
  ingestConfig: typeof import('@/lib/rag/ingest/config');
  ragDeps: typeof import('@/lib/rag/deps');
  /** Selects the database and deployment mode every later call uses. */
  use(db: PGlite, mode: DeploymentMode): void;
  embedding(...argv: string[]): Promise<CliResult>;
  reembed(...argv: string[]): Promise<CliResult>;
  setFinetune(on: boolean): void;
  setProfilesSwitch(value: 'on' | 'off'): void;
  resetCaches(): void;
  close(): Promise<void>;
}

/** Call before any app module is imported in the test file: the app reads its environment at import time. */
export async function startHarness(): Promise<Harness> {
  const db = switchableDb();
  const edge = await startFakeEdge({ db: db.handle });
  const endpoints = await startFakeEmbeddingEndpoints();
  endpoints.setFtEncoder(slotModel);
  Object.assign(process.env, fixtureProcessEnv(edge.url));
  Object.assign(process.env, {
    NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant',
    MYRAG_DEPLOYMENT_MODE: 'multi-tenant',
    RAG_FINETUNE: 'on',
    RAG_FT_SLOT_A_BASE_URL: endpoints.urls.ft,
    RAG_FT_SLOT_A_MODEL: '',
    RAG_FT_SLOT_A_QUERY_PROMPT: QUERY_PROMPT,
    RAG_FT_SLOT_A_DOCUMENT_PROMPT: DOCUMENT_PROMPT,
    RAG_FT_EMBED_API_KEY: 'ft-endpoint-placeholder-secret-0000',
  });
  const envModule = await import('@/lib/env');
  const embeddingCli = await import('@/lib/rag/embeddings/cli');
  const reembedCli = await import('@/lib/rag/ingest/reembed/cli');
  const harness: Harness = {
    edge,
    endpoints,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'finetune-lifecycle-')),
    env: envModule.env,
    rag: await import('@/lib/rag'),
    activeProfile: await import('@/lib/rag/embeddings/active-profile'),
    slot: await import('@/lib/rag/embeddings/finetune-slot'),
    registry: await import('@/lib/rag/embeddings/registry'),
    ingestDeps: await import('@/lib/rag/ingest/deps'),
    ingestConfig: await import('@/lib/rag/ingest/config'),
    ragDeps: await import('@/lib/rag/deps'),
    use(next, mode) {
      db.use(next);
      harness.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      harness.env.MYRAG_DEPLOYMENT_MODE = mode;
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      harness.resetCaches();
    },
    async embedding(...argv) {
      const lines: string[] = [];
      const code = await embeddingCli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) }, undefined, {
        finetuneEnabled: () => harness.env.RAG_FINETUNE === 'on',
        runCommand: async () => 0,
      });
      return { code, text: lines.join('\n') };
    },
    async reembed(...argv) {
      const lines: string[] = [];
      const code = await reembedCli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
      return { code, text: lines.join('\n') };
    },
    setFinetune(on) {
      harness.env.RAG_FINETUNE = on ? 'on' : 'off';
      process.env.RAG_FINETUNE = on ? 'on' : 'off';
      harness.resetCaches();
    },
    setProfilesSwitch(value) {
      harness.ingestConfig.resetIngestConfigForTests();
      harness.ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: value }) });
      harness.activeProfile.resetActiveProfileForTests();
    },
    resetCaches() {
      harness.registry.resetEmbeddingProvidersForTests();
      harness.slot.resetFinetuneProbeCacheForTests();
      harness.activeProfile.resetActiveProfileForTests();
      harness.ragDeps.resetRagDepsForTests();
      harness.ragDeps.setRagDepsForTests({ embedder: async (text: string) => productionModel(text) });
    },
    async close() {
      harness.ingestDeps.resetIngestDepsForTests();
      harness.activeProfile.resetActiveProfileForTests();
      await endpoints.stop();
      await edge.close();
      fs.rmSync(harness.workDir, { recursive: true, force: true });
    },
  };
  return harness;
}

export async function rowsOf(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

/** Puts the legacy profile back as the active one and empties every fine-tune table and slot. */
export async function resetFinetuneState(db: PGlite): Promise<void> {
  await db.query('DELETE FROM embedding_backfill_gaps');
  await db.query('DELETE FROM embedding_backfill_runs');
  await db.query("UPDATE embedding_profiles SET status = 'available', activated_at = NULL, activated_by = NULL, previous_active_id = NULL, eval_evidence = NULL WHERE status <> 'retired'");
  await db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '2 hours', activated_by = 'test' WHERE id = $1", [LEGACY]);
  for (const slot of [SLOT_A, SLOT_B]) await db.query("SELECT * FROM rag_finetune_clear_slot($1, 'test', 10000)", [slot]);
  await db.query('DELETE FROM chunk_embeddings');
  await db.query('DELETE FROM embedding_model_versions');
  await db.query('DELETE FROM rag_finetune_consent');
}

export function writeJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, `${name}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** Consent, card, bind: the operator steps before the re-embed. */
export async function grantRegisterBind(harness: Harness, tenant: string, version: string, slot = SLOT_A): Promise<void> {
  const granted = await harness.embedding('ft-consent', 'grant', tenant, '--scope', 'deployment', '--ref', 'TICKET-2001');
  assert.equal(granted.code, 0, granted.text);
  const registered = await harness.embedding('ft-models', 'register', writeJson(harness.workDir, version, modelCard(version, [tenant])));
  assert.equal(registered.code, 0, registered.text);
  const bound = await harness.embedding('ft-bind', slot, version);
  assert.equal(bound.code, 0, bound.text);
}

/** The run id a `rag:reembed` output line names. */
export function runIdOf(text: string): string {
  const match = /run ([0-9a-f-]{36}) wrote/.exec(text);
  assert.ok(match, text);
  return match[1] as string;
}

interface GoldenItem {
  id: string;
  question: string;
  language: string;
  category: string;
  evidence_language: string | null;
  answerable: boolean;
  split: string;
  provenance: string;
  conversation: unknown[];
  gold_evidence: Array<{ document: string }>;
}

export function goldenItems(limit: number): GoldenItem[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoldenItem)
    .filter((item) => item.split === 'dev' && item.answerable && item.conversation.length === 0 && item.gold_evidence.length > 0)
    .slice(0, limit);
}

/** Fixture document file names by id: the gold evidence names documents by file. */
export async function documentNames(db: PGlite): Promise<Map<string, string>> {
  const rows = await rowsOf(db, "SELECT id, filename, metadata->>'relpath' AS relpath FROM documents");
  return new Map(rows.map((row) => [String(row.id), path.basename(String(row.relpath ?? row.filename))]));
}

function itemResult(item: GoldenItem, ranked: string[], refused: boolean): Record<string, unknown> {
  const gold = item.gold_evidence.map((span) => span.document);
  const hits = (k: number) => gold.filter((document) => ranked.slice(0, k).includes(document)).length;
  const first = ranked.findIndex((document) => gold.includes(document));
  return {
    item_id: item.id,
    language: item.language,
    category: item.category,
    evidence_language: item.evidence_language,
    split: item.split,
    provenance: item.provenance,
    answerable: item.answerable,
    refused,
    span_count: gold.length,
    spans_hit_at_5: hits(5),
    spans_hit_at_10: hits(10),
    first_hit_rank: first >= 0 ? first + 1 : null,
  };
}

/**
 * The eval profile comparison over the fixture golden set: each item is retrieved through the active profile and through the target
 * profile (the eval-only `embeddingProfile` override), scored per item, aggregated by the eval package and compared by the existing
 * `rag_eval.profile_compare_cli`, which writes an EmbeddingProfileComparison.
 */
export async function runProfileComparison(
  harness: Harness,
  db: PGlite,
  scope: import('@/lib/rag').TenantScope,
  target: string,
  backfillRunId: string,
  limit = 1000,
): Promise<{ file: string; comparison: Record<string, unknown> }> {
  const names = await documentNames(db);
  const items = goldenItems(limit);
  const reports: Record<string, Record<string, unknown>[]> = { active_gated: [], active_candidate: [], target_gated: [], target_candidate: [] };
  for (const [prefix, embeddingProfile] of [['active', undefined], ['target', target]] as const) {
    for (const item of items) {
      const result = await harness.rag.runRetrieval({
        scope,
        query: item.question,
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true, ...(embeddingProfile ? { embeddingProfile } : {}) },
        signal: new AbortController().signal,
      });
      assert.notEqual(result.status, 'error', `${prefix} ${item.id}: ${result.reason}`);
      const unique = (ids: string[]) => [...new Set(ids.map((id) => names.get(id) ?? id))];
      reports[`${prefix}_gated`]!.push(itemResult(item, unique(result.kept.map((chunk) => chunk.document_id)), result.kept.length === 0));
      reports[`${prefix}_candidate`]!.push(itemResult(item, unique(result.candidates.map((chunk) => chunk.document_id)), false));
    }
  }
  const dir = fs.mkdtempSync(path.join(harness.workDir, 'compare-'));
  const input = path.join(dir, 'items.json');
  fs.writeFileSync(input, JSON.stringify(reports));
  const script = path.join(dir, 'build_reports.py');
  fs.writeFileSync(script, BUILD_REPORTS_PY);
  const built = spawnSync('uv', ['run', '--frozen', '--directory', path.join(REPO_ROOT, 'eval'), 'python', script, input, dir], { encoding: 'utf8' });
  assert.equal(built.status, 0, `report build: ${built.stderr}`);
  const meta = path.join(dir, 'pre-migration.json');
  fs.writeFileSync(meta, JSON.stringify({ run_id: backfillRunId, corpus_documents_before_run: items.length }));
  const out = path.join(dir, 'comparison.json');
  const compared = spawnSync(
    'uv',
    [
      'run', '--frozen', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', 'rag_eval.profile_compare_cli',
      '--active-gated', path.join(dir, 'active_gated.json'),
      '--active-candidate', path.join(dir, 'active_candidate.json'),
      '--target-gated', path.join(dir, 'target_gated.json'),
      '--target-candidate', path.join(dir, 'target_candidate.json'),
      '--target-profile', target,
      '--noise', NOISE_PATH,
      '--pre-migration-meta', meta,
      '--backfill-run-id', backfillRunId,
      '--out', out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(compared.status, 0, `profile_compare_cli: ${compared.stderr}`);
  return { file: out, comparison: JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown> };
}

const BUILD_REPORTS_PY = `
import json
import sys
from pathlib import Path

from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.metrics import aggregate

source, out = Path(sys.argv[1]), Path(sys.argv[2])
for name, rows in json.loads(source.read_text(encoding="utf-8")).items():
    items = [ItemResult.model_validate(row) for row in rows]
    aggregated = aggregate(items, gate_split="dev")
    report = EvalReport.model_validate(
        {
            "run_id": f"finetune-lifecycle-{name}",
            "tier": "smoke",
            "run_config_hash": "0" * 64,
            "golden_sha256": "1" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "embedder_id": "fixture-ngram",
            "embedder_version": 1,
            "deployment_mode": "single-tenant",
            "request_options": {},
            "k_values": [5, 10],
            **{key: value for key, value in aggregated.items() if value is not None},
            "items": items,
        }
    )
    (out / f"{name}.json").write_text(report.model_dump_json(), encoding="utf-8")
`;
