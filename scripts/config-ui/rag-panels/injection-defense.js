/**
 * Detector summary inside the Config UI "Prompt-injection defense" card (D-18, A-12). Reads the config server's own read-only
 * endpoint; every value is inserted as text. A failed load shows one status line and leaves the card's switches untouched.
 */

const INJECTION_DEFENSE_ENDPOINT = '/api/config/injection-defense';
const PROMPT_GUARD_LANGUAGE_NOTE =
  'Prompt Guard: en and it only; on CPU it runs inline only in eval runs and fills a warm cache for chat';
const INJECTION_RULE_LANGUAGE_ORDER = ['zh', 'en', 'it', 'any'];

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isInjectionDefenseSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  const rules = summary.rules;
  const detectors = summary.detectors;
  if (!rules || typeof rules.version !== 'string' || !rules.counts || typeof rules.counts !== 'object') return false;
  if (!detectors || typeof detectors.version !== 'string') return false;
  const pg = detectors.prompt_guard;
  const lakera = detectors.lakera;
  return Boolean(
    pg && typeof pg.model_id === 'string' && typeof pg.revision === 'string' && typeof pg.threshold === 'number' && isStringList(pg.languages) &&
      lakera && isStringList(lakera.detector_types),
  );
}

/** Label and value pairs in display order. */
function injectionDefenseRows(summary) {
  const counts = summary.rules.counts;
  const countText = INJECTION_RULE_LANGUAGE_ORDER.filter((lang) => typeof counts[lang] === 'number' && (lang !== 'any' || counts[lang] > 0))
    .map((lang) => `${lang} ${counts[lang]}`)
    .join(' · ');
  const pg = summary.detectors.prompt_guard;
  const lakera = summary.detectors.lakera;
  return [
    { label: 'Rule set version', value: summary.rules.version, code: true },
    { label: 'Rules per language', value: countText || 'none' },
    { label: 'Detector config version', value: summary.detectors.version, code: true },
    { label: 'Prompt Guard model', value: pg.model_id, code: true },
    { label: 'Prompt Guard revision', value: pg.revision, code: true },
    { label: 'Prompt Guard threshold', value: String(pg.threshold) },
    { label: 'Prompt Guard languages', value: pg.languages.join(', ') },
    { label: 'Lakera detector types', value: lakera.detector_types.join(', '), code: true },
    { label: 'Lakera minimum level', value: typeof lakera.min_level === 'string' ? lakera.min_level : 'Lakera default', code: typeof lakera.min_level === 'string' },
  ];
}

function injectionDefenseElement(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderInjectionDefenseSummary(container, summary, doc = globalThis.document) {
  const heading = injectionDefenseElement(doc, 'h4', 'font-semibold mb-2 text-balance', 'Detector configuration');
  const list = injectionDefenseElement(doc, 'dl', 'grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm');
  for (const row of injectionDefenseRows(summary)) {
    list.appendChild(injectionDefenseElement(doc, 'dt', 'text-base-content/70', row.label));
    const dd = injectionDefenseElement(doc, 'dd', 'min-w-0 break-all tabular-nums');
    if (row.code) {
      const code = injectionDefenseElement(doc, 'code', '', row.value);
      code.setAttribute('translate', 'no');
      dd.appendChild(code);
    } else {
      dd.textContent = row.value;
    }
    list.appendChild(dd);
  }
  const note = injectionDefenseElement(doc, 'p', 'text-sm text-base-content/70 mt-2', PROMPT_GUARD_LANGUAGE_NOTE);
  container.replaceChildren(heading, list, note);
}

function renderInjectionDefenseError(container, message, doc = globalThis.document) {
  const line = injectionDefenseElement(doc, 'p', 'text-sm text-error', `Detector summary unavailable: ${message}`);
  line.setAttribute('role', 'status');
  container.replaceChildren(line);
}

async function loadInjectionDefenseSummary(container, options = {}) {
  const doc = options.doc || globalThis.document;
  const fetcher = options.fetcher || ((url, init) => globalThis.fetch(url, init));
  try {
    const response = await fetcher(INJECTION_DEFENSE_ENDPOINT, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const reason = body && typeof body.error === 'string' ? body.error : `request failed (${response.status})`;
      renderInjectionDefenseError(container, reason, doc);
      return;
    }
    if (!isInjectionDefenseSummary(body)) {
      renderInjectionDefenseError(container, 'unexpected response', doc);
      return;
    }
    renderInjectionDefenseSummary(container, body, doc);
  } catch {
    renderInjectionDefenseError(container, 'the config server could not be reached', doc);
  }
}

function initInjectionDefensePanel() {
  const container = document.getElementById('injection-defense-summary');
  if (!container) return;
  void loadInjectionDefenseSummary(container);
}

if (typeof window !== 'undefined') {
  window.initInjectionDefensePanel = initInjectionDefensePanel;
  document.addEventListener('DOMContentLoaded', () => initInjectionDefensePanel());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    INJECTION_DEFENSE_ENDPOINT,
    PROMPT_GUARD_LANGUAGE_NOTE,
    injectionDefenseRows,
    renderInjectionDefenseSummary,
    loadInjectionDefenseSummary,
  };
}
