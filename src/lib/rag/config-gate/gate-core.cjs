'use strict';

// Phase 5.3 D-10, D-14 to D-16: the save decision, the change record and the check store, shared by
// scripts/config-server.js and the app. Dependency-free apart from node: modules and the sibling settings-hash.cjs.
// Records and check files hold setting names and hashes only, never a setting value or prompt text.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ragAffectingDiff, ragSettingsHash } = require('./settings-hash.cjs');
const generated = require('./rag-affecting.generated.json');

const OVERRIDE_REASON_MIN = 10;
const OVERRIDE_REASON_MAX = 500;
const CHECK_CACHE_MS = 30 * 60 * 1000;
const CHECK_DIR = 'eval/out/config-gate';
const CHANGE_TABLE = 'rag_config_change_records';
const RECORD_COLUMNS =
  'id, created_at, actor, source, changed_keys, before_hash, after_hash, retrieval_config_hash, gate_result, gate_summary, override_reason, uncalibrated_cells';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const CODE_RE = /^[a-z0-9_]+$/;
const CELL_KEY_RE = /^[A-Za-z0-9_.:/@+-]{1,128}(\|[A-Za-z0-9_.:/@+-]{1,128}){1,7}$/;
const DB_CELL_KEY_RE = /^[A-Za-z0-9_.:/|-]{1,200}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;
const FIXED_ACTORS = new Set(['local-config-ui', 'cli', 'ci']);
const SOURCES = new Set(['config_ui', 'cli', 'release_override', 'local_prerelease', 'profile_activation']);
const RELEASE_SOURCES = new Set(['release_override', 'local_prerelease']);
const GATE_RESULTS = new Set(['pass', 'fail', 'error', 'skipped', 'not_required']);
const CHECK_STATUSES = new Set(['queued', 'running', 'done']);
const CHECK_RESULTS = new Set(['pass', 'fail', 'error']);
const LAYER_ORDER = ['deterministic', 'live', 'real_set'];
const LAYER_RESULTS = new Set(['pass', 'fail', 'error', 'skipped']);
const MAX_CHANGED_KEYS = 200;
const MAX_CELLS = 500;

const REQUIRED = Object.freeze({ kind: 'refuse', status: 409, error: 'rag_gate_required' });
const INVALID_REASON = Object.freeze({ kind: 'refuse', status: 400, error: 'invalid_reason' });

function defaultNames() {
  return Array.isArray(generated && generated.names) ? generated.names : [];
}

/** D-10: '' or missing is off; warn and enforce as named; any other value fails closed as enforce. */
function normaliseMode(mode) {
  const value = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (value === '' || value === 'off') return 'off';
  if (value === 'warn') return 'warn';
  return 'enforce';
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function trimmedReason(ragGate) {
  const override = ragGate && typeof ragGate === 'object' ? ragGate.override : undefined;
  if (!override || typeof override !== 'object') return { present: false, reason: null, valid: false };
  const reason = typeof override.reason === 'string' ? override.reason.trim() : '';
  const valid = reason.length >= OVERRIDE_REASON_MIN && reason.length <= OVERRIDE_REASON_MAX;
  return { present: true, reason, valid };
}

async function matchingCheck(ragGate, readCheck, hash) {
  const id = ragGate && typeof ragGate === 'object' ? ragGate.check_id : undefined;
  if (!isUuid(id) || typeof readCheck !== 'function') return null;
  let check;
  try {
    check = await readCheck(id);
  } catch {
    return null;
  }
  if (!check || typeof check !== 'object') return null;
  if (check.check_id !== id || check.status !== 'done' || check.rag_settings_hash !== hash) return null;
  return CHECK_RESULTS.has(check.result) ? check : null;
}

function write(gateResult, checkId = null, overrideReason = null) {
  return { kind: 'write', gateResult, checkId, overrideReason };
}

/**
 * D-10, D-15: decides one save.
 * @param {{ mode?: string, before: object, after: object, ragGate?: object | null, readCheck?: (id: string) => object | null | Promise<object | null>, names?: Iterable<string> }} input
 * @returns {Promise<{ kind: 'write', gateResult: string, checkId: string | null, overrideReason: string | null } | { kind: 'refuse', status: number, error: string }>}
 */
async function decideSave({ mode, before, after, ragGate, readCheck, names } = {}) {
  const effective = normaliseMode(mode);
  if (effective === 'off') return write('not_required');
  const keys = names ? [...names] : defaultNames();
  if (ragAffectingDiff(before || {}, after || {}, keys).length === 0) return write('not_required');

  const reason = trimmedReason(ragGate);
  if (effective === 'enforce' && reason.present && !reason.valid) return { ...INVALID_REASON };

  const hash = ragSettingsHash(after || {}, keys);
  const check = await matchingCheck(ragGate, readCheck, hash);
  const checkId = check ? check.check_id : null;
  const overrideReason = reason.present && reason.valid ? reason.reason : null;

  if (effective === 'warn') return write(check ? check.result : 'skipped', checkId, overrideReason);
  if (overrideReason !== null) return write(check ? check.result : 'skipped', checkId, overrideReason);
  if (check && check.result === 'pass') return write('pass', checkId);
  return { ...REQUIRED };
}

function uniqueMatching(values, pattern, cap) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || !pattern.test(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

function gateSummary(check, source, releaseSha, githubActor) {
  const summary = { checks: 0, failed: 0, skipped: 0, offenders: [], layers: {} };
  const layers = check && Array.isArray(check.layers) ? check.layers : [];
  for (const layer of layers) {
    if (!layer || !LAYER_ORDER.includes(layer.layer)) continue;
    if (LAYER_RESULTS.has(layer.result)) summary.layers[layer.layer] = layer.result;
    for (const row of Array.isArray(layer.checks) ? layer.checks : []) {
      if (!row || typeof row !== 'object') continue;
      summary.checks += 1;
      if (row.result === 'failed') {
        summary.failed += 1;
        if (typeof row.check === 'string' && CODE_RE.test(row.check) && !summary.offenders.includes(row.check)) summary.offenders.push(row.check);
      } else if (row.result === 'skipped') {
        summary.skipped += 1;
      }
    }
  }
  summary.offenders.sort();
  if (RELEASE_SOURCES.has(source)) {
    if (typeof releaseSha === 'string' && GIT_SHA_RE.test(releaseSha)) summary.release_sha = releaseSha;
    if (typeof githubActor === 'string' && GITHUB_LOGIN_RE.test(githubActor)) summary.github_actor = githubActor;
  }
  return summary;
}

function recordReason(value) {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  if (reason.length < OVERRIDE_REASON_MIN) return null;
  return reason.slice(0, OVERRIDE_REASON_MAX);
}

function hashOrThrow(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${label} must be a sha256 hex string`);
  return value;
}

/**
 * D-16: one rag_config_change_records row without id and created_at (the database sets both).
 * Hashes come from ragSettingsHash over before and after, or from beforeHash and afterHash when no values are known.
 * Only the listed fields are read, so a value passed in by mistake never reaches the row.
 */
function buildChangeRecord(input = {}) {
  const { actor, source, before, after, gateResult, check, overrideReason, uncalibratedCells, releaseSha, githubActor } = input;
  if (typeof actor !== 'string' || !(FIXED_ACTORS.has(actor) || isUuid(actor))) throw new TypeError('actor must be a user id, local-config-ui, cli or ci');
  if (!SOURCES.has(source)) throw new TypeError('unknown change source');
  if (!GATE_RESULTS.has(gateResult)) throw new TypeError('unknown gate result');
  const keys = input.names ? [...input.names] : defaultNames();
  const hasValues = before && typeof before === 'object' && after && typeof after === 'object';
  const changed = hasValues ? ragAffectingDiff(before, after, keys) : input.changedKeys;
  const cells = Array.isArray(uncalibratedCells) ? uncalibratedCells : check && Array.isArray(check.uncalibrated_cells) ? check.uncalibrated_cells : [];
  const retrieval = typeof input.retrievalConfigHash === 'string' && SHA256_RE.test(input.retrievalConfigHash) ? input.retrievalConfigHash : null;
  return {
    actor,
    source,
    changed_keys: uniqueMatching(changed, ENV_NAME_RE, MAX_CHANGED_KEYS),
    before_hash: hasValues ? ragSettingsHash(before, keys) : hashOrThrow(input.beforeHash, 'beforeHash'),
    after_hash: hasValues ? ragSettingsHash(after, keys) : hashOrThrow(input.afterHash, 'afterHash'),
    retrieval_config_hash: retrieval,
    gate_result: gateResult,
    gate_summary: gateSummary(check, source, releaseSha, githubActor),
    override_reason: recordReason(overrideReason),
    uncalibrated_cells: uniqueMatching(cells, { test: (cell) => CELL_KEY_RE.test(cell) && DB_CELL_KEY_RE.test(cell) }, MAX_CELLS),
  };
}

/** Inserts one row with the service-role client. Never throws. */
async function insertChangeRecord(client, row) {
  try {
    if (!client || typeof client.from !== 'function') return { ok: false, reason: 'insert_failed' };
    const { data, error } = await client.from(CHANGE_TABLE).insert(row).select('id').single();
    if (error || !data || !isUuid(data.id)) return { ok: false, reason: 'insert_failed' };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, reason: 'insert_failed' };
  }
}

/** Lists rows created at or after since, newest first. Never throws. */
async function listChangeRecords(client, { since, limit } = {}) {
  try {
    if (!client || typeof client.from !== 'function') return { ok: false, reason: 'read_failed' };
    const { data, error } = await client
      .from(CHANGE_TABLE)
      .select(RECORD_COLUMNS)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return { ok: false, reason: 'read_failed' };
    return { ok: true, records: data };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

function checkDir(root) {
  return path.join(root, CHECK_DIR);
}

/** Minimal shape of a check file; the app wrapper adds ConfigGateCheckSchema on top. */
function isCheckShape(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return false;
  if (!isUuid(check.check_id) || !CHECK_STATUSES.has(check.status)) return false;
  if (check.mode !== 'warn' && check.mode !== 'enforce') return false;
  if (typeof check.rag_settings_hash !== 'string' || !SHA256_RE.test(check.rag_settings_hash)) return false;
  if (!Array.isArray(check.layers) || check.layers.length !== LAYER_ORDER.length) return false;
  if (!check.layers.every((layer, i) => layer && layer.layer === LAYER_ORDER[i] && LAYER_RESULTS.has(layer.result))) return false;
  if (check.status === 'done') {
    if (!CHECK_RESULTS.has(check.result)) return false;
  } else if (check.result !== null && check.result !== undefined) {
    return false;
  }
  return true;
}

function accepted(check, validate) {
  if (!isCheckShape(check)) return false;
  if (typeof validate !== 'function') return true;
  try {
    return validate(check) === true;
  } catch {
    return false;
  }
}

/** Writes a check atomically (temporary file in the same directory, then rename). */
function writeCheck(root, check) {
  if (!isCheckShape(check)) return { ok: false, reason: 'invalid_check' };
  try {
    const dir = checkDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${check.check_id}.json`);
    const temp = path.join(dir, `.${check.check_id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(check, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

/** A missing, unreadable or invalid file, or an id that is not a uuid, reads as null (fail closed). */
function readCheck(root, id, options = {}) {
  if (!isUuid(id)) return null;
  try {
    const check = JSON.parse(fs.readFileSync(path.join(checkDir(root), `${id}.json`), 'utf8'));
    return check && check.check_id === id && accepted(check, options.validate) ? check : null;
  } catch {
    return null;
  }
}

function storedChecks(root, options) {
  let names;
  try {
    names = fs.readdirSync(checkDir(root));
  } catch {
    return [];
  }
  const checks = [];
  for (const name of names) {
    const match = /^([0-9a-f-]{36})\.json$/.exec(name);
    if (!match) continue;
    const check = readCheck(root, match[1], options);
    if (check) checks.push(check);
  }
  return checks;
}

function timeOf(check) {
  const value = Date.parse(check.finished_at || check.started_at || '');
  return Number.isFinite(value) ? value : -Infinity;
}

/** The newest valid check by finished_at (or started_at), or null. */
function latestCheck(root, options = {}) {
  let best = null;
  for (const check of storedChecks(root, options)) {
    if (!best || timeOf(check) > timeOf(best)) best = check;
  }
  return best;
}

/** D-14: a done, non-error check of the same hash finished less than CHECK_CACHE_MS before nowMs, or null. */
function cachedCheck(root, hash, nowMs, options = {}) {
  if (typeof hash !== 'string' || !SHA256_RE.test(hash)) return null;
  let best = null;
  for (const check of storedChecks(root, options)) {
    if (check.status !== 'done' || check.result === 'error' || check.rag_settings_hash !== hash) continue;
    const finished = Date.parse(check.finished_at || '');
    if (!Number.isFinite(finished) || finished > nowMs || nowMs - finished >= CHECK_CACHE_MS) continue;
    if (!best || finished > timeOf(best)) best = check;
  }
  return best;
}

module.exports = {
  CHECK_CACHE_MS,
  CHECK_DIR,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  buildChangeRecord,
  cachedCheck,
  decideSave,
  insertChangeRecord,
  latestCheck,
  listChangeRecords,
  normaliseMode,
  readCheck,
  writeCheck,
};
