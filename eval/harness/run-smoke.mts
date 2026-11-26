import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ingestModeGoldenPaths, mergeGoldenFiles, parseIngestRoutingFlags } from './ingest-mode.mts';
import { dropTableSplitItems } from './table-split.mts';
import { runEval, type EvalRequestOptions } from './run-eval.mts';
import { CHUNKING_PROFILES_NEED_INGEST, loadRunConfig, RunConfigError } from './run-config.mts';
import type { DeploymentMode, FixtureMode } from './pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASELINES: Record<FixtureMode, string> = {
  prechunked: path.join(REPO_ROOT, 'eval/baselines/fixture-baseline.json'),
  ingest: path.join(REPO_ROOT, 'eval/baselines/fixture-ingest-baseline.json'),
};
const DEFAULT_GOLDEN = 'eval/fixtures/golden.jsonl';
// D-46: the golden-set manifest of each fixture mode's default golden files; a --golden override has none unless given.
const DEFAULT_GOLDEN_MANIFESTS: Record<FixtureMode, string> = {
  prechunked: 'eval/fixtures/golden.manifest.json',
  ingest: 'eval/fixtures/ingest/golden-ingest.manifest.json',
};
const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');
const SEC_LOG_SWITCHES = ['RAG_CONTEXT_TAGGING', 'RAG_INJECTION_CHECK', 'RAG_INJECTION_PROMPT_GUARD', 'RAG_INJECTION_LAKERA', 'RAG_TOOL_RESULT_GUARD'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (result.error) throw result.error;
  return result.status ?? 3;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      golden: { type: 'string' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
      'fixture-mode': { type: 'string', default: 'prechunked' },
      out: { type: 'string', default: 'eval/out/smoke' },
      'deployment-mode': { type: 'string', default: 'single-tenant' },
      'max-results': { type: 'string' },
      degrade: { type: 'string' },
      'base-url': { type: 'string' },
      'no-gate': { type: 'boolean', default: false },
      'embedding-profile': { type: 'string' },
      baseline: { type: 'string' },
      'include-drafts': { type: 'boolean', default: false },
      'run-config': { type: 'string' },
      org: { type: 'string' },
      user: { type: 'string' },
      routing: { type: 'string' },
      'force-tier': { type: 'string' },
      citations: { type: 'boolean', default: false },
      groundedness: { type: 'boolean', default: false },
      'table-split-doc-type': { type: 'string' },
      'table-header-repeat': { type: 'string' },
      'cache-pairs': { type: 'boolean', default: false },
      'allow-live-cache': { type: 'boolean', default: false },
      gates: { type: 'string' },
      'gates-mode': { type: 'string' },
      'golden-manifest': { type: 'string' },
    },
    strict: true,
  });

  // D-06, O-1: --gates adds the absolute gate to the noise-band gate; --gates-mode report prints it without changing the exit code.
  const gatesFile = values.gates?.trim();
  if (gatesFile !== undefined && gatesFile === '') {
    console.error('[Eval Harness] --gates must not be empty');
    return 2;
  }
  const gatesMode = values['gates-mode'];
  if (gatesMode !== undefined && gatesFile === undefined) {
    console.error('[Eval Harness] --gates-mode needs --gates');
    return 2;
  }
  if (gatesMode !== undefined && gatesMode !== 'enforce' && gatesMode !== 'report') {
    console.error('[Eval Harness] --gates-mode must be enforce or report');
    return 2;
  }
  const goldenManifestFlag = values['golden-manifest']?.trim();
  if (goldenManifestFlag !== undefined && goldenManifestFlag === '') {
    console.error('[Eval Harness] --golden-manifest must not be empty');
    return 2;
  }

  const deploymentMode = values['deployment-mode'];
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    throw new Error(`--deployment-mode must be single-tenant or multi-tenant, got ${String(deploymentMode)}`);
  }

  const fixtureMode = values['fixture-mode'];
  if (fixtureMode !== 'prechunked' && fixtureMode !== 'ingest') {
    throw new Error(`--fixture-mode must be prechunked or ingest, got ${String(fixtureMode)}`);
  }
  if (fixtureMode === 'ingest' && values['base-url']) {
    throw new Error('--fixture-mode ingest builds the fixture database itself and cannot be combined with --base-url');
  }
  // --routing fixed|tiered sends every document through the queue and the sidecar job function; --force-tier fast|structured|premium
  // pins every page to one tier (D-40).
  const ingestRouting = parseIngestRoutingFlags({ routing: values.routing, 'force-tier': values['force-tier'] });
  if (ingestRouting && fixtureMode !== 'ingest') throw new Error('--routing and --force-tier need --fixture-mode ingest');

  let maxResults: number | undefined;
  if (values['max-results'] !== undefined) {
    maxResults = Number.parseInt(values['max-results'], 10);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new Error('--max-results must be an integer from 1 to 100');
    }
  }

  const embeddingProfileId = values['embedding-profile']?.trim();
  if (embeddingProfileId !== undefined && embeddingProfileId === '') {
    throw new Error('--embedding-profile must not be empty');
  }
  const baseUrl = values['base-url'];
  if (baseUrl && embeddingProfileId) {
    throw new Error('--embedding-profile is only supported for in-process fixture runs (omit --base-url)');
  }

  const runConfigFile = values['run-config']?.trim();
  if (runConfigFile !== undefined && runConfigFile === '') throw new RunConfigError('[Eval Harness] --run-config must not be empty');
  const runConfig = runConfigFile ? loadRunConfig(path.resolve(runConfigFile)) : undefined;
  if (runConfig && baseUrl && Object.keys(runConfig.env).length > 0) {
    throw new RunConfigError('[Eval Harness] a run-config env overlay applies to in-process runs only; omit --base-url or drop its env');
  }
  if (runConfig?.chunkingProfiles?.length && fixtureMode !== 'ingest') throw new RunConfigError(CHUNKING_PROFILES_NEED_INGEST);
  if (runConfig) {
    // The SEC overlay decides the injection report's configuration label (recommended is gated at absolute zero, D-14).
    const security = SEC_LOG_SWITCHES.filter((name) => runConfig.env[name] !== undefined).map((name) => `${name}=${runConfig.env[name]}`);
    if (security.length > 0) console.log(`[Eval Harness] run-config ${runConfig.name} SEC switches: ${security.join(', ')}`);
    // D-39: with the layer on, the in-process run answers every query-LLM call from the fake table.
    const queryLayer = Object.keys(runConfig.env)
      .filter((name) => name.startsWith('RAG_QUERY_') || name.startsWith('RAG_SEMANTIC_CACHE'))
      .map((name) => `${name}=${runConfig.env[name]}`);
    if (queryLayer.length > 0) console.log(`[Eval Harness] run-config ${runConfig.name} query-layer switches: ${queryLayer.join(', ')}`);
  }

  const requestOptions: EvalRequestOptions = {};
  if (maxResults !== undefined) requestOptions.max_results = maxResults;
  if (values.degrade !== undefined) {
    if (values.degrade !== 'drop_top_candidate') throw new Error('--degrade must be drop_top_candidate');
    requestOptions.degrade = values.degrade;
  }
  if (embeddingProfileId) requestOptions.embedding_profile = embeddingProfileId;
  for (const [flag, key] of [['org', 'organization_id'], ['user', 'user_id']] as const) {
    const value = values[flag]?.trim();
    if (value === undefined) continue;
    if (!UUID_RE.test(value)) throw new Error(`--${flag} must be a UUID`);
    requestOptions[key] = value.toLowerCase();
  }

  // Eval check only (D-46): load the table_split documents under another processing profile; such a run is never gated.
  const tableSplitDocType = values['table-split-doc-type']?.trim();
  if (tableSplitDocType !== undefined) {
    if (fixtureMode !== 'ingest' || ingestRouting) throw new Error('--table-split-doc-type needs the inline --fixture-mode ingest');
    const profiles = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/processing-profiles.json'), 'utf8')) as {
      profiles: Array<{ doc_type: string }>;
    };
    const docTypes = profiles.profiles.map((profile) => profile.doc_type);
    if (!docTypes.includes(tableSplitDocType)) throw new Error(`--table-split-doc-type must be one of ${docTypes.join(', ')}`);
  }

  const tableHeaderRepeat = values['table-header-repeat']?.trim();
  if (tableHeaderRepeat !== undefined) {
    if (fixtureMode !== 'ingest' || ingestRouting || baseUrl) throw new Error('--table-header-repeat needs the inline --fixture-mode ingest');
    if (tableHeaderRepeat !== 'profile' && tableHeaderRepeat !== 'always') throw new Error('--table-header-repeat must be profile or always');
  }

  if (values['allow-live-cache'] && !values['cache-pairs']) throw new Error('--allow-live-cache needs --cache-pairs');
  let gate = !values['no-gate'];
  if (tableSplitDocType !== undefined || tableHeaderRepeat !== undefined) gate = false;
  if (embeddingProfileId) gate = false;
  // A queued build has its own corpus hash; it is compared with another routing mode by the parser gate, not with the inline baseline.
  if (ingestRouting && values.baseline === undefined) gate = false;
  if (gate && baseUrl && values.baseline === undefined) {
    console.error('[Eval Harness] a --base-url run needs --baseline <live baseline> or --no-gate');
    return 2;
  }
  const baselinePath = path.resolve(values.baseline ?? DEFAULT_BASELINES[fixtureMode]);

  const outDir = path.resolve(values.out as string);
  if (ingestRouting) ingestRouting.ledgerOut = path.join(outDir, 'ingest-ledger.json');
  // Ingest mode scores the golden files it names itself unless --golden says otherwise, so its ingest-only items need no change here.
  const defaultGolden = fixtureMode === 'ingest' ? ingestModeGoldenPaths() : [DEFAULT_GOLDEN];
  const goldenFiles = values.golden !== undefined ? [path.resolve(values.golden)] : defaultGolden.map((file) => path.resolve(REPO_ROOT, file));
  const mergedGolden = mergeGoldenFiles(goldenFiles, path.join(outDir, 'golden.merged.jsonl'));
  // table_split items run only against the isolated tenants of the inline ingest mode; other runs score without them.
  const goldenPath =
    fixtureMode === 'ingest' && !ingestRouting ? mergedGolden : dropTableSplitItems(mergedGolden, path.join(outDir, 'golden.no-table-split.jsonl'));
  if (runPython('rag_sidecar.contracts.validate', ['--model', 'GoldenItem', '--jsonl', goldenPath]) !== 0) {
    console.error('[Eval Harness] golden file failed Pydantic validation; nothing was run');
    return 2;
  }
  const goldenManifest =
    goldenManifestFlag !== undefined
      ? path.resolve(goldenManifestFlag)
      : values.golden === undefined
        ? path.resolve(REPO_ROOT, DEFAULT_GOLDEN_MANIFESTS[fixtureMode])
        : undefined;
  if (goldenManifest !== undefined) {
    const verifyArgs = ['verify', ...goldenFiles.flatMap((file) => ['--golden', file]), '--manifest', goldenManifest];
    if (runPython('rag_eval.golden_set', verifyArgs) !== 0) {
      console.error('[Eval Harness] golden files do not match their golden-set manifest; nothing was run');
      return 2;
    }
  }
  const result = await runEval({
    goldenPath,
    corpusDir: path.resolve(values.corpus as string),
    outDir,
    deploymentMode: deploymentMode as DeploymentMode,
    fixtureMode,
    requestOptions,
    tier: baseUrl ? 'live' : 'smoke',
    baseUrl,
    includeDrafts: values['include-drafts'],
    embeddingProfileId,
    ...(ingestRouting ? { ingestRouting } : {}),
    ...(runConfig ? { runConfig } : {}),
    ...(tableSplitDocType ? { tableSplitDocType } : {}),
    ...(tableHeaderRepeat ? { ingestBuildEnv: { RAG_TABLE_HEADER_REPEAT: tableHeaderRepeat } } : {}),
    // Either flag implies include_answer; fixture runs answer with the fake citation generator and score against the fake sidecar.
    ...(values.citations ? { citations: true } : {}),
    ...(values.groundedness ? { groundedness: true } : {}),
    // D-37: the golden cache pairs instead of the item run; cache-pairs.json feeds python -m rag_eval.calibrate cache.
    ...(values['cache-pairs'] ? { cachePairs: true } : {}),
    ...(values['allow-live-cache'] ? { allowLiveCache: true } : {}),
  });

  if (result.cachePairsPath) {
    console.log(`[Eval Harness] wrote cache pairs to ${result.cachePairsPath}`);
    return 0;
  }

  console.log(`[Eval Harness] wrote ${result.itemCount} trace(s) to ${result.tracesPath} (${result.skippedCount} golden item(s) not approved, skipped)`);

  const scoreCode = runPython('rag_eval.runner', [
    'score',
    '--traces',
    result.tracesPath,
    '--golden',
    goldenPath,
    '--manifest',
    result.runPath,
    '--out',
    outDir,
    ...(goldenManifest !== undefined ? ['--golden-manifest', goldenManifest] : []),
  ]);
  if (scoreCode !== 0) return scoreCode;
  console.log(`[Eval Harness] report: ${path.join(outDir, 'report.md')}`);

  if (!gate) return 0;

  const gateCode = runPython('rag_eval.gate', [
    '--report',
    path.join(outDir, 'report.json'),
    '--baseline',
    baselinePath,
    '--noise',
    NOISE_PATH,
    '--out',
    outDir,
    ...(goldenManifest !== undefined ? ['--manifest', goldenManifest] : []),
    ...(gatesFile !== undefined ? ['--gates', path.resolve(gatesFile)] : []),
    ...(gatesMode !== undefined ? ['--gates-mode', gatesMode] : []),
  ]);
  console.log(`[Eval Harness] gate: ${path.join(outDir, 'gate.md')}`);
  return gateCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof RunConfigError) {
      console.error(error.message);
      if (error.names.length > 0) console.error(`[Eval Harness] not allowed in run-config env: ${error.names.join(', ')}`);
      process.exit(2);
    }
    console.error(`[Eval Harness] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
