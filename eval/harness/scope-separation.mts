import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from './fixture-embedder.mts';
import { createFixtureDatabase } from './pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SCOPE_SEPARATION_REPORT_PATH = path.join(REPO_ROOT, 'eval/reports/q62-scope-separation/report.json');
export const SCOPE_SEPARATION_PROFILE = 'openai-3-small-1536';
const TENANT = 's:default';
const PERCENTILE = 0.05;

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

async function loadCentroids(db: PGlite): Promise<Centroid[]> {
  await db.exec('SET ROLE service_role');
  try {
    await db.query('SELECT * FROM public.rag_scope_centroids_rebuild($1, $2)', [TENANT, SCOPE_SEPARATION_PROFILE]);
    const rows = await db.query<{ group_kind: Centroid['kind']; group_key: string; centroid: string; member_count: number }>(
      'SELECT group_kind, group_key, centroid::text AS centroid, member_count FROM public.rag_scope_centroids_list($1, $2)',
      [TENANT, SCOPE_SEPARATION_PROFILE],
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

export const SCOPE_SEPARATION_REAL_DIR = '';

export function reportTextLeaks(_text: string): string[] {
  return [];
}

export function requiredEmbeddingKey(_profile: Pick<EmbeddingProfileRow, 'provider'>, _env: Record<string, string | undefined>): string {
  return '';
}

export async function runScopeSeparationCli(_argv: string[], _deps: Record<string, unknown> = {}): Promise<number> {
  return 1;
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

  const { db } = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir });
  let centroids: Centroid[];
  try {
    centroids = await loadCentroids(db);
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
  const items: ScoredItem[] = [];
  for (const row of golden) {
    if ((row.conversation ?? []).length > 0) continue;
    let cls: ItemClass;
    if (row.answerable) cls = 'answerable';
    else if (row.category !== 'no_answer') continue;
    else cls = outOfDomain.has(row.id) ? 'out_of_domain' : 'near_miss';
    const texts = [row.question, ...(translations.get(row.question) ?? [])];
    const vectors = texts.map((text) => normalize(embedText(text)));
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
    embedder: 'fixture-ngram',
    embedding_profile: SCOPE_SEPARATION_PROFILE,
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
      note: 'Measurement on synthetic fixtures with a lexical hash embedder; it calibrates nothing and never changes the D-34 grouping.',
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
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1] ?? '') : SCOPE_SEPARATION_REPORT_PATH;
  writeScopeSeparationReport(outPath).then(
    (report) => {
      console.log('[Scope Separation] wrote report', {
        outPath: path.relative(REPO_ROOT, outPath),
        verdict: report.verdict.d34_separates_at_least_as_well,
      });
    },
    (error: unknown) => {
      console.error('[Scope Separation] failed', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
