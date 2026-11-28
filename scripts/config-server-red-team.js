'use strict';

// SEC-11: start a red-team run from the Config UI. The config server asks the main app whether the caller is an operator
// admin (GET /api/rag/admin/red-team/authorize with the forwarded session) and, only on a 200 that names an admin, starts the
// plan 07-42 runner as a detached child with execFile and a fixed argument array (no shell). One run at a time. The browser
// reads run ids, states, counts and the report cells only: never a question, an answer, corpus text, a tenant key or a path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const RUNS_DIR = path.join('eval', 'out', 'red-team');
const RUN_CONFIGS_DIR = path.join('eval', 'config', 'runs');
const TECHNIQUES_FILE = path.join('config', 'rag', 'red-team-techniques.json');
const RUNNER_SETTINGS_FILE = path.join('eval', 'golden', 'private', 'red-team-runner.json');
const RUNNER_SCRIPT = path.join('eval', 'harness', 'run-red-team.mts');
const AUTHORIZE_PATH = '/api/rag/admin/red-team/authorize';
const STATUS_FILE = 'status.json';
const REPORT_FILE = 'report.json';
const DEFAULT_TENANT = 's:default';
const AUTHORIZE_TIMEOUT_MS = 15000;
const RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_CONFIG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TENANT_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TECHNIQUE_RE = /^[a-z0-9_]{1,64}$/;
const LANGUAGE_RE = /^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*|und)$/;
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;
const PROGRESS_RE = /\[Red Team\] progress (\d+)\/(\d+)/;
const SKIPPED_REASONS = new Set(['domain_expert_review_off', 'review_route_unavailable']);
const BODY_KEYS = new Set(['runConfig']);
const SETTINGS_KEYS = new Set(['tenant', 'baseUrl', 'markerDocument', 'deploymentMode', 'organizationId', 'userId', 'generator', 'generatorModel']);

/** Runner exit codes (eval/harness/run-red-team.mts): 2 refused, 3 crashed, 4 skipped (endpoint or secret missing). */
const EXIT_CODES = { 2: 'runner_refused', 3: 'runner_crashed', 4: 'runner_skipped' };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function countOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The operator's runner settings: optional, private, never from the browser. Without the file the run is in-process on s:default. */
function parseRunnerSettings(raw) {
  if (raw === null) return { ok: true, settings: { tenant: DEFAULT_TENANT } };
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => !SETTINGS_KEYS.has(key))) return { ok: false };
  const settings = {};
  for (const key of SETTINGS_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].trim() === '' || /[\0\r\n]/.test(raw[key])) return { ok: false };
    settings[key] = raw[key].trim();
  }
  settings.tenant = settings.tenant || DEFAULT_TENANT;
  if (!TENANT_RE.test(settings.tenant)) return { ok: false };
  if (settings.baseUrl && !/^https?:\/\/[^\s]+$/i.test(settings.baseUrl)) return { ok: false };
  if (settings.markerDocument && !UUID_RE.test(settings.markerDocument)) return { ok: false };
  if (settings.organizationId && !UUID_RE.test(settings.organizationId)) return { ok: false };
  if (settings.userId && !UUID_RE.test(settings.userId)) return { ok: false };
  if (settings.deploymentMode && !['single-tenant', 'multi-tenant'].includes(settings.deploymentMode)) return { ok: false };
  if (settings.generator && !['stub', 'live'].includes(settings.generator)) return { ok: false };
  if (settings.generatorModel && !/^[A-Za-z0-9._:/-]{1,128}$/.test(settings.generatorModel)) return { ok: false };
  return { ok: true, settings };
}

/** The runner's fixed argument list. Every value is validated above; nothing reaches a shell. */
function runnerArgs({ settings, outDir, runConfig }) {
  const args = ['--import', 'tsx', RUNNER_SCRIPT, 'run', '--tenant', settings.tenant, '--out', outDir];
  if (settings.deploymentMode) args.push('--deployment-mode', settings.deploymentMode);
  if (settings.baseUrl) args.push('--base-url', settings.baseUrl);
  if (settings.markerDocument) args.push('--marker-document', settings.markerDocument);
  if (settings.organizationId) args.push('--organization-id', settings.organizationId);
  if (settings.userId) args.push('--user-id', settings.userId);
  if (settings.generator) args.push('--generator', settings.generator);
  if (settings.generatorModel) args.push('--generator-model', settings.generatorModel);
  if (runConfig) args.push('--run-config', path.join(RUN_CONFIGS_DIR, runConfig));
  return args;
}

function createRedTeamRunner(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const execFile = options.execFile;
  const fetchFn = options.fetch || ((...args) => fetch(...args));
  const appBaseUrl = options.appBaseUrl || (() => 'http://localhost:3000');
  const now = options.now || (() => Date.now());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  const processEnv = options.processEnv || process.env;
  const nodePath = options.nodePath || process.execPath;
  const runTimeoutMs = Number.isFinite(options.runTimeoutMs) && options.runTimeoutMs > 0 ? options.runTimeoutMs : RUN_TIMEOUT_MS;
  const log = options.log || ((line, data) => console.log(line, data || ''));
  const runsDir = path.join(repoRoot, RUNS_DIR);

  let running = null;

  function listRunConfigs() {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, RUN_CONFIGS_DIR), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && RUN_CONFIG_NAME_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  function techniqueLabels() {
    const raw = readJson(path.join(repoRoot, TECHNIQUES_FILE));
    const labels = new Map();
    for (const entry of raw && Array.isArray(raw.techniques) ? raw.techniques : []) {
      if (!entry || typeof entry.id !== 'string') continue;
      labels.set(entry.id, typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : entry.id);
    }
    return labels;
  }

  function readRunnerSettings() {
    const file = path.join(repoRoot, RUNNER_SETTINGS_FILE);
    if (!fs.existsSync(file)) return parseRunnerSettings(null);
    return parseRunnerSettings(readJson(file) ?? false);
  }

  function childEnv(settings) {
    const env = { ...processEnv };
    if (settings.baseUrl && !env.RAG_EVAL_SECRET) {
      try {
        const saved = dotenv.parse(fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8'));
        if (saved.RAG_EVAL_SECRET) env.RAG_EVAL_SECRET = saved.RAG_EVAL_SECRET;
      } catch {
        // no .env.local: the runner reports its own skip notice
      }
    }
    return env;
  }

  async function authorize(headers) {
    const forwarded = { Accept: 'application/json' };
    if (headers && headers.cookie) forwarded.Cookie = headers.cookie;
    if (headers && headers.authorization) forwarded.Authorization = headers.authorization;
    let url;
    try {
      url = new URL(AUTHORIZE_PATH, appBaseUrl()).toString();
    } catch {
      return { ok: false, status: 503 };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), AUTHORIZE_TIMEOUT_MS) : null;
    try {
      const response = await fetchFn(url, { method: 'GET', headers: forwarded, redirect: 'manual', ...(controller ? { signal: controller.signal } : {}) });
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status };
      if (response.status !== 200) return { ok: false, status: 503 };
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!isPlainObject(body) || body.ok !== true || typeof body.adminId !== 'string' || body.adminId.trim() === '') return { ok: false, status: 503 };
      return { ok: true, adminId: body.adminId };
    } catch {
      return { ok: false, status: 503 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function findReport(dir) {
    const direct = path.join(dir, REPORT_FILE);
    if (fs.existsSync(direct)) return readJson(direct);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const nested = path.join(dir, entry.name, REPORT_FILE);
      if (fs.existsSync(nested)) return readJson(nested);
    }
    return null;
  }

  function publicCells(report, labels) {
    const cells = [];
    for (const cell of report && Array.isArray(report.cells) ? report.cells : []) {
      if (!isPlainObject(cell) || typeof cell.technique !== 'string' || !TECHNIQUE_RE.test(cell.technique)) continue;
      if (typeof cell.language !== 'string' || !LANGUAGE_RE.test(cell.language)) continue;
      const attacks = countOf(cell.n);
      const successes = countOf(cell.successes);
      if (attacks === null || successes === null) continue;
      cells.push({ technique: cell.technique, techniqueLabel: labels.get(cell.technique) || cell.technique, language: cell.language, attacks, successes });
    }
    return cells;
  }

  function runView(id, status, report) {
    const labels = techniqueLabels();
    const cells = publicCells(report, labels);
    const total = cells.reduce((sum, cell) => sum + cell.attacks, 0);
    const statusState = status && ['running', 'finished', 'failed'].includes(status.state) ? status.state : null;
    let state = statusState || (report ? 'finished' : 'failed');
    let errorCode = status && typeof status.errorCode === 'string' && ERROR_CODE_RE.test(status.errorCode) ? status.errorCode : null;
    if (state === 'running') {
      state = 'failed';
      errorCode = 'interrupted';
    }
    if (state === 'finished' && !report) {
      state = 'failed';
      errorCode = 'report_missing';
    }
    const finished = state === 'finished';
    return {
      id,
      state,
      startedAt: isoOrNull(status && status.startedAt) || isoOrNull(report && report.started_at),
      finishedAt: isoOrNull(status && status.finishedAt) || isoOrNull(report && report.finished_at),
      progress: finished ? { done: total, total } : { done: null, total: null },
      cells: finished ? cells : [],
      reviewCasesOpened: finished ? countOf(report.review_items_opened) : null,
      casesSkippedReason: finished && SKIPPED_REASONS.has(report.skipped_reason) ? report.skipped_reason : null,
      errorCode: state === 'failed' ? errorCode || 'runner_failed' : null,
    };
  }

  function runningView() {
    return {
      id: running.id,
      state: 'running',
      startedAt: running.startedAt,
      finishedAt: null,
      progress: { done: running.done, total: running.total },
      cells: [],
      reviewCasesOpened: null,
      casesSkippedReason: null,
      errorCode: null,
    };
  }

  /** GET /api/red-team/runs/:id: the run's state and report cells, or null when the id is unknown on this machine. */
  function runStatus(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    const runId = id.toLowerCase();
    if (running && running.id === runId) return runningView();
    const dir = path.join(runsDir, runId);
    if (!fs.existsSync(dir)) return null;
    const status = readJson(path.join(dir, STATUS_FILE));
    const report = findReport(dir);
    if (!status && !report) return null;
    return runView(runId, status, report);
  }

  /** The running run, else the newest run under eval/out/red-team/, else null. */
  function latestRun() {
    if (running) return runningView();
    let entries = [];
    try {
      entries = fs.readdirSync(runsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    let best = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const view = runStatus(entry.name);
      if (!view) continue;
      let at = view.startedAt ? Date.parse(view.startedAt) : NaN;
      if (!Number.isFinite(at)) {
        try {
          at = fs.statSync(path.join(runsDir, entry.name)).mtimeMs;
        } catch {
          at = 0;
        }
      }
      if (!best || at > best.at) best = { at, view };
    }
    return best ? best.view : null;
  }

  function finish(run, error, code) {
    let exitCode = typeof code === 'number' ? code : error && typeof error.code === 'number' ? error.code : error ? null : 0;
    const killed = Boolean(error && (error.killed || error.signal));
    const report = exitCode === 0 && !killed ? findReport(run.dir) : null;
    let errorCode = null;
    if (killed) errorCode = 'runner_stopped';
    else if (error && typeof error.code === 'string') errorCode = 'spawn_failed';
    else if (exitCode !== 0) errorCode = EXIT_CODES[exitCode] || 'runner_failed';
    else if (!report) errorCode = 'report_missing';
    const status = {
      schema_version: 1,
      id: run.id,
      state: errorCode ? 'failed' : 'finished',
      startedAt: run.startedAt,
      finishedAt: new Date(now()).toISOString(),
      errorCode,
    };
    try {
      writeJson(path.join(run.dir, STATUS_FILE), status);
    } catch {
      log('[Red Team] run status not written', { run_id: run.id });
    }
    log('[Red Team] run ended', { run_id: run.id, state: status.state, exit_code: exitCode, error_code: errorCode });
    if (running && running.id === run.id) running = null;
  }

  function watchProgress(run, child) {
    if (!child || !child.stdout || typeof child.stdout.on !== 'function') return;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const match = PROGRESS_RE.exec(line);
        if (!match) continue;
        const done = Number(match[1]);
        const total = Number(match[2]);
        if (Number.isSafeInteger(done) && Number.isSafeInteger(total) && done <= total) {
          run.done = done;
          run.total = total;
        }
      }
      if (buffer.length > 4096) buffer = buffer.slice(-4096);
    });
  }

  /** POST /api/red-team/runs: validate, authorize, one run at a time, then spawn. Every refusal spawns nothing and writes nothing. */
  async function startRun(req) {
    const body = req && req.body === undefined ? {} : req && req.body;
    if (!isPlainObject(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
      return { status: 400, body: { code: 'invalid_body' } };
    }
    const runConfig = body.runConfig === undefined || body.runConfig === null || body.runConfig === '' ? null : body.runConfig;
    if (runConfig !== null && (typeof runConfig !== 'string' || !listRunConfigs().includes(runConfig))) {
      return { status: 400, body: { code: 'run_config_unavailable' } };
    }

    const auth = await authorize(req && req.headers);
    if (!auth.ok) {
      const code = auth.status === 401 ? 'unauthenticated' : auth.status === 403 ? 'forbidden' : 'admin_check_unavailable';
      return { status: auth.status, body: { code } };
    }
    if (running) return { status: 409, body: { code: 'run_active', runningRunId: running.id } };

    const parsed = readRunnerSettings();
    if (!parsed.ok) return { status: 400, body: { code: 'runner_settings_invalid' } };
    const settings = parsed.settings;
    if (settings.baseUrl && runConfig) return { status: 400, body: { code: 'run_config_not_applicable' } };

    const id = randomUUID().toLowerCase();
    if (!UUID_RE.test(id)) return { status: 500, body: { code: 'run_id_invalid' } };
    const dir = path.join(runsDir, id);
    const run = { id, dir, startedAt: new Date(now()).toISOString(), done: null, total: null };
    running = run;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJson(path.join(dir, STATUS_FILE), { schema_version: 1, id, state: 'running', startedAt: run.startedAt, finishedAt: null, errorCode: null });
    } catch {
      running = null;
      return { status: 500, body: { code: 'run_dir_unwritable' } };
    }
    const args = runnerArgs({ settings, outDir: path.join(RUNS_DIR, id), runConfig });
    let child;
    try {
      child = execFile(
        nodePath,
        args,
        { cwd: repoRoot, env: childEnv(settings), shell: false, detached: true, windowsHide: true, timeout: runTimeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_STDOUT_BYTES },
        (error) => finish(run, error, error ? undefined : 0),
      );
    } catch (error) {
      finish(run, { code: 'spawn_failed' });
      return { status: 202, body: { run: runStatus(id) } };
    }
    watchProgress(run, child);
    log('[Red Team] run started', { run_id: id, run_config: runConfig ? 'named' : 'current' });
    return { status: 202, body: { run: runningView() } };
  }

  return { startRun, runStatus, latestRun, listRunConfigs, isRunning: () => Boolean(running) };
}

/** GET /api/red-team/runs, POST /api/red-team/runs, GET /api/red-team/runs/:id. Mounted after securityMiddleware and express.json(). */
function registerRedTeamRoutes(app, runner) {
  app.get('/api/red-team/runs', (req, res) => {
    try {
      return res.json({ latest: runner.latestRun(), runConfigs: runner.listRunConfigs() });
    } catch {
      console.error('[Red Team] runs could not be read');
      return res.status(500).json({ code: 'red_team_unavailable' });
    }
  });

  app.post('/api/red-team/runs', async (req, res) => {
    try {
      const answer = await runner.startRun({ headers: req.headers, body: req.body });
      return res.status(answer.status).json(answer.body);
    } catch {
      console.error('[Red Team] run could not be started');
      return res.status(500).json({ code: 'red_team_unavailable' });
    }
  });

  app.get('/api/red-team/runs/:id', (req, res) => {
    try {
      const run = runner.runStatus(req.params.id);
      if (!run) return res.status(404).json({ code: 'not_found' });
      return res.json({ run });
    } catch {
      return res.status(500).json({ code: 'red_team_unavailable' });
    }
  });
}

module.exports = {
  AUTHORIZE_PATH,
  RUNNER_SETTINGS_FILE,
  createRedTeamRunner,
  registerRedTeamRoutes,
  parseRunnerSettings,
  runnerArgs,
};
