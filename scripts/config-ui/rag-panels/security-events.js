/**
 * Security events panel and page banner of RAG administration (Phase 5.2 SEC-10, SEC-06; D-40, D-43 to D-47, D-57; UI-SPEC 6.13).
 * Lists alerts, uploaders, events and the WhatsApp preview-host check over the workspaces the admin administers, and holds or
 * releases an uploader's uploads. Ids, names and counts only: no route that returns document, question, answer or target text is
 * called. Every server value is text (createElement and textContent through ragUiEl); nothing becomes a link.
 */

const SECURITY_EVENTS_LABELS = {
  en: {
    'panel.title': 'Security events',
    'panel.description':
      'What the upload checks, the retrieval check and the answer guard detected, and whose uploads were involved. Ids and counts only.',
    'banner.title': 'Security alerts: {n} open',
    'banner.body': 'Documents from one or more uploaders passed the alert level for security events.',
    'banner.action': 'Review alerts',
    'tabs.label': 'Security event views',
    'tab.alerts': 'Alerts: {n}',
    'tab.uploaders': 'Uploaders',
    'tab.events': 'Events',
    'tab.previews': 'Link previews',
    'state.open': 'Open alert',
    'state.held': 'Uploads held',
    'state.acknowledged': 'Acknowledged',
    'alert.sentence': 'Documents from this uploader keep triggering security checks.',
    'alert.heldSentence': 'New uploads from this uploader wait for approval.',
    'meta.events': 'Events: {n}',
    'meta.window': 'Window: {n} h',
    'meta.level': 'Alert level: {n}',
    'meta.workspace': 'Workspace: {name}',
    'meta.opened': 'Opened: {time}',
    'action.hold': 'Hold uploads',
    'action.hold.aria': 'Hold uploads: {uploader}',
    'action.release': 'Release hold',
    'action.release.aria': 'Release hold: {uploader}',
    'action.acknowledge': 'Acknowledge alert',
    'action.acknowledge.aria': 'Acknowledge alert: {uploader}',
    'action.showEvents': 'Show events',
    'action.openSetting': 'Open the setting',
    'hold.title': 'Hold uploads from {uploader}?',
    'hold.body':
      'New uploads from this uploader, and their uploads still in the ingestion queue, wait in Upload approvals until an admin approves them. Documents that are already searchable stay searchable.',
    'hold.reason': 'Reason (optional)',
    'hold.keep': 'Keep uploads allowed',
    'hold.running': 'Holding…',
    'hold.done': 'Uploads from {uploader} are held.',
    'release.running': 'Releasing…',
    'release.done': 'Hold released for {uploader}. Uploads already held still wait in Upload approvals.',
    'acknowledge.running': 'Acknowledging…',
    'acknowledge.done': 'Alert acknowledged.',
    'hold.off': 'Holding uploads is switched off. Change it in RAG Modes, Answer rules and output safety.',
    'alerts.empty.title': 'No open alerts',
    'alerts.empty.body':
      'An alert opens when documents from one uploader trigger more security events than the alert level within the window. Set the level in RAG Modes, Answer rules and output safety.',
    'alerts.levelZero': 'Alerts are off: the alert level is 0.',
    'alerts.acknowledged': 'Acknowledged alerts: {n}',
    'alerts.loading': 'Loading alerts…',
    'events.off':
      'Security events are not recorded. Turn on “Record security events with the document’s uploader” in RAG Modes, Answer rules and output safety.',
    'events.unavailableOff': 'Security events are not available on this deployment yet.',
    'events.unavailable': 'Security events are unavailable right now. Select Reload panel in a moment.',
    'events.empty.title': 'No security events',
    'events.empty.body': 'Detections from the upload checks, the retrieval check and the answer guard appear here.',
    'events.loading': 'Loading events…',
    'uploaders.empty': 'No uploaders with events. Uploaders appear here once a document of theirs triggers a security event.',
    'uploaders.loading': 'Loading uploaders…',
    'previews.loading': 'Checking preview hosts…',
    'col.time': 'Time',
    'col.workspace': 'Workspace',
    'col.check': 'Check',
    'col.result': 'Result',
    'col.document': 'Document',
    'col.uploader': 'Uploaded by',
    'col.rules': 'Rules',
    'col.events': 'Events',
    'col.last': 'Last event',
    'col.uploads': 'Uploads',
    'col.actions': 'Actions',
    'col.uploaderName': 'Uploader',
    'col.opened': 'Opened',
    'caption.events': 'Security events',
    'caption.uploaders': 'Uploaders with security events',
    'caption.acknowledged': 'Acknowledged alerts',
    'uploads.allowed': 'Allowed',
    'uploads.heldSince': 'Held since {date}',
    'source.ingest_injection': 'Upload: instruction rule',
    'source.retrieval_injection': 'Retrieval check',
    'source.output_guard': 'Answer guard',
    'source.hidden_text': 'Upload: hidden text',
    'source.untrusted_link': 'Upload: link check',
    'result.detected': 'Detected',
    'result.quarantined': 'Quarantined',
    'result.dropped': 'Left out of the answer',
    'result.downweighted': 'Ranked lower',
    'result.removed': 'Link removed',
    'result.blocked': 'Sentence removed',
    'result.warned': 'Caution added',
    'filter.check': 'Check',
    'filter.allChecks': 'All checks',
    'filter.period': 'Period',
    'filter.uploader': 'Uploaded by: {name}',
    'filter.clearUploader': 'Show all uploaders',
    'period.day': '24 hours',
    'period.week': '7 days',
    'period.month': '30 days',
    'uploader.unknown': 'Unknown uploader',
    'doc.removed': 'Document removed',
    'doc.none': 'No source document',
    'code.unknown': 'Unrecognized value: {code}',
    'refresh.alerts': 'Refresh alerts',
    'refresh.events': 'Refresh events',
    'refresh.uploaders': 'Refresh uploaders',
    'refresh.previews': 'Check preview hosts again',
    'more.events': 'Load more events',
    'more.uploaders': 'Load more uploaders',
    'more.alerts': 'Load more alerts',
    updated: 'Updated {time}',
    'preview.unknown': 'The preview hosts could not be read: the WhatsApp service is not configured or did not answer.',
    'preview.none': 'The WhatsApp service fetches no link previews.',
    'preview.subset': 'Every preview host is on the answer link allowlist.',
    'preview.mismatch': 'These preview hosts are not on the answer link allowlist:',
    'preview.fix': 'Remove them from {variable} on the WhatsApp service, or add them to the allowlist.',
    'preview.forced': 'While the answer guard is on, replies are sent with link previews off.',
    'error.holdFailed': 'The hold was not saved. Select Hold uploads again.',
    'error.outcomeUnknown': 'The request did not finish. The list is reloading so you can see the current state.',
  },
  zh: {
    'panel.title': '安全事件',
    'panel.description': '上传检查、检索检查和回答防护检测到的内容，以及涉及哪些上传者。仅显示标识和数量。',
    'banner.title': '安全提醒：{n} 条未处理',
    'banner.body': '一个或多个上传者的文档触发的安全事件超过了提醒级别。',
    'banner.action': '查看提醒',
    'tabs.label': '安全事件视图',
    'tab.alerts': '提醒：{n}',
    'tab.uploaders': '上传者',
    'tab.events': '事件',
    'tab.previews': '链接预览',
    'state.open': '未处理提醒',
    'state.held': '上传已暂缓',
    'state.acknowledged': '已确认',
    'alert.sentence': '该上传者的文档持续触发安全检查。',
    'alert.heldSentence': '该上传者的新上传需等待审批。',
    'meta.events': '事件：{n}',
    'meta.window': '窗口：{n} 小时',
    'meta.level': '提醒级别：{n}',
    'meta.workspace': '工作区：{name}',
    'meta.opened': '发出时间：{time}',
    'action.hold': '暂缓上传',
    'action.hold.aria': '暂缓上传：{uploader}',
    'action.release': '解除暂缓',
    'action.release.aria': '解除暂缓：{uploader}',
    'action.acknowledge': '确认提醒',
    'action.acknowledge.aria': '确认提醒：{uploader}',
    'action.showEvents': '查看事件',
    'action.openSetting': '打开该设置',
    'hold.title': '暂缓 {uploader} 的上传？',
    'hold.body': '该上传者的新上传以及仍在入库队列中的上传，将在“上传审批”中等待管理员批准。已可检索的文档保持可检索。',
    'hold.reason': '原因（可选）',
    'hold.keep': '继续允许上传',
    'hold.running': '正在暂缓…',
    'hold.done': '{uploader} 的上传已暂缓。',
    'release.running': '正在解除…',
    'release.done': '已解除对 {uploader} 的暂缓。已被暂缓的上传仍在“上传审批”中等待。',
    'acknowledge.running': '正在确认…',
    'acknowledge.done': '提醒已确认。',
    'hold.off': '暂缓上传已关闭。可在“RAG 模式”的“回答规则与输出安全”中更改。',
    'alerts.empty.title': '没有未处理的提醒',
    'alerts.empty.body': '当某个上传者的文档在统计窗口内触发的安全事件超过提醒级别时，会发出提醒。可在“RAG 模式”的“回答规则与输出安全”中设置级别。',
    'alerts.levelZero': '提醒已关闭：提醒级别为 0。',
    'alerts.acknowledged': '已确认的提醒：{n}',
    'alerts.loading': '正在加载提醒…',
    'events.off': '未记录安全事件。请在“RAG 模式”的“回答规则与输出安全”中开启“记录安全事件及文档上传者”。',
    'events.unavailableOff': '此部署尚不提供安全事件。',
    'events.unavailable': '安全事件暂时不可用。请稍后选择“重新加载面板”。',
    'events.empty.title': '没有安全事件',
    'events.empty.body': '上传检查、检索检查和回答防护的检测结果会显示在这里。',
    'events.loading': '正在加载事件…',
    'uploaders.empty': '没有产生事件的上传者。当某位上传者的文档触发安全事件后，会显示在这里。',
    'uploaders.loading': '正在加载上传者…',
    'previews.loading': '正在检查预览主机…',
    'col.time': '时间',
    'col.workspace': '工作区',
    'col.check': '检查',
    'col.result': '结果',
    'col.document': '文档',
    'col.uploader': '上传者',
    'col.rules': '规则',
    'col.events': '事件数',
    'col.last': '最近事件',
    'col.uploads': '上传',
    'col.actions': '操作',
    'col.uploaderName': '上传者',
    'col.opened': '发出时间',
    'caption.events': '安全事件',
    'caption.uploaders': '产生安全事件的上传者',
    'caption.acknowledged': '已确认的提醒',
    'uploads.allowed': '允许',
    'uploads.heldSince': '自 {date} 起暂缓',
    'source.ingest_injection': '上传：指令规则',
    'source.retrieval_injection': '检索检查',
    'source.output_guard': '回答防护',
    'source.hidden_text': '上传：隐藏文本',
    'source.untrusted_link': '上传：链接检查',
    'result.detected': '已检测',
    'result.quarantined': '已隔离',
    'result.dropped': '未用于回答',
    'result.downweighted': '已降低排序',
    'result.removed': '链接已移除',
    'result.blocked': '句子已移除',
    'result.warned': '已添加提醒',
    'filter.check': '检查',
    'filter.allChecks': '全部检查',
    'filter.period': '时间范围',
    'filter.uploader': '上传者：{name}',
    'filter.clearUploader': '显示全部上传者',
    'period.day': '24 小时',
    'period.week': '7 天',
    'period.month': '30 天',
    'uploader.unknown': '未知上传者',
    'doc.removed': '文档已删除',
    'doc.none': '无来源文档',
    'code.unknown': '无法识别的值：{code}',
    'refresh.alerts': '刷新提醒',
    'refresh.events': '刷新事件',
    'refresh.uploaders': '刷新上传者',
    'refresh.previews': '重新检查预览主机',
    'more.events': '加载更多事件',
    'more.uploaders': '加载更多上传者',
    'more.alerts': '加载更多提醒',
    updated: '更新于 {time}',
    'preview.unknown': '无法读取预览主机：WhatsApp 服务未配置或没有响应。',
    'preview.none': 'WhatsApp 服务不会抓取链接预览。',
    'preview.subset': '所有预览主机都在回答链接白名单中。',
    'preview.mismatch': '以下预览主机不在回答链接白名单中：',
    'preview.fix': '请在 WhatsApp 服务的 {variable} 中移除它们，或将其加入白名单。',
    'preview.forced': '回答防护开启时，回复发送时不带链接预览。',
    'error.holdFailed': '暂缓未保存。请再次选择“暂缓上传”。',
    'error.outcomeUnknown': '请求未完成。列表正在重新加载，以显示当前状态。',
  },
  it: {
    'panel.title': 'Eventi di sicurezza',
    'panel.description':
      'Che cosa hanno rilevato i controlli sui caricamenti, il controllo sul recupero e la protezione delle risposte, e di chi erano i caricamenti. Solo identificativi e conteggi.',
    'banner.title': 'Avvisi di sicurezza: {n} aperti',
    'banner.body': 'I documenti di uno o più autori hanno superato il livello di allerta per gli eventi di sicurezza.',
    'banner.action': 'Esamina avvisi',
    'tabs.label': 'Viste degli eventi di sicurezza',
    'tab.alerts': 'Avvisi: {n}',
    'tab.uploaders': 'Autori',
    'tab.events': 'Eventi',
    'tab.previews': 'Anteprime dei link',
    'state.open': 'Avviso aperto',
    'state.held': 'Caricamenti sospesi',
    'state.acknowledged': 'Preso in carico',
    'alert.sentence': 'I documenti di questo autore continuano ad attivare i controlli di sicurezza.',
    'alert.heldSentence': "I nuovi caricamenti di questo autore attendono l'approvazione.",
    'meta.events': 'Eventi: {n}',
    'meta.window': 'Finestra: {n} h',
    'meta.level': 'Livello di allerta: {n}',
    'meta.workspace': 'Spazio di lavoro: {name}',
    'meta.opened': 'Aperto: {time}',
    'action.hold': 'Sospendi caricamenti',
    'action.hold.aria': 'Sospendi caricamenti: {uploader}',
    'action.release': 'Revoca sospensione',
    'action.release.aria': 'Revoca sospensione: {uploader}',
    'action.acknowledge': 'Prendi in carico',
    'action.acknowledge.aria': "Prendi in carico l'avviso: {uploader}",
    'action.showEvents': 'Mostra eventi',
    'action.openSetting': "Apri l'impostazione",
    'hold.title': 'Sospendere i caricamenti di {uploader}?',
    'hold.body':
      'I nuovi caricamenti di questo autore, e quelli ancora in coda di acquisizione, attendono in Approvazione caricamenti finché un amministratore non li approva. I documenti già ricercabili restano ricercabili.',
    'hold.reason': 'Motivo (facoltativo)',
    'hold.keep': 'Mantieni i caricamenti consentiti',
    'hold.running': 'Sospensione…',
    'hold.done': 'I caricamenti di {uploader} sono sospesi.',
    'release.running': 'Revoca in corso…',
    'release.done': 'Sospensione revocata per {uploader}. I caricamenti già sospesi attendono ancora in Approvazione caricamenti.',
    'acknowledge.running': 'Presa in carico…',
    'acknowledge.done': 'Avviso preso in carico.',
    'hold.off': "La sospensione dei caricamenti è disattivata. Modificala in Modalità RAG, Regole di risposta e sicurezza dell'output.",
    'alerts.empty.title': 'Nessun avviso aperto',
    'alerts.empty.body':
      "Un avviso si apre quando i documenti di un autore attivano, nella finestra, più eventi di sicurezza del livello di allerta. Imposta il livello in Modalità RAG, Regole di risposta e sicurezza dell'output.",
    'alerts.levelZero': 'Gli avvisi sono disattivati: il livello di allerta è 0.',
    'alerts.acknowledged': 'Avvisi presi in carico: {n}',
    'alerts.loading': 'Caricamento degli avvisi…',
    'events.off':
      "Gli eventi di sicurezza non vengono registrati. Attiva “Registra gli eventi di sicurezza con l'autore del caricamento” in Modalità RAG, Regole di risposta e sicurezza dell'output.",
    'events.unavailableOff': 'Gli eventi di sicurezza non sono ancora disponibili in questa installazione.',
    'events.unavailable': 'Gli eventi di sicurezza non sono disponibili al momento. Seleziona Ricarica pannello tra poco.',
    'events.empty.title': 'Nessun evento di sicurezza',
    'events.empty.body': 'Qui compaiono i rilevamenti dei controlli sui caricamenti, del controllo sul recupero e della protezione delle risposte.',
    'events.loading': 'Caricamento degli eventi…',
    'uploaders.empty': 'Nessun autore con eventi. Gli autori compaiono qui quando un loro documento attiva un evento di sicurezza.',
    'uploaders.loading': 'Caricamento degli autori…',
    'previews.loading': 'Controllo degli host di anteprima…',
    'col.time': 'Ora',
    'col.workspace': 'Spazio di lavoro',
    'col.check': 'Controllo',
    'col.result': 'Esito',
    'col.document': 'Documento',
    'col.uploader': 'Caricato da',
    'col.rules': 'Regole',
    'col.events': 'Eventi',
    'col.last': 'Ultimo evento',
    'col.uploads': 'Caricamenti',
    'col.actions': 'Azioni',
    'col.uploaderName': 'Autore',
    'col.opened': 'Aperto',
    'caption.events': 'Eventi di sicurezza',
    'caption.uploaders': 'Autori con eventi di sicurezza',
    'caption.acknowledged': 'Avvisi presi in carico',
    'uploads.allowed': 'Consentiti',
    'uploads.heldSince': 'Sospesi dal {date}',
    'source.ingest_injection': 'Caricamento: regola sulle istruzioni',
    'source.retrieval_injection': 'Controllo sul recupero',
    'source.output_guard': 'Protezione delle risposte',
    'source.hidden_text': 'Caricamento: testo nascosto',
    'source.untrusted_link': 'Caricamento: controllo dei link',
    'result.detected': 'Rilevato',
    'result.quarantined': 'In quarantena',
    'result.dropped': 'Escluso dalla risposta',
    'result.downweighted': 'Posizione abbassata',
    'result.removed': 'Link rimosso',
    'result.blocked': 'Frase rimossa',
    'result.warned': 'Avviso aggiunto',
    'filter.check': 'Controllo',
    'filter.allChecks': 'Tutti i controlli',
    'filter.period': 'Periodo',
    'filter.uploader': 'Caricato da: {name}',
    'filter.clearUploader': 'Mostra tutti gli autori',
    'period.day': '24 ore',
    'period.week': '7 giorni',
    'period.month': '30 giorni',
    'uploader.unknown': 'Autore sconosciuto',
    'doc.removed': 'Documento rimosso',
    'doc.none': 'Nessun documento di origine',
    'code.unknown': 'Valore non riconosciuto: {code}',
    'refresh.alerts': 'Aggiorna avvisi',
    'refresh.events': 'Aggiorna eventi',
    'refresh.uploaders': 'Aggiorna autori',
    'refresh.previews': 'Ricontrolla gli host di anteprima',
    'more.events': 'Carica altri eventi',
    'more.uploaders': 'Carica altri autori',
    'more.alerts': 'Carica altri avvisi',
    updated: 'Aggiornato {time}',
    'preview.unknown': 'Impossibile leggere gli host di anteprima: il servizio WhatsApp non è configurato o non ha risposto.',
    'preview.none': 'Il servizio WhatsApp non scarica anteprime dei link.',
    'preview.subset': "Ogni host di anteprima è nell'elenco consentito dei link.",
    'preview.mismatch': "Questi host di anteprima non sono nell'elenco consentito dei link:",
    'preview.fix': "Rimuovili da {variable} nel servizio WhatsApp, oppure aggiungili all'elenco consentito.",
    'preview.forced': 'Con la protezione delle risposte attiva, le risposte sono inviate senza anteprime dei link.',
    'error.holdFailed': 'La sospensione non è stata salvata. Seleziona di nuovo Sospendi caricamenti.',
    'error.outcomeUnknown': "La richiesta non è terminata. L'elenco si sta ricaricando per mostrare lo stato attuale.",
  },
};

const SECURITY_EVENTS_BASE = '/api/rag/admin/security-events';
const SECURITY_EVENTS_PATHS = {
  events: SECURITY_EVENTS_BASE,
  alerts: SECURITY_EVENTS_BASE + '/alerts',
  uploaders: SECURITY_EVENTS_BASE + '/uploaders',
  previews: SECURITY_EVENTS_BASE + '/link-previews',
};
const SECURITY_EVENTS_SOURCES = ['ingest_injection', 'retrieval_injection', 'output_guard', 'hidden_text', 'untrusted_link'];
const SECURITY_EVENTS_SOURCE_ICONS = {
  ingest_injection: 'chat-left-quote',
  retrieval_injection: 'search',
  output_guard: 'shield-lock',
  hidden_text: 'eye-slash',
  untrusted_link: 'link-45deg',
};
const SECURITY_EVENTS_RESULTS = ['detected', 'quarantined', 'dropped', 'downweighted', 'removed', 'blocked', 'warned'];
const SECURITY_EVENTS_PERIODS = { day: 24, week: 24 * 7, month: 24 * 30 };
const SECURITY_EVENTS_HOLD_MODES = ['off', 'manual', 'auto'];
const SECURITY_EVENTS_PREVIEW_STATES = ['unknown', 'none', 'subset', 'mismatch'];
const SECURITY_EVENTS_CHANGED = new Set(['already_held', 'not_held', 'already_acknowledged']);
const SECURITY_EVENTS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECURITY_EVENTS_REASON_MAX = 200;
const SECURITY_EVENTS_PREVIEW_VARIABLE = 'WHATSAPP_LINK_PREVIEW_HOSTS';
const SECURITY_EVENTS_SETTINGS = { events: 'RAG_SECURITY_EVENTS', level: 'RAG_UPLOADER_ALERT_THRESHOLD', hold: 'RAG_UPLOADER_HOLD' };

let securityEventsUi = null;
let securityEventsPanelInstance = null;
if (typeof require !== 'undefined') {
  try {
    securityEventsUi = require('./rag-ui.js');
  } catch {
    securityEventsUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function securityEventsUiLib() {
  if (securityEventsUi) return securityEventsUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function securityEventsLabel(key, locale, vars) {
  const ui = securityEventsUiLib();
  const text = ui.ragUiLookup(SECURITY_EVENTS_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function securityEventsText(value) {
  return typeof value === 'string' ? value : '';
}

function securityEventsCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function securityEventsStrings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** The uploader as a view needs it (UI-SPEC 6.13.2): name as text, the e-mail only when the route returned one, else the id. */
function securityEventsUploader(id, name, email) {
  const uploaderId = securityEventsText(id);
  const display = securityEventsText(name).trim();
  const mail = securityEventsText(email).trim();
  if (!uploaderId && !display) return null;
  return { id: uploaderId, name: display, email: mail, actionable: SECURITY_EVENTS_UUID.test(uploaderId) };
}

function securityEventsUploaderLabel(uploader, locale) {
  if (!uploader) return securityEventsLabel('uploader.unknown', locale);
  return uploader.name || uploader.id;
}

/** One alert from GET …/alerts: named fields only. */
function securityEventsAlertRow(item) {
  if (!item || typeof item !== 'object') return null;
  const id = securityEventsText(item.id);
  if (!id) return null;
  return {
    id,
    tenantKey: securityEventsText(item.tenant_key),
    workspace: securityEventsText(item.workspace_name) || securityEventsText(item.tenant_key),
    workspaceIsKey: !securityEventsText(item.workspace_name),
    uploader: securityEventsUploader(item.uploader_id, item.uploader_name, item.uploader_email),
    events: securityEventsCount(item.event_count),
    windowHours: securityEventsCount(item.window_hours),
    threshold: securityEventsCount(item.threshold),
    openedAt: securityEventsText(item.opened_at),
    status: item.status === 'acknowledged' ? 'acknowledged' : 'open',
    held: item.held === true,
  };
}

/** One uploader from GET …/uploaders. */
function securityEventsUploaderRow(item) {
  if (!item || typeof item !== 'object') return null;
  const uploader = securityEventsUploader(item.user_id, item.display_name, item.email);
  if (!uploader || !uploader.id) return null;
  return {
    key: securityEventsText(item.tenant_key) + '|' + uploader.id,
    tenantKey: securityEventsText(item.tenant_key),
    workspace: securityEventsText(item.workspace_name) || securityEventsText(item.tenant_key),
    workspaceIsKey: !securityEventsText(item.workspace_name),
    uploader,
    events: securityEventsCount(item.event_count),
    lastEventAt: securityEventsText(item.last_event_at),
    held: item.held === true,
    heldSince: securityEventsText(item.held_since),
  };
}

/** One event from GET …/security-events. No text of a document, question, answer or target is in the view. */
function securityEventsEventRow(item) {
  if (!item || typeof item !== 'object') return null;
  const id = securityEventsText(item.id);
  if (!id) return null;
  const source = securityEventsText(item.source);
  const action = securityEventsText(item.action);
  const documentId = securityEventsText(item.document_id);
  const fileName = securityEventsText(item.file_name);
  return {
    id,
    tenantKey: securityEventsText(item.tenant_key),
    workspace: securityEventsText(item.workspace_name) || securityEventsText(item.tenant_key),
    workspaceIsKey: !securityEventsText(item.workspace_name),
    createdAt: securityEventsText(item.created_at),
    source,
    sourceKnown: SECURITY_EVENTS_SOURCES.includes(source),
    action,
    actionKnown: SECURITY_EVENTS_RESULTS.includes(action),
    document: documentId ? (fileName ? { kind: 'file', name: fileName } : { kind: 'removed' }) : { kind: 'none' },
    uploader: securityEventsUploader(item.uploader_id, item.uploader_name, item.uploader_email),
    rules: securityEventsStrings(item.rule_ids),
  };
}

/** The list answers as the views need them; unknown fields are never read. */
function securityEventsRows(kind, body) {
  const data = body && typeof body === 'object' ? body : {};
  const builder = kind === 'alerts' ? securityEventsAlertRow : kind === 'uploaders' ? securityEventsUploaderRow : securityEventsEventRow;
  const items = (Array.isArray(data.items) ? data.items : []).map(builder).filter(Boolean);
  const holdMode = SECURITY_EVENTS_HOLD_MODES.includes(data.hold_mode) ? data.hold_mode : 'off';
  return {
    items,
    nextCursor: typeof data.next_cursor === 'string' && /^\d{1,7}$/.test(data.next_cursor) ? data.next_cursor : null,
    eventsRecorded: data.events_recorded !== false,
    holdMode,
    alertLevel: securityEventsCount(data.alert_level),
    windowHours: securityEventsCount(data.window_hours),
    openCount: securityEventsCount(data.open_count),
  };
}

/** GET …/link-previews: the state and host names only. */
function securityEventsPreviewView(body) {
  const data = body && typeof body === 'object' ? body : {};
  const state = SECURITY_EVENTS_PREVIEW_STATES.includes(data.state) ? data.state : 'unknown';
  return { state, hosts: securityEventsStrings(data.preview_hosts), notAllowed: securityEventsStrings(data.hosts_not_allowlisted) };
}

/** The ISO time a period filter starts at. */
function securityEventsSince(period, now) {
  const hours = SECURITY_EVENTS_PERIODS[period] || SECURITY_EVENTS_PERIODS.day;
  const base = now instanceof Date ? now.getTime() : Date.now();
  return new Date(base - hours * 3600 * 1000).toISOString();
}

/** More than one workspace in the data: the Workspace column appears (UI-SPEC 6.13.2). */
function securityEventsMultiWorkspace(rows) {
  return new Set(rows.map((row) => row.tenantKey).filter(Boolean)).size > 1;
}

/** Activates a tab through its own menu link, so the page's tab logic and panel mounts run as on a click. */
function securityEventsActivateTab(doc, tab) {
  const link = doc.querySelector('.menu-item[data-tab="' + tab + '"]') || doc.querySelector('[data-tab="' + tab + '"]');
  if (link && typeof link.click === 'function') link.click();
}

/** "Change it in RAG Modes…": opens the RAG Modes tab and focuses the setting's control. */
function securityEventsOpenSetting(doc, settingId) {
  securityEventsActivateTab(doc, 'rag-modes');
  const control = doc.getElementById(settingId);
  if (!control) return;
  if (typeof control.scrollIntoView === 'function') control.scrollIntoView({ block: 'center' });
  if (typeof control.focus === 'function') control.focus();
}

class SecurityEventsPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = securityEventsUiLib().ragUiBrowserLocale();
    this.tabs = null;
    this.hosts = {};
    this.data = { alerts: null, uploaders: null, events: null, previews: null };
    this.seq = { alerts: 0, uploaders: 0, events: 0, previews: 0 };
    this.updatedAt = {};
    this.filters = { source: '', period: 'day', uploader: null };
    this.alertHost = null;
    this.unavailableOff = false;
  }

  t(key, vars) {
    return securityEventsLabel(key, this.locale, vars);
  }

  ui() {
    return securityEventsUiLib();
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-security-events-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(this.ui().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  heading() {
    return this.root.querySelector('h3');
  }

  mount() {
    const ui = this.ui();
    this.root.setAttribute('lang', this.locale);
    const title = this.heading();
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-security-events-description]');
    if (description) description.textContent = this.t('panel.description');
    this.alertHost = this.root.querySelector('[data-security-events-alert]');
    const content = this.root.querySelector('[data-security-events-content]');
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-security-events',
      tabs: [
        { id: 'alerts', label: this.t('tab.alerts', { n: '…' }) },
        { id: 'uploaders', label: this.t('tab.uploaders') },
        { id: 'events', label: this.t('tab.events') },
        { id: 'previews', label: this.t('tab.previews') },
      ],
      selected: 'alerts',
      onSelect: (id) => this.load(id, 'tab'),
    });
    this.tabs.tablist.classList.add('!flex');
    for (const button of Array.from(this.tabs.tablist.querySelectorAll('button'))) button.classList.add('whitespace-nowrap', 'h-auto', 'min-h-8', 'py-2');
    const panes = [this.tabs.tablist];
    for (const id of ['alerts', 'uploaders', 'events', 'previews']) {
      this.hosts[id] = this.el('div', { className: 'min-w-0', attrs: { 'data-security-view': id } });
      this.tabs.panels[id].appendChild(this.hosts[id]);
      panes.push(this.tabs.panels[id]);
    }
    if (content) content.replaceChildren(...panes);
    return this.load('alerts', 'first');
  }

  refresh() {
    return this.load(this.tabs ? this.tabs.current() : 'alerts', 'tab');
  }

  /** Opens the panel from elsewhere (banner, Quarantine, injection card): tab, optional uploader filter, scroll and focus. */
  async open(options) {
    const opts = options || {};
    if (opts.uploader) this.filters.uploader = { id: opts.uploader.id, label: opts.uploader.label || opts.uploader.id };
    const tab = opts.tab || 'alerts';
    if (this.tabs) {
      if (this.tabs.current() === tab) await this.load(tab, 'tab');
      else {
        const done = this.tabs.select(tab);
        void done;
      }
    }
    if (typeof this.root.scrollIntoView === 'function') this.root.scrollIntoView({ block: 'start' });
    const heading = this.heading();
    if (heading && typeof heading.focus === 'function') heading.focus();
  }

  formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return securityEventsText(value);
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  timeEl(value) {
    if (!value) return this.el('span', { text: '—' });
    const date = new Date(value);
    const valid = !Number.isNaN(date.getTime());
    return this.el('time', { className: 'tabular-nums', text: this.formatTime(value), attrs: { datetime: valid ? date.toISOString() : null } });
  }

  dayText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? securityEventsText(value) : date.toISOString().slice(0, 10);
  }

  /** A label whose one placeholder is an element (a time); the rest of the template stays text. */
  templateWithNode(key, name, node) {
    const raw = this.ui().ragUiLookup(SECURITY_EVENTS_LABELS, key, this.locale) || '';
    const marker = '{' + name + '}';
    const at = raw.indexOf(marker);
    if (at < 0) return [raw, ' ', node];
    return [raw.slice(0, at), node, raw.slice(at + marker.length)].filter((part) => part !== '');
  }

  codeEl(value) {
    return this.el('code', { className: 'font-mono text-xs break-all', text: value, attrs: { translate: 'no' } });
  }

  workspaceEl(row) {
    return row.workspaceIsKey ? this.codeEl(row.workspace) : this.el('span', { className: '[overflow-wrap:anywhere]', text: row.workspace });
  }

  /** The uploader cell (UI-SPEC 6.13.2): name, an e-mail line only when returned, a bare id in monospace; never a link. */
  uploaderEl(uploader, strong) {
    if (!uploader) return this.el('span', { text: this.t('uploader.unknown') });
    const nodes = [];
    if (uploader.name) nodes.push(this.el('span', { className: 'block [overflow-wrap:anywhere]' + (strong ? ' text-base font-semibold' : ''), text: uploader.name }));
    else nodes.push(this.el('code', { className: 'block font-mono text-xs break-all', text: uploader.id, attrs: { translate: 'no' } }));
    if (uploader.email) nodes.push(this.el('span', { className: 'block text-xs text-base-content/70 font-normal [overflow-wrap:anywhere]', text: uploader.email, attrs: { translate: 'no' } }));
    return this.el('span', { className: 'block min-w-0' }, nodes);
  }

  emptyBlock(title, body) {
    return this.el('div', { className: 'py-8 text-center', attrs: { 'data-security-empty': '' } }, [
      title ? this.el('p', { className: 'text-base font-semibold text-balance', text: title }) : null,
      body ? this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: body }) : null,
    ]);
  }

  settingLink(settingId) {
    const button = this.el('button', { className: 'btn btn-link btn-sm px-0 h-auto min-h-0', text: this.t('action.openSetting'), attrs: { type: 'button', 'data-security-open-setting': settingId } });
    button.addEventListener('click', () => securityEventsOpenSetting(this.doc, settingId));
    return button;
  }

  /** RAG_SECURITY_EVENTS off: the data views show events.off with a link to the setting instead of an empty table. */
  eventsOffBlock() {
    return this.ui().ragUiAlert(this.doc, {
      tone: 'info',
      icon: 'info-circle',
      body: [this.t('events.off')],
      actions: [this.settingLink(SECURITY_EVENTS_SETTINGS.events)],
    });
  }

  setAlert(node) {
    if (this.alertHost) this.alertHost.replaceChildren(...(node ? [node] : []));
  }

  toolbar(view, extra) {
    const refresh = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('refresh.' + view), attrs: { type: 'button', 'data-security-refresh': view } });
    refresh.addEventListener('click', () => this.load(view, 'refresh'));
    const updated = this.updatedAt[view];
    return this.el('div', { className: 'flex flex-wrap items-end justify-between gap-2 mb-4' }, [
      ...(extra || []),
      this.el('p', { className: 'text-xs text-base-content/70', text: updated ? this.t('updated', { time: this.formatTime(updated) }) : '' }),
      refresh,
    ]);
  }

  moreButton(view, label) {
    const more = this.el('button', { className: 'btn btn-outline btn-sm mt-2', text: label, attrs: { type: 'button', 'data-security-more': view } });
    more.addEventListener('click', () => this.load(view, 'more'));
    return more;
  }

  path(view, cursor) {
    const params = new URLSearchParams();
    if (view === 'events') {
      if (this.filters.source) params.set('source', this.filters.source);
      if (this.filters.uploader) params.set('uploader', this.filters.uploader.id);
      params.set('since', securityEventsSince(this.filters.period));
    }
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return SECURITY_EVENTS_PATHS[view] + (query ? '?' + query : '');
  }

  /**
   * Loads one view. source: first | tab | refresh | action | more. Lists are snapshots: reloaded on tab activation, refresh and
   * after an action; nothing polls. Returns the parsed rows when usable.
   */
  async load(view, source) {
    const host = this.hosts[view];
    if (!host) return null;
    const ui = this.ui();
    const append = source === 'more';
    const previous = this.data[view];
    const seq = ++this.seq[view];
    const cursor = append && previous ? previous.nextCursor : null;
    if (append && !cursor) return previous;
    const loadingKey = view === 'previews' ? 'previews.loading' : view + '.loading';
    let restore = null;
    if (append) {
      const more = host.querySelector('[data-security-more]');
      if (more) restore = ui.ragUiButtonBusy(this.doc, more, this.t(loadingKey));
    } else if (previous) ui.ragUiListBusy(host, true);
    else ui.ragUiListLoading(this.doc, host, this.t(loadingKey));
    let result;
    try {
      result = await ui.ragUiRagRequest(this.path(view, cursor), { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    if (seq !== this.seq[view]) return null;
    ui.ragUiListBusy(host, false);
    if (!result || !result.ok || !result.body || typeof result.body !== 'object') {
      this.loadFailed(view, result);
      return null;
    }
    this.unavailableOff = false;
    this.setAlert(null);
    if (view === 'previews') {
      this.data.previews = securityEventsPreviewView(result.body);
      this.updatedAt.previews = new Date();
      this.renderPreviews();
      return this.data.previews;
    }
    const next = securityEventsRows(view, result.body);
    let firstNew = null;
    if (append && previous) {
      const keyOf = (row) => row.key || row.id;
      const known = new Set(previous.items.map(keyOf));
      const added = next.items.filter((row) => !known.has(keyOf(row)));
      firstNew = added[0] ? keyOf(added[0]) : null;
      this.data[view] = { ...next, items: [...previous.items, ...added] };
    } else {
      this.data[view] = next;
    }
    this.updatedAt[view] = new Date();
    if (view === 'alerts') {
      this.setAlertsTab(next.eventsRecorded ? next.openCount : 0);
      securityEventsRenderBanner(this.doc, { openCount: next.eventsRecorded ? next.openCount : 0, locale: this.locale });
    }
    this.render(view);
    if (firstNew) this.focusRow(view, firstNew);
    return this.data[view];
  }

  loadFailed(view, result) {
    const ui = this.ui();
    const host = this.hosts[view];
    if (view === 'alerts') securityEventsRenderBanner(this.doc, { openCount: 0, locale: this.locale });
    if (result && !result.thrown && result.status === 404) {
      this.unavailableOff = true;
      this.data[view] = null;
      host.replaceChildren();
      this.setAlert(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('events.unavailableOff')] }));
      if (view === 'alerts') this.setAlertsTab('—');
      return;
    }
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('events.unavailable') });
    const reload = () => this.load(view, 'refresh');
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.data[view] = null;
      host.replaceChildren(
        mapped.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, reload)
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] }),
      );
      this.setAlert(null);
    } else {
      this.setAlert(ui.ragUiUnavailableAlert(this.doc, this.locale, this.t('events.unavailable'), reload));
      if (this.data[view]) ui.ragUiListBusy(host, true, true);
      else host.replaceChildren();
    }
    if (view === 'alerts' && !this.data.alerts) this.setAlertsTab('—');
    this.announce(mapped.message, true);
  }

  setAlertsTab(n) {
    const tab = this.doc.getElementById('rag-security-events-tab-alerts');
    if (tab) tab.textContent = this.t('tab.alerts', { n: typeof n === 'number' ? this.ui().ragUiFormatNumber(n, this.locale) : n });
  }

  focusRow(view, key) {
    const target = this.hosts[view] ? this.hosts[view].querySelector('[data-security-row-key="' + key + '"]') : null;
    const button = target ? target.querySelector('button') : null;
    const focusable = button || target;
    if (focusable && typeof focusable.focus === 'function') {
      if (!button && target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      focusable.focus();
    }
  }

  render(view) {
    if (view === 'alerts') this.renderAlerts();
    else if (view === 'uploaders') this.renderUploaders();
    else if (view === 'events') this.renderEvents();
  }

  tableRegion(label, table) {
    return this.el(
      'div',
      { className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': label } },
      [table],
    );
  }

  th(text, extra) {
    return this.el('th', { className: 'text-xs font-semibold' + (extra ? ' ' + extra : ''), text, attrs: { scope: 'col' } });
  }

  badge(tone, icon, word, outline) {
    const ui = this.ui();
    return this.el('span', { className: 'badge badge-sm gap-1 shrink-0 h-auto ' + (tone ? 'badge-' + tone : '') + (outline ? ' badge-outline' : '') }, [
      icon ? ui.ragUiIcon(this.doc, icon) : null,
      this.el('span', { text: word }),
    ]);
  }

  uploadsCell(row) {
    if (!row.held) return this.el('span', { text: this.t('uploads.allowed') });
    return this.el('span', { className: 'flex flex-wrap items-center gap-1' }, [
      this.badge('warning', 'pause-circle', this.t('state.held')),
      row.heldSince ? this.el('span', { className: 'text-xs tabular-nums', text: this.t('uploads.heldSince', { date: this.dayText(row.heldSince) }) }) : null,
    ]);
  }

  holdOffLine() {
    return this.el('p', { className: 'text-xs text-base-content/70 min-w-0 break-words', attrs: { 'data-security-hold-off': '' } }, [
      this.el('span', { text: this.t('hold.off') + ' ' }),
      this.settingLink(SECURITY_EVENTS_SETTINGS.hold),
    ]);
  }

  holdButton(target, label) {
    const button = this.el('button', {
      className: 'btn btn-primary md:btn-sm',
      text: this.t('action.hold'),
      attrs: { type: 'button', 'aria-label': this.t('action.hold.aria', { uploader: label }), 'data-security-hold': target.uploader.id },
    });
    button.addEventListener('click', () => this.hold(target, button));
    return button;
  }

  releaseButton(target, label) {
    const button = this.el('button', {
      className: 'btn btn-outline md:btn-sm',
      text: this.t('action.release'),
      attrs: { type: 'button', 'aria-label': this.t('action.release.aria', { uploader: label }), 'data-security-release': target.uploader.id },
    });
    button.addEventListener('click', () => this.release(target, button));
    return button;
  }

  renderAlerts() {
    const data = this.data.alerts;
    const host = this.hosts.alerts;
    if (!data || !host) return;
    if (!data.eventsRecorded) {
      host.replaceChildren(this.eventsOffBlock());
      return;
    }
    const open = data.items.filter((row) => row.status === 'open');
    const acknowledged = data.items.filter((row) => row.status === 'acknowledged');
    const multi = securityEventsMultiWorkspace(data.items);
    const nodes = [this.toolbar('alerts')];
    if (open.length === 0) {
      if (data.alertLevel === 0) {
        nodes.push(
          this.ui().ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('alerts.levelZero')], actions: [this.settingLink(SECURITY_EVENTS_SETTINGS.level)] }),
        );
      } else {
        nodes.push(this.emptyBlock(this.t('alerts.empty.title'), this.t('alerts.empty.body')));
      }
    }
    for (const row of open) nodes.push(this.renderAlert(row, data, multi));
    if (acknowledged.length) nodes.push(this.renderAcknowledged(acknowledged, multi));
    if (data.nextCursor) nodes.push(this.moreButton('alerts', this.t('more.alerts')));
    host.replaceChildren(...nodes);
  }

  renderAlert(row, data, multi) {
    const ui = this.ui();
    const label = securityEventsUploaderLabel(row.uploader, this.locale);
    const actionable = Boolean(row.uploader && row.uploader.actionable);
    let primary = null;
    let holdOff = null;
    if (actionable && row.held) primary = this.releaseButton(row, label);
    else if (actionable && data.holdMode !== 'off') primary = this.holdButton(row, label);
    else if (actionable) holdOff = this.holdOffLine();
    const holdLine = ui.ragUiHoldLine(this.doc, {
      tone: 'warning',
      icon: row.held ? 'pause-circle' : 'exclamation-triangle',
      word: this.t(row.held ? 'state.held' : 'state.open'),
      reason: this.t(row.held ? 'alert.heldSentence' : 'alert.sentence'),
      action: null,
    });
    const badge = holdLine.querySelector('.badge');
    if (badge && row.held) badge.classList.remove('badge-outline');
    if (badge && !row.held) {
      badge.classList.remove('badge-warning');
      badge.classList.add('border-warning', 'text-base-content');
      const icon = badge.querySelector('i');
      if (icon) icon.classList.add('text-warning');
    }
    holdLine.setAttribute('data-security-hold-line', row.held ? 'held' : 'open');
    const fmt = (n) => ui.ragUiFormatNumber(n, this.locale);
    const meta = this.el('ul', { className: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70 mt-2 min-w-0', attrs: { 'data-security-alert-meta': '' } });
    const entry = (nodes) => meta.appendChild(this.el('li', { className: 'min-w-0 tabular-nums [overflow-wrap:anywhere]' }, nodes));
    entry([this.t('meta.events', { n: fmt(row.events) })]);
    entry([this.t('meta.window', { n: fmt(row.windowHours) })]);
    entry([this.t('meta.level', { n: fmt(row.threshold) })]);
    if (multi) entry([this.t('meta.workspace', { name: row.workspace })]);
    entry(this.templateWithNode('meta.opened', 'time', this.timeEl(row.openedAt)));
    const ack = this.el('button', {
      className: 'btn btn-outline md:btn-sm',
      text: this.t('action.acknowledge'),
      attrs: { type: 'button', 'aria-label': this.t('action.acknowledge.aria', { uploader: label }), 'data-security-ack': row.id },
    });
    ack.addEventListener('click', () => this.acknowledge(row, ack));
    const actions = [primary, ack];
    if (row.uploader && row.uploader.actionable) {
      const show = this.el('button', { className: 'btn btn-link md:btn-sm', text: this.t('action.showEvents'), attrs: { type: 'button', 'data-security-show-events': row.uploader.id } });
      show.addEventListener('click', () => this.showEvents({ id: row.uploader.id, label }));
      actions.push(show);
    }
    return this.el('article', { className: 'border border-base-300 rounded-lg p-4 mb-4 min-w-0', attrs: { 'data-security-alert': row.id, 'data-security-row-key': row.id } }, [
      this.el('h4', { className: 'mb-2 break-words' }, [this.uploaderEl(row.uploader, true)]),
      holdLine,
      meta,
      holdOff ? this.el('div', { className: 'mt-2' }, [holdOff]) : null,
      this.el('div', { className: 'flex flex-col md:flex-row md:flex-wrap gap-2 mt-4' }, actions.filter(Boolean)),
    ]);
  }

  renderAcknowledged(rows, multi) {
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('caption.acknowledged') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('col.uploaderName')),
          multi ? this.th(this.t('col.workspace'), 'hidden md:table-cell') : null,
          this.th(this.t('col.events'), 'text-right'),
          this.th(this.t('col.opened'), 'hidden md:table-cell'),
          this.th(this.t('col.uploads')),
        ]),
      ]),
      this.el(
        'tbody',
        {},
        rows.map((row) =>
          this.el('tr', { attrs: { 'data-security-acknowledged-row': row.id } }, [
            this.el('th', { className: 'font-normal min-w-0 max-w-xs', attrs: { scope: 'row' } }, [this.uploaderEl(row.uploader)]),
            multi ? this.el('td', { className: 'hidden md:table-cell' }, [this.workspaceEl(row)]) : null,
            this.el('td', { className: 'text-right tabular-nums', text: this.ui().ragUiFormatNumber(row.events, this.locale) }),
            this.el('td', { className: 'hidden md:table-cell' }, [this.timeEl(row.openedAt)]),
            this.el('td', {}, [this.uploadsCell(row)]),
          ]),
        ),
      ),
    ]);
    return this.el('details', { className: 'mt-4 min-w-0', attrs: { 'data-security-acknowledged': '' } }, [
      this.el('summary', { className: 'cursor-pointer text-sm font-semibold', text: this.t('alerts.acknowledged', { n: this.ui().ragUiFormatNumber(rows.length, this.locale) }) }),
      this.el('div', { className: 'mt-2' }, [this.tableRegion(this.t('caption.acknowledged'), table)]),
    ]);
  }

  renderUploaders() {
    const data = this.data.uploaders;
    const host = this.hosts.uploaders;
    if (!data || !host) return;
    if (!data.eventsRecorded) {
      host.replaceChildren(this.eventsOffBlock());
      return;
    }
    const nodes = [this.toolbar('uploaders')];
    if (!data.items.length) {
      nodes.push(this.emptyBlock(null, this.t('uploaders.empty')));
      host.replaceChildren(...nodes);
      return;
    }
    const multi = securityEventsMultiWorkspace(data.items);
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('caption.uploaders') }),
      this.el('thead', { className: 'hidden md:table-header-group' }, [
        this.el('tr', {}, [
          this.th(this.t('col.uploaderName')),
          multi ? this.th(this.t('col.workspace')) : null,
          this.th(this.t('col.events'), 'text-right'),
          this.th(this.t('col.last'), 'hidden lg:table-cell'),
          this.th(this.t('col.uploads')),
          this.th(this.t('col.actions')),
        ]),
      ]),
      this.el('tbody', {}, data.items.map((row) => this.renderUploaderRow(row, data, multi))),
    ]);
    nodes.push(this.tableRegion(this.t('caption.uploaders'), table));
    if (data.nextCursor) nodes.push(this.moreButton('uploaders', this.t('more.uploaders')));
    host.replaceChildren(...nodes);
  }

  renderUploaderRow(row, data, multi) {
    const label = securityEventsUploaderLabel(row.uploader, this.locale);
    let action = null;
    if (row.uploader.actionable && row.held) action = this.releaseButton(row, label);
    else if (row.uploader.actionable && data.holdMode !== 'off') action = this.holdButton(row, label);
    const cell = 'block md:table-cell align-top';
    return this.el('tr', { className: 'flex flex-col md:table-row border-t border-base-300 md:border-t-0', attrs: { 'data-security-uploader-row': row.uploader.id, 'data-security-row-key': row.key } }, [
      this.el('th', { className: cell + ' font-normal min-w-0 md:max-w-xs', attrs: { scope: 'row' } }, [this.uploaderEl(row.uploader)]),
      multi ? this.el('td', { className: cell }, [this.workspaceEl(row)]) : null,
      this.el('td', { className: cell + ' md:text-right tabular-nums', text: this.ui().ragUiFormatNumber(row.events, this.locale) }),
      this.el('td', { className: 'hidden lg:table-cell align-top' }, [this.timeEl(row.lastEventAt)]),
      this.el('td', { className: cell }, [this.uploadsCell(row)]),
      this.el('td', { className: cell + ' pt-0 md:pt-2' }, action ? [action] : []),
    ]);
  }

  filterSelect(id, labelKey, options, value, onChange) {
    const select = this.el('select', { className: 'select select-bordered select-sm w-full', id });
    for (const option of options) {
      const el = this.el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === value) el.setAttribute('selected', '');
      select.appendChild(el);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return this.el('div', { className: 'form-control min-w-0 w-full sm:w-auto' }, [
      this.el('label', { className: 'label py-1', attrs: { for: id } }, [this.el('span', { className: 'label-text text-xs', text: this.t(labelKey) })]),
      select,
    ]);
  }

  eventFilters() {
    const sources = [{ value: '', label: this.t('filter.allChecks') }, ...SECURITY_EVENTS_SOURCES.map((s) => ({ value: s, label: this.t('source.' + s) }))];
    const periods = Object.keys(SECURITY_EVENTS_PERIODS).map((p) => ({ value: p, label: this.t('period.' + p) }));
    const nodes = [
      this.filterSelect('rag-security-events-filter-check', 'filter.check', sources, this.filters.source, (value) => {
        this.filters.source = SECURITY_EVENTS_SOURCES.includes(value) ? value : '';
        this.load('events', 'refresh');
      }),
      this.filterSelect('rag-security-events-filter-period', 'filter.period', periods, this.filters.period, (value) => {
        this.filters.period = Object.prototype.hasOwnProperty.call(SECURITY_EVENTS_PERIODS, value) ? value : 'day';
        this.load('events', 'refresh');
      }),
    ];
    return this.el('div', { className: 'flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-2 min-w-0' }, nodes);
  }

  uploaderFilterLine() {
    if (!this.filters.uploader) return null;
    const clear = this.el('button', { className: 'btn btn-ghost btn-sm', text: this.t('filter.clearUploader'), attrs: { type: 'button', 'data-security-clear-uploader': '' } });
    clear.addEventListener('click', () => {
      this.filters.uploader = null;
      this.load('events', 'refresh');
    });
    return this.el('div', { className: 'flex flex-wrap items-center gap-2 mb-4 min-w-0', attrs: { 'data-security-uploader-filter': this.filters.uploader.id } }, [
      this.el('span', { className: 'text-sm min-w-0 [overflow-wrap:anywhere]', text: this.t('filter.uploader', { name: this.filters.uploader.label }) }),
      clear,
    ]);
  }

  sourceBadge(row) {
    const ui = this.ui();
    if (!row.sourceKnown) return ui.ragUiCodeSentence(this.doc, this.locale, row.source, this.t('code.unknown'));
    return this.el('span', { className: 'badge badge-outline badge-sm gap-1 h-auto text-left' }, [
      ui.ragUiIcon(this.doc, SECURITY_EVENTS_SOURCE_ICONS[row.source]),
      this.el('span', { text: this.t('source.' + row.source) }),
    ]);
  }

  resultEl(row) {
    if (!row.actionKnown) return this.ui().ragUiCodeSentence(this.doc, this.locale, row.action, this.t('code.unknown'));
    return this.el('span', { text: this.t('result.' + row.action) });
  }

  documentEl(row) {
    if (row.document.kind === 'file') return this.el('span', { className: '[overflow-wrap:anywhere]', text: row.document.name });
    return this.el('span', { className: 'text-base-content/70', text: this.t(row.document.kind === 'removed' ? 'doc.removed' : 'doc.none') });
  }

  renderEvents() {
    const data = this.data.events;
    const host = this.hosts.events;
    if (!data || !host) return;
    if (!data.eventsRecorded) {
      host.replaceChildren(this.eventsOffBlock());
      return;
    }
    const nodes = [this.toolbar('events', [this.eventFilters()])];
    const filterLine = this.uploaderFilterLine();
    if (filterLine) nodes.push(filterLine);
    if (!data.items.length) {
      nodes.push(this.emptyBlock(this.t('events.empty.title'), this.t('events.empty.body')));
      host.replaceChildren(...nodes);
      return;
    }
    const multi = securityEventsMultiWorkspace(data.items);
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('caption.events') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('col.time')),
          multi ? this.th(this.t('col.workspace'), 'hidden md:table-cell') : null,
          this.th(this.t('col.check')),
          this.th(this.t('col.result')),
          this.th(this.t('col.document'), 'hidden md:table-cell'),
          this.th(this.t('col.uploader'), 'hidden md:table-cell'),
          this.th(this.t('col.rules'), 'hidden lg:table-cell'),
        ]),
      ]),
      this.el('tbody', {}, data.items.map((row) => this.renderEventRow(row, multi))),
    ]);
    nodes.push(this.tableRegion(this.t('caption.events'), table));
    if (data.nextCursor) nodes.push(this.moreButton('events', this.t('more.events')));
    host.replaceChildren(...nodes);
  }

  renderEventRow(row, multi) {
    const rules = row.rules.length
      ? this.el('span', { className: 'font-mono text-xs break-all', text: row.rules.join(', '), attrs: { translate: 'no' } })
      : this.el('span', { text: '—' });
    return this.el('tr', { attrs: { 'data-security-event-row': row.id, 'data-security-row-key': row.id } }, [
      this.el('td', { className: 'align-top whitespace-nowrap' }, [this.timeEl(row.createdAt)]),
      multi ? this.el('td', { className: 'align-top hidden md:table-cell' }, [this.workspaceEl(row)]) : null,
      this.el('td', { className: 'align-top min-w-0' }, [
        this.sourceBadge(row),
        this.el('span', { className: 'md:hidden mt-1 flex flex-col gap-1 text-xs text-base-content/70 min-w-0' }, [this.documentEl(row), this.uploaderEl(row.uploader)]),
      ]),
      this.el('td', { className: 'align-top' }, [this.resultEl(row)]),
      this.el('td', { className: 'align-top hidden md:table-cell min-w-0 max-w-xs' }, [this.documentEl(row)]),
      this.el('td', { className: 'align-top hidden md:table-cell min-w-0 max-w-xs' }, [this.uploaderEl(row.uploader)]),
      this.el('td', { className: 'align-top hidden lg:table-cell min-w-0 max-w-xs' }, [rules]),
    ]);
  }

  hostList(hosts) {
    return this.el(
      'ul',
      { className: 'mt-2 flex flex-col gap-1 min-w-0', attrs: { 'data-security-preview-hosts': '' } },
      hosts.map((host) => this.el('li', { className: 'min-w-0' }, [this.codeEl(host)])),
    );
  }

  renderPreviews() {
    const data = this.data.previews;
    const host = this.hosts.previews;
    if (!data || !host) return;
    const ui = this.ui();
    const ok = (key) => this.el('p', { className: 'text-sm flex items-start gap-2' }, [ui.ragUiIcon(this.doc, 'check-circle', 'text-success mt-0.5'), this.el('span', { text: this.t(key) })]);
    let block;
    if (data.state === 'none') block = [ok('preview.none')];
    else if (data.state === 'subset') block = [ok('preview.subset'), this.hostList(data.hosts)];
    else if (data.state === 'mismatch') {
      block = [
        ui.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          body: [
            this.t('preview.mismatch'),
            this.hostList(data.notAllowed),
            this.el('p', { className: 'text-sm mt-2' }, ui.ragUiTemplateNodes(this.doc, this.t('preview.fix'), { variable: SECURITY_EVENTS_PREVIEW_VARIABLE }, ['variable'])),
          ],
        }),
      ];
    } else block = [this.el('p', { className: 'text-sm text-base-content/70', text: this.t('preview.unknown') })];
    host.replaceChildren(
      this.toolbar('previews'),
      this.el('div', { className: 'min-w-0 max-w-prose', attrs: { 'data-security-previews-state': data.state } }, block),
      this.el('p', { className: 'text-xs text-base-content/70 mt-4 max-w-prose', text: this.t('preview.forced') }),
    );
  }

  showEvents(uploader) {
    this.filters.uploader = { id: uploader.id, label: uploader.label };
    if (this.tabs.current() === 'events') return this.load('events', 'refresh');
    this.tabs.select('events');
    return null;
  }

  /** After an action: the lists that show the uploader or alert reload; the banner follows the alerts answer. */
  async reloadAfterAction() {
    const work = [this.load('alerts', 'action')];
    if (this.data.uploaders || (this.tabs && this.tabs.current() === 'uploaders')) work.push(this.load('uploaders', 'action'));
    await Promise.all(work);
  }

  /** UI-SPEC 8.2 for the three actions. Returns the sentence shown, or null when the panel already handled the reload. */
  actionMessage(result) {
    const ui = this.ui();
    const body = result && result.body && typeof result.body === 'object' ? result.body : {};
    if (!result || result.thrown) return { key: 'outcome', message: this.t('error.outcomeUnknown'), reload: true };
    if (result.status === 409 && body.error === 'hold_disabled') return { key: 'holdOff', message: this.t('hold.off'), reload: true };
    if (result.status === 404 || (result.status === 409 && SECURITY_EVENTS_CHANGED.has(body.error))) {
      return { key: 'changed', message: ui.ragUiLabel('error.changed', this.locale), reload: true };
    }
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('events.unavailable') });
    return { key: mapped.kind, message: mapped.message, reload: false, field: mapped.field };
  }

  hold(target, opener) {
    const ui = this.ui();
    const label = securityEventsUploaderLabel(target.uploader, this.locale);
    const fieldId = ui.ragUiNextId('rag-security-events-hold-reason');
    const input = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: fieldId,
      attrs: { type: 'text', maxlength: String(SECURITY_EVENTS_REASON_MAX), autocomplete: 'off', name: 'security-hold-reason', 'data-security-hold-reason': '' },
    });
    const field = this.el('div', { className: 'form-control mt-4 min-w-0' }, [
      this.el('label', { className: 'label py-1', attrs: { for: fieldId } }, [this.el('span', { className: 'label-text', text: this.t('hold.reason') })]),
      input,
    ]);
    let outcome = null;
    const send = async () => {
      const reason = String(input.value || '').trim().slice(0, SECURITY_EVENTS_REASON_MAX);
      const result = await ui.ragUiRagRequest(SECURITY_EVENTS_PATHS.uploaders + '/' + encodeURIComponent(target.uploader.id) + '/hold', {
        method: 'POST',
        body: JSON.stringify({ tenantKey: target.tenantKey, reason: reason || null }),
      });
      if (result && result.ok) {
        outcome = { message: this.t('hold.done', { uploader: label }), error: false };
        return true;
      }
      const mapped = this.actionMessage(result);
      if (mapped.reload) {
        outcome = { message: mapped.message, error: true };
        return true;
      }
      if (mapped.key === 'invalid') {
        input.setAttribute('aria-invalid', 'true');
        input.classList.add('input-error');
        return { keepOpen: true, message: mapped.message, focus: input };
      }
      return { keepOpen: true, message: this.t('error.holdFailed') };
    };
    return ui
      .ragUiConfirmDialog(this.doc, {
        title: this.t('hold.title', { uploader: label }),
        body: [this.t('hold.body'), field],
        keepLabel: this.t('hold.keep'),
        confirmLabel: this.t('action.hold'),
        runningLabel: this.t('hold.running'),
        opener,
        fallbackFocus: this.heading(),
        onConfirm: send,
      })
      .then(async () => {
        if (!outcome) return;
        await this.reloadAfterAction();
        this.announce(outcome.message, outcome.error);
      });
  }

  async release(target, button) {
    const ui = this.ui();
    const label = securityEventsUploaderLabel(target.uploader, this.locale);
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('release.running'));
    let result;
    try {
      result = await ui.ragUiRagRequest(SECURITY_EVENTS_PATHS.uploaders + '/' + encodeURIComponent(target.uploader.id) + '/release', {
        method: 'POST',
        body: JSON.stringify({ tenantKey: target.tenantKey }),
      });
    } finally {
      if (button.isConnected !== false) restore();
    }
    await this.finishAction(result, this.t('release.done', { uploader: label }));
  }

  async acknowledge(row, button) {
    const ui = this.ui();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('acknowledge.running'));
    let result;
    try {
      result = await ui.ragUiRagRequest(SECURITY_EVENTS_PATHS.alerts + '/' + encodeURIComponent(row.id) + '/acknowledge', { method: 'POST' });
    } finally {
      if (button.isConnected !== false) restore();
    }
    await this.finishAction(result, this.t('acknowledge.done'));
  }

  async finishAction(result, doneText) {
    if (result && result.ok) {
      await this.reloadAfterAction();
      this.announce(doneText);
      this.focusAfterAction();
      return;
    }
    const mapped = this.actionMessage(result);
    if (mapped.reload) await this.reloadAfterAction();
    this.announce(mapped.message, true);
    this.focusAfterAction();
  }

  /** The acting row may be gone after the reload: focus the status line so keyboard users keep their place. */
  focusAfterAction() {
    const status = this.statusEl();
    if (status && typeof status.focus === 'function') status.focus();
  }
}

/** The page banner (UI-SPEC 6.13.1): rendered or removed; not dismissible, no alert role. */
function securityEventsRenderBanner(doc, { openCount, locale }) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const host = d ? d.getElementById('rag-security-alert-banner') : null;
  if (!host) return null;
  const n = securityEventsCount(openCount);
  if (n === 0) {
    host.replaceChildren();
    host.className = '';
    return null;
  }
  const ui = securityEventsUiLib();
  const loc = locale || ui.ragUiBrowserLocale();
  const review = ui.ragUiEl(d, 'button', { className: 'btn btn-sm', text: securityEventsLabel('banner.action', loc), attrs: { type: 'button', 'data-security-banner-review': '' } });
  review.addEventListener('click', () => securityEventsReviewAlerts());
  const banner = ui.ragUiAlert(d, {
    tone: 'warning',
    icon: 'shield-exclamation',
    title: securityEventsLabel('banner.title', loc, { n: ui.ragUiFormatNumber(n, loc) }),
    body: [securityEventsLabel('banner.body', loc)],
    actions: [review],
    className: 'mb-6',
  });
  banner.setAttribute('data-security-banner', '');
  banner.setAttribute('lang', loc);
  host.replaceChildren(banner);
  return banner;
}

/** DOMContentLoaded: the alerts call decides the banner. 401, 403, 404, events off and failures render nothing. */
async function renderSecurityAlertBanner() {
  if (typeof document === 'undefined') return null;
  const ui = securityEventsUiLib();
  if (!document.getElementById('rag-security-alert-banner')) return null;
  const result = await ui.ragUiRagRequest(SECURITY_EVENTS_PATHS.alerts, { method: 'GET' });
  if (!result || !result.ok || !result.body || typeof result.body !== 'object') {
    securityEventsRenderBanner(document, { openCount: 0 });
    return null;
  }
  const rows = securityEventsRows('alerts', result.body);
  return securityEventsRenderBanner(document, { openCount: rows.eventsRecorded ? rows.openCount : 0 });
}

/** Review alerts: activates RAG administration, scrolls to the panel, selects Alerts and focuses its heading. */
async function securityEventsReviewAlerts() {
  return openSecurityEvents({ tab: 'alerts' });
}

/** Opens the panel from anywhere on the page (banner, Quarantine, the injection-defense card). */
async function openSecurityEvents(options) {
  if (typeof document === 'undefined') return null;
  securityEventsActivateTab(document, 'rag-administration');
  const started = initSecurityEventsPanel();
  if (started && typeof started.then === 'function') await started;
  if (securityEventsPanelInstance) await securityEventsPanelInstance.open(options || {});
  return securityEventsPanelInstance;
}

function renderSecurityAlerts(panel) {
  panel.renderAlerts();
}

function renderSecurityUploaders(panel) {
  panel.renderUploaders();
}

function renderSecurityEvents(panel) {
  panel.renderEvents();
}

function renderLinkPreviews(panel) {
  panel.renderPreviews();
}

/** Idempotent mount (UI-SPEC 6.11): the first call builds and loads, later calls reload the visible view. */
function initSecurityEventsPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-security-events');
  if (!root) return null;
  if (!securityEventsPanelInstance) {
    securityEventsPanelInstance = new SecurityEventsPanel(root);
    if (typeof window !== 'undefined') window.securityEventsPanel = securityEventsPanelInstance;
    return securityEventsPanelInstance.mount();
  }
  return securityEventsPanelInstance.refresh();
}

function securityEventsBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-security-events-bound')) return;
    link.setAttribute('data-security-events-bound', '1');
    link.addEventListener('click', () => initSecurityEventsPanel());
  });
}

if (typeof window !== 'undefined') {
  window.SECURITY_EVENTS_LABELS = SECURITY_EVENTS_LABELS;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initSecurityEventsPanel = initSecurityEventsPanel;
  window.openSecurityEvents = openSecurityEvents;
  window.renderSecurityAlertBanner = renderSecurityAlertBanner;
  securityEventsBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    securityEventsBindPanel();
    void renderSecurityAlertBanner();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initSecurityEventsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SECURITY_EVENTS_LABELS,
    SECURITY_EVENTS_PATHS,
    securityEventsLabel,
    securityEventsRows,
    securityEventsPreviewView,
    securityEventsSince,
    securityEventsMultiWorkspace,
    securityEventsRenderBanner,
    renderSecurityAlerts,
    renderSecurityUploaders,
    renderSecurityEvents,
    renderLinkPreviews,
    renderSecurityAlertBanner,
    openSecurityEvents,
    SecurityEventsPanel,
    initSecurityEventsPanel,
  };
}
