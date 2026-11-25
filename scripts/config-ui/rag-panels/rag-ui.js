/**
 * Shared helpers for the Phase 3.2 RAG administration panels (UI-SPEC 6.1). Plain-text DOM only: every value is set with
 * textContent or as an attribute through ragUiEl, never as markup. Later panels use these helpers; they do not edit them.
 */

let ragUiSharedIngestLabel = null;
if (typeof require !== 'undefined') {
  try {
    ragUiSharedIngestLabel = require('../document-processing/status-monitor.js').ingestLabel;
  } catch {
    ragUiSharedIngestLabel = null;
  }
}

const RAG_UI_LABELS = {
  en: {
    'action.reload': 'Reload panel',
    'panel.workspace': 'Workspace: {name}',
    'panel.updated': 'Updated {time}',
    'error.workspace':
      'Your admin account is not a member of this workspace. Choose another workspace under Document Processing, Upload Destination.',
    'error.changed': 'This item was changed by someone else. The list has been reloaded.',
    'error.outcomeUnknown':
      'The server did not answer, so the change may or may not have been made. The list has been reloaded; check it before trying again.',
    'error.invalid': 'The request was not accepted: {detail}',
    'error.languagesNotConfigured':
      'The supported languages are not chosen, so this is unavailable. Choose them in the Languages panel.',
    'error.approvalNeedsUnified':
      'Not uploaded. Upload approval is on and needs the unified ingest pipeline, which is off. Ask an admin to turn it on.',
    'error.hiddenNeedsSidecar':
      'Not saved. Quarantining hidden text needs the sidecar service, which is not configured. Set it up, or choose "Record only".',
  },
  zh: {
    'action.reload': '重新加载面板',
    'panel.workspace': '工作区：{name}',
    'panel.updated': '更新于 {time}',
    'error.workspace': '你的管理员账号不是此工作区的成员。请在“文档处理 → 上传目标”中选择其他工作区。',
    'error.changed': '此项已被其他人更改。列表已重新加载。',
    'error.outcomeUnknown': '服务器没有响应，更改可能已生效也可能没有。列表已重新加载，请确认后再重试。',
    'error.invalid': '请求未被接受：{detail}',
    'error.languagesNotConfigured': '尚未选择支持的语言，因此此功能不可用。请在“语言”面板中选择。',
    'error.approvalNeedsUnified': '未上传。上传审批已开启，但它需要统一入库流程，而该流程目前关闭。请联系管理员开启。',
    'error.hiddenNeedsSidecar': '未保存。隔离隐藏文字需要侧车服务，而该服务尚未配置。请先配置，或选择“仅记录”。',
  },
  it: {
    'action.reload': 'Ricarica pannello',
    'panel.workspace': 'Spazio di lavoro: {name}',
    'panel.updated': 'Aggiornato alle {time}',
    'error.workspace':
      'Il tuo account amministratore non è membro di questo spazio di lavoro. Scegline un altro in Document Processing, Upload Destination.',
    'error.changed': 'Questo elemento è stato modificato da qualcun altro. L’elenco è stato ricaricato.',
    'error.outcomeUnknown':
      'Il server non ha risposto, quindi la modifica potrebbe essere avvenuta o no. L’elenco è stato ricaricato: controllalo prima di riprovare.',
    'error.invalid': 'La richiesta non è stata accettata: {detail}',
    'error.languagesNotConfigured':
      'Le lingue supportate non sono scelte, quindi questa funzione non è disponibile. Sceglile nel pannello Lingue.',
    'error.approvalNeedsUnified':
      'Non caricato. L’approvazione dei caricamenti è attiva e richiede la pipeline di ingestione unificata, che è disattivata. Chiedi a un amministratore di attivarla.',
    'error.hiddenNeedsSidecar':
      'Non salvato. La quarantena del testo nascosto richiede il servizio sidecar, che non è configurato. Configuralo, oppure scegli «Solo registrazione».',
  },
};

const RAG_UI_REQUEST_TIMEOUT_MS = 15000;
const RAG_UI_FORBIDDEN_ATTR = /^(on|href$|src$|srcdoc$|formaction$|xlink:href$|style$)/i;

/** UI-SPEC 6.1: the first two letters of navigator.language, zh or it, otherwise en. */
function ragUiResolveLocale(language) {
  const lang = typeof language === 'string' ? language.slice(0, 2).toLowerCase() : '';
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

function ragUiBrowserLocale() {
  return ragUiResolveLocale(typeof navigator !== 'undefined' && navigator ? navigator.language : undefined);
}

function ragUiFill(text, vars) {
  if (typeof text !== 'string' || !vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : match));
}

/** Looks a key up in a { en, zh, it } table, falls back to English, then to the key itself. */
function ragUiLookup(table, key, locale, vars) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const text = (table[loc] && table[loc][key]) || (table.en && table.en[key]);
  return text === undefined ? undefined : ragUiFill(text, vars);
}

function ragUiAppUrl() {
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') {
    const url = window.getConfiguredMyRAGAppUrl();
    if (url) return url;
  }
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

/** Sign-in, network and generic-failure sentences come from the shared ingestLabel table (UI-SPEC 8.2). */
function ragUiSharedLabel(key, locale, vars) {
  const filled = key === 'error.signIn' ? { appUrl: ragUiAppUrl(), ...(vars || {}) } : vars;
  let fn = null;
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') fn = window.ingestLabel;
  else if (ragUiSharedIngestLabel) fn = ragUiSharedIngestLabel;
  if (fn) {
    const text = fn(key, locale, filled);
    if (text && text !== key) return text;
  }
  if (typeof window !== 'undefined' && typeof window.authMessage === 'function') {
    if (key === 'error.signIn') return window.authMessage(401, ragUiAppUrl());
    if (key === 'error.generic') return window.authMessage((vars && vars.status) || 0);
  }
  return key;
}

function ragUiLabel(key, locale, vars) {
  const own = ragUiLookup(RAG_UI_LABELS, key, locale, vars);
  return own === undefined ? ragUiSharedLabel(key, locale, vars) : own;
}

function ragUiDoc(doc) {
  return doc || (typeof document !== 'undefined' ? document : null);
}

/**
 * The element builder. Text goes through textContent; attributes through setAttribute, and inline handlers, link and
 * source attributes are refused so no server value can become a link, a request or code.
 */
function ragUiEl(doc, tag, options, children) {
  const d = ragUiDoc(doc);
  const el = d.createElement(tag);
  const opts = options || {};
  if (opts.className) el.className = opts.className;
  if (opts.id) el.id = opts.id;
  if (opts.attrs) {
    for (const [name, value] of Object.entries(opts.attrs)) {
      if (RAG_UI_FORBIDDEN_ATTR.test(name)) throw new Error('ragUiEl: attribute not allowed: ' + name);
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (opts.text !== undefined && opts.text !== null) el.textContent = String(opts.text);
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? d.createTextNode(child) : child);
  }
  return el;
}

/** A Bootstrap icon; decorative only, always next to a text label. */
function ragUiIcon(doc, name, extraClass) {
  return ragUiEl(doc, 'i', { className: 'bi bi-' + name + (extraClass ? ' ' + extraClass : ''), attrs: { 'aria-hidden': 'true' } });
}

/** A spinner with its text; under reduced motion only the text remains. */
function ragUiSpinner(doc, text) {
  return ragUiEl(doc, 'span', { className: 'inline-flex items-center gap-2 text-sm' }, [
    ragUiEl(doc, 'span', { className: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } }),
    ragUiEl(doc, 'span', { text }),
  ]);
}

/**
 * Fills a template whose placeholders in codeVars become code elements (UI-SPEC 12: "{variable}" is a code element, not
 * text). Returns an array of nodes.
 */
function ragUiTemplateNodes(doc, template, vars, codeVars) {
  const nodes = [];
  const code = new Set(codeVars || []);
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m;
  const text = String(template ?? '');
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(ragUiDoc(doc).createTextNode(text.slice(last, m.index)));
    const name = m[1];
    const has = vars && Object.prototype.hasOwnProperty.call(vars, name);
    const value = has ? String(vars[name] ?? '') : m[0];
    if (has && code.has(name)) {
      nodes.push(ragUiEl(doc, 'code', { className: 'font-mono text-xs break-all', text: value, attrs: { translate: 'no' } }));
    } else {
      nodes.push(ragUiDoc(doc).createTextNode(value));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(ragUiDoc(doc).createTextNode(text.slice(last)));
  return nodes;
}

/**
 * An alert block. tone: warning | error | info | success. body: a string or nodes. actions: buttons placed after the text.
 */
function ragUiAlert(doc, { tone, icon, title, body, role, actions, className }) {
  const text = ragUiEl(doc, 'div', { className: 'min-w-0 max-w-prose' });
  if (title) text.appendChild(ragUiEl(doc, 'p', { className: 'text-base font-semibold', text: title }));
  const bodies = Array.isArray(body) ? body : body === undefined || body === null ? [] : [body];
  for (const part of bodies) {
    if (typeof part === 'string') text.appendChild(ragUiEl(doc, 'p', { className: 'text-sm', text: part }));
    else if (part) text.appendChild(part);
  }
  const children = [];
  if (icon) children.push(ragUiIcon(doc, icon, 'text-lg'));
  children.push(text);
  if (actions && actions.length) children.push(ragUiEl(doc, 'div', { className: 'flex flex-wrap gap-2' }, actions));
  return ragUiEl(
    doc,
    'div',
    {
      className: 'alert alert-' + (tone || 'info') + ' items-start text-sm flex-wrap' + (className ? ' ' + className : ''),
      attrs: { role: role || null },
    },
    children,
  );
}

function ragUiFormatNumber(value, locale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  try {
    return new Intl.NumberFormat(locale || 'en').format(n);
  } catch {
    return String(n);
  }
}

/** UI-SPEC 12: every count is "label: number", so no string needs a plural form. */
function ragUiCount(label, value, locale) {
  const sep = locale === 'zh' ? '：' : ': ';
  return String(label) + sep + ragUiFormatNumber(value, locale);
}

async function ragUiReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Config-server request (/api/config/…): same-origin credentials, only Accept and Content-Type headers, a 15-second
 * client timeout.
 * Resolves { ok, status, body } or { thrown: true }.
 */
async function ragUiFetchJson(url, init, timeoutMs) {
  const fetchFn = typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch : typeof fetch === 'function' ? fetch : null;
  if (!fetchFn) return { ok: false, thrown: true, status: 0, body: null };
  const options = { method: (init && init.method) || 'GET', credentials: 'same-origin' };
  const headers = { Accept: 'application/json' };
  if (init && init.body !== undefined) {
    options.body = init.body;
    headers['Content-Type'] = 'application/json';
  }
  options.headers = headers;
  let timer = null;
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    options.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs || RAG_UI_REQUEST_TIMEOUT_MS);
  }
  try {
    const response = await fetchFn(url, options);
    const body = await ragUiReadJson(response);
    return { ok: Boolean(response.ok), status: response.status, body };
  } catch {
    return { ok: false, thrown: true, status: 0, body: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** App route through ragFetch with the full path and the same timeout. Resolves { ok, status, body } or { thrown: true }. */
async function ragUiRagRequest(apiPath, init, timeoutMs) {
  const fetcher = typeof window !== 'undefined' && typeof window.ragFetch === 'function' ? window.ragFetch : null;
  if (!fetcher) return { ok: false, thrown: true, status: 0, body: null };
  const options = { ...(init || {}) };
  let timer = null;
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    options.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs || RAG_UI_REQUEST_TIMEOUT_MS);
  }
  try {
    const result = await fetcher(apiPath, options);
    return result || { ok: false, thrown: true, status: 0, body: null };
  } catch {
    return { ok: false, thrown: true, status: 0, body: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (typeof window !== 'undefined') {
  window.RAG_UI_LABELS = RAG_UI_LABELS;
  window.ragUiLabel = ragUiLabel;
  window.ragUiResolveLocale = ragUiResolveLocale;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RAG_UI_LABELS,
    RAG_UI_REQUEST_TIMEOUT_MS,
    ragUiResolveLocale,
    ragUiBrowserLocale,
    ragUiFill,
    ragUiLookup,
    ragUiLabel,
    ragUiSharedLabel,
    ragUiAppUrl,
    ragUiEl,
    ragUiIcon,
    ragUiSpinner,
    ragUiTemplateNodes,
    ragUiAlert,
    ragUiFormatNumber,
    ragUiCount,
    ragUiFetchJson,
    ragUiRagRequest,
  };
}
