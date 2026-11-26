/**
 * Query layer card additions (D-44, D-22, research P-10): the calibrated cache distance per embedding profile (read-only), the
 * config warnings, the LangChain install hint next to the framework select and the authenticated "Clear cache for tenant" action.
 * Status comes from the config server's own read-only endpoint; the clear action goes to the app through ragFetch with the
 * forwarded admin_session cookie. Every value is inserted as text.
 */

const QUERY_LAYER_STATUS_ENDPOINT = '/api/config/query-layer/status';
const SEMANTIC_CACHE_CLEAR_PATH = '/api/rag/admin/semantic-cache';

const QUERY_LAYER_WARNING_TEXT = {
  cache_under_legacy:
    'The semantic cache is on, but the retrieval pipeline is legacy. The cache runs only with the v2 pipeline (RAG Modes, Retrieval pipeline).',
  langchain_missing:
    'LangChain is selected, but @langchain/classic is not installed. Until the package is installed, the query layer runs on the native LlamaIndex port.',
  langsmith_tracing_set:
    'LANGSMITH_* or LANGCHAIN_TRACING* is set while LangChain is selected. LangChain may send query traces to LangSmith; unset these variables unless that is intended.',
};

const LANGCHAIN_INSTALL_HINT =
  'LangChain needs the @langchain/classic package, which is not installed. Until it is, the query layer runs on the native LlamaIndex port.';

function queryLayerElement(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function isQueryLayerStatus(status) {
  if (!status || typeof status !== 'object') return false;
  const calibration = status.calibration;
  return Boolean(
    typeof status.framework === 'string' &&
      typeof status.langchain_installed === 'boolean' &&
      Array.isArray(status.warnings) &&
      calibration &&
      typeof calibration.calibrated === 'boolean' &&
      Array.isArray(calibration.profiles),
  );
}

function formatDistance(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '–';
}

function renderCalibration(doc, calibration) {
  const section = queryLayerElement(doc, 'div', 'space-y-2');
  section.appendChild(queryLayerElement(doc, 'h4', 'font-semibold text-sm text-balance', 'Calibrated cache distance'));
  if (!calibration.calibrated || calibration.profiles.length === 0) {
    const text =
      calibration.state === 'invalid'
        ? 'Not calibrated: eval/config/semantic-cache.json is not valid, so Max hit distance applies to every profile.'
        : 'Not calibrated yet: Max hit distance applies to every profile. Run python -m rag_eval.calibrate cache, commit the result and redeploy.';
    section.appendChild(queryLayerElement(doc, 'p', 'text-sm text-base-content/70', text));
    return section;
  }
  const table = queryLayerElement(doc, 'table', 'table table-sm w-full');
  table.appendChild(queryLayerElement(doc, 'caption', 'text-left text-sm text-base-content/70 mb-1', 'Read-only. Changes only through the calibration tool and a pull request.'));
  const head = queryLayerElement(doc, 'thead');
  const headRow = queryLayerElement(doc, 'tr');
  for (const label of ['Embedding profile', 'Max distance', 'Source', 'Fitted']) {
    const th = queryLayerElement(doc, 'th', '', label);
    th.setAttribute('scope', 'col');
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  const body = queryLayerElement(doc, 'tbody');
  for (const profile of calibration.profiles) {
    const row = queryLayerElement(doc, 'tr');
    const id = queryLayerElement(doc, 'td', 'min-w-0 break-all');
    const code = queryLayerElement(doc, 'code', '', String(profile.embedding_profile_id));
    code.setAttribute('translate', 'no');
    id.appendChild(code);
    row.appendChild(id);
    row.appendChild(queryLayerElement(doc, 'td', 'tabular-nums', formatDistance(profile.max_distance)));
    row.appendChild(queryLayerElement(doc, 'td', '', profile.source === 'calibrated' ? 'Calibrated' : 'Default'));
    row.appendChild(queryLayerElement(doc, 'td', 'tabular-nums', typeof profile.fitted_at === 'string' ? profile.fitted_at.slice(0, 10) : '–'));
    body.appendChild(row);
  }
  table.appendChild(head);
  table.appendChild(body);
  section.appendChild(table);
  return section;
}

function renderQueryLayerStatus(container, status, doc = globalThis.document) {
  const nodes = [];
  for (const code of status.warnings) {
    const text = QUERY_LAYER_WARNING_TEXT[code];
    if (!text) continue;
    const alert = queryLayerElement(doc, 'div', 'alert alert-warning text-sm', text);
    alert.setAttribute('role', 'alert');
    nodes.push(alert);
  }
  nodes.push(renderCalibration(doc, status.calibration));
  container.replaceChildren(...nodes);
}

function renderQueryLayerError(container, message, doc = globalThis.document) {
  const line = queryLayerElement(doc, 'p', 'text-sm text-error', `Query layer status unavailable: ${message}`);
  line.setAttribute('role', 'status');
  container.replaceChildren(line);
}

/** Loads and renders the status; returns it, or null after rendering an error line. */
async function loadQueryLayerStatus(container, options = {}) {
  const doc = options.doc || globalThis.document;
  const fetcher = options.fetcher || ((url, init) => globalThis.fetch(url, init));
  try {
    const response = await fetcher(QUERY_LAYER_STATUS_ENDPOINT, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      renderQueryLayerError(container, body && typeof body.error === 'string' ? body.error : `request failed (${response.status})`, doc);
      return null;
    }
    if (!isQueryLayerStatus(body)) {
      renderQueryLayerError(container, 'unexpected response', doc);
      return null;
    }
    renderQueryLayerStatus(container, body, doc);
    return body;
  } catch {
    renderQueryLayerError(container, 'the config server could not be reached', doc);
    return null;
  }
}

/** The install hint for the framework currently selected in the form (not the saved value). */
function renderFrameworkWarning(el, framework, status, _doc = globalThis.document) {
  const show = framework === 'langchain' && Boolean(status) && status.langchain_installed === false;
  el.textContent = show ? LANGCHAIN_INSTALL_HINT : '';
  el.hidden = !show;
}

async function clearTenantCache(tenantKey, options = {}) {
  const key = typeof tenantKey === 'string' ? tenantKey.trim() : '';
  if (!key) return { ok: false, message: 'Enter a tenant key, for example s:default or o:<organization id>.' };
  const fetcher = options.ragFetch || (typeof window !== 'undefined' ? window.ragFetch : null);
  if (typeof fetcher !== 'function') return { ok: false, message: 'The admin request helper is not loaded. Reload the Config UI.' };
  try {
    const result = await fetcher(SEMANTIC_CACHE_CLEAR_PATH, { method: 'POST', body: JSON.stringify({ tenantKey: key }) });
    if (!result.ok) {
      const message = result.message || (result.body && typeof result.body.error === 'string' ? result.body.error : `Request failed (${result.status})`);
      return { ok: false, message };
    }
    const body = result.body || {};
    if (body.backend === 'off') return { ok: true, message: 'The semantic cache is off; nothing was cleared.' };
    const deleted = typeof body.deleted === 'number' ? body.deleted : 0;
    return { ok: true, message: `Cleared ${deleted} cached ${deleted === 1 ? 'answer' : 'answers'} for this tenant.` };
  } catch {
    return { ok: false, message: 'The request could not be sent. Check that the main app is running.' };
  }
}

function initQueryLayerPanel() {
  const container = document.getElementById('query-layer-status');
  const frameworkSelect = document.getElementById('RAG_QUERY_FRAMEWORK');
  const frameworkWarning = document.getElementById('query-layer-framework-warning');
  const tenantInput = document.getElementById('query-layer-clear-tenant');
  const clearButton = document.getElementById('query-layer-clear-button');
  const clearResult = document.getElementById('query-layer-clear-result');
  let status = null;

  const refreshFrameworkWarning = () => {
    if (frameworkSelect && frameworkWarning) renderFrameworkWarning(frameworkWarning, frameworkSelect.value, status);
  };

  if (container) {
    void loadQueryLayerStatus(container).then((loaded) => {
      status = loaded;
      refreshFrameworkWarning();
    });
  }
  if (frameworkSelect) frameworkSelect.addEventListener('change', refreshFrameworkWarning);

  if (clearButton && tenantInput && clearResult) {
    clearButton.addEventListener('click', async () => {
      clearButton.disabled = true;
      clearResult.className = 'text-sm min-w-0';
      clearResult.textContent = 'Clearing…';
      const result = await clearTenantCache(tenantInput.value);
      clearResult.className = result.ok ? 'text-sm min-w-0 text-success' : 'text-sm min-w-0 text-error';
      clearResult.textContent = result.message;
      clearButton.disabled = false;
    });
  }
}

if (typeof window !== 'undefined') {
  window.initQueryLayerPanel = initQueryLayerPanel;
  document.addEventListener('DOMContentLoaded', () => initQueryLayerPanel());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUERY_LAYER_STATUS_ENDPOINT,
    SEMANTIC_CACHE_CLEAR_PATH,
    QUERY_LAYER_WARNING_TEXT,
    LANGCHAIN_INSTALL_HINT,
    isQueryLayerStatus,
    renderQueryLayerStatus,
    loadQueryLayerStatus,
    renderFrameworkWarning,
    clearTenantCache,
  };
}
