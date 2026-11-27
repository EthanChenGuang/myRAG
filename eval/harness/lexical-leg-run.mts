import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RpcClient } from '../../src/lib/rag/backend/supabase-rpc';
import { bm25ArgsFrom } from '../../src/lib/rag/backend/pgvector';
import { scalarOf } from '../../src/lib/rag/cache/wire';
import { isTenantKey } from '../../src/lib/rag/ingest/writer';
import type { LexicalOptions } from '../../src/lib/rag/lexical/options';
import { queryLexicalTokens } from '../../src/lib/rag/lexical/tokenize';
import { GoldenItemSchema } from '../../src/lib/rag-eval/contracts.generated.ts';

/**
 * D-37, R-13: the lexical leg alone, at the search-function level. Each question is tokenized with the application tokenizer and the
 * deployment's query-side lexical options, then sent to the lexical leg of hybrid_search_chunks (p_dense_limit 0, the ts_rank_cd arm)
 * and to rag_bm25_search_chunks (one bm25 arm per k1, b combination) for one tenant, with no other filter. The ranked chunk ids,
 * document ids, document names and chunk content are written per item and arm to a git-ignored directory; the console gets item
 * counts and durations only (D-34). Eval tooling, service role, never imported by src/.
 */

const PREFIX = '[Lexical Legs]';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY_PROFILE_ID = 'openai-3-small-1536';
export const LEXICAL_LEG_LIMIT = 50;
export const LEXICAL_LEG_MAX_GRID = 9;
export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;
export const LEGS_FILE = 'lexical-legs.jsonl';
export const MANIFEST_FILE = 'manifest.json';
export const TS_RANK_CD_ARM = 'ts_rank_cd';

export type LexicalLegErrorCode = 'lexical_stats_not_ready' | 'rpc_failed' | 'bad_arguments' | 'out_not_ignored' | 'missing_environment';

export class LexicalLegError extends Error {
  constructor(
    readonly code: LexicalLegErrorCode,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code} (${detail})` : code);
    this.name = 'LexicalLegError';
  }
}

export interface LexicalLegItem {
  id: string;
  question: string;
  language: string;
}

export interface LexicalLegArm {
  /** `ts_rank_cd`, `bm25` for a single default combination, else `bm25:k1=<k1>,b=<b>`. */
  label: string;
  scoring: 'ts_rank_cd' | 'bm25';
  k1?: number;
  b?: number;
}

export interface LexicalLegHit {
  chunk_id: string;
  document_id: string;
  document_name: string | null;
  content: string;
}

export interface LexicalLegItemResult {
  item_id: string;
  language: string;
  token_count: number;
  arms: Record<string, LexicalLegHit[]>;
}

export interface LexicalOptionsSummary {
  stem_it: boolean;
  dictionary_version: string | null;
  identifier_patterns: number;
  quantity: boolean;
}

export interface LexicalLegsInput {
  rpc: RpcClient;
  tenantKey: string;
  items: readonly LexicalLegItem[];
  arms: readonly LexicalLegArm[];
  /** The query-side lexical options the search stage would use for this question; undefined tokenizes with the defaults. */
  lexicalOptionsFor?: (question: string) => Promise<LexicalOptions | undefined>;
  limit?: number;
  profileId?: string;
}

export interface LexicalLegsResult {
  items: LexicalLegItemResult[];
  options: LexicalOptionsSummary;
}

function bm25Label(k1: number, b: number): string {
  return `bm25:k1=${k1},b=${b}`;
}

/** The ts_rank_cd arm plus one bm25 arm per k1 x b combination; a single default combination is labelled `bm25`. */
export function lexicalLegArms(k1s: readonly number[] = [DEFAULT_K1], bs: readonly number[] = [DEFAULT_B]): LexicalLegArm[] {
  const uniqueK1 = [...new Set(k1s)];
  const uniqueB = [...new Set(bs)];
  if (uniqueK1.length === 0 || uniqueB.length === 0) throw new LexicalLegError('bad_arguments', 'k1 and b need at least one value');
  for (const value of [...uniqueK1, ...uniqueB]) {
    if (!Number.isFinite(value) || value < 0) throw new LexicalLegError('bad_arguments', 'k1 and b must be finite and not negative');
  }
  if (uniqueB.some((value) => value > 1)) throw new LexicalLegError('bad_arguments', 'b must be at most 1');
  if (uniqueK1.length * uniqueB.length > LEXICAL_LEG_MAX_GRID) {
    throw new LexicalLegError('bad_arguments', `the k1 x b grid is capped at ${LEXICAL_LEG_MAX_GRID} combinations`);
  }
  const single = uniqueK1.length === 1 && uniqueB.length === 1 && uniqueK1[0] === DEFAULT_K1 && uniqueB[0] === DEFAULT_B;
  const arms: LexicalLegArm[] = [{ label: TS_RANK_CD_ARM, scoring: 'ts_rank_cd' }];
  for (const k1 of uniqueK1) {
    for (const b of uniqueB) arms.push({ label: single ? 'bm25' : bm25Label(k1, b), scoring: 'bm25', k1, b });
  }
  return arms;
}

function summarize(options: LexicalOptions | undefined, into: LexicalOptionsSummary): void {
  if (!options) return;
  if (options.stemIt === true) into.stem_it = true;
  if (options.dictionary?.version) into.dictionary_version = options.dictionary.version;
  if (options.identifierPatterns) into.identifier_patterns = Math.max(into.identifier_patterns, options.identifierPatterns.length);
  if (options.quantity) into.quantity = true;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data.filter((row) => row !== null && typeof row === 'object') as Record<string, unknown>[]) : [];
}

function lexicalHits(data: unknown): LexicalLegHit[] {
  return rowsOf(data)
    .filter((row) => row.leg === 'lexical')
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .map((row) => ({
      chunk_id: String(row.chunk_id),
      document_id: String(row.document_id),
      document_name: typeof row.document_filename === 'string' ? row.document_filename : null,
      content: typeof row.content === 'string' ? row.content : '',
    }));
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await rpc.rpc(fn, args);
  if (response.error) throw new LexicalLegError('rpc_failed', `${fn} ${response.error.code ?? 'unknown'}`);
  return response.data;
}

/** The statistics the bm25 arms need: state ready with at least one counted chunk, else lexical_stats_not_ready. */
export async function assertLexicalStatsReady(rpc: RpcClient, tenantKey: string): Promise<void> {
  const status = scalarOf(await call(rpc, 'rag_lexstats_status', { p_tenant_key: tenantKey }), 'rag_lexstats_status') as
    | { state?: unknown; chunk_count?: unknown }
    | null
    | undefined;
  if (!status || status.state !== 'ready' || !(Number(status.chunk_count) > 0)) throw new LexicalLegError('lexical_stats_not_ready');
}

/** The hybrid arguments of a lexical-only call (dense limit 0, no embedding, no filter), the shape buildRpcArgs gives such a request. */
export function lexicalOnlyHybridArgs(tenantKey: string, profileId: string, tokens: string[], limit: number): Record<string, unknown> {
  return {
    p_tenant_key: tenantKey,
    p_profile_id: profileId,
    p_query_embedding: null,
    p_lexical_tokens: tokens,
    p_dense_limit: 0,
    p_lexical_limit: limit,
  };
}

/**
 * Every item and arm, or an error and no result: the statistics are checked first, and any failed call ends the run (D-34: the error
 * carries the function name and the error code only).
 */
export async function runLexicalLegs(input: LexicalLegsInput): Promise<LexicalLegsResult> {
  const limit = input.limit ?? LEXICAL_LEG_LIMIT;
  const profileId = input.profileId ?? LEGACY_PROFILE_ID;
  if (!isTenantKey(input.tenantKey)) throw new LexicalLegError('bad_arguments', 'a tenant key is s:default, u:<uuid> or o:<uuid>');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new LexicalLegError('bad_arguments', 'the limit is an integer from 1 to 200');
  if (input.arms.some((arm) => arm.scoring === 'bm25')) await assertLexicalStatsReady(input.rpc, input.tenantKey);
  const options: LexicalOptionsSummary = { stem_it: false, dictionary_version: null, identifier_patterns: 0, quantity: false };
  const items: LexicalLegItemResult[] = [];
  for (const item of input.items) {
    const lexicalOptions = input.lexicalOptionsFor ? await input.lexicalOptionsFor(item.question) : undefined;
    summarize(lexicalOptions, options);
    const tokens = queryLexicalTokens(item.question, lexicalOptions);
    const arms: Record<string, LexicalLegHit[]> = {};
    for (const arm of input.arms) {
      if (tokens.length === 0) {
        arms[arm.label] = [];
        continue;
      }
      const hybridArgs = lexicalOnlyHybridArgs(input.tenantKey, profileId, tokens, limit);
      arms[arm.label] =
        arm.scoring === 'ts_rank_cd'
          ? lexicalHits(await call(input.rpc, 'hybrid_search_chunks', hybridArgs))
          : lexicalHits(
              await call(input.rpc, 'rag_bm25_search_chunks', bm25ArgsFrom(hybridArgs, { mode: 'bm25', k1: arm.k1 ?? DEFAULT_K1, b: arm.b ?? DEFAULT_B }, limit)),
            );
    }
    items.push({ item_id: item.id, language: item.language, token_count: tokens.length, arms });
  }
  return { items, options };
}

// ---------- command line

export interface LexicalLegArgs {
  golden: string;
  tenant: string;
  out: string;
  k1: number[];
  b: number[];
  limit: number;
  profile: string;
}

const USAGE =
  'usage: node --import tsx eval/harness/lexical-leg-run.mts --golden <file> --tenant <key> --out <dir> [--k1 a,b] [--b a,b] [--limit 50] [--profile <id>]';

function numberList(value: string, flag: string): number[] {
  const parts = value.split(',').map((part) => part.trim());
  const numbers = parts.map(Number);
  if (parts.some((part) => part === '') || numbers.some((n) => !Number.isFinite(n))) throw new LexicalLegError('bad_arguments', `${flag} takes numbers`);
  return numbers;
}

export function parseLexicalLegArgs(argv: readonly string[]): LexicalLegArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!['--golden', '--tenant', '--out', '--k1', '--b', '--limit', '--profile'].includes(flag)) {
      throw new LexicalLegError('bad_arguments', `unknown argument ${flag.startsWith('--') ? flag : '(value)'}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new LexicalLegError('bad_arguments', `${flag} needs a value`);
    values.set(flag, value);
    i += 1;
  }
  for (const flag of ['--golden', '--tenant', '--out']) {
    if (!values.get(flag)) throw new LexicalLegError('bad_arguments', `${flag} is required`);
  }
  const tenant = values.get('--tenant')!;
  if (!isTenantKey(tenant)) throw new LexicalLegError('bad_arguments', '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>');
  const limit = Number(values.get('--limit') ?? LEXICAL_LEG_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new LexicalLegError('bad_arguments', '--limit is an integer from 1 to 200');
  return {
    golden: values.get('--golden')!,
    tenant,
    out: values.get('--out')!,
    k1: values.has('--k1') ? numberList(values.get('--k1')!, '--k1') : [DEFAULT_K1],
    b: values.has('--b') ? numberList(values.get('--b')!, '--b') : [DEFAULT_B],
    limit,
    profile: values.get('--profile') ?? LEGACY_PROFILE_ID,
  };
}

/** The output directory must be git-ignored (eval/out/, eval/reports/<run>/private/, ...): it holds chunk content. */
export function assertGitIgnored(dir: string, cwd: string = REPO_ROOT): void {
  const absolute = path.resolve(cwd, dir);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new LexicalLegError('out_not_ignored', 'the output directory must be inside the repository');
  const probe = path.join(relative, LEGS_FILE);
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', probe], { cwd });
  if (result.status !== 0) throw new LexicalLegError('out_not_ignored', 'the output directory is not git-ignored');
}

export function readLexicalLegItems(goldenPath: string): { items: LexicalLegItem[]; sha256: string } {
  const bytes = fs.readFileSync(goldenPath);
  const items: LexicalLegItem[] = [];
  bytes
    .toString('utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new LexicalLegError('bad_arguments', `golden line ${index + 1} is not valid JSON`);
      }
      const parsed = GoldenItemSchema.safeParse(raw);
      if (!parsed.success) throw new LexicalLegError('bad_arguments', `golden line ${index + 1} violates GoldenItemSchema`);
      items.push({ id: parsed.data.id, question: parsed.data.question, language: parsed.data.language });
    });
  return { items, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function tenantHash(tenantKey: string): string {
  return crypto.createHash('sha256').update(tenantKey).digest('hex').slice(0, 12);
}

export interface LexicalLegManifest {
  schema_version: 1;
  created_at: string;
  eval_set_sha256: string;
  tenant_hash: string;
  profile_id: string;
  limit: number;
  arms: LexicalLegArm[];
  lexical_options: LexicalOptionsSummary;
  item_count: number;
  empty_token_items: number;
}

/** Writes both files only after every item finished (no partial output). */
export function writeLexicalLegs(out: string, result: LexicalLegsResult, manifest: Omit<LexicalLegManifest, 'lexical_options' | 'item_count' | 'empty_token_items'>): LexicalLegManifest {
  const full: LexicalLegManifest = {
    ...manifest,
    lexical_options: result.options,
    item_count: result.items.length,
    empty_token_items: result.items.filter((item) => item.token_count === 0).length,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, LEGS_FILE), result.items.map((item) => JSON.stringify(item)).join('\n') + (result.items.length ? '\n' : ''));
  fs.writeFileSync(path.join(out, MANIFEST_FILE), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/** Real project: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment only. Exit 0 done, 1 refused or failed, 2 usage. */
export async function main(argv: readonly string[] = process.argv.slice(2), io: CliIo = consoleIo): Promise<number> {
  let args: LexicalLegArgs;
  let arms: LexicalLegArm[];
  try {
    args = parseLexicalLegArgs(argv);
    arms = lexicalLegArms(args.k1, args.b);
  } catch (error) {
    io.err(`${PREFIX} ${error instanceof LexicalLegError ? error.message : 'bad arguments'}`);
    io.err(USAGE);
    return 2;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    io.err(`${PREFIX} refused: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  const started = Date.now();
  try {
    assertGitIgnored(args.out);
    const { items, sha256 } = readLexicalLegItems(path.resolve(REPO_ROOT, args.golden));
    const { createClient } = await import('@supabase/supabase-js');
    const rpc = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
    const { loadRagConfig } = await import('../../src/lib/rag/config');
    const { getRagDeps } = await import('../../src/lib/rag/deps');
    const { resolveLexicalOptions } = await import('../../src/lib/rag/lexical/resolve-options');
    const { lexicalOptionsOn } = await import('../../src/lib/rag/lexical/options');
    const { storeScopeForTenantKey } = await import('../../src/lib/rag/tenant/store-scope');
    const { queryLanguage } = await import('../../src/lib/rag/query/language');
    const config = loadRagConfig(getRagDeps().ragEnv());
    const scope = storeScopeForTenantKey(args.tenant);
    const result = await runLexicalLegs({
      rpc,
      tenantKey: args.tenant,
      items,
      arms,
      limit: args.limit,
      profileId: args.profile,
      // The pipeline's resolution (LANG-07): only while a lexical switch is on, with the detected query language.
      lexicalOptionsFor: lexicalOptionsOn(config)
        ? async (question) => (await resolveLexicalOptions(scope, config, { language: queryLanguage(question) })).options
        : undefined,
    });
    const manifest = writeLexicalLegs(path.resolve(REPO_ROOT, args.out), result, {
      schema_version: 1,
      created_at: new Date().toISOString(),
      eval_set_sha256: sha256,
      tenant_hash: tenantHash(args.tenant),
      profile_id: args.profile,
      limit: args.limit,
      arms,
    });
    io.out(`${PREFIX} ${manifest.item_count} item(s), ${arms.length} arm(s), ${manifest.empty_token_items} without tokens, ${Date.now() - started} ms`);
    return 0;
  } catch (error) {
    io.err(`${PREFIX} failed: ${error instanceof LexicalLegError ? error.message : error instanceof Error ? error.name : 'unknown'} after ${Date.now() - started} ms`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
