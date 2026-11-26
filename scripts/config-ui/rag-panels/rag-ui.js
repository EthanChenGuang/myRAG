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
    'evidence.inert': 'Shown as text. Never a link.',
    'evidence.cut': 'Cut at 2,000 characters.',
    'evidence.showAll': 'Show all: {count}',
    'code.unknown': 'The server reported {code}.',
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
      'Not saved. Quarantining hidden text needs the sidecar service, which is not configured. Set it up, or choose “Record only”.',
  },
  zh: {
    'evidence.inert': '仅以文本显示，不是链接。',
    'evidence.cut': '已在 2,000 个字符处截断。',
    'evidence.showAll': '显示全部：{count}',
    'code.unknown': '服务器返回了 {code}。',
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
    'evidence.inert': 'Mostrato come testo. Mai un link.',
    'evidence.cut': 'Troncato a 2.000 caratteri.',
    'evidence.showAll': 'Mostra tutti: {count}',
    'code.unknown': 'Il server ha indicato {code}.',
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
  if (title) text.appendChild(ragUiEl(doc, 'p', { className: 'text-base font-semibold text-balance', text: title }));
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
      className: 'alert alert-' + (tone || 'info') + ' items-start text-sm' + (className ? ' ' + className : ''),
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

const RAG_UI_EVIDENCE_MAX = 2000;
const RAG_UI_CHANGED_CODES = new Set(['not_pending', 'not_quarantined', 'already_decided']);
const RAG_UI_STATE_ACTIONS = new Set(['activate', 'rollback', 'confirm', 'undo']);

/**
 * UI-SPEC 8.2. Maps a { ok, status, body } or { thrown } result to { key, kind, message, reload?, field?, code?, reason? }.
 * options.unavailable: the view's own unavailable sentence; options.action: the action that was running.
 * Panel-specific codes (language save, tag_exists, gate reasons) are handled by the panel before or after this mapper.
 */
function ragUiMapError(result, locale, options) {
  const opts = options || {};
  const status = result && result.status;
  const body = (result && result.body && typeof result.body === 'object' ? result.body : null) || {};
  const err = typeof body.error === 'string' ? body.error : '';
  if (!result || result.thrown) {
    if (opts.action && RAG_UI_STATE_ACTIONS.has(opts.action)) {
      return { key: 'error.outcomeUnknown', kind: 'outcomeUnknown', message: ragUiLabel('error.outcomeUnknown', locale), reload: true };
    }
    return { key: 'error.network', kind: 'network', message: ragUiSharedLabel('error.network', locale) };
  }
  if (status === 401 || (status === 403 && err !== 'Forbidden')) {
    return { key: 'error.signIn', kind: 'signIn', message: ragUiSharedLabel('error.signIn', locale) };
  }
  if (status === 403) return { key: 'error.workspace', kind: 'workspace', message: ragUiLabel('error.workspace', locale) };
  if (status === 503) {
    if (err === 'languages_not_configured') {
      return { key: 'error.languagesNotConfigured', kind: 'unavailable', message: ragUiLabel('error.languagesNotConfigured', locale) };
    }
    if (err === 'upload_approval_requires_unified_pipeline') {
      return { key: 'error.approvalNeedsUnified', kind: 'unavailable', message: ragUiLabel('error.approvalNeedsUnified', locale) };
    }
    return { key: 'unavailable', kind: 'unavailable', message: opts.unavailable || ragUiSharedLabel('error.unavailable', locale) };
  }
  if (status === 400) {
    if (err === 'hidden_text_needs_sidecar') {
      return { key: 'error.hiddenNeedsSidecar', kind: 'invalid', message: ragUiLabel('error.hiddenNeedsSidecar', locale) };
    }
    const detail = Array.isArray(body.details) && body.details[0] && typeof body.details[0] === 'object' ? body.details[0] : null;
    const text = detail && typeof detail.message === 'string' ? detail.message : err;
    const mapped = { key: 'error.invalid', kind: 'invalid', message: ragUiLabel('error.invalid', locale, { detail: text }) };
    if (detail && typeof detail.path === 'string') mapped.field = detail.path;
    return mapped;
  }
  if (status === 404 || (status === 409 && RAG_UI_CHANGED_CODES.has(err))) {
    return { key: 'error.changed', kind: 'changed', message: ragUiLabel('error.changed', locale), reload: true };
  }
  if (status === 409) {
    return {
      key: 'conflict',
      kind: 'conflict',
      code: err,
      reason: typeof body.reason === 'string' ? body.reason : null,
      message: ragUiLabel('code.unknown', locale, { code: body.reason || err }),
    };
  }
  return { key: 'error.generic', kind: 'generic', message: ragUiSharedLabel('error.generic', locale, { status: status || '?' }) };
}

/** An unknown code, state, kind, signal or reason: the code in monospace inside a full sentence (UI-SPEC 7.1). */
function ragUiCodeSentence(doc, locale, code, template) {
  const text = template || ragUiLabel('code.unknown', locale);
  return ragUiEl(doc, 'span', {}, ragUiTemplateNodes(doc, text, { code: String(code ?? '') }, ['code']));
}

let ragUiIdCounter = 0;
function ragUiNextId(prefix) {
  ragUiIdCounter += 1;
  return (prefix || 'rag-ui') + '-' + ragUiIdCounter;
}

/**
 * Sub-tabs (UI-SPEC 9.2): role=tablist with a label, roving tabindex, Left/Right move and activate, Home/End jump.
 * Returns { tablist, panels: { id: element }, select(id) }.
 */
function ragUiSubTabs(doc, { label, idPrefix, tabs, selected, onSelect }) {
  const prefix = idPrefix || ragUiNextId('rag-tabs');
  const tablist = ragUiEl(doc, 'div', { className: 'tabs tabs-bordered flex-wrap mb-4', attrs: { role: 'tablist', 'aria-label': label } });
  const buttons = [];
  const panels = {};
  let current = selected || (tabs[0] && tabs[0].id);
  const apply = (id) => {
    current = id;
    buttons.forEach((button, index) => {
      const on = tabs[index].id === id;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.setAttribute('tabindex', on ? '0' : '-1');
      button.classList.toggle('tab-active', on);
    });
    for (const tab of tabs) panels[tab.id].hidden = tab.id !== id;
  };
  const select = (id, focus) => {
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    apply(id);
    if (focus) buttons[index].focus();
    if (typeof onSelect === 'function') onSelect(id);
  };
  tabs.forEach((tab, index) => {
    const tabId = prefix + '-tab-' + tab.id;
    const panelId = prefix + '-panel-' + tab.id;
    const button = ragUiEl(doc, 'button', {
      className: 'tab',
      id: tabId,
      text: tab.label,
      attrs: { type: 'button', role: 'tab', 'aria-controls': panelId },
    });
    button.addEventListener('click', () => select(tab.id, false));
    button.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      let target = null;
      if (event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
      else if (event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = last;
      if (target === null) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      select(tabs[target].id, true);
    });
    buttons.push(button);
    tablist.appendChild(button);
    panels[tab.id] = ragUiEl(doc, 'div', { id: panelId, attrs: { role: 'tabpanel', 'aria-labelledby': tabId, tabindex: '0' } });
  });
  apply(current);
  return { tablist, panels, select: (id) => select(id, false), current: () => current };
}

/**
 * Confirmation dialog (UI-SPEC 9.6, 12.1): native dialog.modal, focus on the safe "Keep…" button, Escape and the backdrop
 * cancel except while the action runs, focus returns to the opener (or fallbackFocus when the opener is gone).
 * tone 'error' only for the destructive actions. Resolves true after onConfirm ran, false when kept.
 */
function ragUiConfirmDialog(doc, { title, body, keepLabel, confirmLabel, runningLabel, tone, opener, fallbackFocus, onConfirm }) {
  const titleId = ragUiNextId('rag-dialog-title');
  const bodyId = ragUiNextId('rag-dialog-body');
  const dialog = ragUiEl(doc, 'dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': bodyId } });
  const keep = ragUiEl(doc, 'button', { className: 'btn btn-sm', text: keepLabel, attrs: { type: 'button' } });
  const confirm = ragUiEl(doc, 'button', {
    className: 'btn btn-sm ' + (tone === 'error' ? 'btn-error' : 'btn-primary'),
    text: confirmLabel,
    attrs: { type: 'button' },
  });
  const bodyNodes = Array.isArray(body) ? body : [body];
  const bodyEl = ragUiEl(doc, 'div', { className: 'text-sm max-w-prose', id: bodyId });
  for (const part of bodyNodes) {
    if (typeof part === 'string') bodyEl.appendChild(ragUiEl(doc, 'p', { text: part }));
    else if (part) bodyEl.appendChild(part);
  }
  const box = ragUiEl(doc, 'div', { className: 'modal-box min-w-0 overscroll-contain' }, [
    ragUiEl(doc, 'h3', { className: 'text-base font-semibold mb-2 break-words text-balance', id: titleId, text: title }),
    bodyEl,
    ragUiEl(doc, 'div', { className: 'modal-action flex-wrap gap-2' }, [keep, confirm]),
  ]);
  const backdropButton = ragUiEl(doc, 'button', { className: 'cursor-default', text: keepLabel, attrs: { type: 'submit', tabindex: '-1' } });
  const backdrop = ragUiEl(doc, 'form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]);
  dialog.appendChild(box);
  dialog.appendChild(backdrop);
  ragUiDoc(doc).body.appendChild(dialog);
  let running = false;
  return new Promise((resolve) => {
    let confirmed = false;
    const finish = () => {
      dialog.remove();
      const target = opener && opener.isConnected !== false ? opener : fallbackFocus;
      if (target && typeof target.focus === 'function') target.focus();
      resolve(confirmed);
    };
    dialog.addEventListener('cancel', (event) => {
      if (running && typeof event.preventDefault === 'function') event.preventDefault();
    });
    backdrop.addEventListener('submit', (event) => {
      if (running && typeof event.preventDefault === 'function') event.preventDefault();
    });
    dialog.addEventListener('close', finish);
    keep.addEventListener('click', () => {
      if (!running) dialog.close('keep');
    });
    confirm.addEventListener('click', async () => {
      if (running) return;
      running = true;
      const restore = ragUiButtonBusy(doc, confirm, runningLabel || confirmLabel, [keep, backdropButton]);
      try {
        if (typeof onConfirm === 'function') await onConfirm();
        confirmed = true;
      } finally {
        running = false;
        restore();
        dialog.close(confirmed ? 'confirm' : 'keep');
      }
    });
    dialog.showModal();
    keep.focus();
  });
}

/** Unicode Cc (except line feed and tab) and Cf characters become visible code points, e.g. [U+200B] (UI-SPEC 6.5.1). */
function ragUiVisibleControls(text) {
  return String(text ?? '').replace(/[\p{Cc}\p{Cf}]/gu, (ch) => {
    if (ch === '\n' || ch === '\t') return ch;
    return '[U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ']';
  });
}

/**
 * The inert evidence block (UI-SPEC 6.5.1): figure, caption and a focusable pre region, text only, cut at 2,000 characters.
 * tone 'untrusted' (warning rule) or 'quote' (neutral rule). Never a link, a title carrying the text, or a request.
 */
function ragUiEvidence(doc, { tone, caption, text, locale }) {
  const visible = ragUiVisibleControls(text);
  const cut = visible.length > RAG_UI_EVIDENCE_MAX;
  const shown = cut ? visible.slice(0, RAG_UI_EVIDENCE_MAX) : visible;
  const figure = ragUiEl(doc, 'figure', {
    className: 'border-l-4 ' + (tone === 'quote' ? 'border-base-300' : 'border-warning') + ' bg-base-100 rounded-r-lg p-2 min-w-0',
  });
  figure.appendChild(ragUiEl(doc, 'figcaption', { className: 'text-xs text-base-content/70 mb-1 break-words', text: caption }));
  figure.appendChild(
    ragUiEl(doc, 'pre', {
      className:
        'font-mono text-xs whitespace-pre-wrap break-all max-h-40 overflow-y-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      text: shown,
      attrs: { tabindex: '0', role: 'region', 'aria-label': caption, translate: 'no' },
    }),
  );
  if (cut) figure.appendChild(ragUiEl(doc, 'p', { className: 'text-xs text-base-content/70 mt-1', text: ragUiLabel('evidence.cut', locale) }));
  return figure;
}

/** The hold line (UI-SPEC 1): state badge with icon and word, the reason sentence, then the one action, in DOM order. */
function ragUiHoldLine(doc, { tone, icon, word, reason, action }) {
  const badge = ragUiEl(doc, 'span', { className: 'badge badge-sm badge-outline badge-' + (tone || 'info') + ' gap-1 shrink-0' }, [
    icon ? ragUiIcon(doc, icon) : null,
    ragUiEl(doc, 'span', { text: word }),
  ]);
  const reasonEl = typeof reason === 'string' ? ragUiEl(doc, 'span', { className: 'text-sm min-w-0 break-words', text: reason }) : reason;
  return ragUiEl(doc, 'div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [badge, reasonEl, action || null]);
}

/** First load: a spinner with the view's loading text in the content host. */
function ragUiListLoading(doc, host, text) {
  if (!host) return;
  ragUiListBusy(host, false);
  host.replaceChildren(ragUiEl(doc, 'div', { className: 'py-8' }, [ragUiSpinner(doc, text)]));
}

/** Refresh with content present (or earlier content after a failure): dimmed, aria-busy while a request runs. */
function ragUiListBusy(host, busy, dimOnly) {
  if (!host) return;
  host.classList.toggle('opacity-60', Boolean(busy));
  if (busy && !dimOnly) host.setAttribute('aria-busy', 'true');
  else host.removeAttribute('aria-busy');
}

function ragUiReloadButton(doc, locale, onReload) {
  const button = ragUiEl(doc, 'button', { className: 'btn btn-sm', text: ragUiLabel('action.reload', locale), attrs: { type: 'button' } });
  button.addEventListener('click', () => onReload());
  return button;
}

/** 401 or 403 on an admin route: the shared sign-in sentence and Reload panel. No password field, no token prompt. */
function ragUiSignInAlert(doc, locale, onReload) {
  return ragUiAlert(doc, {
    tone: 'warning',
    icon: 'person-lock',
    body: [ragUiSharedLabel('error.signIn', locale)],
    actions: [ragUiReloadButton(doc, locale, onReload)],
  });
}

/** 503 or network failure: the view's unavailable sentence and Reload panel. */
function ragUiUnavailableAlert(doc, locale, message, onReload) {
  return ragUiAlert(doc, {
    tone: 'error',
    icon: 'exclamation-circle',
    body: [message],
    actions: [ragUiReloadButton(doc, locale, onReload)],
  });
}

/** A running action: spinner and in-flight text on the button, sibling buttons disabled. Returns the restore function. */
function ragUiButtonBusy(doc, button, runningText, siblings) {
  const before = Array.from(button.childNodes);
  const wasDisabled = button.disabled;
  const others = (siblings || []).filter(Boolean).map((el) => [el, el.disabled]);
  button.disabled = true;
  button.setAttribute('aria-disabled', 'true');
  button.replaceChildren(
    ragUiEl(doc, 'span', { className: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } }),
    ragUiEl(doc, 'span', { text: runningText }),
  );
  for (const [el] of others) el.disabled = true;
  return () => {
    button.replaceChildren(...before);
    button.disabled = wasDisabled;
    button.removeAttribute('aria-disabled');
    for (const [el, disabled] of others) el.disabled = disabled;
  };
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
    ragUiMapError,
    ragUiCodeSentence,
    ragUiNextId,
    ragUiSubTabs,
    ragUiConfirmDialog,
    ragUiVisibleControls,
    ragUiEvidence,
    ragUiHoldLine,
    ragUiListLoading,
    ragUiListBusy,
    ragUiReloadButton,
    ragUiSignInAlert,
    ragUiUnavailableAlert,
    ragUiButtonBusy,
  };
}
