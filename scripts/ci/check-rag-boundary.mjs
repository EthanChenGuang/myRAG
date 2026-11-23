import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCAN_ROOTS = ['src', 'scripts', 'voice-agent/src', 'tests', 'eval/harness'];
export const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist']);

export const ALLOWLIST = [
  { path: 'tests/', reason: 'test suites exercise the pipeline internals directly' },
  { path: 'scripts/tests/', reason: 'CI script self-tests carry rule fixtures as literals' },
  { path: 'eval/harness/', reason: 'the evaluation harness drives retrieval backends directly' },
  { path: 'scripts/rag/reprocess-documents.js', reason: 'offline re-embed ingestion script' },
];

export const RETIRED_MODULES = [
  'enhanced-rag-retrieval',
  'retrieval-strategies',
  'optimized-search',
  'adaptive-retrieval',
  'reranker-adapter',
  'reranker-local',
  'query-enhancer-local',
  'bm25-scorer',
  'mmr-scorer',
  'temporal-query-detector',
  'thinking-rag-enhancer',
];

export const VECTOR_OR_RERANK_PACKAGES = ['weaviate-client', '@qdrant/js-client-rest', 'cohere-ai', 'voyageai'];
export const AI_SDK_BANNED_EXPORTS = ['embed', 'embedMany', 'rerank'];

const RAG_DIR = 'src/lib/rag/';
const TENANT_DIR = 'src/lib/rag/tenant/';

const outsideRag = (rel) => !rel.startsWith(RAG_DIR);
const outsideTenant = (rel) => !rel.startsWith(TENANT_DIR);
const inVoiceAgent = (rel) => rel.startsWith('voice-agent/src/');

const IMPORT_FROM_RE =
  /\b(?:import|export)\s+(?:type\s+)?((?:[\w$]+\s*,?\s*)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})?)\s*from\s*(['"])([^'"\n]+)\2/g;
const IMPORT_SIDE_EFFECT_RE = /\bimport\s*(['"])([^'"\n]+)\1/g;
const IMPORT_CALL_RE = /\b(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1/g;

export function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote || (ch === '\n' && quote !== '`')) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < text.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

export function listImports(text) {
  const found = [];
  for (const m of text.matchAll(IMPORT_FROM_RE)) {
    found.push({ spec: m[3], clause: m[1], kind: 'from', index: m.index + m[0].lastIndexOf(m[3]) });
  }
  for (const m of text.matchAll(IMPORT_SIDE_EFFECT_RE)) {
    found.push({ spec: m[2], clause: '', kind: 'side-effect', index: m.index + m[0].lastIndexOf(m[2]) });
  }
  for (const m of text.matchAll(IMPORT_CALL_RE)) {
    found.push({ spec: m[2], clause: '', kind: 'call', index: m.index + m[0].lastIndexOf(m[2]) });
  }
  return found;
}

function regexMatches(re, text) {
  return [...text.matchAll(re)].map((m) => ({ index: m.index, message: m[0].replace(/\s+/g, ' ').trim() }));
}

function importMatches(text, predicate) {
  const out = [];
  for (const imp of listImports(text)) {
    const message = predicate(imp);
    if (message) out.push({ index: imp.index, message });
  }
  return out;
}

const clauseNames = (clause) =>
  [...clause.matchAll(/[\w$]+/g)].map((m) => m[0]).filter((n) => n !== 'type' && n !== 'as');

const specBase = (spec) => spec.replace(/\.(?:[cm]?[jt]sx?)$/, '');

export const RULES = [
  {
    id: 'embeddings-call',
    description: 'embeddings API called outside the pipeline',
    appliesTo: outsideRag,
    find: (text) => regexMatches(/\.embeddings\s*\.\s*create\s*\(/g, text),
  },
  {
    id: 'retrieval-rpc',
    description: 'retrieval RPC (match_*, hybrid_*, search_chunks*) called outside the pipeline',
    appliesTo: outsideRag,
    find: (text) => regexMatches(/\.rpc\s*\(\s*(['"`])(?:match_|hybrid_|search_chunks)/g, text),
  },
  {
    id: 'voice-agent-rpc',
    description: 'the voice agent must not call database RPCs; it goes through the app API',
    appliesTo: inVoiceAgent,
    find: (text) => regexMatches(/\.rpc\s*\(/g, text),
  },
  {
    id: 'retired-module',
    description: 'import of a retired or re-homed retrieval module',
    appliesTo: outsideRag,
    find: (text) =>
      importMatches(text, ({ spec }) => {
        if (spec.includes('/rag/') || spec.endsWith('/rag')) return null;
        const base = specBase(spec).split('/').pop();
        return RETIRED_MODULES.includes(base) ? spec : null;
      }),
  },
  {
    id: 'deep-import',
    description: 'import below @/lib/rag instead of the public index',
    appliesTo: outsideRag,
    find: (text) =>
      importMatches(text, ({ spec }) => {
        const m = /(?:^|\/)lib\/rag\/(.+)$/.exec(specBase(spec));
        return m && m[1] !== 'index' ? spec : null;
      }),
  },
  {
    id: 'vector-or-rerank-client',
    description: 'vector-store or reranker client package, or AI SDK embed/embedMany/rerank, outside the pipeline',
    appliesTo: outsideRag,
    find: (text) =>
      importMatches(text, ({ spec, clause }) => {
        if (VECTOR_OR_RERANK_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) return spec;
        if (spec === 'ai' && clauseNames(clause).some((n) => AI_SDK_BANNED_EXPORTS.includes(n))) {
          return `ai: ${clauseNames(clause).filter((n) => AI_SDK_BANNED_EXPORTS.includes(n)).join(', ')}`;
        }
        return null;
      }),
  },
  {
    id: 'mint-scope',
    description: 'mintScope used outside src/lib/rag/tenant/',
    appliesTo: outsideTenant,
    find: (text) => {
      const out = importMatches(text, ({ spec, clause, kind }) => {
        if (kind !== 'from') return null;
        if (clauseNames(clause).includes('mintScope')) return `mintScope from ${spec}`;
        if (/\*/.test(clause) && /(?:^|\/)tenant\/scope$/.test(specBase(spec))) return `namespace import of ${spec}`;
        return null;
      });
      const requireRe = /\{[^}]*\bmintScope\b[^}]*\}\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g;
      out.push(...regexMatches(requireRe, text).map((m) => ({ index: m.index, message: 'mintScope via require' })));
      return out;
    },
  },
];

export function isAllowlisted(rel) {
  return ALLOWLIST.some((a) => (a.path.endsWith('/') ? rel.startsWith(a.path) : rel === a.path));
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

export function collectFiles(root) {
  const seen = new Set();
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(path.join(root, scanRoot))) seen.add(file);
  }
  return [...seen].sort();
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function checkBoundary(root = DEFAULT_ROOT) {
  const violations = [];
  for (const file of collectFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (isAllowlisted(rel)) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const rule of RULES) {
      if (!rule.appliesTo(rel)) continue;
      for (const hit of rule.find(text)) {
        const line = lineOf(text, hit.index);
        const key = `${line}:${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({ file: rel, line, rule: rule.id, message: hit.message });
      }
    }
  }
  return violations;
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i] ?? '');
  }
  return args;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const violations = checkBoundary(root);
  if (violations.length === 0) {
    console.log(`[check-rag-boundary] ok: ${collectFiles(root).length} file(s) scanned, no boundary violations`);
    return 0;
  }
  for (const v of violations) console.error(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
  console.error(`[check-rag-boundary] ${violations.length} violation(s)`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
