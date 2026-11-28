import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { loadCorpus } from './corpus.mts';
import { embedText } from './fixture-embedder.mts';
import { createFixtureDatabase } from './pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SCOPE_SEPARATION_REPORT_PATH = path.join(REPO_ROOT, 'eval/reports/q62-scope-separation/report.json');
export const SCOPE_SEPARATION_PROFILE = 'openai-3-small-1536';
const TENANT = 's:default';
const PERCENTILE = 0.05;
const EMBED_BATCH = 100;
const EMBED_TIMEOUT_MS = 120_000;
const FIXTURE_NOTE = 'Measurement on synthetic fixtures with a lexical hash embedder; it calibrates nothing and never changes the D-34 grouping.';
const REAL_NOTE = 'Measurement on synthetic fixtures with a real embedding profile; it calibrates nothing and never changes the D-34 grouping.';

/** The existing out-of-domain no-answer items of research F-12 (world-knowledge questions, two per language); the other no_answer items are near misses. */
export const OUT_OF_DOMAIN_IDS = [
  'en-no-answer-003',
  'en-no-answer-004',
  'it-no-answer-003',
  'it-no-answer-004',
  'zh-no-answer-003',
  'zh-no-answer-004',
] as const;

export const GROUPINGS = ['tenant', 'tenant_language', 'doc_type', 'doc_type_language', 'd34_all'] as const;
export type Grouping = (typeof GROUPINGS)[number];

interface GoldenRow {
  id: string;
  category: string;
  answerable: boolean;
  language: string;
  evidence_language?: string | null;
  question: string;
  split: string;
  conversation?: unknown[];
}

interface TranslationTable {
  entries: Array<{ question: string; translations: Array<{ language: string; text: string }> }>;
}

interface Centroid {
  kind: 'doc_type' | 'scope_tag' | 'tenant';
  key: string;
  vector: number[];
  members: number;
}

type ItemClass = 'answerable' | 'out_of_domain' | 'near_miss';

interface ScoredItem {
  id: string;
  cls: ItemClass;
  split: string;
  pair: string;
  crossLingual: boolean;
  scores: Record<Grouping, number>;
  originalOnly: Record<Grouping, number>;
}

export interface GroupingResult {
  centroids: number;
  threshold: number;
  answerable_below: { total: number; by_pair: Record<string, number> };
  out_of_domain_below: { total: number; by_language: Record<string, number>; ids: string[] };
  near_miss_below: { total: number; by_language: Record<string, number> };
  cross_lingual_below: { max_over_variants: number; original_only: number };
}

export interface ScopeSeparationReport {
  version: 1;
  measurement: 'q62-scope-separation';
  embedder: string;
  embedding_profile: string;
  embedding_run?: { calls: number; texts: number };
  scoring: string;
  threshold_rule: string;
  counts: { answerable: number; out_of_domain: number; near_miss: number; cross_lingual: number; dev_answerable: number };
  centroids_by_kind: Record<string, number>;
  groupings: Record<Grouping, GroupingResult>;
  verdict: {
    compared: ['doc_type_language', 'doc_type'];
    d34_separates_at_least_as_well: boolean;
    out_of_domain_below: { doc_type_language: number; doc_type: number };
    answerable_below: { doc_type_language: number; doc_type: number };
    note: string;
  };
  items: Array<{ id: string; class: ItemClass; split: string; pair: string; scores: Record<Grouping, number> }>;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector.slice();
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += (a[index] ?? 0) * (b[index] ?? 0);
  return sum;
}

function splitKey(key: string): { group: string; language: string } {
  const slash = key.lastIndexOf('/');
  return { group: key.slice(0, slash), language: key.slice(slash + 1) };
}

/** Merge language-specific centroids into one per group: the member-weighted mean of means is the mean over all members. */
function mergeByGroup(centroids: Centroid[]): number[][] {
  const merged = new Map<string, { sum: number[]; members: number }>();
  for (const centroid of centroids) {
    const { group } = splitKey(centroid.key);
    const entry = merged.get(group) ?? { sum: new Array<number>(centroid.vector.length).fill(0), members: 0 };
    centroid.vector.forEach((value, index) => {
      entry.sum[index] = (entry.sum[index] ?? 0) + value * centroid.members;
    });
    entry.members += centroid.members;
    merged.set(group, entry);
  }
  return [...merged.keys()].sort().map((group) => {
    const entry = merged.get(group)!;
    return normalize(entry.sum.map((value) => value / entry.members));
  });
}

function percentileLower(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function loadCentroids(db: PGlite, profileId: string): Promise<Centroid[]> {
  await db.exec('SET ROLE service_role');
  try {
    await db.query('SELECT * FROM public.rag_scope_centroids_rebuild($1, $2)', [TENANT, profileId]);
    const rows = await db.query<{ group_kind: Centroid['kind']; group_key: string; centroid: string; member_count: number }>(
      'SELECT group_kind, group_key, centroid::text AS centroid, member_count FROM public.rag_scope_centroids_list($1, $2)',
      [TENANT, profileId],
    );
    return rows.rows.map((row) => ({
      kind: row.group_kind,
      key: row.group_key,
      vector: row.centroid.replace(/^\[|\]$/g, '').split(',').map(Number),
      members: Number(row.member_count),
    }));
  } finally {
    await db.exec('RESET ROLE');
  }
}

function readGolden(goldenPath: string): GoldenRow[] {
  return fs
    .readFileSync(goldenPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GoldenRow);
}

export interface EmbeddingProfileRow {
  id: string;
  provider: string;
  model: string;
  dims: number;
  storage: string;
}

export interface SeparationEmbedder {
  name: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQueries(texts: string[]): Promise<number[][]>;
}

export type SeparationEmbedderFactory = (profile: EmbeddingProfileRow) => SeparationEmbedder | Promise<SeparationEmbedder>;

export const SCOPE_SEPARATION_REAL_DIR = path.join(REPO_ROOT, 'eval/reports/q62-scope-separation-real');

export class ScopeSeparationError extends Error {
  constructor(
    readonly code: 'unknown_embedding_profile' | 'embedding_dims_mismatch' | 'embedding_key_missing' | 'embedding_model_mismatch' | 'chunk_text_missing',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ScopeSeparationError';
  }
}

type EnvSource = Record<string, string | undefined>;

/** The variable that holds the key of the host serving a profile's provider, read the way the app's providers read it. */
export function requiredEmbeddingKey(profile: Pick<EmbeddingProfileRow, 'provider'>, env: EnvSource): string {
  const value = (name: string) => (env[name] ?? '').trim().toLowerCase();
  switch (profile.provider) {
    case 'openai':
      return value('RAG_OPENAI_EMBEDDINGS_VIA') === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
    case 'voyage':
      return 'VOYAGE_API_KEY';
    case 'qwen3':
      return value('RAG_QWEN_EMBED_PRIMARY') === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPINFRA_API_KEY';
    case 'bge-m3':
      if (value('RAG_BGE_M3_SERVING') === 'sidecar') return 'RAG_SIDECAR_SECRET';
      return value('RAG_BGE_M3_VIA') === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPINFRA_API_KEY';
    case 'ft_slot_a':
    case 'ft_slot_b':
      return 'RAG_FT_EMBED_API_KEY';
    default:
      throw new ScopeSeparationError('unknown_embedding_profile', `provider ${profile.provider}`);
  }
}

/** The app's embedding provider for the profile (registry, as ingestion and query embedding use it); the key is checked first and never read back. */
export async function createRealEmbedder(profile: EmbeddingProfileRow, env: EnvSource = process.env): Promise<SeparationEmbedder> {
  const keyName = requiredEmbeddingKey(profile, env);
  if (!(env[keyName] ?? '').trim()) throw new ScopeSeparationError('embedding_key_missing', keyName);
  const registry = await import('../../src/lib/rag/embeddings/registry');
  const provider = registry.getEmbeddingProviderFor(profile.provider, profile.model);
  const checkModel = (served: string) => {
    if (registry.canonicalModelId(served) !== registry.canonicalModelId(profile.model)) {
      throw new ScopeSeparationError('embedding_model_mismatch', `profile ${profile.id}`);
    }
  };
  const opts = () => ({ dims: profile.dims, signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
  return {
    name: `${profile.provider}:${provider.model}`,
    async embedDocuments(texts) {
      const out = await provider.embedDocuments(texts, opts());
      checkModel(out.model);
      return out.vectors;
    },
    async embedQueries(texts) {
      if (provider.embedQueries) {
        const out = await provider.embedQueries(texts, opts());
        checkModel(out.model);
        return out.vectors;
      }
      const vectors: number[][] = [];
      for (const text of texts) {
        const out = await provider.embedQuery(text, opts());
        checkModel(out.model);
        vectors.push(...out.vectors);
      }
      return vectors;
    },
  };
}

interface FixtureTexts {
  labels: string[];
  values: string[];
}

let fixtureTexts: FixtureTexts | null = null;

function loadFixtureTexts(): FixtureTexts {
  if (fixtureTexts) return fixtureTexts;
  const labels: string[] = [];
  const values: string[] = [];
  for (const row of readGolden(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'))) {
    labels.push(`question:${row.id}`);
    values.push(row.question);
  }
  const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/fixtures/translation-table.json'), 'utf8')) as TranslationTable;
  table.entries.forEach((entry, index) => {
    entry.translations.forEach((translation) => {
      labels.push(`translation:${index}:${translation.language}`);
      values.push(translation.text);
    });
  });
  for (const doc of loadCorpus(path.join(REPO_ROOT, 'eval/fixtures/corpus')).documents) {
    for (const chunk of doc.chunks) {
      labels.push(`chunk:${chunk.id}`);
      values.push(chunk.text);
    }
  }
  fixtureTexts = { labels, values };
  return fixtureTexts;
}

/** Labels (ids, never text) of every fixture question, translation or chunk text found in a rendered report. */
export function reportTextLeaks(text: string): string[] {
  const { labels, values } = loadFixtureTexts();
  const leaks: string[] = [];
  values.forEach((value, index) => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    if (text.includes(trimmed) || text.includes(JSON.stringify(trimmed).slice(1, -1))) leaks.push(labels[index]!);
  });
  return leaks;
}

async function readProfile(db: PGlite, id: string): Promise<EmbeddingProfileRow> {
  const rows = await db.query<{ id: string; provider: string; model: string; dims: number; storage: string }>(
    'SELECT id, provider, model, dims, storage FROM public.embedding_profiles WHERE id = $1',
    [id],
  );
  const row = rows.rows[0];
  if (!row) throw new ScopeSeparationError('unknown_embedding_profile', id);
  return { id: row.id, provider: row.provider, model: row.model, dims: Number(row.dims), storage: row.storage };
}

interface EmbedCounter {
  calls: number;
  texts: number;
}

async function embedAll(
  texts: string[],
  embed: (batch: string[]) => Promise<number[][]>,
  dims: number,
  counter: EmbedCounter,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const out = await embed(batch);
    counter.calls += 1;
    counter.texts += batch.length;
    if (out.length !== batch.length) throw new ScopeSeparationError('embedding_dims_mismatch', `expected ${batch.length} vectors, got ${out.length}`);
    for (const vector of out) {
      if (vector.length !== dims) throw new ScopeSeparationError('embedding_dims_mismatch', `profile dims ${dims}, vector dims ${vector.length}`);
      vectors.push(vector);
    }
  }
  return vectors;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** Replace the fixture vectors of every centroid member chunk with the embedder's, in the column or table the profile reads. */
async function writeRealChunkVectors(
  db: PGlite,
  profile: EmbeddingProfileRow,
  embedder: SeparationEmbedder,
  corpusDir: string,
  counter: EmbedCounter,
): Promise<void> {
  const chunkText = new Map<string, string>();
  for (const doc of loadCorpus(corpusDir).documents) for (const chunk of doc.chunks) chunkText.set(chunk.id, chunk.text);
  const rows = await db.query<{ id: string }>(
    `SELECT c.id FROM public.document_chunks c
       JOIN public.documents d ON d.id = c.document_id
      WHERE c.tenant_key = $1 AND c.is_current AND c.status = 'ready' AND NOT c.provisional
        AND d.is_current AND d.status = 'ready' AND NOT d.provisional
      ORDER BY c.id`,
    [TENANT],
  );
  const ids = rows.rows.map((row) => row.id);
  const texts = ids.map((id) => {
    const text = chunkText.get(id);
    if (text === undefined) throw new ScopeSeparationError('chunk_text_missing', id);
    return text;
  });
  const vectors = await embedAll(texts, (batch) => embedder.embedDocuments(batch), profile.dims, counter);
  const legacy = profile.storage === 'legacy_column';
  for (let index = 0; index < ids.length; index += 1) {
    const literal = vectorLiteral(vectors[index]!);
    if (legacy) {
      await db.query('UPDATE public.document_chunks SET embedding = $2::vector WHERE id = $1', [ids[index], literal]);
    } else {
      await db.query(
        `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
         VALUES ($1, $2, $3, $4::halfvec, $5, $6, 'scope-separation')
         ON CONFLICT (chunk_id, profile_id) DO UPDATE SET embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model`,
        [ids[index], profile.id, TENANT, literal, profile.model, profile.dims],
      );
    }
  }
}

function renderMarkdown(report: ScopeSeparationReport): string {
  const lines = [
    '# Scope separation with a real embedding profile (06.2-42)',
    '',
    `- Embedder: \`${report.embedder}\`, embedding profile \`${report.embedding_profile}\``,
    `- Items: ${report.counts.answerable} answerable (${report.counts.dev_answerable} dev, non-cross-lingual), ${report.counts.out_of_domain} out-of-domain, ${report.counts.near_miss} near-miss, ${report.counts.cross_lingual} cross-lingual`,
    `- Scoring: ${report.scoring}`,
    `- Threshold: ${report.threshold_rule}`,
    ...(report.embedding_run ? [`- Embedding calls: ${report.embedding_run.calls} (${report.embedding_run.texts} texts)`] : []),
    '',
    `| Grouping | Centroids | Threshold | Answerable below | Out-of-domain below (of ${report.counts.out_of_domain}) | Near-miss below (of ${report.counts.near_miss}) | Cross-lingual below (max / original only) |`,
    '|----------|-----------|-----------|------------------|------------------------|--------------------|--------------------------------------------|',
    ...GROUPINGS.map((grouping) => {
      const g = report.groupings[grouping];
      return `| ${grouping} | ${g.centroids} | ${g.threshold} | ${g.answerable_below.total} | ${g.out_of_domain_below.total} | ${g.near_miss_below.total} | ${g.cross_lingual_below.max_over_variants} / ${g.cross_lingual_below.original_only} |`;
    }),
    '',
    `**Verdict: \`d34_separates_at_least_as_well = ${report.verdict.d34_separates_at_least_as_well}\`** (out-of-domain below: doc_type_language ${report.verdict.out_of_domain_below.doc_type_language}, doc_type ${report.verdict.out_of_domain_below.doc_type}; answerable below: doc_type_language ${report.verdict.answerable_below.doc_type_language}, doc_type ${report.verdict.answerable_below.doc_type}).`,
    '',
    report.verdict.note,
    '',
  ];
  return lines.join('\n');
}

export interface ScopeSeparationCliDeps {
  env?: EnvSource;
  embedderFor?: SeparationEmbedderFactory;
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** `--embedder fixture|real` (default fixture), `--profile <id>` (real only), `--out <dir>` or `--out <file>.json`. Exit 2: embedding_key_missing. */
export async function runScopeSeparationCli(argv: string[], deps: ScopeSeparationCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const mode = flagValue(argv, '--embedder') ?? 'fixture';
  const outArg = flagValue(argv, '--out');
  if (mode !== 'fixture' && mode !== 'real') {
    error('[Scope Separation] --embedder must be fixture or real');
    return 1;
  }
  const profile = flagValue(argv, '--profile');
  if (mode === 'real' && !profile) {
    error('[Scope Separation] profile_required: --embedder real needs --profile <id>');
    return 1;
  }
  if (mode === 'fixture' && profile) {
    error('[Scope Separation] --profile applies only to --embedder real');
    return 1;
  }
  try {
    const env = deps.env ?? process.env;
    const report = await runScopeSeparation(
      mode === 'real' ? { embedding: { profile: profile!, create: deps.embedderFor ?? ((row) => createRealEmbedder(row, env)) } } : {},
    );
    const json = stableJson(report);
    const files: Array<[string, string]> = [];
    if (mode === 'fixture') {
      const outPath = outArg === undefined ? SCOPE_SEPARATION_REPORT_PATH : outArg.endsWith('.json') ? path.resolve(outArg) : path.resolve(outArg, 'report.json');
      files.push([outPath, json]);
    } else {
      const dir = outArg === undefined ? SCOPE_SEPARATION_REAL_DIR : path.resolve(outArg);
      files.push([path.join(dir, 'report.json'), json], [path.join(dir, 'report.md'), renderMarkdown(report)]);
    }
    const leaks = files.flatMap(([, content]) => reportTextLeaks(content));
    if (leaks.length > 0) {
      error('[Scope Separation] report_contains_text', { count: leaks.length, first: leaks[0] });
      return 1;
    }
    for (const [file, content] of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    log('[Scope Separation] wrote report', {
      outPath: path.relative(REPO_ROOT, path.dirname(files[0]![0])),
      embedder: report.embedder,
      verdict: report.verdict.d34_separates_at_least_as_well,
      ...(report.embedding_run ? { embeddingCalls: report.embedding_run.calls } : {}),
    });
    return 0;
  } catch (caught) {
    if (caught instanceof ScopeSeparationError) {
      error(caught.code === 'embedding_key_missing' ? `[Scope Separation] embedding_key_missing: set ${caught.detail}` : `[Scope Separation] ${caught.code}: ${caught.detail}`);
      return caught.code === 'embedding_key_missing' ? 2 : 1;
    }
    error('[Scope Separation] failed', caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

export interface ScopeSeparationOptions {
  corpusDir?: string;
  goldenPath?: string;
  translationPath?: string;
  embedding?: { profile: string; create: SeparationEmbedderFactory };
}

export async function runScopeSeparation(options: ScopeSeparationOptions = {}): Promise<ScopeSeparationReport> {
  const corpusDir = options.corpusDir ?? path.join(REPO_ROOT, 'eval/fixtures/corpus');
  const golden = readGolden(options.goldenPath ?? path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'));
  const table = JSON.parse(fs.readFileSync(options.translationPath ?? path.join(REPO_ROOT, 'eval/fixtures/translation-table.json'), 'utf8')) as TranslationTable;
  const translations = new Map(table.entries.map((entry) => [entry.question, entry.translations.map((t) => t.text)]));

  const profileId = options.embedding?.profile ?? SCOPE_SEPARATION_PROFILE;
  const counter: EmbedCounter = { calls: 0, texts: 0 };
  let embedder: SeparationEmbedder | null = null;
  let profileDims = 0;
  const { db } = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir });
  let centroids: Centroid[];
  try {
    if (options.embedding) {
      const profile = await readProfile(db, profileId);
      profileDims = profile.dims;
      embedder = await options.embedding.create(profile);
      await writeRealChunkVectors(db, profile, embedder, corpusDir, counter);
    }
    centroids = await loadCentroids(db, profileId);
  } finally {
    await db.close();
  }

  const byKind = (kind: Centroid['kind']) => centroids.filter((c) => c.kind === kind);
  const sets: Record<Grouping, number[][]> = {
    tenant: mergeByGroup(byKind('tenant')),
    tenant_language: byKind('tenant').map((c) => normalize(c.vector)),
    doc_type: mergeByGroup(byKind('doc_type')),
    doc_type_language: byKind('doc_type').map((c) => normalize(c.vector)),
    d34_all: centroids.map((c) => normalize(c.vector)),
  };

  const outOfDomain = new Set<string>(OUT_OF_DOMAIN_IDS);
  const selected: Array<{ row: GoldenRow; cls: ItemClass; texts: string[] }> = [];
  for (const row of golden) {
    if ((row.conversation ?? []).length > 0) continue;
    let cls: ItemClass;
    if (row.answerable) cls = 'answerable';
    else if (row.category !== 'no_answer') continue;
    else cls = outOfDomain.has(row.id) ? 'out_of_domain' : 'near_miss';
    selected.push({ row, cls, texts: [row.question, ...(translations.get(row.question) ?? [])] });
  }
  const queryVectors = new Map<string, number[]>();
  if (embedder) {
    const real = embedder;
    const unique = [...new Set(selected.flatMap((entry) => entry.texts))];
    const vectors = await embedAll(unique, (batch) => real.embedQueries(batch), profileDims, counter);
    unique.forEach((text, index) => queryVectors.set(text, normalize(vectors[index]!)));
  }
  const queryVector = (text: string) => queryVectors.get(text) ?? normalize(embedText(text));

  const items: ScoredItem[] = [];
  for (const { row, cls, texts } of selected) {
    const vectors = texts.map(queryVector);
    const scores = {} as Record<Grouping, number>;
    const originalOnly = {} as Record<Grouping, number>;
    for (const grouping of GROUPINGS) {
      const set = sets[grouping];
      const best = (vector: number[]) => set.reduce((max, centroid) => Math.max(max, dot(vector, centroid)), -1);
      originalOnly[grouping] = round3(best(vectors[0]!));
      scores[grouping] = round3(Math.max(...vectors.map(best)));
    }
    const evidence = row.evidence_language ?? row.language;
    items.push({
      id: row.id,
      cls,
      split: row.split,
      pair: cls === 'answerable' ? `${row.language}->${evidence}` : row.language,
      crossLingual: row.category === 'cross_lingual',
      scores,
      originalOnly,
    });
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groupings = {} as Record<Grouping, GroupingResult>;
  for (const grouping of GROUPINGS) {
    const devAnswerable = items.filter((item) => item.cls === 'answerable' && item.split === 'dev' && !item.crossLingual).map((item) => item.scores[grouping]);
    const threshold = round3(percentileLower(devAnswerable, PERCENTILE));
    const result: GroupingResult = {
      centroids: sets[grouping].length,
      threshold,
      answerable_below: { total: 0, by_pair: {} },
      out_of_domain_below: { total: 0, by_language: {}, ids: [] },
      near_miss_below: { total: 0, by_language: {} },
      cross_lingual_below: { max_over_variants: 0, original_only: 0 },
    };
    for (const item of items) {
      const below = item.scores[grouping] < threshold;
      if (item.cls === 'answerable') {
        if (below) {
          result.answerable_below.total += 1;
          increment(result.answerable_below.by_pair, item.pair);
        }
        if (item.crossLingual) {
          if (below) result.cross_lingual_below.max_over_variants += 1;
          if (item.originalOnly[grouping] < threshold) result.cross_lingual_below.original_only += 1;
        }
      } else if (below && item.cls === 'out_of_domain') {
        result.out_of_domain_below.total += 1;
        increment(result.out_of_domain_below.by_language, item.pair);
        result.out_of_domain_below.ids.push(item.id);
      } else if (below) {
        result.near_miss_below.total += 1;
        increment(result.near_miss_below.by_language, item.pair);
      }
    }
    result.answerable_below.by_pair = sortRecord(result.answerable_below.by_pair);
    result.out_of_domain_below.by_language = sortRecord(result.out_of_domain_below.by_language);
    result.near_miss_below.by_language = sortRecord(result.near_miss_below.by_language);
    groupings[grouping] = result;
  }

  const d34 = groupings.doc_type_language;
  const base = groupings.doc_type;
  const centroidsByKind: Record<string, number> = { doc_type: 0, scope_tag: 0, tenant: 0 };
  for (const centroid of centroids) increment(centroidsByKind, centroid.kind);

  return {
    version: 1,
    measurement: 'q62-scope-separation',
    embedder: embedder ? embedder.name : 'fixture-ngram',
    embedding_profile: profileId,
    ...(embedder ? { embedding_run: { calls: counter.calls, texts: counter.texts } } : {}),
    scoring: 'max cosine over the original question and its fixture translations (no HyDE) against the grouping centroids',
    threshold_rule: '5th percentile (nearest rank, lower) of dev-split answerable, non-cross-lingual scores, per grouping',
    counts: {
      answerable: items.filter((item) => item.cls === 'answerable').length,
      out_of_domain: items.filter((item) => item.cls === 'out_of_domain').length,
      near_miss: items.filter((item) => item.cls === 'near_miss').length,
      cross_lingual: items.filter((item) => item.crossLingual).length,
      dev_answerable: items.filter((item) => item.cls === 'answerable' && item.split === 'dev' && !item.crossLingual).length,
    },
    centroids_by_kind: centroidsByKind,
    groupings,
    verdict: {
      compared: ['doc_type_language', 'doc_type'],
      d34_separates_at_least_as_well:
        d34.out_of_domain_below.total >= base.out_of_domain_below.total && d34.answerable_below.total <= base.answerable_below.total,
      out_of_domain_below: { doc_type_language: d34.out_of_domain_below.total, doc_type: base.out_of_domain_below.total },
      answerable_below: { doc_type_language: d34.answerable_below.total, doc_type: base.answerable_below.total },
      note: embedder ? REAL_NOTE : FIXTURE_NOTE,
    },
    items: items.map((item) => ({ id: item.id, class: item.cls, split: item.split, pair: item.pair, scores: item.scores })),
  };
}

export function stableJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sortKeys((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export async function writeScopeSeparationReport(outPath: string = SCOPE_SEPARATION_REPORT_PATH): Promise<ScopeSeparationReport> {
  const report = await runScopeSeparation();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stableJson(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (flagValue(argv, '--embedder') === 'real') {
    const { config } = await import('dotenv');
    config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
  }
  process.exitCode = await runScopeSeparationCli(argv);
}
