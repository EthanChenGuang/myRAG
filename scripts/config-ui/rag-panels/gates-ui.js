/**
 * Shared helpers of the Phase 5.3 Config UI panels (UI-SPEC 6.1, 6.2, 7.1, 8.2, 12.2): the verdict line, the evidence table, the share
 * bar, sub-tabs, the confirmation dialog, the error mapper, the locale resolver, number and date formatters and GATES_UI_LABELS. A
 * result is one word from a closed list, and anything unknown reads "No result", never "Passed". DOM is built with cuiEl,
 * createElement and textContent only; no server string is inserted as markup.
 */

const GATES_UI_TIMEOUT_MS = 15000;

const GATES_UI_LABELS = {
  en: {
    'verdict.pass': 'Passed',
    'verdict.fail': 'Failed',
    'verdict.error': 'No result',
    'verdict.skipped': 'Skipped',
    'verdict.insufficient': 'Not enough data',
    'verdict.reportOnly': 'Report only',
    'verdict.notApplicable': 'Does not apply',
    'verdict.running': 'Running',
    'verdict.pending': 'Waiting',
    'reason.timeout': 'It stopped after 10 minutes.',
    'reason.crashed': "The check stopped unexpectedly. See the config server’s log under [Config Gate].",
    'reason.toolchain_missing': "The evaluation tools are not installed on this machine. Install the project’s dependencies, then select Run check again.",
    'reason.live_off': 'The live model check is switched off.',
    'reason.keys_missing': 'No key is set for the chat model.',
    'reason.no_real_set': 'This workspace has no test set of its own on this machine.',
    'reason.eval_endpoint_off': 'The evaluation endpoint is off.',
    'reason.no_answer': 'The config server did not answer. Check that it is running.',
    'reason.other': 'Reason code: {code}.',
    'reason.missing': 'The app sent no reason. Select Reload panel; if it comes back, check the app log.',
    'layer.deterministic': 'Built-in test questions',
    'layer.live': 'Live model',
    'layer.real_set': 'Workspace test set',
    'layer.real_set.named': 'Workspace test set {hash}',
    'check.no_answer_share': 'Share of questions with no answer in the documents',
    'check.false_answer_rate': 'False answers',
    'check.false_refusal_rate': 'False refusals',
    'check.stale_share': 'Out-of-date test items',
    'check.faithfulness': 'Faithfulness',
    'check.answer_relevance': 'Answer relevance',
    'check.noise_band': 'Change against the baseline: {metric}',
    'slice.overall': 'All questions',
    'slice.language': 'Questions in {language}',
    'limit.max': 'at most {value}',
    'limit.min': 'at least {value}',
    'limit.band': 'within {value} of the baseline',
    'limit.none': 'no limit, report only',
    'measured.rate': '{rate} ({count} of {total})',
    'col.check': 'Check',
    'col.questions': 'Questions',
    'col.measured': 'Measured',
    'col.limit': 'Limit',
    'col.result': 'Result',
    'checks.showAll': 'Show all checks: {count}',
    'checks.caption': 'Checks and their results',
    'action.reload': 'Reload panel',
    updatedAt: 'Updated {time}',
    'workspace.line': 'Workspace: {name}',
    'value.on': 'On',
    'value.off': 'Off',
    'error.unavailable': '{view} is unavailable right now. Select Reload panel in a moment.',
    'error.switchedOffApp': 'The app answered that this feature is off. If you just saved the setting, restart the app, then select Reload panel.',
    'error.unknownCode': 'The app returned a code this page does not know: {code}. Select Reload panel; if it comes back, check the app log.',
    'settings.saveHint': 'These settings are saved with Save All Changes at the top of the page and apply after the app restarts.',
    'settings.secret.set': 'A secret is stored. Leave empty to keep it.',
    'settings.secret.reveal': 'Show or hide the webhook secret',
    'banner.title': 'Needs attention',
    'banner.alerts': 'Open monitoring alerts: {count}',
    'banner.alertsAction': 'Review alerts',
    'banner.uncal': 'Refusal thresholds not applied after a setting change: {count}',
    'banner.uncalAction': 'Open refusal calibration',
  },
  zh: {
    'verdict.pass': '通过',
    'verdict.fail': '未通过',
    'verdict.error': '无结果',
    'verdict.skipped': '已跳过',
    'verdict.insufficient': '数据不足',
    'verdict.reportOnly': '仅报告',
    'verdict.notApplicable': '不适用',
    'verdict.running': '运行中',
    'verdict.pending': '等待中',
    'reason.timeout': '运行 10 分钟后被停止。',
    'reason.crashed': '检查意外中止。请查看配置服务器日志中的 [Config Gate]。',
    'reason.toolchain_missing': '本机未安装评估工具。请安装项目依赖，然后点击“重新运行检查”。',
    'reason.live_off': '真实模型检查已关闭。',
    'reason.keys_missing': '未设置对话模型的密钥。',
    'reason.no_real_set': '本机上没有该工作区自己的测试集。',
    'reason.eval_endpoint_off': '评估端点已关闭。',
    'reason.no_answer': '配置服务器没有响应。请确认它正在运行。',
    'reason.other': '原因代码：{code}。',
    'reason.missing': '应用没有给出原因。请点击“重新加载面板”；如果再次出现，请查看应用日志。',
    'layer.deterministic': '内置测试问题',
    'layer.live': '真实模型',
    'layer.real_set': '工作区测试集',
    'layer.real_set.named': '工作区测试集 {hash}',
    'check.no_answer_share': '文档中无答案的问题占比',
    'check.false_answer_rate': '错误作答',
    'check.false_refusal_rate': '错误拒答',
    'check.stale_share': '已过期的测试条目',
    'check.faithfulness': '忠实度',
    'check.answer_relevance': '回答相关性',
    'check.noise_band': '与基线相比的变化：{metric}',
    'slice.overall': '全部问题',
    'slice.language': '{language}问题',
    'limit.max': '不超过 {value}',
    'limit.min': '不低于 {value}',
    'limit.band': '与基线相差不超过 {value}',
    'limit.none': '无限值，仅报告',
    'measured.rate': '{rate}（{total} 个中的 {count} 个）',
    'col.check': '检查项',
    'col.questions': '问题范围',
    'col.measured': '实测值',
    'col.limit': '限值',
    'col.result': '结果',
    'checks.showAll': '显示全部检查项：{count}',
    'checks.caption': '检查项及其结果',
    'action.reload': '重新加载面板',
    updatedAt: '更新于 {time}',
    'workspace.line': '工作区：{name}',
    'value.on': '开启',
    'value.off': '关闭',
    'error.unavailable': '{view}暂时不可用。请稍后点击“重新加载面板”。',
    'error.switchedOffApp': '应用返回该功能处于关闭状态。如果刚保存了设置，请重启应用，然后点击“重新加载面板”。',
    'error.unknownCode': '应用返回了本页面无法识别的代码：{code}。请点击“重新加载面板”；如果再次出现，请查看应用日志。',
    'settings.saveHint': '这些设置通过页面顶部的“Save All Changes”保存，应用重启后生效。',
    'settings.secret.set': '已保存密钥。留空表示保持不变。',
    'settings.secret.reveal': '显示或隐藏 Webhook 密钥',
    'banner.title': '需要关注',
    'banner.alerts': '未处理的监控告警：{count}',
    'banner.alertsAction': '查看告警',
    'banner.uncal': '设置更改后未生效的拒答阈值：{count}',
    'banner.uncalAction': '打开拒答校准',
  },
  it: {
    'verdict.pass': 'Superato',
    'verdict.fail': 'Non superato',
    'verdict.error': 'Nessun esito',
    'verdict.skipped': 'Saltato',
    'verdict.insufficient': 'Dati insufficienti',
    'verdict.reportOnly': 'Solo report',
    'verdict.notApplicable': 'Non applicabile',
    'verdict.running': 'In corso',
    'verdict.pending': 'In attesa',
    'reason.timeout': 'Si è fermato dopo 10 minuti.',
    'reason.crashed': 'Il controllo si è interrotto in modo imprevisto. Vedi il log del server di configurazione alla voce [Config Gate].',
    'reason.toolchain_missing': 'Gli strumenti di valutazione non sono installati su questa macchina. Installa le dipendenze del progetto, poi seleziona Ripeti controllo.',
    'reason.live_off': 'Il controllo con il modello reale è disattivato.',
    'reason.keys_missing': 'Nessuna chiave impostata per il modello di chat.',
    'reason.no_real_set': "Quest’area di lavoro non ha un proprio set di test su questa macchina.",
    'reason.eval_endpoint_off': "L’endpoint di valutazione è disattivato.",
    'reason.no_answer': 'Il server di configurazione non ha risposto. Verifica che sia in esecuzione.',
    'reason.other': 'Codice del motivo: {code}.',
    'reason.missing': "L’app non ha indicato un motivo. Seleziona Ricarica pannello; se si ripete, controlla il log dell’app.",
    'layer.deterministic': 'Domande di test integrate',
    'layer.live': 'Modello reale',
    'layer.real_set': "Set di test dell’area di lavoro",
    'layer.real_set.named': "Set di test dell’area di lavoro {hash}",
    'check.no_answer_share': 'Quota di domande senza risposta nei documenti',
    'check.false_answer_rate': 'Risposte indebite',
    'check.false_refusal_rate': 'Rifiuti indebiti',
    'check.stale_share': 'Elementi di test non più validi',
    'check.faithfulness': 'Fedeltà',
    'check.answer_relevance': 'Pertinenza della risposta',
    'check.noise_band': 'Variazione rispetto alla baseline: {metric}',
    'slice.overall': 'Tutte le domande',
    'slice.language': 'Domande in {language}',
    'limit.max': 'al massimo {value}',
    'limit.min': 'almeno {value}',
    'limit.band': 'entro {value} dalla baseline',
    'limit.none': 'nessun limite, solo report',
    'measured.rate': '{rate} ({count} su {total})',
    'col.check': 'Controllo',
    'col.questions': 'Domande',
    'col.measured': 'Misurato',
    'col.limit': 'Limite',
    'col.result': 'Esito',
    'checks.showAll': 'Mostra tutti i controlli: {count}',
    'checks.caption': 'Controlli e relativi esiti',
    'action.reload': 'Ricarica pannello',
    updatedAt: 'Aggiornato alle {time}',
    'workspace.line': 'Area di lavoro: {name}',
    'value.on': 'Attivo',
    'value.off': 'Disattivato',
    'error.unavailable': '{view} non è disponibile in questo momento. Seleziona Ricarica pannello tra poco.',
    'error.switchedOffApp': "L’app ha risposto che la funzione è disattivata. Se hai appena salvato l’impostazione, riavvia l’app e seleziona Ricarica pannello.",
    'error.unknownCode': "L’app ha restituito un codice che questa pagina non conosce: {code}. Seleziona Ricarica pannello; se si ripete, controlla il log dell’app.",
    'settings.saveHint': "Queste impostazioni si salvano con Save All Changes in cima alla pagina e valgono dopo il riavvio dell’app.",
    'settings.secret.set': 'Un segreto è già salvato. Lascia vuoto per mantenerlo.',
    'settings.secret.reveal': 'Mostra o nascondi il segreto del webhook',
    'banner.title': 'Richiede attenzione',
    'banner.alerts': 'Avvisi di monitoraggio aperti: {count}',
    'banner.alertsAction': 'Esamina avvisi',
    'banner.uncal': 'Soglie di rifiuto non applicate dopo una modifica: {count}',
    'banner.uncalAction': 'Apri calibrazione del rifiuto',
  },
};

/** UI-SPEC 6.2: the closed verdict list. Only verdict.pass is ever success. */
const GATES_UI_VERDICTS = {
  pass: { key: 'verdict.pass', classes: 'badge-success', icon: 'bi-check-circle-fill' },
  passed: { key: 'verdict.pass', classes: 'badge-success', icon: 'bi-check-circle-fill' },
  success: { key: 'verdict.pass', classes: 'badge-success', icon: 'bi-check-circle-fill' },
  fail: { key: 'verdict.fail', classes: 'badge-error', icon: 'bi-x-octagon-fill' },
  failed: { key: 'verdict.fail', classes: 'badge-error', icon: 'bi-x-octagon-fill' },
  error: { key: 'verdict.error', classes: 'badge-warning', icon: 'bi-exclamation-triangle-fill' },
  skipped: { key: 'verdict.skipped', classes: 'badge-warning badge-outline', icon: 'bi-slash-circle' },
  insufficient_n: { key: 'verdict.insufficient', classes: 'badge-ghost', icon: 'bi-dash-circle' },
  insufficient_sample: { key: 'verdict.insufficient', classes: 'badge-ghost', icon: 'bi-dash-circle' },
  report_only: { key: 'verdict.reportOnly', classes: 'badge-ghost', icon: 'bi-eye' },
  not_applicable: { key: 'verdict.notApplicable', classes: 'badge-ghost', icon: 'bi-dash' },
  not_required: { key: 'verdict.notApplicable', classes: 'badge-ghost', icon: 'bi-dash' },
  running: { key: 'verdict.running', classes: 'badge-info badge-outline', icon: 'bi-arrow-repeat' },
  pending: { key: 'verdict.pending', classes: 'badge-ghost', icon: 'bi-hourglass' },
  queued: { key: 'verdict.pending', classes: 'badge-ghost', icon: 'bi-hourglass' },
};

const GATES_UI_CODE_VARS = ['command', 'variable', 'code', 'id'];
const GATES_UI_LIMIT_KINDS = { max: 'limit.max', min: 'limit.min', band: 'limit.band' };

function gatesUiHas(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Locale and strings

function gatesUiLocale(value) {
  let raw = value;
  if (raw === undefined || raw === null) raw = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
  const lang = String(raw).slice(0, 2).toLowerCase();
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

/** A template from a { en, zh, it } table, falling back to English; null when the key is unknown. */
function gatesUiTemplateFrom(table, key, locale) {
  const own = table && table[gatesUiLocale(locale)];
  if (gatesUiHas(own, key)) return own[key];
  if (table && gatesUiHas(table.en, key)) return table.en[key];
  return null;
}

/**
 * Template to segments. command, variable, code and id become code segments; a value given as { code }, { mono } or { time } keeps its
 * own segment; a missing value leaves the placeholder as text.
 */
function gatesUiFill(template, vars) {
  const segments = [];
  const source = String(template);
  const re = /\{(\w+)\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match.index > last) segments.push({ text: source.slice(last, match.index) });
    const name = match[1];
    const value = vars && gatesUiHas(vars, name) ? vars[name] : undefined;
    if (value && typeof value === 'object' && typeof value.code === 'string') segments.push({ code: value.code });
    else if (value && typeof value === 'object' && typeof value.mono === 'string') segments.push({ mono: value.mono });
    else if (value && typeof value === 'object' && value.time) segments.push({ time: value.time });
    else if (value === undefined || value === null) segments.push({ text: match[0] });
    else if (GATES_UI_CODE_VARS.includes(name)) segments.push({ code: String(value) });
    else segments.push({ text: String(value) });
    last = re.lastIndex;
  }
  if (last < source.length) segments.push({ text: source.slice(last) });
  const merged = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];
    if (segment.text !== undefined && prev && prev.text !== undefined) prev.text += segment.text;
    else merged.push(segment);
  }
  return merged;
}

function gatesUiSegmentsText(segments) {
  return segments
    .map((s) => (s.text !== undefined ? s.text : s.code !== undefined ? s.code : s.mono !== undefined ? s.mono : s.time.text))
    .join('');
}

function gatesUiSharedTemplate(key, locale) {
  let text = null;
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') text = window.ingestLabel(key, locale, {});
  else if (typeof require === 'function') {
    try {
      text = require('../document-processing/status-monitor.js').ingestLabel(key, locale, {});
    } catch {
      text = null;
    }
  }
  if (text && text !== key) return text;
  if (key === 'error.network') return "Can't reach the Config UI server. Check that it is running, then reload.";
  if (key === 'error.signIn') return 'Admin sign-in required. Sign in to the main myRAG app at {appUrl} (Settings → Admin tab), then reload the Config UI.';
  return 'Request failed ({status}).';
}

/** A message from any panel's label table: { key, segments, text }. */
function gatesUiMessageFrom(table, key, locale, vars) {
  const shared = key === 'error.signIn' || key === 'error.network' || key === 'error.generic';
  const template = shared ? gatesUiSharedTemplate(key, gatesUiLocale(locale)) : gatesUiTemplateFrom(table, key, locale);
  const segments = gatesUiFill(template === null ? key : template, vars || {});
  return { key, segments, text: gatesUiSegmentsText(segments) };
}

function gatesUiMessage(key, locale, vars) {
  return gatesUiMessageFrom(GATES_UI_LABELS, key, locale, vars);
}

function gatesUiLabel(key, locale, vars) {
  return gatesUiMessage(key, locale, vars).text;
}

function gatesUiAppUrl(fallback) {
  if (fallback) return fallback;
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') return window.getConfiguredMyRAGAppUrl();
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Formatters (Intl with the locale)

function gatesUiFinite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function gatesUiNumber(value, locale) {
  if (!gatesUiFinite(value)) return '';
  return new Intl.NumberFormat(gatesUiLocale(locale)).format(value);
}

function gatesUiPercent(value, locale) {
  if (!gatesUiFinite(value)) return '';
  return new Intl.NumberFormat(gatesUiLocale(locale), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

/** A rate with its count: "38.0% (76 of 200)". */
function gatesUiRate(numerator, denominator, locale) {
  if (!gatesUiFinite(numerator) || !gatesUiFinite(denominator) || denominator <= 0) return '';
  return gatesUiLabel('measured.rate', locale, {
    rate: gatesUiPercent(numerator / denominator, locale),
    count: gatesUiNumber(numerator, locale),
    total: gatesUiNumber(denominator, locale),
  });
}

function gatesUiScore(value, locale) {
  if (!gatesUiFinite(value)) return '';
  return new Intl.NumberFormat(gatesUiLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** A signed delta with two decimals: "+0.03". */
function gatesUiSigned(value, locale) {
  if (!gatesUiFinite(value)) return '';
  return new Intl.NumberFormat(gatesUiLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(value);
}

function gatesUiDate(value, locale, style) {
  if (typeof value !== 'string' || value === '') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? value + 'T00:00:00Z' : value);
  if (Number.isNaN(parsed.getTime())) return null;
  const options = style === 'time' ? { timeStyle: 'short' } : { dateStyle: 'medium' };
  if (dateOnly) options.timeZone = 'UTC';
  return { iso: value, text: new Intl.DateTimeFormat(gatesUiLocale(locale), options).format(parsed) };
}

function gatesUiLanguageName(code, locale) {
  const value = String(code);
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      const name = new Intl.DisplayNames([gatesUiLocale(locale)], { type: 'language', fallback: 'none' }).of(value);
      if (name) return name;
    }
  } catch {
    // An invalid code falls through to the code itself.
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// DOM helpers (cuiEl, createElement, textContent)

function gatesUiCuiEl() {
  if (typeof cuiEl === 'function') return cuiEl;
  if (typeof window !== 'undefined' && typeof window.cuiEl === 'function') return window.cuiEl;
  return require('../utils/safe-dom.js').cuiEl;
}

/** cuiEl with a children array: gatesUiEl(tag, { className, text, attrs, on }, [children]). */
function gatesUiEl(tag, opts, children) {
  return gatesUiCuiEl()(tag, opts || {}, ...(children || []));
}

function gatesUiIcon(name, extra) {
  return gatesUiEl('i', { className: 'bi ' + name + (extra ? ' ' + extra : ''), attrs: { 'aria-hidden': 'true' } });
}

function gatesUiSpinner() {
  return gatesUiEl('span', { className: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } });
}

function gatesUiAppendMessage(el, message) {
  for (const segment of message.segments) {
    if (segment.text !== undefined) el.appendChild(document.createTextNode(segment.text));
    else if (segment.code !== undefined) el.appendChild(gatesUiEl('code', { className: 'font-mono text-xs break-words', text: segment.code, attrs: { translate: 'no' } }));
    else if (segment.mono !== undefined) el.appendChild(gatesUiEl('span', { className: 'font-mono text-xs break-all', text: segment.mono, attrs: { translate: 'no' } }));
    else if (segment.time) el.appendChild(gatesUiEl('time', { text: segment.time.text, attrs: { datetime: segment.time.iso } }));
  }
  return el;
}

function gatesUiMessageEl(tag, cls, message) {
  return gatesUiAppendMessage(gatesUiEl(tag, { className: cls }), message);
}

/** An alert block: tone warning, error or info; extras (buttons, lists) go under the sentence. */
function gatesUiAlert(tone, icon, message, extras, lang) {
  const text = gatesUiMessageEl('p', 'text-sm', message);
  if (lang) text.setAttribute('lang', lang);
  const body = gatesUiEl('div', { className: 'flex flex-col gap-2 items-start min-w-0 max-w-prose' }, [text, ...(extras || [])]);
  return gatesUiEl('div', { className: 'alert alert-' + tone + ' items-start justify-items-start text-left' }, [gatesUiIcon(icon, 'mt-0.5'), body]);
}

/** Writes a message into a panel's status region; an error gets text-error and a leading icon. */
function gatesUiStatus(host, message, isError) {
  if (!host) return;
  host.replaceChildren();
  host.classList.toggle('text-error', Boolean(isError));
  if (isError) host.appendChild(gatesUiIcon('bi-exclamation-circle', 'mr-1'));
  if (typeof message === 'string') host.appendChild(document.createTextNode(message));
  else gatesUiAppendMessage(host, message);
}

/** UI-SPEC 7.1, refresh with content present: dimmed and aria-busy, no layout change. */
function gatesUiSetBusy(el, busy) {
  if (!el) return;
  el.classList.toggle('opacity-60', Boolean(busy));
  if (busy) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
}

/** UI-SPEC 7.1, first load: a spinner with the view's loading text. */
function gatesUiLoadingBlock(text) {
  return gatesUiEl('p', { className: 'flex items-center gap-2 text-sm text-base-content/70' }, [gatesUiSpinner(), text]);
}

/** UI-SPEC 7.1, empty: a centred block with a 16/600 title and a 14px body. */
function gatesUiEmptyBlock(title, body) {
  const bodyEl = typeof body === 'string' ? gatesUiEl('p', { className: 'text-sm text-base-content/70 max-w-prose', text: body }) : gatesUiMessageEl('p', 'text-sm text-base-content/70 max-w-prose', body);
  return gatesUiEl('div', { className: 'flex flex-col items-center text-center gap-2 py-8' }, [
    gatesUiEl('h4', { className: 'text-base font-semibold text-balance', text: title }),
    bodyEl,
  ]);
}

function gatesUiReloadButton(locale, onClick) {
  return gatesUiEl('button', { className: 'btn btn-sm', text: gatesUiLabel('action.reload', locale), attrs: { type: 'button' }, on: { click: onClick } });
}

/** The alert for a mapped error (UI-SPEC 7.1): sign-in and switched-off are warnings, the rest errors. */
function gatesUiErrorAlert(mapped, locale, onReload) {
  const reload = onReload ? [gatesUiReloadButton(locale, onReload)] : [];
  if (mapped.kind === 'signIn') return gatesUiAlert('warning', 'bi-person-lock', mapped, reload);
  if (mapped.kind === 'switchedOff') return gatesUiAlert('warning', 'bi-exclamation-triangle', mapped, reload);
  return gatesUiAlert('error', 'bi-exclamation-octagon', mapped, reload);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Verdict line and evidence table (UI-SPEC 6.2)

function gatesUiVerdictView(value) {
  const known = typeof value === 'string' && gatesUiHas(GATES_UI_VERDICTS, value);
  const entry = known ? GATES_UI_VERDICTS[value] : GATES_UI_VERDICTS.error;
  return { key: entry.key, classes: entry.classes, icon: entry.icon, known };
}

function gatesUiBadge(value, locale) {
  const view = gatesUiVerdictView(value);
  return gatesUiEl('span', { className: 'badge badge-sm gap-1 h-auto whitespace-nowrap ' + view.classes }, [gatesUiIcon(view.icon), gatesUiLabel(view.key, locale)]);
}

/** The reason sentence of a verdict: a known reason, a code in a sentence, or the missing-reason sentence. */
function gatesUiReasonMessage(reason, locale) {
  if (typeof reason === 'string' && reason !== '') {
    const key = 'reason.' + reason;
    if (reason !== 'other' && reason !== 'missing' && gatesUiTemplateFrom(GATES_UI_LABELS, key, locale) !== null) return gatesUiMessage(key, locale);
    return gatesUiMessage('reason.other', locale, { code: reason });
  }
  return gatesUiMessage('reason.missing', locale);
}

/**
 * The verdict line: badge, then the reason sentence. Skipped and No result always carry a reason; an unknown value names the code it
 * was given.
 */
function gatesUiVerdict(value, locale, reason) {
  const view = gatesUiVerdictView(value);
  const line = gatesUiEl('span', { className: 'inline-flex flex-wrap items-baseline gap-2' }, [gatesUiBadge(value, locale)]);
  let message = null;
  if (typeof reason === 'string' && reason !== '') message = gatesUiReasonMessage(reason, locale);
  else if (!view.known && typeof value === 'string' && value !== '') message = gatesUiMessage('reason.other', locale, { code: value });
  else if (view.key === 'verdict.skipped' || view.key === 'verdict.error') message = gatesUiMessage('reason.missing', locale);
  if (message) line.appendChild(gatesUiMessageEl('span', 'text-sm', message));
  return line;
}

function gatesUiCheckMessage(name, locale) {
  const key = 'check.' + String(name);
  if (typeof name === 'string' && key !== 'check.noise_band' && gatesUiTemplateFrom(GATES_UI_LABELS, key, locale) !== null) return gatesUiMessage(key, locale);
  return { key: 'check.unknown', segments: [{ code: String(name) }], text: String(name) };
}

function gatesUiSliceText(slice, locale) {
  if (slice === undefined || slice === null || slice === '' || slice === 'overall') return gatesUiLabel('slice.overall', locale);
  const match = /^language:([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/.exec(String(slice));
  if (match) return gatesUiLabel('slice.language', locale, { language: gatesUiLanguageName(match[1], locale) });
  return String(slice);
}

/** A value as a rate when the check is a rate or share, else as a two-decimal score. */
function gatesUiValueText(check, value, locale) {
  const name = String(check || '');
  return /(_rate|_share)$/.test(name) ? gatesUiPercent(value, locale) : gatesUiScore(value, locale);
}

/** Pure: evidence rows, failed and no-result rows visible, the rest hidden behind "Show all checks". */
function gatesUiEvidenceRows(checks, locale) {
  const list = Array.isArray(checks) ? checks : [];
  const visible = [];
  const hidden = [];
  for (const raw of list) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const verdict = gatesUiVerdictView(c.result);
    const measured =
      gatesUiFinite(c.numerator) && gatesUiFinite(c.denominator) && c.denominator > 0 ? gatesUiRate(c.numerator, c.denominator, locale) : gatesUiValueText(c.check, c.measured, locale);
    const limitKey = typeof c.limit_kind === 'string' && gatesUiHas(GATES_UI_LIMIT_KINDS, c.limit_kind) ? GATES_UI_LIMIT_KINDS[c.limit_kind] : null;
    const limit = limitKey && gatesUiFinite(c.limit) ? gatesUiLabel(limitKey, locale, { value: gatesUiValueText(c.check, c.limit, locale) }) : gatesUiLabel('limit.none', locale);
    const checkMessage = gatesUiCheckMessage(c.check, locale);
    const row = {
      checkMessage,
      checkLabel: checkMessage.text,
      slice: gatesUiSliceText(c.slice, locale),
      measured,
      limit,
      result: c.result,
      verdictKey: verdict.key,
    };
    if (verdict.key === 'verdict.fail' || verdict.key === 'verdict.error') visible.push(row);
    else hidden.push(row);
  }
  return { visible, hidden };
}

function gatesUiEvidenceTableEl(rows, locale, caption) {
  const head = gatesUiEl('tr', null, [
    ...['col.check', 'col.questions'].map((k) => gatesUiEl('th', { className: 'text-xs font-semibold', text: gatesUiLabel(k, locale), attrs: { scope: 'col' } })),
    ...['col.measured', 'col.limit'].map((k) => gatesUiEl('th', { className: 'text-xs font-semibold text-right', text: gatesUiLabel(k, locale), attrs: { scope: 'col' } })),
    gatesUiEl('th', { className: 'text-xs font-semibold', text: gatesUiLabel('col.result', locale), attrs: { scope: 'col' } }),
  ]);
  const body = gatesUiEl('tbody');
  for (const row of rows) {
    const rowHead = gatesUiMessageEl('th', 'font-normal text-sm align-top break-words', row.checkMessage);
    rowHead.setAttribute('scope', 'row');
    body.appendChild(
      gatesUiEl('tr', null, [
        rowHead,
        gatesUiEl('td', { className: 'text-sm align-top break-words', text: row.slice }),
        gatesUiEl('td', { className: 'text-sm align-top text-right tabular-nums', text: row.measured }),
        gatesUiEl('td', { className: 'text-sm align-top text-right tabular-nums', text: row.limit }),
        gatesUiEl('td', { className: 'align-top' }, [gatesUiBadge(row.result, locale)]),
      ]),
    );
  }
  return gatesUiEl(
    'div',
    {
      className: 'overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      attrs: { tabindex: '0', role: 'region', 'aria-label': caption },
    },
    [gatesUiEl('table', { className: 'table table-sm' }, [gatesUiEl('caption', { className: 'sr-only', text: caption }), gatesUiEl('thead', null, [head]), body])],
  );
}

/** The evidence table: failed and no-result rows always visible, the others in a details with their count. */
function gatesUiEvidenceTable(checks, locale) {
  const rows = gatesUiEvidenceRows(checks, locale);
  const caption = gatesUiLabel('checks.caption', locale);
  const out = gatesUiEl('div', { className: 'flex flex-col gap-2 min-w-0' });
  if (rows.visible.length > 0) out.appendChild(gatesUiEvidenceTableEl(rows.visible, locale, caption));
  if (rows.hidden.length > 0) {
    out.appendChild(
      gatesUiEl('details', null, [
        gatesUiEl('summary', {
          className: 'text-sm cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          text: gatesUiLabel('checks.showAll', locale, { count: gatesUiNumber(rows.hidden.length, locale) }),
        }),
        gatesUiEvidenceTableEl(rows.hidden, locale, caption),
      ]),
    );
  }
  return out;
}

/** UI-SPEC 6.8: one neutral 4px by 96px track with one fill; decorative, the number is always next to it. */
function gatesUiShareBar(share) {
  const value = gatesUiFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  const fill = gatesUiEl('div', { className: 'h-1 rounded-full bg-base-content/60' });
  fill.style.width = Math.round(value * 1000) / 10 + '%';
  return gatesUiEl('div', { className: 'w-24 h-1 rounded-full bg-base-300 max-md:hidden shrink-0', attrs: { 'aria-hidden': 'true' } }, [fill]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Sub-tabs (UI-SPEC 9.2) and confirmation dialog (UI-SPEC 9.8)

/**
 * Sub-tabs with a roving tabindex: Left and Right move and activate, Home and End jump. opts: { label, idPrefix, tabs: [{ id, label }],
 * selected, onSelect }. Returns { root, tabs, panels, select }.
 */
function gatesUiSubTabs(opts) {
  const o = opts || {};
  const prefix = String(o.idPrefix || 'gates-ui-tabs');
  const defs = Array.isArray(o.tabs) ? o.tabs : [];
  const root = gatesUiEl('div', { className: 'tabs tabs-bordered mb-4 flex-wrap', attrs: { role: 'tablist', 'aria-label': o.label || '' } });
  const tabs = [];
  const panels = [];
  let current = -1;
  const select = (index, focus) => {
    if (index < 0 || index >= tabs.length) return;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.classList.toggle('tab-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.setAttribute('tabindex', on ? '0' : '-1');
      panels[i].hidden = !on;
    });
    if (focus) tabs[index].focus();
    if (index !== current || focus) {
      current = index;
      if (typeof o.onSelect === 'function') o.onSelect(defs[index].id);
    }
  };
  defs.forEach((def, i) => {
    const tabId = prefix + '-tab-' + def.id;
    const panelId = prefix + '-panel-' + def.id;
    const tab = gatesUiEl('button', {
      className: 'tab focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      text: def.label,
      attrs: { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, 'aria-selected': 'false', tabindex: '-1' },
      on: { click: () => select(i, false) },
    });
    const panel = gatesUiEl('div', { className: 'min-w-0', attrs: { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: '0' } });
    panel.hidden = true;
    tabs.push(tab);
    panels.push(panel);
    root.appendChild(tab);
  });
  root.addEventListener('keydown', (event) => {
    if (tabs.length === 0) return;
    const from = current < 0 ? 0 : current;
    let next = -1;
    if (event.key === 'ArrowRight') next = (from + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (from - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    select(next, true);
  });
  const initial = Math.max(
    0,
    defs.findIndex((d) => d.id === o.selected),
  );
  if (tabs.length > 0) {
    tabs.forEach((tab, i) => {
      tab.classList.toggle('tab-active', i === initial);
      tab.setAttribute('aria-selected', i === initial ? 'true' : 'false');
      tab.setAttribute('tabindex', i === initial ? '0' : '-1');
      panels[i].hidden = i !== initial;
    });
    current = initial;
  }
  return {
    root,
    tabs,
    panels,
    select: (id) => select(defs.findIndex((d) => d.id === id), false),
  };
}

let GATES_UI_CONFIRM_SEQ = 0;

/**
 * A confirmation (native dialog built with DOM calls): default focus on the Keep button, Escape and the backdrop cancel, focus returns to
 * the opener. opts: { title, body (string or message), keepLabel, confirmLabel, opener, locale, fallbackFocus }. Resolves true on confirm.
 */
function gatesUiConfirm(opts) {
  const o = opts || {};
  GATES_UI_CONFIRM_SEQ += 1;
  const id = 'gates-ui-confirm-' + GATES_UI_CONFIRM_SEQ;
  return new Promise((resolve) => {
    let settled = false;
    const titleEl = gatesUiEl('h3', { className: 'text-base font-semibold', text: o.title || '', attrs: { id: id + '-title' } });
    const bodyEl =
      o.body && typeof o.body === 'object' && Array.isArray(o.body.segments)
        ? gatesUiMessageEl('p', 'text-sm mt-2 max-w-prose', o.body)
        : gatesUiEl('p', { className: 'text-sm mt-2 max-w-prose', text: o.body || '' });
    bodyEl.setAttribute('id', id + '-body');
    const keep = gatesUiEl('button', { className: 'btn', text: o.keepLabel || '', attrs: { type: 'button', autofocus: true } });
    const confirm = gatesUiEl('button', { className: 'btn btn-primary', text: o.confirmLabel || '', attrs: { type: 'button' } });
    const box = gatesUiEl('div', { className: 'modal-box w-11/12 max-w-lg overscroll-contain' }, [
      titleEl,
      bodyEl,
      gatesUiEl('div', { className: 'modal-action flex-col-reverse sm:flex-row gap-2' }, [keep, confirm]),
    ]);
    const backdrop = gatesUiEl('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [
      gatesUiEl('button', { text: o.keepLabel || '', attrs: { type: 'submit', tabindex: '-1' } }),
    ]);
    const dialog = gatesUiEl('dialog', {
      className: 'modal',
      attrs: { 'aria-labelledby': id + '-title', 'aria-describedby': id + '-body', lang: gatesUiLocale(o.locale) },
    }, [box, backdrop]);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      const target = o.opener && o.opener.isConnected !== false ? o.opener : o.fallbackFocus;
      if (target && typeof target.focus === 'function') target.focus();
      resolve(value);
    };
    keep.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    keep.focus();
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Errors and requests (UI-SPEC 8.2)

/**
 * Maps a request result to { kind, key, segments, text }. ctx: { view, switchedOn, appUrl }. Kinds: network, signIn, switchedOff, off,
 * unavailable, generic.
 */
function gatesUiMapError(result, locale, ctx) {
  const c = ctx || {};
  if (!result || typeof result !== 'object' || result.thrown) return { ...gatesUiMessage('error.network', locale), kind: 'network' };
  const status = typeof result.status === 'number' ? result.status : 0;
  if (status === 401 || status === 403) return { ...gatesUiMessage('error.signIn', locale, { appUrl: gatesUiAppUrl(c.appUrl) }), kind: 'signIn' };
  if (status === 404 && c.switchedOn === true) return { ...gatesUiMessage('error.switchedOffApp', locale), kind: 'switchedOff' };
  if (status === 404 && c.switchedOn === false) return { key: 'off', segments: [], text: '', kind: 'off' };
  if (status === 500 || status === 503) return { ...gatesUiMessage('error.unavailable', locale, { view: c.view || '' }), kind: 'unavailable' };
  return { ...gatesUiMessage('error.generic', locale, { status: status || '?' }), kind: 'generic' };
}

/** ragFetch wrapped in try with a client timeout (15 seconds by default). deps: { fetcher, timeoutMs }. Never throws. */
async function gatesUiFetch(apiPath, init, deps) {
  const d = deps || {};
  const fetcher = d.fetcher || ((path, requestInit) => window.ragFetch(path, requestInit));
  const timeoutMs = gatesUiFinite(d.timeoutMs) ? d.timeoutMs : GATES_UI_TIMEOUT_MS;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 0, thrown: true, timeout: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => fetcher(apiPath, init || { method: 'GET' })), timeout]);
    return result && typeof result === 'object' ? result : { ok: false, status: 0, thrown: true };
  } catch {
    return { ok: false, status: 0, thrown: true };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Page attention banner (UI-SPEC 6.6): at most two rows, requested only when the loaded configuration asks for them, never polls.

const GATES_UI_BANNER_ALERTS_API = '/api/rag/admin/monitor/alerts?status=open&limit=1';
const GATES_UI_BANNER_REFUSAL_API = '/api/rag/admin/refusal-calibration';
const GATES_UI_BANNER_STATE = { config: null, deps: null, seq: 0 };

/** Which rows the loaded (saved) configuration asks for; an unsaved select value is never read. */
function gatesUiBannerPlan(config) {
  const c = config && typeof config === 'object' ? config : {};
  const monitor = String(c.RAG_MONITOR === undefined || c.RAG_MONITOR === null ? 'false' : c.RAG_MONITOR).trim().toLowerCase() === 'true';
  const gate = String(c.RAG_CONFIG_GATE === undefined || c.RAG_CONFIG_GATE === null || c.RAG_CONFIG_GATE === '' ? 'off' : c.RAG_CONFIG_GATE).trim().toLowerCase();
  return { alerts: monitor, uncal: monitor || gate !== 'off' };
}

/** Pure: the open-alert count and whether an open alert of severity alert was returned; null when the request failed. */
function gatesUiBannerAlertCount(result) {
  if (!result || !result.ok || !result.body || typeof result.body !== 'object') return null;
  const counts = result.body.counts;
  const open = counts && gatesUiFinite(counts.open) && counts.open >= 0 ? Math.floor(counts.open) : null;
  if (open === null) return null;
  const alerts = Array.isArray(result.body.alerts) ? result.body.alerts : [];
  const severe = alerts.some((a) => a && a.status === 'open' && a.severity === 'alert');
  return { count: open, severe };
}

/** Pure: refusal cells marked pending after a setting change (a score shift still applies, so it does not count). */
function gatesUiBannerPendingCount(result) {
  if (!result || !result.ok || !result.body || typeof result.body !== 'object' || !Array.isArray(result.body.cells)) return null;
  return result.body.cells.filter((cell) => cell && cell.pending && typeof cell.pending === 'object' && cell.pending.reason !== 'score_shift').length;
}

/** Pure: the banner view, or null when no row has a count above 0. */
function gatesUiBannerView(alerts, pending) {
  const rows = [];
  if (alerts && alerts.count > 0) rows.push({ kind: 'alerts', count: alerts.count });
  if (gatesUiFinite(pending) && pending > 0) rows.push({ kind: 'uncal', count: pending });
  if (rows.length === 0) return null;
  return { tone: alerts && alerts.count > 0 && alerts.severe ? 'error' : 'warning', rows };
}

/** Review alerts: activates RAG administration, selects the Alerts sub-tab when the Monitoring panel exists, scrolls, focuses its heading. */
function gatesUiOpenMonitorAlerts() {
  const link = document.querySelector('.menu-item[data-tab="rag-administration"]') || document.querySelector('[data-tab="rag-administration"]');
  if (link) link.click();
  const section = document.getElementById('rag-administration-monitor');
  if (!section) return;
  const tab = section.querySelector('[data-monitor-tab="alerts"]');
  if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const heading = section.querySelector('h3');
  if (heading && typeof heading.focus === 'function') heading.focus({ preventScroll: true });
}

function gatesUiOpenRefusal() {
  if (typeof window !== 'undefined' && typeof window.openRefusalCalibrationPanel === 'function') window.openRefusalCalibrationPanel();
}

function gatesUiBannerEl(view, locale, deps) {
  const d = deps || {};
  const list = gatesUiEl('ul', { className: 'grid gap-2 w-full' });
  for (const row of view.rows) {
    const alertsRow = row.kind === 'alerts';
    const button = gatesUiEl('button', {
      className: 'btn btn-sm shrink-0 w-full sm:w-auto',
      text: gatesUiLabel(alertsRow ? 'banner.alertsAction' : 'banner.uncalAction', locale),
      attrs: { type: 'button' },
      on: { click: () => (alertsRow ? (d.openAlerts || gatesUiOpenMonitorAlerts)() : (d.openRefusal || gatesUiOpenRefusal)()) },
    });
    list.appendChild(
      gatesUiEl('li', { className: 'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 min-w-0' }, [
        gatesUiEl('span', {
          className: 'text-sm tabular-nums break-words min-w-0',
          text: gatesUiLabel(alertsRow ? 'banner.alerts' : 'banner.uncal', locale, { count: gatesUiNumber(row.count, locale) }),
        }),
        button,
      ]),
    );
  }
  return gatesUiEl('div', { className: 'alert alert-' + view.tone + ' items-start justify-items-start text-left mb-6', attrs: { lang: locale } }, [
    gatesUiIcon('bi-exclamation-triangle', 'mt-0.5'),
    gatesUiEl('div', { className: 'flex flex-col gap-2 min-w-0 w-full' }, [gatesUiEl('h2', { className: 'text-base font-semibold text-balance', text: gatesUiLabel('banner.title', locale) }), list]),
  ]);
}

/**
 * Mounts or refreshes #rag-attention-banner from the loaded configuration. deps: { fetcher, locale, openAlerts, openRefusal }. A failed
 * request leaves its row out and shows nothing; with neither switch on no request is made. Resolves to the view or null.
 */
async function gatesUiMountBanner(config, deps) {
  GATES_UI_BANNER_STATE.config = config && typeof config === 'object' ? config : {};
  if (deps) GATES_UI_BANNER_STATE.deps = deps;
  const d = GATES_UI_BANNER_STATE.deps || {};
  const seq = (GATES_UI_BANNER_STATE.seq += 1);
  const host = typeof document !== 'undefined' ? document.getElementById('rag-attention-banner') : null;
  const plan = gatesUiBannerPlan(GATES_UI_BANNER_STATE.config);
  if (!plan.alerts && !plan.uncal) {
    if (host) host.replaceChildren();
    return null;
  }
  const locale = gatesUiLocale(d.locale);
  const fetchDeps = { fetcher: d.fetcher };
  const [alertsResult, refusalResult] = await Promise.all([
    plan.alerts ? gatesUiFetch(GATES_UI_BANNER_ALERTS_API, { method: 'GET' }, fetchDeps) : Promise.resolve(null),
    plan.uncal ? gatesUiFetch(GATES_UI_BANNER_REFUSAL_API, { method: 'GET' }, fetchDeps) : Promise.resolve(null),
  ]);
  if (seq !== GATES_UI_BANNER_STATE.seq) return null;
  const view = gatesUiBannerView(gatesUiBannerAlertCount(alertsResult), gatesUiBannerPendingCount(refusalResult));
  if (host) {
    if (view) host.replaceChildren(gatesUiBannerEl(view, locale, d));
    else host.replaceChildren();
  }
  return view;
}

/** Refreshes the banner with the last loaded configuration (after an action or a tab activation); nothing polls. */
function gatesUiRefreshBanner() {
  let config = GATES_UI_BANNER_STATE.config;
  if (typeof window !== 'undefined' && window.configManager && window.configManager.savedConfig) config = window.configManager.savedConfig;
  if (!config) return Promise.resolve(null);
  return gatesUiMountBanner(config);
}

function gatesUiBindBannerRefresh() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-gates-banner-bound')) return;
    link.setAttribute('data-gates-banner-bound', '1');
    link.addEventListener('click', () => {
      gatesUiRefreshBanner();
    });
  });
}

if (typeof window !== 'undefined') {
  window.GATES_UI_LABELS = GATES_UI_LABELS;
  window.gatesUiLocale = gatesUiLocale;
  window.gatesUiLabel = gatesUiLabel;
  window.gatesUiMessage = gatesUiMessage;
  window.gatesUiMessageFrom = gatesUiMessageFrom;
  window.gatesUiVerdict = gatesUiVerdict;
  window.gatesUiEvidenceTable = gatesUiEvidenceTable;
  window.gatesUiShareBar = gatesUiShareBar;
  window.gatesUiSubTabs = gatesUiSubTabs;
  window.gatesUiConfirm = gatesUiConfirm;
  window.gatesUiMapError = gatesUiMapError;
  window.gatesUiFetch = gatesUiFetch;
  window.gatesUiMountBanner = gatesUiMountBanner;
  window.gatesUiRefreshBanner = gatesUiRefreshBanner;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    gatesUiBindBannerRefresh();
    document.addEventListener('DOMContentLoaded', () => gatesUiBindBannerRefresh());
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GATES_UI_LABELS,
    GATES_UI_TIMEOUT_MS,
    gatesUiLocale,
    gatesUiTemplateFrom,
    gatesUiFill,
    gatesUiMessageFrom,
    gatesUiMessage,
    gatesUiLabel,
    gatesUiAppUrl,
    gatesUiNumber,
    gatesUiPercent,
    gatesUiRate,
    gatesUiScore,
    gatesUiSigned,
    gatesUiDate,
    gatesUiLanguageName,
    gatesUiEl,
    gatesUiIcon,
    gatesUiSpinner,
    gatesUiAppendMessage,
    gatesUiMessageEl,
    gatesUiAlert,
    gatesUiStatus,
    gatesUiSetBusy,
    gatesUiLoadingBlock,
    gatesUiEmptyBlock,
    gatesUiReloadButton,
    gatesUiErrorAlert,
    gatesUiVerdictView,
    gatesUiVerdict,
    gatesUiEvidenceRows,
    gatesUiEvidenceTable,
    gatesUiShareBar,
    gatesUiSubTabs,
    gatesUiConfirm,
    gatesUiMapError,
    gatesUiFetch,
    gatesUiBannerPlan,
    gatesUiBannerAlertCount,
    gatesUiBannerPendingCount,
    gatesUiBannerView,
    gatesUiMountBanner,
    gatesUiRefreshBanner,
  };
}
