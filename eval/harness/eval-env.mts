import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INIT_ENV_PATH = path.join(REPO_ROOT, 'scripts/init-env.js');
const PINNED_PATH = path.join(REPO_ROOT, 'eval/config/rag-eval-env.json');

const EXCLUDED_PREFIXES = ['RAG_EVAL_', 'RAG_SIDECAR_', 'RAG_VOICE_TOKEN_'];
const EXCLUDED_NAMES = new Set(['RAG_SYSTEM_PROMPT', 'RAG_PRE_CONTEXT', 'RAG_POST_CONTEXT', 'RAG_EMBED_TENANT']);

export function derivePinnedEvalEnv(initEnvText: string): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const line of initEnvText.split('\n')) {
    const match = /^(RAG_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1];
    const value = match[2].trim();
    if (value.includes('${')) continue;
    if (EXCLUDED_NAMES.has(name)) continue;
    if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    pinned[name] = value;
  }
  pinned.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
  pinned.NEXT_PUBLIC_MCP_SYSTEM_ENABLED = 'true';
  pinned.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  return sortKeys(pinned);
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

export function loadPinnedEvalEnv(): Record<string, string> {
  return JSON.parse(fs.readFileSync(PINNED_PATH, 'utf8')) as Record<string, string>;
}

function serialize(pinned: Record<string, string>): string {
  return `${JSON.stringify(pinned, null, 2)}\n`;
}

function runCli(argv: string[]): number {
  const derived = derivePinnedEvalEnv(fs.readFileSync(INIT_ENV_PATH, 'utf8'));
  if (argv.includes('--write')) {
    fs.mkdirSync(path.dirname(PINNED_PATH), { recursive: true });
    fs.writeFileSync(PINNED_PATH, serialize(derived));
    console.log(`[Eval Env] wrote ${Object.keys(derived).length} pinned value(s) to ${path.relative(REPO_ROOT, PINNED_PATH)}`);
    return 0;
  }
  if (argv.includes('--check')) {
    const current = fs.existsSync(PINNED_PATH) ? fs.readFileSync(PINNED_PATH, 'utf8') : '';
    if (current === serialize(derived)) {
      console.log('[Eval Env] pinned eval env matches scripts/init-env.js');
      return 0;
    }
    console.error('[Eval Env] eval/config/rag-eval-env.json drifted from scripts/init-env.js; run: npx tsx eval/harness/eval-env.mts --write');
    return 1;
  }
  console.error('[Eval Env] usage: eval-env.mts --write | --check');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)));
}
