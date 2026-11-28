/**
 * Real-deployment mode of run-binding-compare.mts (quick-311, EMB-10 gap 1). No fixture database, no fixture embedder and no fake for any
 * profile: the global profile is whatever the deployment serves, and every arm is scored from traces the deployment returned.
 *
 *   1. Read the real embedding registry (service role, from .env.local): the one active global profile and each candidate.
 *   2. Print each candidate's re-embed dry-run cost (npm run rag:reembed -- --profile <id> --dry-run); stop with exit 4 without --confirm-cost.
 *   3. Per candidate: bind the doc type (deployment-wide), set it backfilling, run the scoped re-embed on the real project, set it available.
 *   4. Run the baseline, control and candidate arms through run-eval against --base-url, each with its own request options.
 *   5. Refuse the run if any trace was not served by the active global model on the v2 pipeline with domain bindings on.
 *   6. rag_eval.binding_compare_cli on the three kinds of report, with --live-deployment (never --fixture-embedder).
 *
 * Prints counts, ids, costs and reason words only; never a key, the base URL's credentials or document text.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalRequestOptions, RunEvalOptions, RunEvalResult } from './run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');
const RETRIEVAL_PARAMS_PATH = path.join(REPO_ROOT, 'eval/config/retrieval-params.json');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
/** The server-side switches every arm needs; the harness cannot set them on a deployment, so it checks them in the traces. */
export const LIVE_REQUIRED_RAG_ENV = { RAG_PIPELINE: 'v2', RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' } as const;
export const LIVE_DEPLOYMENT_NOTE =
  'Live deployment run: corpus_sha256 identifies the deployment origin and the baseline effective config, not a committed corpus.';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const EXIT_WRITTEN = 0;
export const EXIT_USAGE = 2;
export const EXIT_FAILED = 3;
export const EXIT_COST_NOT_CONFIRMED = 4;

export interface LiveCompareArgs {
  docType: string;
  candidates: string[];
  golden: string;
  outDir: string;
  baseUrl: string;
  confirmCost: boolean;
  organizationId: string | null;
  userId: string | null;
}

export interface LiveProfile {
  id: string;
  provider: string;
  model: string;
  status: string;
}

export interface CommandResult {
  status: number;
  stdout: string;
}

export interface LiveCompareDeps {
  /** The real registry, read with the service role. */
  listProfiles: () => Promise<LiveProfile[]>;
  /** An npm script with arguments (rag:reembed, rag:embedding); stdout is captured, stderr goes to the terminal. */
  npm: (script: string, args: string[]) => CommandResult;
  runEval: (options: RunEvalOptions) => Promise<RunEvalResult>;
  python: (module: string, args: string[]) => number;
  catalogEntry: (provider: string, model: string) => { model: string; usdPerMillionTokens: number; supportedLanguages: readonly string[] } | undefined;
  catalogVersion: number;
  log: (line: string) => void;
}

export class LiveCompareError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_FAILED,
  ) {
    super(message);
    this.name = 'LiveCompareError';
  }
}

function sha256(...parts: string[]): string {
  const hash = crypto.createHash('sha256');
  parts.forEach((part, index) => {
    if (index > 0) hash.update(Buffer.from([0]));
    hash.update(part);
  });
  return hash.digest('hex');
}

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** One trace per line; the effective config each one was served with. */
function traceConfigs(tracesPath: string): Array<{ embedding_model?: unknown; rag_env?: Record<string, unknown> }> {
  return fs
    .readFileSync(tracesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { effective_config?: { embedding_model?: unknown; rag_env?: Record<string, unknown> } }).effective_config ?? {});
}

/**
 * The guard behind "the global profile is never a fake": every trace of an arm must name the active global profile's model and the v2
 * pipeline with domain bindings on. A fixture model, a missing config or another model refuses the whole comparison.
 */
export function assertServedByDeployment(arm: string, tracesPath: string, globalModel: string): number {
  const configs = traceConfigs(tracesPath);
  if (configs.length === 0) throw new LiveCompareError(`arm ${arm}: the deployment returned no trace`);
  for (const config of configs) {
    if (config.embedding_model !== globalModel) {
      throw new LiveCompareError(
        `arm ${arm}: a trace was served by embedding model ${String(config.embedding_model ?? 'none')}, not the active global model ${globalModel}`,
      );
    }
    for (const [name, value] of Object.entries(LIVE_REQUIRED_RAG_ENV)) {
      const served = String(config.rag_env?.[name] ?? '').trim().toLowerCase();
      if (served !== value) throw new LiveCompareError(`arm ${arm}: the deployment runs ${name}=${served || 'unset'}; the comparison needs ${value}`);
    }
  }
  return configs.length;
}

function npmOk(deps: LiveCompareDeps, script: string, args: string[], what: string): string {
  const result = deps.npm(script, args);
  if (result.status !== 0) throw new LiveCompareError(`${what} exited with code ${result.status}`);
  return result.stdout;
}

/** bind is idempotent (an existing row comes back); the id is read from its one output line. */
function bindingIdFrom(stdout: string, docType: string, profileId: string): string {
  const line = stdout.split('\n').find((entry) => entry.includes('[Embedding] binding ') && entry.includes(` → ${profileId} `) && entry.includes(docType));
  const id = line?.match(UUID)?.[0];
  if (!id) throw new LiveCompareError(`could not read the binding id for ${docType} → ${profileId}`);
  return id;
}

function reembedRunIdFrom(stdout: string, profileId: string): string {
  const line = stdout.split('\n').find((entry) => entry.startsWith('[Re-embed] completed: run '));
  const id = line?.match(UUID)?.[0];
  if (!id) throw new LiveCompareError(`the re-embed of ${profileId} did not report a completed run`);
  return id;
}

export async function runLiveDeploymentCompare(args: LiveCompareArgs, deps: LiveCompareDeps): Promise<number> {
  fs.mkdirSync(args.outDir, { recursive: true });
  const profiles = await deps.listProfiles();
  const active = profiles.filter((profile) => profile.status === 'active');
  if (active.length !== 1) throw new LiveCompareError(`the deployment has ${active.length} active global profiles; exactly one is needed`);
  const global = active[0]!;
  const candidates = args.candidates.map((id) => {
    const profile = profiles.find((entry) => entry.id === id);
    if (!profile) throw new LiveCompareError(`no embedding profile ${id} on the deployment`, EXIT_USAGE);
    if (profile.id === global.id) throw new LiveCompareError(`${id} is the active global profile, not a candidate`, EXIT_USAGE);
    return profile;
  });
  const catalog: Record<string, { model: string; usd_per_million_tokens: number; supported_languages: string[] }> = {};
  for (const candidate of candidates) {
    const entry = deps.catalogEntry(candidate.provider, candidate.model);
    if (!entry) throw new LiveCompareError(`${candidate.id}: ${candidate.provider}/${candidate.model} is not in the catalog`, EXIT_USAGE);
    catalog[candidate.id] = { model: entry.model, usd_per_million_tokens: entry.usdPerMillionTokens, supported_languages: [...entry.supportedLanguages] };
  }
  deps.log(`[Binding Compare] live deployment: global profile ${global.id} (${global.model}), candidates ${candidates.map((c) => c.id).join(', ')}`);

  for (const candidate of candidates) {
    npmOk(deps, 'rag:reembed', ['--profile', candidate.id, '--dry-run'], `re-embed dry run of ${candidate.id}`);
  }
  if (!args.confirmCost) {
    deps.log('[Binding Compare] re-run with --confirm-cost to bind, re-embed on the real project and run the arms');
    return EXIT_COST_NOT_CONFIRMED;
  }

  const runIds: string[] = [];
  for (const candidate of candidates) {
    const bindingId = bindingIdFrom(npmOk(deps, 'rag:embedding', ['bind', args.docType, candidate.id], `bind ${candidate.id}`), args.docType, candidate.id);
    npmOk(deps, 'rag:embedding', ['bind-status', bindingId, 'backfilling'], `bind-status ${bindingId} backfilling`);
    const runId = reembedRunIdFrom(npmOk(deps, 'rag:reembed', ['--profile', candidate.id], `re-embed of ${candidate.id}`), candidate.id);
    npmOk(deps, 'rag:embedding', ['bind-status', bindingId, 'available'], `bind-status ${bindingId} available`);
    runIds.push(`${candidate.id}=${runId}`);
    deps.log(`[Binding Compare] re-embedded ${candidate.id} on the deployment (run ${runId}, binding ${bindingId})`);
  }

  const scope: EvalRequestOptions = {
    ...(args.organizationId ? { organization_id: args.organizationId } : {}),
    ...(args.userId ? { user_id: args.userId } : {}),
  };
  let baselineEffectiveConfigHash = '';
  const scoreArm = async (name: string, requestOptions: EvalRequestOptions): Promise<string> => {
    const armDir = path.join(args.outDir, name);
    const result = await deps.runEval({
      goldenPath: args.golden,
      corpusDir: CORPUS_DIR,
      outDir: armDir,
      deploymentMode: 'single-tenant',
      requestOptions: { ...scope, ...requestOptions },
      tier: 'live',
      baseUrl: args.baseUrl,
    });
    const traces = assertServedByDeployment(name, result.tracesPath, global.model);
    if (name === 'baseline') baselineEffectiveConfigHash = result.manifest.effective_config_hash ?? '';
    const code = deps.python('rag_eval.runner', [
      'score',
      '--traces',
      result.tracesPath,
      '--golden',
      args.golden,
      '--manifest',
      result.runPath,
      '--out',
      armDir,
      '--rank-source',
      'candidates',
    ]);
    if (code !== 0) throw new LiveCompareError(`scoring failed for arm ${name}`);
    deps.log(`[Binding Compare] arm ${name}: ${traces} traces from the deployment`);
    return path.relative(REPO_ROOT, path.join(armDir, 'report.json'));
  };

  const baselineReport = await scoreArm('baseline', {});
  const controlReport = await scoreArm('control', { domain_control_leg: args.docType as EvalRequestOptions['domain_control_leg'] });
  const candidateReports: string[] = [];
  for (const candidate of candidates) {
    const report = await scoreArm(`candidate-${candidate.id}`, {
      embedding_bindings: { [args.docType]: candidate.id } as EvalRequestOptions['embedding_bindings'],
    });
    candidateReports.push(`${candidate.id}=${report}`);
  }

  const hashesPath = path.join(args.outDir, 'hashes.json');
  fs.writeFileSync(
    hashesPath,
    `${JSON.stringify(
      {
        corpus_sha256: sha256('live-deployment', new URL(args.baseUrl).origin, baselineEffectiveConfigHash),
        golden_sha256: fileSha256(args.golden),
        noise_sha256: fileSha256(NOISE_PATH),
        retrieval_params_hash: fileSha256(RETRIEVAL_PARAMS_PATH),
        catalog_version: deps.catalogVersion,
      },
      null,
      2,
    )}\n`,
  );
  const catalogPath = path.join(args.outDir, 'catalog.json');
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  return deps.python('rag_eval.binding_compare_cli', [
    '--doc-type',
    args.docType,
    '--baseline-profile',
    global.id,
    '--baseline',
    baselineReport,
    '--control',
    controlReport,
    ...candidateReports.flatMap((entry) => ['--candidate', entry]),
    '--golden',
    args.golden,
    '--noise',
    NOISE_PATH,
    ...runIds.flatMap((entry) => ['--reembed-run', entry]),
    '--hashes-json',
    hashesPath,
    '--catalog-json',
    catalogPath,
    '--live-deployment',
    '--note',
    LIVE_DEPLOYMENT_NOTE,
    '--out',
    path.join(args.outDir, 'comparison.json'),
  ]);
}

/** The production wiring: .env.local is loaded by the caller; npm scripts run from the repository root. */
export async function defaultLiveDeps(runPython: (module: string, args: string[]) => number): Promise<LiveCompareDeps> {
  const { listEmbeddingProfiles } = await import('../../src/lib/rag/embeddings/active-profile');
  const { EMBEDDING_CATALOG_VERSION, catalogEntry } = await import('../../src/lib/rag/embeddings/catalog');
  const runEvalModule = await import('./run-eval.mts');
  return {
    listProfiles: async () => (await listEmbeddingProfiles()).map(({ id, provider, model, status }) => ({ id, provider, model, status })),
    npm: (script, scriptArgs) => {
      const result = spawnSync('npm', ['run', '--silent', script, '--', ...scriptArgs], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      const stdout = result.stdout ?? '';
      for (const line of stdout.split('\n')) if (line.trim() !== '') console.log(line);
      return { status: result.status ?? EXIT_FAILED, stdout };
    },
    runEval: (options) => runEvalModule.runEval(options),
    python: runPython,
    catalogEntry: (provider, model) => catalogEntry(provider, model),
    catalogVersion: EMBEDDING_CATALOG_VERSION,
    log: (line) => console.log(line),
  };
}
