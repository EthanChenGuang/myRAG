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

export const WRITER_RPCS = [
  'rag_begin_document_version',
  'rag_write_chunks',
  'rag_write_profile_chunks',
  'rag_publish_document_version',
  'rag_set_document_fields',
  'rag_save_ingest_state',
];

const LEGACY_REMOVED_BY = 'Phase 7 release defaults (RAG_INGEST_PIPELINE removal)';

export const LEGACY_WRITERS = [
  {
    path: 'src/app/api/process-document/route.ts',
    rules: ['chunk-writer', 'document-insert'],
    reason: 'legacy branch: own LlamaParse upload, character chunker and direct document and chunk inserts',
    removedBy: LEGACY_REMOVED_BY,
  },
  {
    path: 'src/app/api/ai-to-rag/route.ts',
    rules: ['chunk-writer', 'document-insert'],
    reason: 'legacy branch: own document and chunk inserts for saved AI answers',
    removedBy: LEGACY_REMOVED_BY,
  },
  {
    path: 'src/lib/supabase.ts',
    rules: ['chunk-writer', 'document-insert'],
    reason: 'storeDocument, called by document-processor.ts and the Nango and scraper adapters under the legacy pipeline',
    removedBy: LEGACY_REMOVED_BY,
  },
];

export function legacyWriterProblems(list, knownRules = null) {
  const known = knownRules ?? new Set(RULES.map((r) => r.id));
  const problems = [];
  for (const [i, entry] of list.entries()) {
    const label = entry?.path || `entry ${i}`;
    if (typeof entry?.path !== 'string' || entry.path.trim() === '') problems.push(`${label}: path is required`);
    if (!Array.isArray(entry?.rules) || entry.rules.length === 0) problems.push(`${label}: rules must list at least one rule id`);
    else for (const id of entry.rules) if (!known.has(id)) problems.push(`${label}: unknown rule ${id}`);
    if (typeof entry?.reason !== 'string' || entry.reason.trim() === '') problems.push(`${label}: reason is required`);
    if (typeof entry?.removedBy !== 'string' || entry.removedBy.trim() === '') {
      problems.push(`${label}: removedBy must name the plan that removes this legacy writer`);
    }
  }
  return problems;
}

const RAG_DIR = 'src/lib/rag/';
export const LANGCHAIN_DIR = 'src/lib/rag/query/langchain/';
const SELF_TEST_DIR = 'scripts/tests/';
const RERANK_DIR = 'src/lib/rag/rerank/';
const TENANT_DIR = 'src/lib/rag/tenant/';
const INGEST_DIR = 'src/lib/rag/ingest/';
const PROFILES_DIR = 'src/lib/rag/ingest/profiles/';
const LEDGER_CLIENT = 'src/lib/rag/ingest/ledger.ts';
const BUDGET_CLIENT = 'src/lib/rag/ingest/guard/cloud-budget.ts';
const CACHE_CLIENT = 'src/lib/rag/ingest/parse-cache.ts';
const BACKFILL_DIR = 'src/lib/rag/ingest/backfill/';

const outsideRag = (rel) => !rel.startsWith(RAG_DIR);
const inSrcOrScripts = (rel) => rel.startsWith('src/') || rel.startsWith('scripts/');
const outsideRerankHttp = (rel) => inSrcOrScripts(rel) && !rel.startsWith(RERANK_DIR);
const LAKERA_ADAPTER = 'src/lib/rag/security/lakera.ts';
const outsideLakeraAdapter = (rel) => rel !== LAKERA_ADAPTER;
const outsideTenant = (rel) => !rel.startsWith(TENANT_DIR);
const inVoiceAgent = (rel) => rel.startsWith('voice-agent/src/');
const isLegacyWriter = (rel, ruleId) => LEGACY_WRITERS.some((w) => w.path === rel && w.rules.includes(ruleId));
const writerRuleApplies = (ruleId) => (rel) => !rel.startsWith(INGEST_DIR) && !isLegacyWriter(rel, ruleId);
const docTypeRuleApplies = (rel) => rel.startsWith('src/') && !rel.startsWith(PROFILES_DIR);

const fromTable = (table) => String.raw`\.from\s*(?:<[^>()]*>)?\s*\(\s*(['"\`])${table}\1[^()]*\)\s*`;
const CHUNK_WRITE_RE = new RegExp(`${fromTable('document_chunks')}\\.\\s*(?:insert|update|upsert)\\s*\\(`, 'g');
const DOCUMENT_INSERT_RE = new RegExp(`${fromTable('documents')}\\.\\s*(?:insert|upsert)\\s*\\(`, 'g');
const WRITER_RPC_RE = new RegExp(String.raw`\.rpc\s*\(\s*(['"\`])(?:${WRITER_RPCS.join('|')})`, 'g');
const DOC_TYPE_NAME = String.raw`(?:doc_type|docType)\b`;
const DOC_TYPE_COMPARE_RE = new RegExp(String.raw`\b${DOC_TYPE_NAME}\s*[!=]==?`, 'g');
const DOC_TYPE_COMPARE_REVERSED_RE = new RegExp(String.raw`[!=]==?\s*[\w$.]*\b${DOC_TYPE_NAME}`, 'g');
const DOC_TYPE_SWITCH_RE = new RegExp(String.raw`\bswitch\s*\(\s*[\w$.]*\b${DOC_TYPE_NAME}`, 'g');

const LEDGER_TABLES = [
  'ingestion_jobs',
  'ingestion_batches',
  'rag_parse_cache',
  'rag_parse_budget_usage',
  'rag_parse_budget_reservations',
  'rag_parse_tier_overrides',
  'rag_embed_batches',
];
const LEDGER_TABLE_WRITE_RE = new RegExp(
  String.raw`\.from\s*(?:<[^>()]*>)?\s*\(\s*(['"\`])(${LEDGER_TABLES.join('|')})\1[^()]*\)\s*\.\s*(?:insert|update|upsert|delete)\s*\(`,
  'g',
);
const LEDGER_RPC_RE = /\.rpc\s*\(\s*(['"`])[^'"`]*ingestion_job/g;
const BUDGET_RPCS = [
  'rag_reserve_parse_budget',
  'rag_settle_parse_budget',
  'rag_release_parse_budget',
  'rag_reserve_batch_budget',
];
const BUDGET_RPC_RE = new RegExp(String.raw`\.rpc\s*\(\s*(['"\`])(?:${BUDGET_RPCS.join('|')})`, 'g');
const BACKFILL_RPC_TOKENS = ['ingestion_batch', 'rag_enqueue_backfill_jobs', 'rag_existing_file_hashes', 'embed_batch'];
const BACKFILL_RPC_RE = new RegExp(
  `\\.rpc\\s*\\(\\s*(['"\`])[^'"\`\\$]*(?:${BACKFILL_RPC_TOKENS.join('|')})`,
  'g',
);

const TERMINOLOGY_DIR = 'src/lib/rag/terminology/';
const TERMINOLOGY_RPC_RE = /\.rpc\s*\(\s*(['"`])rag_term_/g;
const TERMINOLOGY_TABLE_RE = new RegExp(String.raw`\.from\s*(?:<[^>()]*>)?\s*\(\s*(['"\`])rag_term_`, 'g');

const inSrc = (rel) => rel.startsWith('src/');
// D-16: the deterministic lookup RPCs run only inside the pipeline, and the lookup module never builds SQL or reaches a model.
export const TABLE_LOOKUP_RPCS = [
  'rag_table_lookup',
  'rag_identifier_resolve',
  'rag_identifier_candidates',
  'rag_document_versions',
  'rag_dup_cluster_sources',
];
export const TABLE_LOOKUP_MODULE = 'src/lib/rag/retrieval/table-lookup.ts';
const TABLE_LOOKUP_RPC_RE = new RegExp(String.raw`\.rpc\s*\(\s*(['"\`])(?:${TABLE_LOOKUP_RPCS.join('|')})\1`, 'g');
const STRING_LITERAL_RE = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
const SQL_KEYWORD_RE = /\b(?:select|insert|update|delete|drop|alter|truncate|union|execute|where|join|from|into|values)\b/i;
const SQL_CALL_RE = /\.(?:from|query|sql|raw|unsafe)\s*(?:<[^>()]*>)?\s*\(|\bsql\s*`/g;
const MODEL_PACKAGE_RE = /^(?:ai|openai|@ai-sdk\/|@openrouter\/|@anthropic-ai\/|@langchain\/|@modelcontextprotocol\/)/;
const MODEL_MODULE_PREFIXES = ['src/lib/rag/generation/', 'src/lib/rag/query/llm', 'src/lib/rag/rerank/', 'src/lib/openrouter', 'src/lib/ai'];
const isTableLookupModule = (rel) => rel === TABLE_LOOKUP_MODULE;

function findTableLookupSql(text, rel) {
  const out = [];
  for (const m of text.matchAll(STRING_LITERAL_RE)) {
    if (SQL_KEYWORD_RE.test(m[0])) out.push({ index: m.index, message: `SQL text in a string: ${m[0].slice(0, 60)}` });
  }
  out.push(...regexMatches(SQL_CALL_RE, text));
  for (const imp of listImports(text)) {
    const resolved = resolveSpec(rel, imp.spec);
    const model =
      resolved === null ? MODEL_PACKAGE_RE.test(imp.spec) : MODEL_MODULE_PREFIXES.some((prefix) => `${specBase(resolved)}`.startsWith(prefix));
    if (model) out.push({ index: imp.index, message: `generation or model import ${imp.spec}` });
  }
  return out;
}

const outsideTerminologyDir = (rel) => inSrc(rel) && !rel.startsWith(TERMINOLOGY_DIR);
const outsideLedgerClient = (rel) => inSrc(rel) && rel !== LEDGER_CLIENT;
const outsideBudgetClient = (rel) => inSrc(rel) && rel !== BUDGET_CLIENT;
const outsideBackfillDir = (rel) => inSrc(rel) && !rel.startsWith(BACKFILL_DIR);

export const LANGCHAIN_ADAPTER_ALLOWED_IMPORTS = [
  { kind: 'package-prefix', value: '@langchain/', reason: 'LangChain packages' },
  { kind: 'path-prefix', value: LANGCHAIN_DIR, reason: 'files inside the adapter' },
  { kind: 'path', value: 'src/lib/rag/query/port-types', reason: 'the retrieval port types (D-18)' },
  { kind: 'path-prefix', value: 'src/lib/rag/query/prompts/', reason: 'versioned query prompts' },
  { kind: 'path', value: 'src/lib/rag/query/transformer', typeOnly: true, reason: 'the QueryTransformer interface, types only' },
  { kind: 'path', value: 'src/lib/rag-eval/contracts.generated', reason: 'generated zod/v3 contracts' },
  { kind: 'path-prefix', value: 'rag-sidecar/schemas/', suffix: '.schema.json', reason: 'generated JSON Schemas' },
];

const QUERY_DIR = 'src/lib/rag/query/';
const QUERY_LLM_MODULE = 'src/lib/rag/query/llm';

export const QUERY_LLM_IMPORTERS = [
  { path: QUERY_DIR, reason: 'query transforms call the query LLM (D-13)' },
  { path: 'src/lib/rag/deps.ts', reason: 'RagDeps builds the default client so a fake can be injected' },
];
export const QUERY_LLM_AI_CALLS = ['generateText', 'generateObject', 'streamText', 'streamObject'];

export const CACHE_RPC_HOMES = [
  { prefix: 'rag_set_document_parse_cache', home: CACHE_CLIENT, srcOnly: true, reason: 'Phase 3.1 parse cache' },
  { prefix: 'rag_parse_cache_', home: CACHE_CLIENT, srcOnly: true, reason: 'Phase 3.1 parse cache' },
  { prefix: 'rag_cache_', home: 'src/lib/rag/cache/', reason: 'tenant-keyed semantic cache' },
  { name: 'rag_tenant_language_shares', home: QUERY_DIR, reason: 'tenant-keyed KB language shares' },
];

const pathMatches = (rel, p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CACHE_RPC_MATCHERS = CACHE_RPC_HOMES.map((entry) => ({
  ...entry,
  re: new RegExp(
    String.raw`\.rpc\s*\(\s*(['"\`])` + (entry.name ? `${escapeRe(entry.name)}(?![\\w])` : escapeRe(entry.prefix)),
    'g',
  ),
}));

function findCacheRpc(text, rel) {
  const out = [];
  for (const m of CACHE_RPC_MATCHERS) {
    if (m.srcOnly && !inSrc(rel)) continue;
    if (pathMatches(rel, m.home)) continue;
    out.push(...regexMatches(m.re, text));
  }
  return out;
}

function findQueryLlmCall(text, rel) {
  const importerAllowed = QUERY_LLM_IMPORTERS.some((a) => pathMatches(rel, a.path));
  const aiCallsAllowed = !rel.startsWith(QUERY_DIR) || specBase(rel) === QUERY_LLM_MODULE;
  return importMatches(text, (imp) => {
    if (!importerAllowed) {
      const resolved = resolveSpec(rel, imp.spec);
      const base = resolved === null ? null : specBase(resolved);
      if (base === QUERY_LLM_MODULE || base === `${QUERY_LLM_MODULE}/index`) return `query LLM client ${imp.spec}`;
    }
    if (!aiCallsAllowed && imp.spec === 'ai') {
      if (imp.kind === 'call') return 'dynamic import of ai';
      if (imp.kind !== 'from' || imp.typeOnly) return null;
      const banned = clauseNames(imp.clause).filter((n) => QUERY_LLM_AI_CALLS.includes(n));
      if (banned.length > 0) return `ai: ${banned.join(', ')}`;
      if (/\*/.test(imp.clause)) return 'namespace import of ai';
    }
    return null;
  });
}

const LANGCHAIN_PACKAGE_RE = /^(?:@langchain\/|langchain(?:\/|$))/;
const ZOD_V4_RE = /^zod\/(?:v4|mini|v4-mini)(?:\/|$)/;

export function resolveSpec(rel, spec) {
  if (spec.startsWith('@/')) return path.posix.normalize(`src/${spec.slice(2)}`);
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
  }
  return null;
}

export function adapterImportAllowed(rel, imp) {
  const resolved = resolveSpec(rel, imp.spec);
  const base = resolved === null ? null : specBase(resolved).replace(/\/$/, '');
  return LANGCHAIN_ADAPTER_ALLOWED_IMPORTS.some((entry) => {
    if (entry.kind === 'package-prefix') return resolved === null && imp.spec.startsWith(entry.value);
    if (base === null) return false;
    if (entry.typeOnly && !imp.typeOnly) return false;
    if (entry.suffix && !base.endsWith(entry.suffix)) return false;
    if (entry.kind === 'path') return base === entry.value;
    return `${base}/`.startsWith(entry.value);
  });
}

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

function isTypeOnly(statement, clause) {
  if (/^(?:import|export)\s+type\s/.test(statement)) return true;
  const braces = /^\s*\{([^}]*)\}\s*$/.exec(clause);
  if (!braces) return false;
  const names = braces[1].split(',').map((n) => n.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

export function listImports(text) {
  const found = [];
  for (const m of text.matchAll(IMPORT_FROM_RE)) {
    found.push({ spec: m[3], clause: m[1], kind: 'from', typeOnly: isTypeOnly(m[0], m[1]), index: m.index + m[0].lastIndexOf(m[3]) });
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

const outsideLangchainDir = (rel) => !rel.startsWith(LANGCHAIN_DIR);
const inLangchainDir = (rel) => rel.startsWith(LANGCHAIN_DIR);
const outsideSelfTests = (rel) => !rel.startsWith(SELF_TEST_DIR);
const everywhere = () => true;

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
    id: 'finetune-export-rpc',
    description: 'fine-tune vector export RPC (rag_finetune_export_vectors) called outside the pipeline',
    appliesTo: outsideRag,
    find: (text) => regexMatches(/\.rpc\s*\(\s*(['"`])rag_finetune_export_vectors\1/g, text),
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
  {
    id: 'chunk-writer',
    description: 'document_chunks written (insert, update, upsert) outside src/lib/rag/ingest/',
    appliesTo: writerRuleApplies('chunk-writer'),
    find: (text) => regexMatches(CHUNK_WRITE_RE, text),
  },
  {
    id: 'document-insert',
    description: 'documents row inserted outside src/lib/rag/ingest/',
    appliesTo: writerRuleApplies('document-insert'),
    find: (text) => regexMatches(DOCUMENT_INSERT_RE, text),
  },
  {
    id: 'writer-rpc',
    description: 'ingest writer RPC called outside src/lib/rag/ingest/',
    appliesTo: writerRuleApplies('writer-rpc'),
    find: (text) => regexMatches(WRITER_RPC_RE, text),
  },
  {
    id: 'doc-type-branching',
    description: 'document type compared or switched on outside src/lib/rag/ingest/profiles/ (profiles are data, D-13)',
    appliesTo: docTypeRuleApplies,
    find: (text) => [
      ...regexMatches(DOC_TYPE_COMPARE_RE, text),
      ...regexMatches(DOC_TYPE_COMPARE_REVERSED_RE, text),
      ...regexMatches(DOC_TYPE_SWITCH_RE, text),
    ],
  },
  {
    id: 'ledger-table-write',
    description: 'ledger, cache or budget tables mutated via PostgREST outside SQL RPCs (D-04)',
    appliesTo: inSrc,
    find: (text) => regexMatches(LEDGER_TABLE_WRITE_RE, text),
  },
  {
    id: 'ledger-rpc',
    description: 'ingestion_job RPC called outside src/lib/rag/ingest/ledger.ts',
    appliesTo: outsideLedgerClient,
    find: (text) => regexMatches(LEDGER_RPC_RE, text),
  },
  {
    id: 'budget-rpc',
    description: 'parse or batch budget RPC called outside src/lib/rag/ingest/guard/cloud-budget.ts',
    appliesTo: outsideBudgetClient,
    find: (text) => regexMatches(BUDGET_RPC_RE, text),
  },
  {
    id: 'cache-rpc',
    description:
      'cache RPC called outside its home: parse cache in src/lib/rag/ingest/parse-cache.ts, rag_cache_* in src/lib/rag/cache/, rag_tenant_language_shares in src/lib/rag/query/',
    appliesTo: everywhere,
    find: findCacheRpc,
  },
  {
    id: 'backfill-rpc',
    description: 'backfill batch RPC called outside src/lib/rag/ingest/backfill/',
    appliesTo: outsideBackfillDir,
    find: (text) => regexMatches(BACKFILL_RPC_RE, text),
  },
  {
    id: 'terminology-rpc',
    description: 'rag_term_* RPC call or table access under src/ outside src/lib/rag/terminology/ (read through getTerminologyLexicon)',
    appliesTo: outsideTerminologyDir,
    find: (text) => [...regexMatches(TERMINOLOGY_RPC_RE, text), ...regexMatches(TERMINOLOGY_TABLE_RE, text)],
  },
  {
    id: 'table-lookup-rpc',
    description: `deterministic lookup RPC (${TABLE_LOOKUP_RPCS.join(', ')}) called outside src/lib/rag (go through runRetrieval)`,
    appliesTo: outsideRag,
    find: (text) => regexMatches(TABLE_LOOKUP_RPC_RE, text),
  },
  {
    id: 'table-lookup-sql',
    description: 'SQL text, a query builder call, or a generation or model import in the table lookup module (D-16: token arrays only)',
    appliesTo: isTableLookupModule,
    find: (text, rel) => findTableLookupSql(text, rel),
  },
  {
    id: 'rerank-http',
    description: 'hosted rerank HTTP call outside src/lib/rag/rerank/',
    appliesTo: outsideRerankHttp,
    find: (text) => {
      const out = [];
      out.push(...regexMatches(/fetch\s*\([^)\n]*api\.cohere\.com/g, text));
      out.push(...regexMatches(/fetch\s*\([^)\n]*api\.voyageai\.com/g, text));
      out.push(...regexMatches(/fetch\s*\(\s*[`'"][^`'"\n]*\/rerank/g, text));
      out.push(...regexMatches(/fetch\s*\(\s*`[^`\n]*\/rerank/g, text));
      return out;
    },
  },
  {
    id: 'lakera-http',
    description: 'Lakera Guard host or guard endpoint path outside src/lib/rag/security/lakera.ts (the gated adapter)',
    appliesTo: outsideLakeraAdapter,
    find: (text) => [
      ...regexMatches(/\b(?:[a-z0-9-]+\.)*api\.lakera\.ai\b/gi, text),
      ...regexMatches(/\/v2\/guard\b/g, text),
    ],
  },
  {
    id: 'langchain-import',
    description: `@langchain package imported outside ${LANGCHAIN_DIR} (D-19)`,
    appliesTo: outsideLangchainDir,
    enforcedOnAllowlisted: outsideSelfTests,
    find: (text) => importMatches(text, ({ spec }) => (LANGCHAIN_PACKAGE_RE.test(spec) ? spec : null)),
  },
  {
    id: 'langchain-adapter-reach',
    description: 'the LangChain adapter imports outside its allow-list (LANGCHAIN_ADAPTER_ALLOWED_IMPORTS, D-18)',
    appliesTo: inLangchainDir,
    find: (text, rel) => importMatches(text, (imp) => (adapterImportAllowed(rel, imp) ? null : imp.spec)),
  },
  {
    id: 'query-llm-call',
    description: 'query-LLM client imported outside src/lib/rag/query/ and deps.ts, or an ai generate/stream call in src/lib/rag/query/ outside llm.ts (D-13)',
    appliesTo: everywhere,
    find: findQueryLlmCall,
  },
  {
    id: 'zod-v4',
    description: 'zod 4 (zod/v4, zod/mini) imported in app code; only LangChain\'s nested copy uses zod 4 (D-20)',
    appliesTo: everywhere,
    find: (text) => importMatches(text, ({ spec }) => (ZOD_V4_RE.test(spec) ? spec : null)),
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
    const allowlisted = isAllowlisted(rel);
    const rules = RULES.filter(
      (rule) => rule.appliesTo(rel) && (!allowlisted || (rule.enforcedOnAllowlisted?.(rel) ?? false)),
    );
    if (rules.length === 0) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const rule of rules) {
      for (const hit of rule.find(text, rel)) {
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
