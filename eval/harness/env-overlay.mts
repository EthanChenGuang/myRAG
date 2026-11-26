import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * `--env-overlay <file>` (Phase 5.3 D-13): proposed settings for an in-process fixture run, `{ "env": { NAME: value } }`.
 * Names come from the generated RAG-affecting list; secrets are refused. Names the fixture layer cannot exercise are not
 * applied and are reported as `not_evaluated` with a reason code (research Pitfall 8), never dropped silently.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RAG_AFFECTING_PATH = path.join(REPO_ROOT, 'src/lib/rag/config-gate/rag-affecting.generated.json');
export const OVERLAY_REPORT_FILE = 'overlay-report.json';
const MAX_VALUE_CHARS = 100_000;
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const require = createRequire(import.meta.url);
const { isSecretName, hasUrlCredentials } = require('../../src/lib/rag/config-gate/secret-name.cjs') as {
  isSecretName: (name: string) => boolean;
  hasUrlCredentials: (value: unknown) => boolean;
};

export type NotEvaluatedReason = 'fake_generator' | 'fixture_embedder' | 'no_credentials' | 'fixture_pin' | 'external_service';

export class OverlayError extends Error {
  readonly names: readonly string[];

  constructor(message: string, names: readonly string[] = []) {
    super(message);
    this.name = 'OverlayError';
    this.names = names;
  }
}

/** Values the fixture layer sets itself: the embedder, the deployment mode, the languages, the fake-edge endpoints, the eval floor. */
export const FIXTURE_PINNED_NAMES: readonly string[] = [
  'OPENAI_EMBEDDING_MODEL',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'COHERE_BASE_URL',
  'VOYAGE_BASE_URL',
  'DEEPINFRA_BASE_URL',
  'RAG_EVAL_RETRIEVAL_MIN_SIMILARITY',
];

const FIXTURE_EMBEDDER_RE = /^(?:OPENAI_EMBEDDING_MODEL|RAG_OPENAI_EMBEDDINGS_VIA|RAG_QWEN_EMBED_(?:PRIMARY|FALLBACK)|RAG_BGE_M3_SERVING|RAG_FINETUNE|RAG_FT_SLOT_[A-Z]_[A-Z_]+)$/;
const FAKE_GENERATOR_NAMES = new Set([
  'NEXT_PUBLIC_AI_PROVIDER',
  'NEXT_PUBLIC_OPENAI_MODELS',
  'NEXT_PUBLIC_OPENROUTER_MODELS',
  'RAG_GROUNDEDNESS_JUDGE_MODEL',
  'RAG_QUERY_LLM_MODEL',
  'RAG_DOC_TRANSLATION_MODEL',
  'RAG_PARSE_VLM_MODEL',
]);
const NO_CREDENTIALS_RE =
  /^(?:COHERE_BASE_URL|VOYAGE_BASE_URL|DEEPINFRA_BASE_URL|ANTHROPIC_BASE_URL|LAKERA_GUARD_BASE_URL|RAG_CLAUDE_CITATIONS|RAG_INJECTION_LAKERA(?:_MULTI_TENANT_ACK)?|RAG_GROUNDEDNESS_VECTARA_(?:OPT_IN|MULTI_TENANT_ACK)|LLAMACLOUD_[A-Z_]+)$/;
const EXTERNAL_SERVICE_NAMES = new Set([
  'QDRANT_URL',
  'WEAVIATE_URL',
  'RAG_RETRIEVAL_BACKEND',
  'RAG_RETRIEVAL_BACKEND_VOICE',
  'RAG_VECTOR_SYNC_MAX_LAG_SECONDS',
  'RAG_SIDECAR_URL',
]);

/** Why the fixture layer cannot exercise a name, or null when it applies it. */
export function notEvaluatedReason(name: string): NotEvaluatedReason | null {
  if (FIXTURE_EMBEDDER_RE.test(name)) return 'fixture_embedder';
  if (FAKE_GENERATOR_NAMES.has(name)) return 'fake_generator';
  if (NO_CREDENTIALS_RE.test(name)) return 'no_credentials';
  if (EXTERNAL_SERVICE_NAMES.has(name)) return 'external_service';
  if (FIXTURE_PINNED_NAMES.includes(name)) return 'fixture_pin';
  return null;
}

export interface NotEvaluatedEntry {
  name: string;
  reason: NotEvaluatedReason;
}

export interface EnvOverlay {
  /** The names the run applies, with their values. */
  env: Record<string, string>;
  evaluated: string[];
  notEvaluated: NotEvaluatedEntry[];
}

export function loadRagAffectingNames(file: string = RAG_AFFECTING_PATH): ReadonlySet<string> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { names?: unknown };
  if (!Array.isArray(raw.names) || !raw.names.every((name) => typeof name === 'string')) {
    throw new OverlayError(`[Env Overlay] ${file}: names must be a list of strings`);
  }
  return new Set(raw.names as string[]);
}

/** Validates an overlay object and splits it into applied and not-evaluated names. */
export function parseEnvOverlay(raw: unknown, ragAffecting: ReadonlySet<string> = loadRagAffectingNames()): EnvOverlay {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OverlayError('[Env Overlay] the overlay must be a JSON object');
  const unknownKeys = Object.keys(raw).filter((key) => key !== 'env');
  if (unknownKeys.length > 0) throw new OverlayError(`[Env Overlay] unknown top-level key(s): ${unknownKeys.join(', ')}`, unknownKeys);
  const envRaw = (raw as { env?: unknown }).env;
  if (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw)) {
    throw new OverlayError('[Env Overlay] env must be an object of variable names to string values');
  }
  const entries = Object.entries(envRaw as Record<string, unknown>);
  const secrets = entries.map(([name]) => name).filter((name) => isSecretName(name));
  if (secrets.length > 0) throw new OverlayError('[Env Overlay] secrets cannot be set through an overlay', secrets.sort());
  const refused = entries.map(([name]) => name).filter((name) => !NAME_RE.test(name) || !ragAffecting.has(name));
  if (refused.length > 0) throw new OverlayError('[Env Overlay] only RAG-affecting names can be overlaid', refused.sort());
  const badValues = entries
    .filter(([, value]) => typeof value !== 'string' || value.length > MAX_VALUE_CHARS || hasUrlCredentials(value))
    .map(([name]) => name);
  if (badValues.length > 0) {
    throw new OverlayError(
      `[Env Overlay] values must be strings of at most ${MAX_VALUE_CHARS} characters with no credentials in a URL`,
      badValues.sort(),
    );
  }
  const env: Record<string, string> = {};
  const notEvaluated: NotEvaluatedEntry[] = [];
  for (const [name, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const reason = notEvaluatedReason(name);
    if (reason) notEvaluated.push({ name, reason });
    else env[name] = value as string;
  }
  return { env, evaluated: Object.keys(env), notEvaluated };
}

export function loadEnvOverlay(file: string, ragAffecting?: ReadonlySet<string>): EnvOverlay {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new OverlayError(`[Env Overlay] ${file} is not readable JSON: ${(error as Error).message}`);
  }
  return parseEnvOverlay(raw, ragAffecting);
}

/** overlay-report.json: names only, never values (a prompt can be long and an operator's value is not ours to copy). */
export function overlayReport(overlay: EnvOverlay): { schema_version: 1; evaluated: string[]; not_evaluated: NotEvaluatedEntry[] } {
  return { schema_version: 1, evaluated: [...overlay.evaluated], not_evaluated: overlay.notEvaluated.map((entry) => ({ ...entry })) };
}

export function writeOverlayReport(outDir: string, overlay: EnvOverlay): string {
  const file = path.join(outDir, OVERLAY_REPORT_FILE);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(overlayReport(overlay), null, 2)}\n`);
  return file;
}
