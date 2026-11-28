'use strict';

// Phase 5.3 D-13, D-14, D-18: the pre-save setting check of the Config UI, run on the operator's machine.
// Three layers (deterministic fixture smoke, live model, private real sets), one check at a time, cached by
// rag_settings_hash for 30 minutes, killed after 600 seconds. Children are spawned without a shell, with argument
// arrays and server-generated file paths only; proposed values travel in files that are deleted after the run.
// The stored check holds names, hashes and verdicts only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const gateCore = require('../src/lib/rag/config-gate/gate-core.cjs');
const { ragAffectingDiff, ragSettingsHash } = require('../src/lib/rag/config-gate/settings-hash.cjs');
const { isSecretName, hasUrlCredentials } = require('../src/lib/rag/config-gate/secret-name.cjs');
const RAG_AFFECTING_FILE = path.join(__dirname, '../src/lib/rag/config-gate/rag-affecting.generated.json');

const CHECK_TIMEOUT_MS = 600000;
const CHECK_DIR = gateCore.CHECK_DIR;
const GATES_FILE = 'eval/config/quality-gates.json';
const MEASUREMENT_FILE = 'eval/reports/phase-05.3/absolute-gate-measurement.json';
const FIXTURE_GOLDEN = 'eval/fixtures/golden.jsonl';
const PRIVATE_DOMAIN_DIR = 'eval/golden/private/domain';
const MEASUREMENT_TIER = 'smoke';
const MEASUREMENT_STAGE = 'after';
const LIVE_ANSWERABLE_PER_LANGUAGE = 10;
const MAX_REAL_SETS = 3;
const LIVE_PROVIDER_KEY = 'OPENROUTER_API_KEY';
const REAL_SET_KEY = 'RAG_EVAL_SECRET';
const LAYERS = ['deterministic', 'live', 'real_set'];

/** The only names a child process inherits from the config server's own environment (D-13, T-05.3-222). */
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CACHE_HOME',
  'UV_CACHE_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'UV_PYTHON_CACHE_DIR',
  'UV_TOOL_DIR',
  'UV_OFFLINE',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const CODE_RE = /^[a-z0-9_]+$/;
const SLICE_RE = /^[a-z0-9_]+(:[A-Za-z0-9_.|-]+)*$/;
const TENANT_HASH_RE = /^[a-f0-9]{8,64}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BACKENDS = new Set(['pgvector', 'weaviate', 'qdrant']);
const ROW_RESULTS = new Set(['passed', 'failed', 'insufficient_n', 'report_only', 'skipped']);
const MODEL_LIST_NAMES = ['NEXT_PUBLIC_OPENROUTER_MODELS', 'NEXT_PUBLIC_AI_PROVIDER'];
const TOOLCHAIN_REASONS = new Set(['ENOENT', 'EACCES']);

class LayerError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

let cachedNames = null;

/** The generated RAG-affecting list, read as data like eval/harness/env-overlay.mts does. */
function names() {
  if (!cachedNames) {
    // Fails closed: an unreadable list throws (the route answers 500) instead of treating every change as not RAG-affecting.
    const raw = JSON.parse(fs.readFileSync(RAG_AFFECTING_FILE, 'utf8'));
    if (!Array.isArray(raw.names) || raw.names.length === 0) throw new Error('rag-affecting list is empty');
    cachedNames = raw.names.filter((name) => typeof name === 'string');
  }
  return cachedNames;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function escapeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
}

/** Mirrors stringifyJsonForEnv in src/lib/env-file.ts so the hash matches the app's save. */
function stringifyJsonForEnv(data) {
  return JSON.stringify(data).replace(/[$#'`\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Fallback filter for { kind: 'config' } when the config server passes none: env names, scalar values, empty secret = unchanged. */
function defaultPrepareConfig(raw) {
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME_RE.test(name)) continue;
    if (value === null || value === undefined) continue;
    const text = typeof value === 'object' ? (Array.isArray(value) ? value.join(',') : JSON.stringify(value)) : String(value);
    if (isSecretName(name) && text === '') continue;
    if (/[\r\n\u2028\u2029]/.test(text)) return null;
    out[name] = text;
  }
  return out;
}

/** The env values a proposal changes, in the shape the matching save writes them (D-15). */
function proposalUpdates(input, prepareConfig) {
  const { kind } = input;
  if (kind === 'config') {
    if (!isPlainObject(input.config)) return null;
    return prepareConfig(input.config);
  }
  if (kind === 'prompt') {
    const prompt = input.prompt;
    if (!isPlainObject(prompt) || typeof prompt.preContext !== 'string' || prompt.preContext === '') return null;
    if (prompt.postContext !== undefined && prompt.postContext !== null && typeof prompt.postContext !== 'string') return null;
    const updates = { RAG_PRE_CONTEXT: escapeNewlines(prompt.preContext) };
    if (prompt.postContext) updates.RAG_POST_CONTEXT = escapeNewlines(prompt.postContext);
    return updates;
  }
  if (kind === 'models') {
    const models = input.models;
    if (!isPlainObject(models) || typeof models.provider !== 'string') return null;
    const lists = ['openaiModels', 'openrouterModels', 'groqModels'].map((key) => (models[key] === undefined ? [] : models[key]));
    if (!lists.every(Array.isArray)) return null;
    return {
      NEXT_PUBLIC_AI_PROVIDER: models.provider,
      NEXT_PUBLIC_OPENAI_MODELS: stringifyJsonForEnv(lists[0]),
      NEXT_PUBLIC_OPENROUTER_MODELS: stringifyJsonForEnv(lists[1]),
      NEXT_PUBLIC_GROQ_MODELS: stringifyJsonForEnv(lists[2]),
    };
  }
  return null;
}

function readEnvLocal(repoRoot) {
  const file = path.join(repoRoot, '.env.local');
  try {
    return dotenv.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function findOnPath(command, pathValue) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, command + ext), fs.constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

function defaultToolchain(repoRoot, env) {
  return { tsx: fs.existsSync(path.join(repoRoot, 'node_modules', 'tsx')), uv: findOnPath('uv', env.PATH) };
}

/** The proposed default chat model of the OpenRouter list (isDefault, else the first). */
function proposedModel(values) {
  try {
    const list = JSON.parse(values.NEXT_PUBLIC_OPENROUTER_MODELS || '[]');
    if (!Array.isArray(list)) return null;
    const chosen = list.find((model) => model && model.isDefault === true) || list[0];
    const id = chosen && typeof chosen.id === 'string' ? chosen.id : null;
    return id && MODEL_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function cleanRow(raw, slicePrefix) {
  if (!isPlainObject(raw) || typeof raw.check !== 'string' || !CODE_RE.test(raw.check)) return null;
  const slice = slicePrefix ? `${slicePrefix}:${raw.slice}` : raw.slice;
  if (typeof slice !== 'string' || !SLICE_RE.test(slice)) return null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    check: raw.check,
    slice,
    measured: number(raw.measured),
    numerator: count(raw.numerator),
    denominator: count(raw.denominator),
    limit: number(raw.limit),
    limit_kind: raw.limit_kind === 'min' ? 'min' : 'max',
    result: ROW_RESULTS.has(raw.result) ? raw.result : 'failed',
    reason: typeof raw.reason === 'string' && CODE_RE.test(raw.reason) ? raw.reason : null,
  };
}

function rowsOf(absolute, slicePrefix) {
  const checks = isPlainObject(absolute) && Array.isArray(absolute.checks) ? absolute.checks : null;
  if (!checks) return null;
  return checks.map((raw) => cleanRow(raw, slicePrefix)).filter(Boolean);
}

/** check|slice -> result of the committed measurement record for the prechunked smoke tier (O-1). */
function baselineResults(repoRoot) {
  const record = readJson(path.join(repoRoot, MEASUREMENT_FILE));
  const results = new Map();
  const tiers = record && Array.isArray(record.tiers) ? record.tiers : [];
  for (const tier of tiers) {
    if (!tier || tier.name !== MEASUREMENT_TIER || tier.stage !== MEASUREMENT_STAGE || !Array.isArray(tier.checks)) continue;
    for (const entry of tier.checks) {
      if (entry && typeof entry.check === 'string' && typeof entry.slice === 'string') results.set(`${entry.check}|${entry.slice}`, entry.result);
    }
  }
  return results;
}

/** A failure counts only where the record shows the check passing; a check the record lists as not passing is report_only. */
function applyBaseline(rows, baseline) {
  return rows.map((entry) => {
    if (entry.result !== 'failed') return entry;
    const recorded = baseline.get(`${entry.check}|${entry.slice}`);
    if (recorded === undefined || recorded === 'passed') return entry;
    return { ...entry, result: 'report_only', reason: 'baseline_failing' };
  });
}

function layerResultOf(rows) {
  return rows.some((entry) => entry.result === 'failed') ? 'fail' : 'pass';
}

function pendingLayer(layer) {
  return { layer, result: 'skipped', reason: 'not_run', set_hash: null, checks: [] };
}

function skipped(layer, reason) {
  return { layer, result: 'skipped', reason, set_hash: null, checks: [] };
}

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function liveSubset(goldenText) {
  const items = [];
  for (const line of goldenText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (isPlainObject(item) && typeof item.id === 'string') items.push({ item, line });
    } catch {
      // the harness validates the file itself
    }
  }
  const chosen = items.filter(({ item }) => item.answerable === false);
  const byLanguage = new Map();
  for (const entry of items) {
    if (entry.item.answerable !== true) continue;
    const language = String(entry.item.language || '');
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push(entry);
  }
  for (const language of [...byLanguage.keys()].sort()) {
    const ranked = byLanguage.get(language).sort((a, b) => (sha256(a.item.id) < sha256(b.item.id) ? -1 : 1));
    chosen.push(...ranked.slice(0, LIVE_ANSWERABLE_PER_LANGUAGE));
  }
  return `${chosen.map(({ line }) => line).join('\n')}\n`;
}

/**
 * Creates the check runner of the config server.
 * @param {{ repoRoot: string, spawn: Function, now?: () => number, readCurrentEnv?: () => Record<string, string>, timeoutMs?: number,
 *   prepareConfig?: (raw: object) => Record<string, string> | null, appBaseUrl?: () => string | null, processEnv?: Record<string, string | undefined>,
 *   toolchain?: () => { tsx: boolean, uv: boolean }, log?: (line: string, data?: object) => void }} options
 */
function createRagGateRunner(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const spawn = options.spawn;
  const now = options.now || (() => Date.now());
  const readCurrentEnv = options.readCurrentEnv || (() => readEnvLocal(repoRoot));
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CHECK_TIMEOUT_MS;
  const prepareConfig = options.prepareConfig || defaultPrepareConfig;
  const appBaseUrl = options.appBaseUrl || (() => null);
  const processEnv = options.processEnv || process.env;
  const log = options.log || ((line, data) => console.log(line, data || ''));

  let running = null;
  let current = Promise.resolve();

  function childEnv(currentValues, extra = {}) {
    const env = {};
    for (const name of CHILD_ENV_ALLOWLIST) {
      const value = processEnv[name];
      if (typeof value !== 'string' || value === '') continue;
      if (Object.prototype.hasOwnProperty.call(currentValues, name)) continue;
      if (isSecretName(name) || hasUrlCredentials(value)) continue;
      env[name] = value;
    }
    return { ...env, ...extra };
  }

  function save(check) {
    const written = gateCore.writeCheck(repoRoot, check);
    if (!written.ok) log('[Config Gate] check file not written', { check_id: check.check_id, reason: written.reason });
  }

  function get(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    return gateCore.readCheck(repoRoot, id);
  }

  function latest() {
    return gateCore.latestCheck(repoRoot);
  }

  async function start(input = {}) {
    const currentValues = readCurrentEnv() || {};
    const mode = gateCore.normaliseMode(currentValues.RAG_CONFIG_GATE);
    if (mode === 'off') return { status: 200, body: { required: false, mode: 'off' } };
    const updates = proposalUpdates(input, prepareConfig);
    if (!updates) return { status: 400, body: { error: 'invalid_proposal' } };
    const proposed = { ...currentValues, ...updates };
    const keys = names();
    const changed = ragAffectingDiff(currentValues, proposed, keys);
    if (changed.length === 0) return { status: 200, body: { required: false, mode } };
    const hash = ragSettingsHash(proposed, keys);
    if (running) return { status: 409, body: { error: 'rag_gate_busy', running_since: running.since } };
    if (input.force !== true) {
      const cached = gateCore.cachedCheck(repoRoot, hash, now());
      if (cached) return { status: 200, body: { ...cached, cached: true } };
    }
    const check = {
      check_id: crypto.randomUUID(),
      status: 'queued',
      stage: null,
      started_at: nowIso(now()),
      finished_at: null,
      mode,
      cached: false,
      changed_keys: changed,
      result: null,
      error_reason: null,
      layers: LAYERS.map(pendingLayer),
      rag_settings_hash: hash,
      not_evaluated: [],
      not_evaluated_on_real_set: [],
      uncalibrated_cells: [],
    };
    save(check);
    running = { id: check.check_id, since: check.started_at };
    current = runCheck(check, currentValues, proposed, changed).finally(() => {
      running = null;
    });
    return { status: 202, body: { check_id: check.check_id } };
  }

  async function runCheck(check, currentValues, proposed, changed) {
    const workDir = path.join(repoRoot, CHECK_DIR, check.check_id);
    const valueFiles = [];
    const children = new Set();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      for (const child of children) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, timeoutMs);

    const toolchain = (options.toolchain || (() => defaultToolchain(repoRoot, processEnv)))();

    function writeValueFile(name, content) {
      fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
      const file = path.join(workDir, name);
      fs.writeFileSync(file, content, { mode: 0o600 });
      valueFiles.push(file);
      return file;
    }

    function rel(file) {
      return path.relative(repoRoot, file) || file;
    }

    function run(command, args, env, { capture = false } = {}) {
      if (timedOut) return Promise.reject(new LayerError('timeout'));
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(command, args, { cwd: repoRoot, env, shell: false, stdio: capture ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'ignore', 'ignore'] });
        } catch (error) {
          reject(new LayerError(error && TOOLCHAIN_REASONS.has(error.code) ? 'toolchain_missing' : 'crashed'));
          return;
        }
        children.add(child);
        let stdout = '';
        if (capture && child.stdout) child.stdout.on('data', (chunk) => (stdout += chunk));
        let settled = false;
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          children.delete(child);
          reject(new LayerError(timedOut ? 'timeout' : error && TOOLCHAIN_REASONS.has(error.code) ? 'toolchain_missing' : 'crashed'));
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          children.delete(child);
          if (timedOut) reject(new LayerError('timeout'));
          else resolve({ code, signal, stdout });
        });
      });
    }

    const node = (script, args, env, opts) => run(process.execPath, ['--import', 'tsx', script, ...args], env, opts);
    const uv = (module, args, env) => run('uv', ['run', '--directory', 'eval', 'python', '-m', module, ...args], env);

    function update(patch) {
      Object.assign(check, patch);
      save(check);
    }

    function setLayer(index, layer) {
      check.layers[index] = { set_hash: null, checks: [], reason: null, ...layer };
      save(check);
      log('[Config Gate] layer', { check_id: check.check_id, layer: layer.layer, result: layer.result, checks: (layer.checks || []).length });
    }

    const overlayEnv = {};
    const secretChanged = [];
    for (const name of changed) {
      if (isSecretName(name)) secretChanged.push(name);
      else overlayEnv[name] = proposed[name] === undefined || proposed[name] === null ? '' : String(proposed[name]);
    }

    async function deterministic() {
      const outDir = path.join(workDir, 'deterministic');
      const overlay = writeValueFile('overlay.json', JSON.stringify({ env: overlayEnv }));
      await node(
        'eval/harness/run-smoke.mts',
        ['--env-overlay', rel(overlay), '--gates', GATES_FILE, '--gates-mode', 'report', '--out', rel(outDir)],
        childEnv(currentValues),
      );
      const gateJson = readJson(path.join(outDir, 'gate.json'));
      const rows = gateJson ? rowsOf(gateJson.absolute, null) : null;
      if (!rows) throw new LayerError('crashed');
      const report = readJson(path.join(outDir, 'overlay-report.json'));
      const notEvaluated = [];
      for (const entry of report && Array.isArray(report.not_evaluated) ? report.not_evaluated : []) {
        if (entry && ENV_NAME_RE.test(entry.name) && CODE_RE.test(String(entry.reason))) notEvaluated.push({ key: entry.name, reason: entry.reason });
      }
      for (const name of secretChanged) notEvaluated.push({ key: name, reason: 'secret' });
      check.not_evaluated = notEvaluated;
      const checked = applyBaseline(rows, baselineResults(repoRoot));
      return { layer: 'deterministic', result: layerResultOf(checked), checks: checked };
    }

    async function uncalibrated() {
      const visible = (values) => {
        const out = {};
        for (const name of names()) {
          if (isSecretName(name)) continue;
          if (values[name] !== undefined && values[name] !== null) out[name] = String(values[name]);
        }
        return out;
      };
      const currentFile = writeValueFile('current-env.json', JSON.stringify(visible(currentValues)));
      const proposedFile = writeValueFile('proposed-env.json', JSON.stringify(visible(proposed)));
      try {
        const result = await node('src/lib/rag/refusal/pending-cli.ts', ['--current', rel(currentFile), '--proposed', rel(proposedFile)], childEnv(currentValues), {
          capture: true,
        });
        if (result.code !== 0) return;
        const parsed = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
        if (Array.isArray(parsed.uncalibrated_cells)) check.uncalibrated_cells = parsed.uncalibrated_cells.filter((key) => typeof key === 'string');
      } catch (error) {
        if (error instanceof LayerError && error.reason === 'timeout') throw error;
        log('[Config Gate] uncalibrated cells not listed', { check_id: check.check_id });
      }
    }

    async function live() {
      if (String(currentValues.RAG_CONFIG_GATE_LIVE || '').trim().toLowerCase() !== 'true') return skipped('live', 'switched_off');
      const provider = String(proposed.NEXT_PUBLIC_AI_PROVIDER || 'openrouter').trim().toLowerCase();
      if (provider !== 'openrouter') return skipped('live', 'unsupported_provider');
      const key = String(proposed[LIVE_PROVIDER_KEY] || '').trim();
      if (!key) return skipped('live', 'no_credentials');
      const model = proposedModel(proposed);
      if (!model) return skipped('live', 'no_model');
      let goldenText;
      try {
        goldenText = fs.readFileSync(path.join(repoRoot, FIXTURE_GOLDEN), 'utf8');
      } catch {
        throw new LayerError('crashed');
      }
      const outDir = path.join(workDir, 'live');
      const subset = writeValueFile('live-golden.jsonl', liveSubset(goldenText));
      const overlay = writeValueFile('live-overlay.json', JSON.stringify({ env: overlayEnv }));
      const env = childEnv(currentValues);
      const nightly = await node(
        'eval/harness/run-nightly.mts',
        ['--generator', 'live', '--generator-model', model, '--golden', rel(subset), '--env-overlay', rel(overlay), '--out', rel(outDir)],
        childEnv(currentValues, { [LIVE_PROVIDER_KEY]: key }),
      );
      if (nightly.code === 4) return skipped('live', 'no_credentials');
      if (nightly.code !== 0) throw new LayerError('crashed');
      const scored = await uv(
        'rag_eval.runner',
        ['score', '--traces', rel(path.join(outDir, 'traces.jsonl')), '--golden', rel(subset), '--manifest', rel(path.join(outDir, 'run.json')), '--out', rel(outDir)],
        env,
      );
      if (scored.code !== 0) throw new LayerError('crashed');
      await uv(
        'rag_eval.absolute_gate',
        ['check', '--report', rel(path.join(outDir, 'report.json')), '--gates', GATES_FILE, '--tier', 'nightly', '--mode', 'report', '--out', rel(outDir)],
        env,
      );
      const rows = rowsOf(readJson(path.join(outDir, 'absolute.json')), null);
      if (!rows) throw new LayerError('crashed');
      return { layer: 'live', result: layerResultOf(rows), checks: rows };
    }

    function realSetRunConfig() {
      const runConfig = { name: 'config-gate', env: {} };
      const expressed = new Set();
      const backend = proposed.RAG_RETRIEVAL_BACKEND;
      if (changed.includes('RAG_RETRIEVAL_BACKEND') && BACKENDS.has(backend)) {
        runConfig.overrides = { backend };
        expressed.add('RAG_RETRIEVAL_BACKEND');
      }
      if (MODEL_LIST_NAMES.some((name) => changed.includes(name))) {
        const model = proposedModel(proposed);
        if (model) {
          runConfig.generator_model = model;
          for (const name of MODEL_LIST_NAMES) if (changed.includes(name)) expressed.add(name);
        }
      }
      check.not_evaluated_on_real_set = changed.filter((name) => !expressed.has(name));
      return runConfig;
    }

    async function realSet() {
      let tenants = [];
      try {
        tenants = fs
          .readdirSync(path.join(repoRoot, PRIVATE_DOMAIN_DIR))
          .filter((name) => TENANT_HASH_RE.test(name) && fs.existsSync(path.join(repoRoot, PRIVATE_DOMAIN_DIR, name, 'golden.jsonl')))
          .sort()
          .slice(0, MAX_REAL_SETS);
      } catch {
        tenants = [];
      }
      if (tenants.length === 0) return skipped('real_set', 'no_real_set');
      if (String(currentValues.RAG_EVAL_ENDPOINT_ENABLED || '').trim().toLowerCase() !== 'true') return skipped('real_set', 'eval_endpoint_off');
      const secret = String(currentValues[REAL_SET_KEY] || '').trim();
      if (!secret) return skipped('real_set', 'no_credentials');
      const baseUrl = appBaseUrl();
      if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) return skipped('real_set', 'no_app_url');
      const runConfig = writeValueFile('real-set-run-config.json', JSON.stringify(realSetRunConfig()));
      const rows = [];
      let worst = 'pass';
      let setHash = null;
      for (const tenant of tenants) {
        const golden = path.join(PRIVATE_DOMAIN_DIR, tenant, 'golden.jsonl');
        const outDir = path.join(workDir, `real-set-${tenant.slice(0, 8)}`);
        const smoke = await node(
          'eval/harness/run-smoke.mts',
          ['--base-url', baseUrl, '--golden', golden, '--run-config', rel(runConfig), '--no-gate', '--out', rel(outDir)],
          childEnv(currentValues, { [REAL_SET_KEY]: secret }),
        );
        if (smoke.code !== 0) throw new LayerError('crashed');
        await uv(
          'rag_eval.absolute_gate',
          ['check', '--report', rel(path.join(outDir, 'report.json')), '--gates', GATES_FILE, '--tier', 'smoke', '--mode', 'report', '--out', rel(outDir)],
          childEnv(currentValues),
        );
        const setRows = rowsOf(readJson(path.join(outDir, 'absolute.json')), tenant.slice(0, 8));
        if (!setRows) throw new LayerError('crashed');
        rows.push(...setRows);
        if (layerResultOf(setRows) === 'fail') worst = 'fail';
        if (tenants.length === 1) {
          try {
            setHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, golden))).digest('hex');
          } catch {
            setHash = null;
          }
        }
      }
      return { layer: 'real_set', result: worst, checks: rows, set_hash: setHash };
    }

    let errorReason = null;
    try {
      update({ status: 'running' });
      if (!toolchain.tsx || !toolchain.uv) throw new LayerError('toolchain_missing');
      const steps = [
        [0, deterministic],
        [1, live],
        [2, realSet],
      ];
      for (const [index, step] of steps) {
        update({ stage: LAYERS[index] });
        try {
          setLayer(index, await step());
        } catch (error) {
          const reason = error instanceof LayerError ? error.reason : 'crashed';
          setLayer(index, { layer: LAYERS[index], result: 'error', reason, checks: [] });
          errorReason = errorReason || reason;
          if (index === 0 || reason === 'timeout' || reason === 'toolchain_missing') break;
        }
        if (index === 0) await uncalibrated().catch((error) => {
          if (error instanceof LayerError && error.reason === 'timeout') errorReason = errorReason || 'timeout';
        });
        if (errorReason === 'timeout') break;
      }
    } catch (error) {
      errorReason = errorReason || (error instanceof LayerError ? error.reason : 'crashed');
    } finally {
      clearTimeout(timer);
      for (const file of valueFiles) fs.rmSync(file, { force: true });
    }
    if (timedOut) errorReason = 'timeout';
    const results = check.layers.map((layer) => layer.result);
    const result = errorReason || results.includes('error') ? 'error' : results.includes('fail') ? 'fail' : 'pass';
    update({ status: 'done', stage: null, finished_at: nowIso(now()), result, error_reason: result === 'error' ? errorReason || 'crashed' : null });
    log('[Config Gate] check done', {
      check_id: check.check_id,
      result,
      error_reason: check.error_reason,
      changed: check.changed_keys.length,
      not_evaluated: check.not_evaluated.length,
    });
  }

  return {
    start,
    get,
    latest,
    /** Resolves when the running check (if any) has finished. */
    idle: () => current.catch(() => undefined),
  };
}

const CHECK_FIELDS = [
  'check_id',
  'status',
  'stage',
  'started_at',
  'finished_at',
  'mode',
  'cached',
  'changed_keys',
  'result',
  'error_reason',
  'layers',
  'rag_settings_hash',
  'not_evaluated_on_real_set',
  'not_evaluated',
  'uncalibrated_cells',
  'saved_as',
];
const BODY_KINDS = { config: 'config', prompt: 'prompt', models: 'models' };

/** The check object of UI-SPEC 8.1 only: names, hashes and verdicts. */
function publicCheck(check, { withSavedAs = false } = {}) {
  const out = {};
  for (const field of CHECK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(check, field)) out[field] = check[field];
  }
  if (withSavedAs && out.saved_as === undefined) out.saved_as = null;
  return out;
}

function validBody(body) {
  if (!isPlainObject(body) || typeof body.kind !== 'string' || !Object.prototype.hasOwnProperty.call(BODY_KINDS, body.kind)) return false;
  const payloadKey = BODY_KINDS[body.kind];
  const allowed = new Set(['kind', 'force', payloadKey]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return false;
  if (body.force !== undefined && typeof body.force !== 'boolean') return false;
  const payload = body[payloadKey];
  if (!isPlainObject(payload)) return false;
  if (body.kind === 'prompt') {
    if (typeof payload.preContext !== 'string') return false;
    if (payload.postContext !== undefined && payload.postContext !== null && typeof payload.postContext !== 'string') return false;
  }
  if (body.kind === 'models') {
    if (typeof payload.provider !== 'string') return false;
    for (const key of ['openaiModels', 'openrouterModels', 'groqModels']) {
      if (payload[key] !== undefined && !Array.isArray(payload[key])) return false;
    }
  }
  return true;
}

/**
 * D-14: POST /api/config/rag-gate/check, GET /api/config/rag-gate/check/latest and GET /api/config/rag-gate/check/:id.
 * Mounted after securityMiddleware and express.json(), so the loopback and x-config-ui rules apply. JSON answers only.
 */
function registerRagGateRoutes(app, runner) {
  app.post('/api/config/rag-gate/check', async (req, res) => {
    if (!validBody(req.body)) return res.status(400).json({ error: 'invalid_body' });
    try {
      const answer = await runner.start(req.body);
      const body = answer.body && answer.body.check_id && answer.body.status ? publicCheck(answer.body) : answer.body;
      return res.status(answer.status).json(body);
    } catch {
      console.error('[Config Gate] check could not be started');
      return res.status(500).json({ error: 'rag_gate_failed' });
    }
  });

  app.get('/api/config/rag-gate/check/latest', (req, res) => {
    try {
      const check = runner.latest();
      if (!check) return res.status(404).json({ error: 'not_found' });
      return res.json(publicCheck(check, { withSavedAs: true }));
    } catch {
      return res.status(500).json({ error: 'rag_gate_failed' });
    }
  });

  app.get('/api/config/rag-gate/check/:id', (req, res) => {
    try {
      const id = req.params.id;
      const check = typeof id === 'string' && UUID_RE.test(id) ? runner.get(id) : null;
      if (!check) return res.status(404).json({ error: 'not_found' });
      return res.json(publicCheck(check));
    } catch {
      return res.status(500).json({ error: 'rag_gate_failed' });
    }
  });
}

/** Names POST /api/config may empty with { clear: [...] }; write-only values the UI cannot otherwise remove (UI-SPEC 6.12). */
const clearableNames = Object.freeze(['RAG_MONITOR_WEBHOOK_URL']);

const RAG_GATE_REQUIRED_MESSAGE =
  'This change affects RAG answers. Run the setting check in the Config UI and save once it passes, or save with a typed reason.';
const RAG_GATE_INVALID_REASON_MESSAGE = 'An override reason must be 10 to 500 characters.';
const RAG_GATE_OVERRIDE_REQUIRED_MESSAGE = 'Lowering RAG_CONFIG_GATE while it enforces needs a typed override reason (10 to 500 characters); it is stored in the change record.';
const MODE_RANK = { off: 0, warn: 1, enforce: 2 };

function refuseWith(status, error, message) {
  return { ok: false, status, body: message ? { success: false, error, message } : { success: false, error } };
}

function gateRequired() {
  return refuseWith(409, 'rag_gate_required', RAG_GATE_REQUIRED_MESSAGE);
}

/** The three accepted ragGate shapes of UI-SPEC 8.1, strictly: { check_id }, { override: { reason }, check_id? }, { skipped: true }. */
function parseRagGate(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false };
  const keys = Object.keys(value);
  const only = (allowed) => keys.every((key) => allowed.includes(key));
  if (Object.prototype.hasOwnProperty.call(value, 'override')) {
    if (!only(['override', 'check_id'])) return { ok: false };
    if (value.check_id !== undefined && typeof value.check_id !== 'string') return { ok: false };
    const override = value.override;
    if (!isPlainObject(override) || Object.keys(override).some((key) => key !== 'reason') || typeof override.reason !== 'string') return { ok: false };
    return { ok: true, value };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'skipped')) {
    return only(['skipped']) && value.skipped === true ? { ok: true, value } : { ok: false };
  }
  if (only(['check_id']) && typeof value.check_id === 'string') return { ok: true, value };
  return { ok: false };
}

function defaultMakeClient(values) {
  const url = values && typeof values.NEXT_PUBLIC_SUPABASE_URL === 'string' ? values.NEXT_PUBLIC_SUPABASE_URL.trim() : '';
  const key = values && typeof values.SUPABASE_SERVICE_ROLE_KEY === 'string' ? values.SUPABASE_SERVICE_ROLE_KEY.trim() : '';
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * D-10, D-15, D-16: decides one config-server write of .env.local before anything is written.
 * Mode off (the stricter of the process value and the file's RAG_CONFIG_GATE) returns at once without reading a check or
 * creating a client. A save that changes no RAG-affecting name is written without a check. Otherwise enforce needs a passed check
 * of the proposed hash or a typed reason, and every written RAG-affecting change gets a change record; an override whose record
 * cannot be written is refused with 503. Warn never blocks. Never throws: an internal failure refuses with 409 in enforce.
 * @param {{ before: Record<string, string>, after: Record<string, string>, ragGate?: unknown, repoRoot: string, mode?: string,
 *   processEnv?: Record<string, string | undefined>, makeClient?: (values: Record<string, string>) => object | null,
 *   route?: string, log?: (line: string, data?: object) => void, loadNames?: () => string[] }} input
 * @returns {Promise<{ ok: true, ragGate: { record_id: string, gate_result: string } | null } | { ok: false, status: number, body: object }>}
 */
async function guardEnvWrite(input) {
  const before = isPlainObject(input && input.before) ? input.before : {};
  const after = isPlainObject(input && input.after) ? input.after : {};
  const route = input && typeof input.route === 'string' ? input.route : 'config';
  const log = (input && input.log) || ((line, data) => console.log(line, data || ''));
  const processEnv = (input && input.processEnv) || process.env;
  const fromProcess = gateCore.normaliseMode(input && input.mode !== undefined ? input.mode : processEnv.RAG_CONFIG_GATE);
  const fromFile = gateCore.normaliseMode(before.RAG_CONFIG_GATE);
  const mode = MODE_RANK[fromFile] > MODE_RANK[fromProcess] ? fromFile : fromProcess;
  if (mode === 'off') return { ok: true, ragGate: null };

  try {
    const keys = (typeof input.loadNames === 'function' ? input.loadNames : names)();
    if (!Array.isArray(keys) || keys.length === 0) throw new Error('rag-affecting list unavailable');
    if (ragAffectingDiff(before, after, keys).length === 0) return { ok: true, ragGate: null };

    const parsed = parseRagGate(input.ragGate);
    if (!parsed.ok && mode === 'enforce') return refuseWith(400, 'invalid_rag_gate', RAG_GATE_REQUIRED_MESSAGE);
    const ragGate = parsed.ok ? parsed.value : null;

    const repoRoot = path.resolve(input.repoRoot);
    let matched = null;
    const decision = await gateCore.decideSave({
      mode,
      before,
      after,
      ragGate,
      names: keys,
      readCheck: (id) => {
        matched = gateCore.readCheck(repoRoot, id);
        return matched;
      },
    });
    if (decision.kind === 'refuse') {
      log('[Config Gate] save refused', { route, error: decision.error });
      if (decision.error === 'invalid_reason') return refuseWith(400, 'invalid_reason', RAG_GATE_INVALID_REASON_MESSAGE);
      if (decision.error === 'rag_gate_override_required') return refuseWith(409, 'rag_gate_override_required', RAG_GATE_OVERRIDE_REQUIRED_MESSAGE);
      return gateRequired();
    }

    const row = gateCore.buildChangeRecord({
      actor: 'local-config-ui',
      source: 'config_ui',
      before,
      after,
      names: keys,
      gateResult: decision.gateResult,
      check: decision.checkId ? matched : null,
      overrideReason: decision.overrideReason,
    });

    let inserted = { ok: false, reason: 'insert_failed' };
    try {
      const makeClient = input.makeClient || defaultMakeClient;
      const client = await makeClient(before);
      if (client) inserted = await gateCore.insertChangeRecord(client, row);
    } catch {
      inserted = { ok: false, reason: 'insert_failed' };
    }

    if (!inserted.ok) {
      log('[Config Gate] change record insert failed', { route, result: decision.gateResult, changed: row.changed_keys.length });
      if (decision.overrideReason !== null && mode === 'enforce') return refuseWith(503, 'rag_gate_record_failed');
      return { ok: true, ragGate: null };
    }

    log('[Config Gate] save recorded', { route, result: decision.gateResult, recordId: inserted.id, changed: row.changed_keys.length });
    return { ok: true, ragGate: { record_id: inserted.id, gate_result: decision.gateResult } };
  } catch {
    log('[Config Gate] guard failed', { route, mode });
    return mode === 'enforce' ? gateRequired() : { ok: true, ragGate: null };
  }
}

module.exports = {
  CHECK_TIMEOUT_MS,
  CHILD_ENV_ALLOWLIST,
  clearableNames,
  createRagGateRunner,
  guardEnvWrite,
  proposalUpdates,
  registerRagGateRoutes,
};
