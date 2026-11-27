/**
 * Monitoring panel (OBS-03, D-20 to D-27; UI-SPEC 6.7, 6.12 and 12.4): the summary of the daily monitor, the Alerts view (entries with
 * evidence, Acknowledge alert, Resolve alert, Run monitor now) and its Settings (the monitor group of #rag-phase053-settings, with Remove
 * webhook). The Test set coverage sub-view is a host filled by plan 05.3-45. Alerts carry ids, codes and counts only: no question,
 * answer, chunk or document text, no override reason, no full hash, no dedup key and no raw breakdown JSON; the webhook URL and secret are
 * never read back. With RAG_MONITOR off nothing is requested. DOM through the gates-ui helpers (cuiEl, createElement, textContent).
 */

const MONITOR_GATES =
  typeof gatesUiMessageFrom === 'function'
    ? {
        GATES_UI_LABELS,
        gatesUiMessageFrom,
        gatesUiMessage,
        gatesUiLabel,
        gatesUiLocale,
        gatesUiNumber,
        gatesUiPercent,
        gatesUiScore,
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
        gatesUiErrorAlert,
        gatesUiMapError,
        gatesUiFetch,
        gatesUiSubTabs,
        gatesUiConfirm,
      }
    : require('./gates-ui.js');

const MONITOR_ALERTS_API = '/api/rag/admin/monitor/alerts';
const MONITOR_RUN_API = '/api/rag/admin/monitor/run';
const MONITOR_CONFIG_API = '/api/config';
const MONITOR_WEBHOOK_NAME = 'RAG_MONITOR_WEBHOOK_URL';
const MONITOR_TABS = ['alerts', 'coverage', 'settings'];
const MONITOR_FILTERS = ['active', 'resolved', 'all'];
const MONITOR_PAGE_SIZE = 20;
const MONITOR_MAX_TRACES = 10;
/** A run reads the log and writes counts and alerts; it gets longer than the 15-second default (UI-SPEC 6.1 exceptions). */
const MONITOR_RUN_TIMEOUT_MS = 60000;
const MONITOR_RECORD_CHANGE_COMMAND = 'npm run rag:monitor -- record-change --keys <names> --reason <text>';
const MONITOR_REFUSAL_COMMAND = 'python -m rag_eval.calibrate refusal';
const MONITOR_RATE_RULES = [
  'refusal_rate',
  'zero_result_rate',
  'below_threshold_rate',
  'not_helpful_rate',
  'groundedness_flagged_rate',
  'kb_error_rate',
  'kb_degraded_rate',
  'kb_unavailable_rate',
];
/** Rule id to label key (UI-SPEC 12.4); the PSI rule is named by what it measures. Any other id is shown in code. */
const MONITOR_RULE_KEYS = {
  ...Object.fromEntries(MONITOR_RATE_RULES.map((rule) => [rule, 'rule.' + rule])),
  top_score_psi: 'rule.top_score_shift',
  latency_p95: 'rule.latency_p95',
  online_judge_mean: 'rule.online_judge_mean',
  test_set_not_representative: 'rule.test_set_not_representative',
};
const MONITOR_BREAKDOWN_DIMENSIONS = [
  { field: 'by_mode', key: 'breakdown.mode' },
  { field: 'by_channel', key: 'breakdown.channel' },
  { field: 'by_doc_type', key: 'breakdown.docType' },
];

const MONITOR_LABELS = {
  en: {
    "panel.title": "Monitoring",
    "panel.description": "Once a day, refusals, empty searches, votes, judge scores, knowledge-base failures and latency are compared with the 30 days before. A value outside its usual range raises an alert. Alerts hold counts and ids, never question or answer text.",
    "panel.tabsLabel": "Monitoring views",
    "tab.alerts": "Alerts",
    "tab.coverage": "Test set coverage",
    "tab.settings": "Settings",
    "summary.state": "Daily monitoring",
    "summary.lastRun": "Last run",
    "summary.never": "Not run yet",
    "summary.log": "Retrieval log",
    "summary.groups": "Groups checked",
    "summary.thin": "Groups with too little data",
    "action.refresh": "Refresh alerts",
    "action.run": "Run monitor now",
    "action.more": "Load more alerts",
    "alerts.loading": "Loading alerts…",
    "alerts.loaded": "Alerts loaded. Open: {open}. Acknowledged: {acknowledged}.",
    "run.running": "Running the monitor…",
    "run.done": "Monitor finished. Days added: {days}. Alerts opened: {opened}. Alerts updated: {updated}.",
    "run.failed": "The monitor did not finish. Nothing was changed by this run. Select Run monitor now again in a moment.",
    "off.title": "Monitoring is off",
    "off.body": "Nothing is measured and no alert is raised. To start, set Daily monitoring to On under Settings and save. Monitoring reads the retrieval log, which must be at the level ids or masked_query.",
    "needsLog": "The retrieval log is off, so the monitor has nothing to read and writes nothing. Set {variable} to ids or masked_query.",
    "filter.legend": "Show alerts",
    "filter.active": "Open and acknowledged",
    "filter.resolved": "Resolved",
    "filter.all": "All",
    "filter.workspace": "Workspace",
    "filter.allWorkspaces": "All workspaces",
    "alerts.empty.title": "No open alerts",
    "alerts.empty.body": "Every measured value is inside its usual range, or there is too little data to tell. Groups with too little data: {count}.",
    "alerts.empty.neverRan": "The monitor has not run yet. It runs once a day, or now with Run monitor now.",
    "alerts.empty.filtered": "No alerts match this filter.",
    "severity.alert": "Alert",
    "severity.warning": "Warning",
    "status.open": "Open",
    "status.acknowledged": "Acknowledged {date}",
    "status.resolved": "Resolved {date}",
    "rule.refusal_rate": "Refusal rate",
    "rule.zero_result_rate": "Searches with no result",
    "rule.below_threshold_rate": "Searches below the threshold",
    "rule.not_helpful_rate": "Not-helpful votes",
    "rule.groundedness_flagged_rate": "Answers flagged as unsupported",
    "rule.kb_error_rate": "Knowledge-base errors",
    "rule.kb_degraded_rate": "Knowledge base degraded",
    "rule.kb_unavailable_rate": "“Knowledge base unavailable” messages",
    "rule.top_score_shift": "Top score distribution",
    "rule.latency_p95": "Latency (p95)",
    "rule.online_judge_mean": "Online judge score",
    "rule.test_set_not_representative": "Test set no longer representative",
    "alert.meta.language": "Language: {language}",
    "alert.meta.allLanguages": "Language: all",
    "alert.meta.day": "Day: {day}",
    "alert.meta.window": "Window: {days} days ending {day}",
    "measure.rate": "Measured: {rate} ({count} of {total}). Usual: {baseRate} ({baseCount} of {baseTotal}, the 30 days before).",
    "measure.distribution": "Shift (PSI): {value}. Limits: warning {warn}, alert {alert}.",
    "measure.latency": "p95: {value} ms. Usual: {base} ms. Budget: {budget} ms.",
    "measure.score": "Mean score: {value} (n = {n}). Usual: {base}.",
    "measure.drift": "Difference from real questions: {value}. Topic groups: {ids}.",
    "measure.generic": "Measured: {value}. Usual: {base}.",
    "measure.crossed": "Crossed:",
    "measure.crossed.ratio": "{ratio} times the usual value (limit {limit})",
    "measure.crossed.delta": "changed by {delta} points (limit {limit})",
    "measure.crossed.z": "z-score {z} (limit {limit})",
    "measure.crossed.drop": "dropped by {drop} (limit {limit})",
    "evidence.show": "Show evidence",
    "evidence.breakdown": "Where it happened",
    "breakdown.mode": "RAG mode",
    "breakdown.channel": "Channel",
    "breakdown.docType": "Document type",
    "breakdown.unknownType": "Type no longer known",
    "breakdown.col.requests": "Requests",
    "breakdown.col.count": "Count",
    "breakdown.col.rate": "Rate",
    "evidence.companions": "Other measures for the same group",
    "companions.col.measure": "Measure",
    "companions.col.usual": "Usual",
    "evidence.changes": "Setting changes in this window",
    "changes.col.when": "When",
    "changes.col.source": "Made through",
    "changes.col.keys": "Changed settings",
    "changes.col.config": "Configuration",
    "changes.col.record": "Record",
    "changes.hashPair": "{before} to {after}",
    "changes.source.config_ui": "Config UI",
    "changes.source.cli": "Command line",
    "changes.source.release_override": "Release, with a reason",
    "changes.source.local_prerelease": "Pre-release run",
    "changes.source.profile_activation": "Profile activation",
    "changes.none": "No setting change is recorded in this window.",
    "changes.unrecorded": "The configuration changed, but no change was recorded. If it was changed in the host’s environment settings, record it with {command}.",
    "evidence.traces": "Sample traces: {count}",
    "traces.none": "No sample trace is attached to this alert.",
    "traces.openAria": "Open trace {id} in a new tab",
    "action.copyIds": "Copy trace ids",
    "copy.done": "Trace ids copied.",
    "evidence.suggestion": "Suggested next step",
    "suggestion.recalibrate_refusal": "The score distribution moved, so the refusal thresholds may no longer fit. Run {command}, then check Refusal calibration.",
    "suggestion.sample_under_covered": "The next weekly sample draws from the under-covered topic groups. See Test set coverage.",
    "suggestion.other": "Suggestion code: {code}.",
    "evidence.delivery": "Where this alert was sent",
    "channel.banner": "Config UI banner",
    "channel.webhook": "Admin webhook",
    "channel.langfuse": "Langfuse score on the sample traces",
    "delivery.delivered": "Delivered {time}",
    "delivery.pending": "Not delivered yet. It is tried again on the next run.",
    "delivery.notConfigured": "Not set up",
    "action.ack": "Acknowledge alert",
    "action.ackAria": "Acknowledge alert: {measure}, {language}",
    "action.resolve": "Resolve alert",
    "action.resolveAria": "Resolve alert: {measure}, {language}",
    "ack.done": "Alert acknowledged. It leaves the banner and stays in this list until it is resolved.",
    "confirm.resolve.title": "Resolve this alert?",
    "confirm.resolve.body": "{measure}, {language}. A resolved alert is closed for good. If the value leaves its usual range again, a new alert opens.",
    "confirm.resolve.keep": "Keep alert open",
    "resolve.done": "Alert resolved.",
    "error.alertGone": "This alert changed since the list was loaded. The list has been reloaded.",
    "settings.monitor.label": "Daily monitoring",
    "settings.monitor.help": "Off: nothing runs and nothing is stored.",
    "settings.webhook.label": "Admin webhook URL",
    "settings.webhook.help": "Optional. Each alert is posted here as JSON with counts and ids. HTTPS only.",
    "settings.webhook.state": "Webhook: {state}",
    "settings.webhook.stateSet": "set",
    "settings.webhook.stateUnset": "not set",
    "settings.webhook.set": "A webhook URL is stored and is not shown. Enter a new one to replace it, or leave empty to keep it.",
    "action.removeWebhook": "Remove webhook",
    "confirm.webhook.title": "Remove the webhook?",
    "confirm.webhook.body": "Alerts will no longer be sent to the admin channel. The banner and the alert list keep working.",
    "confirm.webhook.keep": "Keep webhook",
    "webhook.removed": "Webhook removed.",
    "webhook.removeFailed": "The webhook was not removed: the config server did not answer. Try again in a moment.",
    "settings.secret.label": "Webhook signing secret",
    "settings.secret.help": "Optional. At least 32 characters. When set, each delivery is signed with HMAC-SHA256.",
    "warn.monitorNeedsLog": "Monitoring is on, but the retrieval log is off. The monitor will write nothing until the log is at the level ids or masked_query.",
    "warn.webhookHttps": "The webhook URL must start with https://.",
    "action.refreshCoverage": "Refresh coverage",
    "count.item": "{label}: {value}",
    "status.acknowledged.plain": "Acknowledged",
    "status.resolved.plain": "Resolved",
    "measure.latency.noBudget": "p95: {value} ms. Usual: {base} ms.",
    "measure.generic.value": "Measured: {value}.",
    "measure.crossed.separator": "; ",
    "value.ms": "{value} ms",
    "alerts.listLabel": "Monitoring alerts",
    "settings.webhook.removeHint": "Removing takes effect at once; it does not wait for Save All Changes.",
  },
  zh: {
    "panel.title": "监控",
    "panel.description": "每天一次，将拒答、空检索、投票、评判分数、知识库故障和延迟与此前 30 天比较。超出通常范围的数值会触发告警。告警只包含计数和 ID，不包含问题或回答文本。",
    "panel.tabsLabel": "监控视图",
    "tab.alerts": "告警",
    "tab.coverage": "测试集覆盖",
    "tab.settings": "设置",
    "summary.state": "每日监控",
    "summary.lastRun": "最近一次运行",
    "summary.never": "尚未运行",
    "summary.log": "检索日志",
    "summary.groups": "已检查的分组",
    "summary.thin": "数据不足的分组",
    "action.refresh": "刷新告警",
    "action.run": "立即运行监控",
    "action.more": "加载更多告警",
    "alerts.loading": "正在加载告警…",
    "alerts.loaded": "告警已加载。未处理：{open}。已确认：{acknowledged}。",
    "run.running": "正在运行监控…",
    "run.done": "监控已完成。新增天数：{days}。新开告警：{opened}。更新告警：{updated}。",
    "run.failed": "监控没有完成，本次运行未做任何更改。请稍后再次点击“立即运行监控”。",
    "off.title": "监控已关闭",
    "off.body": "当前不做任何测量，也不会触发告警。要开始使用，请在“设置”中将“每日监控”设为开启并保存。监控读取检索日志，日志级别需为 ids 或 masked_query。",
    "needsLog": "检索日志已关闭，监控没有可读取的数据，也不会写入任何内容。请将 {variable} 设为 ids 或 masked_query。",
    "filter.legend": "显示告警",
    "filter.active": "未处理和已确认",
    "filter.resolved": "已解决",
    "filter.all": "全部",
    "filter.workspace": "工作区",
    "filter.allWorkspaces": "所有工作区",
    "alerts.empty.title": "没有未处理的告警",
    "alerts.empty.body": "所有测量值都在通常范围内，或数据不足以判断。数据不足的分组：{count}。",
    "alerts.empty.neverRan": "监控尚未运行。它每天运行一次，也可以点击“立即运行监控”。",
    "alerts.empty.filtered": "没有符合此筛选条件的告警。",
    "severity.alert": "告警",
    "severity.warning": "提醒",
    "status.open": "未处理",
    "status.acknowledged": "已确认 {date}",
    "status.resolved": "已解决 {date}",
    "rule.refusal_rate": "拒答率",
    "rule.zero_result_rate": "无结果检索率",
    "rule.below_threshold_rate": "低于阈值的检索率",
    "rule.not_helpful_rate": "“没有帮助”投票率",
    "rule.groundedness_flagged_rate": "被标记为缺乏依据的回答",
    "rule.kb_error_rate": "知识库错误",
    "rule.kb_degraded_rate": "知识库降级",
    "rule.kb_unavailable_rate": "“知识库暂时不可用”消息",
    "rule.top_score_shift": "最高分分布",
    "rule.latency_p95": "延迟（p95）",
    "rule.online_judge_mean": "在线评判分数",
    "rule.test_set_not_representative": "测试集已不具代表性",
    "alert.meta.language": "语言：{language}",
    "alert.meta.allLanguages": "语言：全部",
    "alert.meta.day": "日期：{day}",
    "alert.meta.window": "窗口：截至 {day} 的 {days} 天",
    "measure.rate": "实测：{rate}（{total} 个中的 {count} 个）。通常：{baseRate}（此前 30 天，{baseTotal} 个中的 {baseCount} 个）。",
    "measure.distribution": "偏移（PSI）：{value}。限值：提醒 {warn}，告警 {alert}。",
    "measure.latency": "p95：{value} 毫秒。通常：{base} 毫秒。预算：{budget} 毫秒。",
    "measure.score": "平均分：{value}（n = {n}）。通常：{base}。",
    "measure.drift": "与真实问题的差异：{value}。主题分组：{ids}。",
    "measure.generic": "实测：{value}。通常：{base}。",
    "measure.crossed": "超出：",
    "measure.crossed.ratio": "为通常值的 {ratio} 倍（限值 {limit}）",
    "measure.crossed.delta": "变化 {delta} 个百分点（限值 {limit}）",
    "measure.crossed.z": "z 值 {z}（限值 {limit}）",
    "measure.crossed.drop": "下降 {drop}（限值 {limit}）",
    "evidence.show": "显示依据",
    "evidence.breakdown": "发生在哪里",
    "breakdown.mode": "RAG 模式",
    "breakdown.channel": "渠道",
    "breakdown.docType": "文档类型",
    "breakdown.unknownType": "类型已无法确定",
    "breakdown.col.requests": "请求数",
    "breakdown.col.count": "计数",
    "breakdown.col.rate": "比率",
    "evidence.companions": "同一分组的其他指标",
    "companions.col.measure": "指标",
    "companions.col.usual": "通常",
    "evidence.changes": "此窗口内的设置更改",
    "changes.col.when": "时间",
    "changes.col.source": "更改途径",
    "changes.col.keys": "已更改的设置",
    "changes.col.config": "配置",
    "changes.col.record": "记录",
    "changes.hashPair": "{before} 变为 {after}",
    "changes.source.config_ui": "Config UI",
    "changes.source.cli": "命令行",
    "changes.source.release_override": "发布（已填写原因）",
    "changes.source.local_prerelease": "发布前运行",
    "changes.source.profile_activation": "配置激活",
    "changes.none": "此窗口内没有记录到设置更改。",
    "changes.unrecorded": "配置发生了变化，但没有相应的更改记录。如果是在托管平台的环境设置中更改的，请用 {command} 补记。",
    "evidence.traces": "样本追踪：{count}",
    "traces.none": "此告警没有附带样本追踪。",
    "traces.openAria": "在新标签页中打开追踪 {id}",
    "action.copyIds": "复制追踪 ID",
    "copy.done": "追踪 ID 已复制。",
    "evidence.suggestion": "建议的下一步",
    "suggestion.recalibrate_refusal": "分数分布发生了偏移，拒答阈值可能不再合适。请运行 {command}，然后查看“拒答校准”。",
    "suggestion.sample_under_covered": "下一次每周抽样会从覆盖不足的主题分组中抽取。请查看“测试集覆盖”。",
    "suggestion.other": "建议代码：{code}。",
    "evidence.delivery": "此告警的发送去向",
    "channel.banner": "Config UI 横幅",
    "channel.webhook": "管理员 Webhook",
    "channel.langfuse": "样本追踪上的 Langfuse 评分",
    "delivery.delivered": "已送达 {time}",
    "delivery.pending": "尚未送达，将在下次运行时重试。",
    "delivery.notConfigured": "未配置",
    "action.ack": "确认告警",
    "action.ackAria": "确认告警：{measure}，{language}",
    "action.resolve": "解决告警",
    "action.resolveAria": "解决告警：{measure}，{language}",
    "ack.done": "告警已确认。它不再出现在横幅中，但在解决之前仍保留在此列表。",
    "confirm.resolve.title": "解决此告警？",
    "confirm.resolve.body": "{measure}，{language}。已解决的告警将永久关闭。如果数值再次超出通常范围，会新开一个告警。",
    "confirm.resolve.keep": "保留告警",
    "resolve.done": "告警已解决。",
    "error.alertGone": "此告警在列表加载后已发生变化。列表已重新加载。",
    "settings.monitor.label": "每日监控",
    "settings.monitor.help": "关闭：不运行任何任务，也不存储任何数据。",
    "settings.webhook.label": "管理员 Webhook 地址",
    "settings.webhook.help": "可选。每个告警会以 JSON（仅含计数和 ID）发送到此地址。仅支持 HTTPS。",
    "settings.webhook.state": "Webhook：{state}",
    "settings.webhook.stateSet": "已设置",
    "settings.webhook.stateUnset": "未设置",
    "settings.webhook.set": "已保存 Webhook 地址，出于安全不予显示。输入新地址可替换，留空则保持不变。",
    "action.removeWebhook": "移除 Webhook",
    "confirm.webhook.title": "移除 Webhook？",
    "confirm.webhook.body": "告警将不再发送到管理员渠道。横幅和告警列表仍照常工作。",
    "confirm.webhook.keep": "保留 Webhook",
    "webhook.removed": "Webhook 已移除。",
    "webhook.removeFailed": "Webhook 未移除：配置服务器没有响应。请稍后再试。",
    "settings.secret.label": "Webhook 签名密钥",
    "settings.secret.help": "可选。至少 32 个字符。设置后，每次发送都会用 HMAC-SHA256 签名。",
    "warn.monitorNeedsLog": "监控已开启，但检索日志处于关闭状态。在日志级别设为 ids 或 masked_query 之前，监控不会写入任何内容。",
    "warn.webhookHttps": "Webhook 地址必须以 https:// 开头。",
    "action.refreshCoverage": "刷新覆盖情况",
    "count.item": "{label}：{value}",
    "status.acknowledged.plain": "已确认",
    "status.resolved.plain": "已解决",
    "measure.latency.noBudget": "p95：{value} 毫秒。通常：{base} 毫秒。",
    "measure.generic.value": "实测：{value}。",
    "measure.crossed.separator": "；",
    "value.ms": "{value} 毫秒",
    "alerts.listLabel": "监控告警",
    "settings.webhook.removeHint": "移除会立即生效，无需点击“Save All Changes”。",
  },
  it: {
    "panel.title": "Monitoraggio",
    "panel.description": "Una volta al giorno rifiuti, ricerche senza risultati, voti, punteggi dei giudici, errori della knowledge base e latenza vengono confrontati con i 30 giorni precedenti. Un valore fuori dall’intervallo abituale genera un avviso. Gli avvisi contengono conteggi e ID, mai il testo di domande o risposte.",
    "panel.tabsLabel": "Viste del monitoraggio",
    "tab.alerts": "Avvisi",
    "tab.coverage": "Copertura del set di test",
    "tab.settings": "Impostazioni",
    "summary.state": "Monitoraggio giornaliero",
    "summary.lastRun": "Ultima esecuzione",
    "summary.never": "Mai eseguito",
    "summary.log": "Log di recupero",
    "summary.groups": "Gruppi controllati",
    "summary.thin": "Gruppi con dati insufficienti",
    "action.refresh": "Aggiorna avvisi",
    "action.run": "Esegui monitoraggio ora",
    "action.more": "Carica altri avvisi",
    "alerts.loading": "Caricamento degli avvisi…",
    "alerts.loaded": "Avvisi caricati. Aperti: {open}. Presi in carico: {acknowledged}.",
    "run.running": "Monitoraggio in corso…",
    "run.done": "Monitoraggio terminato. Giorni aggiunti: {days}. Avvisi aperti: {opened}. Avvisi aggiornati: {updated}.",
    "run.failed": "Il monitoraggio non è terminato. Questa esecuzione non ha modificato nulla. Seleziona di nuovo Esegui monitoraggio ora tra poco.",
    "off.title": "Il monitoraggio è disattivato",
    "off.body": "Non viene misurato nulla e non viene generato alcun avviso. Per iniziare, imposta Monitoraggio giornaliero su Attivo in Impostazioni e salva. Il monitoraggio legge il log di recupero, che deve essere al livello ids o masked_query.",
    "needsLog": "Il log di recupero è disattivato: il monitoraggio non ha nulla da leggere e non scrive nulla. Imposta {variable} su ids o masked_query.",
    "filter.legend": "Mostra avvisi",
    "filter.active": "Aperti e presi in carico",
    "filter.resolved": "Risolti",
    "filter.all": "Tutti",
    "filter.workspace": "Area di lavoro",
    "filter.allWorkspaces": "Tutte le aree di lavoro",
    "alerts.empty.title": "Nessun avviso aperto",
    "alerts.empty.body": "Ogni valore misurato è nell’intervallo abituale, oppure i dati sono troppo pochi per dirlo. Gruppi con dati insufficienti: {count}.",
    "alerts.empty.neverRan": "Il monitoraggio non è ancora stato eseguito. Parte una volta al giorno, oppure ora con Esegui monitoraggio ora.",
    "alerts.empty.filtered": "Nessun avviso corrisponde a questo filtro.",
    "severity.alert": "Allarme",
    "severity.warning": "Attenzione",
    "status.open": "Aperto",
    "status.acknowledged": "Preso in carico il {date}",
    "status.resolved": "Risolto il {date}",
    "rule.refusal_rate": "Tasso di rifiuto",
    "rule.zero_result_rate": "Ricerche senza risultati",
    "rule.below_threshold_rate": "Ricerche sotto la soglia",
    "rule.not_helpful_rate": "Voti “non utile”",
    "rule.groundedness_flagged_rate": "Risposte segnalate come non supportate",
    "rule.kb_error_rate": "Errori della knowledge base",
    "rule.kb_degraded_rate": "Knowledge base degradata",
    "rule.kb_unavailable_rate": "Messaggi “knowledge base non disponibile”",
    "rule.top_score_shift": "Distribuzione del punteggio più alto",
    "rule.latency_p95": "Latenza (p95)",
    "rule.online_judge_mean": "Punteggio del giudice online",
    "rule.test_set_not_representative": "Set di test non più rappresentativo",
    "alert.meta.language": "Lingua: {language}",
    "alert.meta.allLanguages": "Lingua: tutte",
    "alert.meta.day": "Giorno: {day}",
    "alert.meta.window": "Finestra: {days} giorni fino al {day}",
    "measure.rate": "Misurato: {rate} ({count} su {total}). Abituale: {baseRate} ({baseCount} su {baseTotal}, nei 30 giorni precedenti).",
    "measure.distribution": "Spostamento (PSI): {value}. Limiti: attenzione {warn}, allarme {alert}.",
    "measure.latency": "p95: {value} ms. Abituale: {base} ms. Budget: {budget} ms.",
    "measure.score": "Punteggio medio: {value} (n = {n}). Abituale: {base}.",
    "measure.drift": "Differenza dalle domande reali: {value}. Gruppi di argomenti: {ids}.",
    "measure.generic": "Misurato: {value}. Abituale: {base}.",
    "measure.crossed": "Superato:",
    "measure.crossed.ratio": "{ratio} volte il valore abituale (limite {limit})",
    "measure.crossed.delta": "variazione di {delta} punti (limite {limit})",
    "measure.crossed.z": "z-score {z} (limite {limit})",
    "measure.crossed.drop": "calo di {drop} (limite {limit})",
    "evidence.show": "Mostra i dati",
    "evidence.breakdown": "Dove è successo",
    "breakdown.mode": "Modalità RAG",
    "breakdown.channel": "Canale",
    "breakdown.docType": "Tipo di documento",
    "breakdown.unknownType": "Tipo non più noto",
    "breakdown.col.requests": "Richieste",
    "breakdown.col.count": "Conteggio",
    "breakdown.col.rate": "Tasso",
    "evidence.companions": "Altre misure dello stesso gruppo",
    "companions.col.measure": "Misura",
    "companions.col.usual": "Abituale",
    "evidence.changes": "Modifiche alle impostazioni in questa finestra",
    "changes.col.when": "Quando",
    "changes.col.source": "Tramite",
    "changes.col.keys": "Impostazioni modificate",
    "changes.col.config": "Configurazione",
    "changes.col.record": "Registrazione",
    "changes.hashPair": "da {before} a {after}",
    "changes.source.config_ui": "Config UI",
    "changes.source.cli": "Riga di comando",
    "changes.source.release_override": "Rilascio, con motivo",
    "changes.source.local_prerelease": "Esecuzione pre-rilascio",
    "changes.source.profile_activation": "Attivazione di un profilo",
    "changes.none": "In questa finestra non è registrata alcuna modifica alle impostazioni.",
    "changes.unrecorded": "La configurazione è cambiata, ma nessuna modifica è stata registrata. Se è stata cambiata nelle impostazioni d’ambiente dell’host, registrala con {command}.",
    "evidence.traces": "Tracce di esempio: {count}",
    "traces.none": "A questo avviso non è allegata alcuna traccia di esempio.",
    "traces.openAria": "Apri la traccia {id} in una nuova scheda",
    "action.copyIds": "Copia ID delle tracce",
    "copy.done": "ID delle tracce copiati.",
    "evidence.suggestion": "Passo successivo consigliato",
    "suggestion.recalibrate_refusal": "La distribuzione dei punteggi si è spostata e le soglie di rifiuto potrebbero non essere più adatte. Esegui {command}, poi controlla Calibrazione del rifiuto.",
    "suggestion.sample_under_covered": "Il prossimo campione settimanale attingerà dai gruppi di argomenti poco coperti. Vedi Copertura del set di test.",
    "suggestion.other": "Codice del suggerimento: {code}.",
    "evidence.delivery": "Dove è stato inviato l’avviso",
    "channel.banner": "Banner della Config UI",
    "channel.webhook": "Webhook dell’amministratore",
    "channel.langfuse": "Punteggio Langfuse sulle tracce di esempio",
    "delivery.delivered": "Consegnato {time}",
    "delivery.pending": "Non ancora consegnato. Si riprova alla prossima esecuzione.",
    "delivery.notConfigured": "Non configurato",
    "action.ack": "Prendi in carico avviso",
    "action.ackAria": "Prendi in carico avviso: {measure}, {language}",
    "action.resolve": "Risolvi avviso",
    "action.resolveAria": "Risolvi avviso: {measure}, {language}",
    "ack.done": "Avviso preso in carico. Esce dal banner e resta in questo elenco finché non viene risolto.",
    "confirm.resolve.title": "Risolvere questo avviso?",
    "confirm.resolve.body": "{measure}, {language}. Un avviso risolto è chiuso definitivamente. Se il valore esce di nuovo dall’intervallo abituale, si apre un nuovo avviso.",
    "confirm.resolve.keep": "Lascia aperto l’avviso",
    "resolve.done": "Avviso risolto.",
    "error.alertGone": "Questo avviso è cambiato dopo il caricamento dell’elenco. L’elenco è stato ricaricato.",
    "settings.monitor.label": "Monitoraggio giornaliero",
    "settings.monitor.help": "Disattivato: non viene eseguito né salvato nulla.",
    "settings.webhook.label": "URL del webhook dell’amministratore",
    "settings.webhook.help": "Facoltativo. Ogni avviso viene inviato qui come JSON con conteggi e ID. Solo HTTPS.",
    "settings.webhook.state": "Webhook: {state}",
    "settings.webhook.stateSet": "impostato",
    "settings.webhook.stateUnset": "non impostato",
    "settings.webhook.set": "Un URL del webhook è salvato e non viene mostrato. Inseriscine uno nuovo per sostituirlo, o lascia vuoto per mantenerlo.",
    "action.removeWebhook": "Rimuovi webhook",
    "confirm.webhook.title": "Rimuovere il webhook?",
    "confirm.webhook.body": "Gli avvisi non verranno più inviati al canale dell’amministratore. Il banner e l’elenco degli avvisi continuano a funzionare.",
    "confirm.webhook.keep": "Mantieni webhook",
    "webhook.removed": "Webhook rimosso.",
    "webhook.removeFailed": "Il webhook non è stato rimosso: il server di configurazione non ha risposto. Riprova tra poco.",
    "settings.secret.label": "Segreto di firma del webhook",
    "settings.secret.help": "Facoltativo. Almeno 32 caratteri. Se impostato, ogni invio è firmato con HMAC-SHA256.",
    "warn.monitorNeedsLog": "Il monitoraggio è attivo ma il log di recupero è disattivato. Il monitoraggio non scriverà nulla finché il log non è al livello ids o masked_query.",
    "warn.webhookHttps": "L’URL del webhook deve iniziare con https://.",
    "action.refreshCoverage": "Aggiorna copertura",
    "count.item": "{label}: {value}",
    "status.acknowledged.plain": "Preso in carico",
    "status.resolved.plain": "Risolto",
    "measure.latency.noBudget": "p95: {value} ms. Abituale: {base} ms.",
    "measure.generic.value": "Misurato: {value}.",
    "measure.crossed.separator": "; ",
    "value.ms": "{value} ms",
    "alerts.listLabel": "Avvisi di monitoraggio",
    "settings.webhook.removeHint": "La rimozione ha effetto subito, senza attendere Save All Changes.",
  },
};

function monitorHas(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function monitorSharedLabels() {
  if (typeof GATES_UI_LABELS !== 'undefined') return GATES_UI_LABELS;
  return MONITOR_GATES.GATES_UI_LABELS;
}

/** A message from this panel's table, or from the shared gates-ui table for the keys it holds (updatedAt, workspace.line, value.*, …). */
function monitorMessage(key, locale, vars) {
  const own = monitorHas(MONITOR_LABELS.en, key);
  return MONITOR_GATES.gatesUiMessageFrom(own ? MONITOR_LABELS : monitorSharedLabels(), key, locale, vars);
}

function monitorLabel(key, locale, vars) {
  return monitorMessage(key, locale, vars).text;
}

function monitorFinite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function monitorTrue(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase() === 'true';
}

function monitorObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function monitorFixed(value, locale, digits) {
  if (!monitorFinite(value)) return '';
  return new Intl.NumberFormat(MONITOR_GATES.gatesUiLocale(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function monitorInteger(value, locale) {
  if (!monitorFinite(value)) return '';
  return MONITOR_GATES.gatesUiNumber(Math.round(value), locale);
}

function monitorDateTime(value, locale) {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return { iso: value, text: new Intl.DateTimeFormat(MONITOR_GATES.gatesUiLocale(locale), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(parsed) };
}

function monitorCountItem(labelKey, value, locale) {
  return monitorLabel('count.item', locale, { label: monitorLabel(labelKey, locale), value });
}

/** The label of a known rule, else null (the id is then shown in code). */
function monitorRuleLabel(rule, locale) {
  const key = typeof rule === 'string' && monitorHas(MONITOR_RULE_KEYS, rule) ? MONITOR_RULE_KEYS[rule] : null;
  return key ? monitorLabel(key, locale) : null;
}

function monitorRuleName(rule, locale) {
  const label = monitorRuleLabel(rule, locale);
  return label ? { text: label, code: false } : { text: String(rule === undefined || rule === null ? '' : rule), code: true };
}

/** A value of a rule in its unit: a rate as a percentage, a latency in ms, anything else with two decimals. */
function monitorRuleValue(rule, value, locale) {
  if (!monitorFinite(value)) return '';
  if (MONITOR_RATE_RULES.includes(rule)) return MONITOR_GATES.gatesUiPercent(value, locale);
  if (rule === 'latency_p95') return monitorLabel('value.ms', locale, { value: monitorInteger(value, locale) });
  return MONITOR_GATES.gatesUiScore(value, locale);
}

function monitorLanguageText(language, locale) {
  if (language === 'all') return { all: true, name: '' };
  return { all: false, name: MONITOR_GATES.gatesUiLanguageName(String(language === undefined || language === null ? '' : language), locale) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Pure builders (UI-SPEC 6.7, 8.1, 11): only the fields named there, never by iterating an alert's keys.

/** The summary rows of UI-SPEC 6.7: with the switch off only the state, so an off state shows no count (UI-SPEC 11 rule 14). */
function monitorSummaryView(monitor, enabled, locale) {
  const { gatesUiLabel, gatesUiNumber } = MONITOR_GATES;
  const rows = [{ key: 'state', label: monitorLabel('summary.state', locale), text: gatesUiLabel(enabled ? 'value.on' : 'value.off', locale) }];
  if (!enabled || !monitor || typeof monitor !== 'object') return rows;
  const last = monitorDateTime(typeof monitor.last_run_at === 'string' ? monitor.last_run_at : '', locale);
  rows.push({ key: 'lastRun', label: monitorLabel('summary.lastRun', locale), text: last ? last.text : monitorLabel('summary.never', locale), time: last });
  if (typeof monitor.log_level === 'string' && monitor.log_level !== '') rows.push({ key: 'log', label: monitorLabel('summary.log', locale), text: monitor.log_level, mono: true });
  if (monitorFinite(monitor.groups_checked)) rows.push({ key: 'groups', label: monitorLabel('summary.groups', locale), text: gatesUiNumber(monitor.groups_checked, locale) });
  if (monitorFinite(monitor.groups_insufficient)) rows.push({ key: 'thin', label: monitorLabel('summary.thin', locale), text: gatesUiNumber(monitor.groups_insufficient, locale) });
  return rows;
}

/** The combination notes of UI-SPEC 6.12 for the monitor group, read from the page's own inputs. */
function monitorSettingsWarnings(values) {
  const v = values || {};
  const out = [];
  if (monitorTrue(v.monitor) && v.log !== undefined && v.log === 'off') out.push('warn.monitorNeedsLog');
  const url = typeof v.url === 'string' ? v.url.trim() : '';
  if (url !== '' && !url.toLowerCase().startsWith('https://')) out.push('warn.webhookHttps');
  return out;
}

function monitorStatusView(alert, locale) {
  const { gatesUiDate } = MONITOR_GATES;
  const status = alert.status;
  if (status === 'acknowledged') {
    const date = gatesUiDate(typeof alert.acknowledged_at === 'string' ? alert.acknowledged_at : '', locale);
    return date
      ? { key: 'acknowledged', message: monitorMessage('status.acknowledged', locale, { date: { time: date } }) }
      : { key: 'acknowledged', message: monitorMessage('status.acknowledged.plain', locale) };
  }
  if (status === 'resolved') {
    const date = gatesUiDate(typeof alert.updated_at === 'string' ? alert.updated_at : '', locale);
    return date
      ? { key: 'resolved', message: monitorMessage('status.resolved', locale, { date: { time: date } }) }
      : { key: 'resolved', message: monitorMessage('status.resolved.plain', locale) };
  }
  return { key: 'open', message: monitorMessage('status.open', locale) };
}

function monitorPart(value) {
  return value && typeof value === 'object' ? value : {};
}

/** One measurement sentence by the rule's kind, from the alert's own numbers; anything else reads measure.generic. */
function monitorMeasurement(alert, locale) {
  const { gatesUiPercent, gatesUiNumber, gatesUiScore } = MONITOR_GATES;
  const observed = monitorPart(alert.observed);
  const baseline = monitorPart(alert.baseline);
  const band = monitorPart(alert.band);
  const kind = alert.kind;
  const rateOf = (part) => (monitorFinite(part.value) ? part.value : monitorFinite(part.count) && monitorFinite(part.n) && part.n > 0 ? part.count / part.n : null);
  if (kind === 'rate' && monitorFinite(observed.count) && monitorFinite(observed.n) && monitorFinite(baseline.count) && monitorFinite(baseline.n)) {
    const rate = rateOf(observed);
    const baseRate = rateOf(baseline);
    if (rate !== null && baseRate !== null) {
      return monitorMessage('measure.rate', locale, {
        rate: gatesUiPercent(rate, locale),
        count: gatesUiNumber(observed.count, locale),
        total: gatesUiNumber(observed.n, locale),
        baseRate: gatesUiPercent(baseRate, locale),
        baseCount: gatesUiNumber(baseline.count, locale),
        baseTotal: gatesUiNumber(baseline.n, locale),
      });
    }
  }
  if (kind === 'distribution' && monitorFinite(band.measured_value) && monitorFinite(band.warn) && monitorFinite(band.alert)) {
    return monitorMessage('measure.distribution', locale, { value: gatesUiScore(band.measured_value, locale), warn: gatesUiScore(band.warn, locale), alert: gatesUiScore(band.alert, locale) });
  }
  if (kind === 'latency' && monitorFinite(observed.value) && monitorFinite(baseline.value)) {
    const vars = { value: monitorInteger(observed.value, locale), base: monitorInteger(baseline.value, locale) };
    if (monitorFinite(band.budget)) return monitorMessage('measure.latency', locale, { ...vars, budget: monitorInteger(band.budget, locale) });
    return monitorMessage('measure.latency.noBudget', locale, vars);
  }
  if (kind === 'judge_mean' && monitorFinite(observed.value) && monitorFinite(observed.n) && monitorFinite(baseline.value)) {
    return monitorMessage('measure.score', locale, { value: gatesUiScore(observed.value, locale), n: gatesUiNumber(observed.n, locale), base: gatesUiScore(baseline.value, locale) });
  }
  if (kind === 'drift') {
    const value = monitorFinite(observed.value) ? observed.value : band.measured_value;
    const ids = (Array.isArray(alert.cluster_ids) ? alert.cluster_ids : []).filter((id) => typeof id === 'string' && id !== '');
    if (monitorFinite(value) && ids.length > 0) return monitorMessage('measure.drift', locale, { value: gatesUiScore(value, locale), ids: { mono: ids.join(', ') } });
  }
  const value = monitorFinite(observed.value) ? observed.value : monitorFinite(band.measured_value) ? band.measured_value : null;
  const base = monitorFinite(baseline.value) ? baseline.value : null;
  if (value !== null && base !== null) return monitorMessage('measure.generic', locale, { value: gatesUiScore(value, locale), base: gatesUiScore(base, locale) });
  if (value !== null) return monitorMessage('measure.generic.value', locale, { value: gatesUiScore(value, locale) });
  return null;
}

/** The conditions the alert's band records as crossed, joined by the locale's separator; null when none. */
function monitorCrossed(alert, locale) {
  const band = monitorPart(alert.band);
  const parts = [];
  if (monitorFinite(band.measured_ratio) && monitorFinite(band.ratio)) {
    parts.push(monitorLabel('measure.crossed.ratio', locale, { ratio: monitorFixed(band.measured_ratio, locale, 1), limit: monitorFixed(band.ratio, locale, 1) }));
  }
  if (monitorFinite(band.measured_delta) && monitorFinite(band.drop)) {
    parts.push(monitorLabel('measure.crossed.drop', locale, { drop: monitorFixed(-band.measured_delta, locale, 2), limit: monitorFixed(band.drop, locale, 2) }));
  } else if (monitorFinite(band.measured_delta) && monitorFinite(band.min_abs_delta)) {
    parts.push(monitorLabel('measure.crossed.delta', locale, { delta: monitorFixed(band.measured_delta * 100, locale, 1), limit: monitorFixed(band.min_abs_delta * 100, locale, 1) }));
  }
  if (monitorFinite(band.measured_z) && monitorFinite(band.min_z)) {
    parts.push(monitorLabel('measure.crossed.z', locale, { z: monitorFixed(band.measured_z, locale, 2), limit: monitorFixed(band.min_z, locale, 2) }));
  }
  if (parts.length === 0) return null;
  const lead = monitorLabel('measure.crossed', locale);
  const text = lead + ' ' + parts.join(monitorLabel('measure.crossed.separator', locale));
  return { key: 'measure.crossed', segments: [{ text }], text };
}

/**
 * Pure: one alert entry (UI-SPEC 6.7). ctx: { multiTenant, workspaceName(tenantKey) }. Names only the fields of UI-SPEC 8.1; the dedup
 * key, the actor and the raw breakdown are never read.
 */
function monitorAlertView(alert, locale, ctx) {
  const { gatesUiDate } = MONITOR_GATES;
  const a = alert && typeof alert === 'object' ? alert : {};
  const c = ctx || {};
  const measure = monitorRuleName(a.rule, locale);
  const severe = a.severity === 'alert';
  const language = monitorLanguageText(a.language, locale);
  const meta = [language.all ? monitorMessage('alert.meta.allLanguages', locale) : monitorMessage('alert.meta.language', locale, { language: language.name })];
  if (c.multiTenant) {
    const name = typeof c.workspaceName === 'function' ? c.workspaceName(a.tenant_key) : null;
    meta.push(MONITOR_GATES.gatesUiMessage('workspace.line', locale, { name: name ? name : { mono: String(a.tenant_key || '') } }));
  }
  const day = gatesUiDate(typeof a.day === 'string' ? a.day : '', locale);
  if (day) {
    meta.push(
      monitorFinite(a.window_days) && a.window_days > 1
        ? monitorMessage('alert.meta.window', locale, { days: MONITOR_GATES.gatesUiNumber(a.window_days, locale), day: { time: day } })
        : monitorMessage('alert.meta.day', locale, { day: { time: day } }),
    );
  }
  const status = monitorStatusView(a, locale);
  const ariaVars = { measure: measure.text, language: language.all ? monitorLabel('alert.meta.allLanguages', locale) : language.name };
  return {
    id: typeof a.id === 'string' ? a.id : '',
    measure,
    severity: severe
      ? { key: 'alert', label: monitorLabel('severity.alert', locale), tone: 'badge-error', icon: 'bi-exclamation-octagon-fill' }
      : { key: 'warning', label: monitorLabel('severity.warning', locale), tone: 'badge-warning', icon: 'bi-exclamation-triangle-fill' },
    status: { key: status.key, label: status.message.text, message: status.message },
    meta,
    measurement: monitorMeasurement(a, locale),
    crossed: monitorCrossed(a, locale),
    actions: status.key === 'open' ? ['ack', 'resolve'] : status.key === 'acknowledged' ? ['resolve'] : [],
    ackAria: monitorLabel('action.ackAria', locale, ariaVars),
    resolveAria: monitorLabel('action.resolveAria', locale, ariaVars),
    confirmBody: monitorMessage('confirm.resolve.body', locale, ariaVars),
  };
}

function monitorDocTypeLabel(type, locale) {
  if (type === 'unknown') return { label: monitorLabel('breakdown.unknownType', locale), mono: false };
  if (typeof window !== 'undefined' && typeof window.docTypeLabelForLocale === 'function') {
    const label = window.docTypeLabelForLocale(type, locale);
    if (typeof label === 'string' && label !== '' && label !== type) return { label, mono: false };
  }
  return { label: type, mono: true };
}

function monitorHash8(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, 8) : '';
}

/** Pure: the evidence blocks of UI-SPEC 6.7. Absent breakdown, companions and suggestion are left out; delivery always has three rows. */
function monitorEvidenceView(alert, locale) {
  const { gatesUiNumber } = MONITOR_GATES;
  const a = alert && typeof alert === 'object' ? alert : {};
  const breakdownSource = monitorObject(a.breakdown);
  const breakdown = [];
  for (const dim of MONITOR_BREAKDOWN_DIMENSIONS) {
    const entries = monitorObject(breakdownSource[dim.field]);
    const rows = Object.keys(entries)
      .map((value) => ({ value, part: monitorObject(entries[value]) }))
      .filter((row) => monitorFinite(row.part.n))
      .sort((x, y) => y.part.n - x.part.n || (x.value < y.value ? -1 : x.value > y.value ? 1 : 0))
      .map((row) => {
        const name = dim.field === 'by_doc_type' ? monitorDocTypeLabel(row.value, locale) : { label: row.value, mono: true };
        return {
          label: name.label,
          mono: name.mono,
          requests: gatesUiNumber(row.part.n, locale),
          count: monitorFinite(row.part.count) ? gatesUiNumber(row.part.count, locale) : '',
          rate: monitorRuleValue(a.rule, row.part.value, locale),
        };
      });
    if (rows.length > 0) breakdown.push({ dimension: dim.field, title: monitorLabel(dim.key, locale), rows });
  }

  const companions = (Array.isArray(a.companions) ? a.companions : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const name = monitorRuleName(item.rule, locale);
      return { measure: name.text, code: name.code, measured: monitorRuleValue(item.rule, item.value, locale), usual: monitorRuleValue(item.rule, item.baseline, locale) };
    });

  const changeRows = (Array.isArray(a.config_changes) ? a.config_changes : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const when = monitorDateTime(typeof item.at === 'string' ? item.at : '', locale);
      const source = typeof item.source === 'string' && monitorHas(MONITOR_LABELS.en, 'changes.source.' + item.source) ? { text: monitorLabel('changes.source.' + item.source, locale), code: false } : { text: String(item.source || ''), code: true };
      const keys = (Array.isArray(item.changed_keys) ? item.changed_keys : []).filter((k) => typeof k === 'string' && k !== '');
      const before = monitorHash8(item.before_hash);
      const after = monitorHash8(item.after_hash);
      const row = {
        when,
        source,
        keys,
        config: before || after ? monitorMessage('changes.hashPair', locale, { before: { mono: before || '—' }, after: { mono: after || '—' } }) : null,
        record: typeof item.record_id === 'string' && item.record_id !== '' ? item.record_id : '',
      };
      if (item.unrecorded === true) row.unrecorded = monitorMessage('changes.unrecorded', locale, { command: MONITOR_RECORD_CHANGE_COMMAND });
      return row;
    });

  const ids = (Array.isArray(a.sample_trace_ids) ? a.sample_trace_ids : []).filter((id) => typeof id === 'string' && id !== '').slice(0, MONITOR_MAX_TRACES);

  let suggestion = null;
  if (a.suggestion === 'recalibrate_refusal') suggestion = { message: monitorMessage('suggestion.recalibrate_refusal', locale, { command: MONITOR_REFUSAL_COMMAND }), refusalLink: true };
  else if (a.suggestion === 'review_test_set') suggestion = { message: monitorMessage('suggestion.sample_under_covered', locale), refusalLink: false };
  else if (typeof a.suggestion === 'string' && a.suggestion !== '') suggestion = { message: monitorMessage('suggestion.other', locale, { code: a.suggestion }), refusalLink: false };

  const delivered = monitorObject(a.delivered);
  const stored = monitorDateTime(typeof a.created_at === 'string' ? a.created_at : '', locale);
  const delivery = [
    {
      channel: 'banner',
      label: monitorLabel('channel.banner', locale),
      message: stored ? monitorMessage('delivery.delivered', locale, { time: { time: stored } }) : monitorMessage('delivery.pending', locale),
    },
  ];
  for (const channel of ['webhook', 'langfuse']) {
    const entry = monitorObject(delivered[channel]);
    let message = monitorMessage('delivery.notConfigured', locale);
    if (entry.state === 'delivered') {
      const at = monitorDateTime(typeof entry.last_attempt_at === 'string' ? entry.last_attempt_at : '', locale);
      message = at ? monitorMessage('delivery.delivered', locale, { time: { time: at } }) : monitorMessage('delivery.delivered', locale, { time: '' });
    } else if (entry.state === 'pending' || entry.state === 'failed') message = monitorMessage('delivery.pending', locale);
    delivery.push({ channel, label: monitorLabel('channel.' + channel, locale), message });
  }

  return {
    breakdown,
    companions,
    changes: { rows: changeRows, empty: changeRows.length === 0 ? monitorMessage('changes.none', locale) : null },
    traces: { ids, title: monitorLabel('evidence.traces', locale, { count: gatesUiNumber(ids.length, locale) }) },
    suggestion,
    delivery,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Panel

class MonitorPanel {
  constructor(root, deps) {
    const d = deps || {};
    this.root = root;
    this.locale = MONITOR_GATES.gatesUiLocale(d.locale);
    this.fetcher = d.fetcher || null;
    this.configFetcher = d.configFetcher || null;
    this.appUrl = d.appUrl || null;
    this.configSource = typeof d.config === 'function' ? d.config : null;
    this.secretsSource = typeof d.secretsSet === 'function' ? d.secretsSet : null;
    this.refreshBannerFn = typeof d.refreshBanner === 'function' ? d.refreshBanner : null;
    this.openRefusalFn = typeof d.openRefusal === 'function' ? d.openRefusal : null;
    this.clipboard = monitorHas(d, 'clipboard') ? d.clipboard : typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
    this.mounted = false;
    this.current = 'alerts';
    this.views = {};
    this.list = { alerts: [], next: null, loading: false, running: false, seq: 0, data: false, monitor: null, counts: null, updatedAt: null };
    this.filter = 'active';
    this.tenant = '';
    this.tenants = [];
    this.entrySeq = 0;
    this.hosts = {
      title: root.querySelector('[data-monitor-title]'),
      description: root.querySelector('[data-monitor-description]'),
      alert: root.querySelector('[data-monitor-alert]'),
      summary: root.querySelector('[data-monitor-summary]'),
      content: root.querySelector('[data-monitor-content]'),
      status: root.querySelector('[data-monitor-status]'),
    };
  }

  t(key, vars) {
    return monitorLabel(key, this.locale, vars);
  }

  m(key, vars) {
    return monitorMessage(key, this.locale, vars);
  }

  el(tag, opts, children) {
    return MONITOR_GATES.gatesUiEl(tag, opts, children);
  }

  config() {
    if (this.configSource) return this.configSource() || {};
    if (typeof window !== 'undefined' && window.configManager && window.configManager.savedConfig) return window.configManager.savedConfig;
    return {};
  }

  /** The saved switch: the loaded configuration first, then the page's own input. */
  enabled() {
    const c = this.config();
    if (monitorHas(c, 'RAG_MONITOR')) return monitorTrue(c.RAG_MONITOR);
    const input = document.getElementById('RAG_MONITOR');
    return input ? monitorTrue(input.value) : false;
  }

  multiTenant() {
    const c = this.config();
    return (c.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE || c.MYRAG_DEPLOYMENT_MODE) === 'multi-tenant';
  }

  secrets() {
    if (this.secretsSource) return this.secretsSource() || new Set();
    if (typeof window !== 'undefined' && window.configManager && window.configManager.secretsSet) return window.configManager.secretsSet;
    return new Set();
  }

  setStatus(message, isError) {
    MONITOR_GATES.gatesUiStatus(this.hosts.status, message, isError);
  }

  request(path, init, timeoutMs) {
    return MONITOR_GATES.gatesUiFetch(path, init || { method: 'GET' }, { fetcher: this.fetcher || undefined, timeoutMs });
  }

  mapError(result) {
    return MONITOR_GATES.gatesUiMapError(result, this.locale, { view: this.t('tab.alerts'), switchedOn: true, appUrl: this.appUrl });
  }

  refreshBanner() {
    if (this.refreshBannerFn) return this.refreshBannerFn();
    if (typeof window !== 'undefined' && typeof window.gatesUiRefreshBanner === 'function') return window.gatesUiRefreshBanner();
    return null;
  }

  openRefusal() {
    if (this.openRefusalFn) return this.openRefusalFn();
    if (typeof window !== 'undefined' && typeof window.openRefusalCalibrationPanel === 'function') return window.openRefusalCalibrationPanel();
    return null;
  }

  async mount() {
    if (!this.mounted) {
      this.mounted = true;
      this.root.setAttribute('lang', this.locale);
      if (this.hosts.title) this.hosts.title.textContent = this.t('panel.title');
      if (this.hosts.description) this.hosts.description.textContent = this.t('panel.description');
      if (this.hosts.status) this.hosts.status.setAttribute('tabindex', '-1');
      this.buildChrome();
      this.mountSettings();
    }
    return this.refresh();
  }

  buildChrome() {
    const content = this.hosts.content;
    if (!content) return;
    const tabs = MONITOR_GATES.gatesUiSubTabs({
      label: this.t('panel.tabsLabel'),
      idPrefix: 'rag-monitor',
      tabs: MONITOR_TABS.map((id) => ({ id, label: this.t('tab.' + id) })),
      selected: this.current,
      onSelect: (id) => {
        this.current = id;
        this.refresh();
      },
    });
    this.tabs = tabs;
    // DaisyUI tabs are a grid, so the shared flex-wrap does not apply; as flex they wrap at 360px instead of scrolling the page sideways.
    tabs.root.classList.add('flex');
    tabs.tabs.forEach((tab, i) => {
      tab.setAttribute('data-monitor-tab', MONITOR_TABS[i]);
      tab.classList.add('h-auto', 'min-h-8', 'whitespace-nowrap');
    });
    tabs.panels.forEach((panel, i) => {
      panel.setAttribute('data-monitor-view', MONITOR_TABS[i]);
      this.views[MONITOR_TABS[i]] = panel;
    });
    this.views.coverage.appendChild(this.el('div', { className: 'min-w-0', attrs: { 'data-monitor-coverage-host': '' } }));
    content.replaceChildren(tabs.root, ...tabs.panels);
    this.buildAlertsView();
  }

  async selectTab(id) {
    if (!this.tabs || !MONITOR_TABS.includes(id)) return;
    if (id === this.current) return this.refresh();
    this.tabs.select(id);
  }

  /** Keeps the selected sub-view; Alerts loads (nothing with the switch off), Settings recomputes its notes and makes no request. */
  async refresh() {
    this.renderSummary();
    if (this.current === 'alerts') return this.loadAlerts(false);
    if (this.current === 'coverage') {
      if (typeof window !== 'undefined' && typeof window.initMonitorCoverage === 'function') window.initMonitorCoverage(this);
      return;
    }
    this.renderWebhookState();
    this.renderSettingsWarnings();
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Summary (UI-SPEC 6.7)

  renderSummary() {
    const host = this.hosts.summary;
    if (!host) return;
    const enabled = this.enabled();
    const rows = monitorSummaryView(enabled ? this.list.monitor : null, enabled, this.locale);
    const dl = this.el('dl', { className: 'grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 max-w-3xl' });
    for (const row of rows) {
      let value;
      if (row.time) value = this.el('time', { text: row.text, attrs: { datetime: row.time.iso } });
      else if (row.mono) value = this.el('span', { className: 'font-mono text-xs break-all', text: row.text, attrs: { translate: 'no' } });
      else value = row.text;
      dl.appendChild(
        this.el('div', { className: 'min-w-0', attrs: { 'data-monitor-summary-row': row.key } }, [
          this.el('dt', { className: 'text-xs text-base-content/70', text: row.label }),
          this.el('dd', { className: 'text-sm tabular-nums break-words' + (row.key === 'state' ? ' font-semibold' : '') }, [value]),
        ]),
      );
    }
    host.replaceChildren(dl);
  }

  renderNeedsLog() {
    const host = this.hosts.alert;
    if (!host) return;
    const monitor = this.list.monitor;
    if (this.enabled() && monitor && monitor.log_level === 'off') {
      host.replaceChildren(MONITOR_GATES.gatesUiAlert('warning', 'bi-exclamation-triangle', this.m('needsLog', { variable: 'RAG_RETRIEVAL_LOG' }), []));
    } else host.replaceChildren();
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Alerts (UI-SPEC 6.7)

  buildAlertsView() {
    const view = this.views.alerts;
    const { gatesUiIcon } = MONITOR_GATES;
    const legendId = 'rag-monitor-filter-legend';
    this.filterInputs = MONITOR_FILTERS.map((value) => {
      const input = this.el('input', {
        className: 'join-item btn btn-sm',
        attrs: { type: 'radio', name: 'rag-monitor-status-filter', value, 'aria-label': this.t('filter.' + value) },
        on: {
          change: () => {
            if (!input.checked) return;
            this.filter = value;
            this.loadAlerts(false);
          },
        },
      });
      input.checked = value === this.filter;
      return input;
    });
    this.filterFieldset = this.el('fieldset', { className: 'join flex-wrap', attrs: { 'aria-labelledby': legendId } }, [
      this.el('legend', { className: 'sr-only', text: this.t('filter.legend'), attrs: { id: legendId } }),
      ...this.filterInputs,
    ]);
    const selectId = 'rag-monitor-workspace-filter';
    this.workspaceSelect = this.el('select', {
      className: 'select select-bordered select-sm max-w-full',
      attrs: { id: selectId, name: 'rag-monitor-workspace', 'data-monitor-workspace': '', autocomplete: 'off' },
      on: {
        change: () => {
          this.tenant = this.workspaceSelect.value || '';
          this.loadAlerts(false);
        },
      },
    });
    this.workspaceControl = this.el('div', { className: 'flex items-center gap-2 min-w-0' }, [
      this.el('label', { className: 'text-sm', text: this.t('filter.workspace'), attrs: { for: selectId } }),
      this.workspaceSelect,
    ]);
    this.updated = this.el('span', { className: 'text-xs text-base-content/70 tabular-nums' });
    this.refreshButton = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.loadAlerts(false) } }, [
      gatesUiIcon('bi-arrow-clockwise'),
      this.t('action.refresh'),
    ]);
    this.runButton = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.runMonitor() } }, [this.t('action.run')]);
    this.toolbarEnd = this.el('div', { className: 'flex flex-wrap items-center gap-2 md:ml-auto' }, [this.updated, this.refreshButton, this.runButton]);
    this.toolbar = this.el('div', { className: 'flex flex-wrap items-center gap-2 mb-4' }, [this.filterFieldset, this.toolbarEnd]);
    this.alertsAlert = this.el('div', { className: 'mb-4 empty:mb-0' });
    this.listEl = this.el('ul', { className: 'divide-y divide-base-300', attrs: { 'aria-label': this.t('alerts.listLabel') } });
    this.moreButton = this.el('button', { className: 'btn btn-outline btn-sm mt-4', attrs: { type: 'button' }, on: { click: () => this.loadAlerts(true) } }, [this.t('action.more')]);
    this.alertsBody = this.el('div', { className: 'min-w-0' });
    view.replaceChildren(this.alertsAlert, this.alertsBody);
  }

  toolbarShown(shown) {
    const view = this.views.alerts;
    if (!shown) {
      this.toolbar.remove();
      return;
    }
    const start = [this.filterFieldset];
    if (this.multiTenant()) start.push(this.workspaceControl);
    this.toolbar.replaceChildren(...start, this.toolbarEnd);
    if (this.toolbar.parentNode !== view) view.insertBefore(this.toolbar, this.alertsBody);
  }

  renderOff() {
    const { gatesUiEmptyBlock } = MONITOR_GATES;
    this.list.data = false;
    this.list.monitor = null;
    this.alertsAlert.replaceChildren();
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
    this.toolbarShown(false);
    this.alertsBody.replaceChildren(gatesUiEmptyBlock(this.t('off.title'), this.t('off.body')));
  }

  setBusy(busy) {
    const { gatesUiSetBusy, gatesUiSpinner, gatesUiIcon, gatesUiLoadingBlock } = MONITOR_GATES;
    this.list.loading = busy;
    gatesUiSetBusy(this.alertsBody, busy && this.list.data);
    this.refreshButton.disabled = busy;
    this.refreshButton.replaceChildren(busy ? gatesUiSpinner() : gatesUiIcon('bi-arrow-clockwise'), this.t('action.refresh'));
    if (busy && !this.list.data) {
      this.alertsBody.replaceChildren(gatesUiLoadingBlock(this.t('alerts.loading')));
      this.setStatus(this.t('alerts.loading'));
    }
  }

  query(append) {
    const params = new URLSearchParams();
    params.set('status', this.filter);
    params.set('limit', String(MONITOR_PAGE_SIZE));
    if (this.tenant) params.set('tenant', this.tenant);
    if (append && this.list.next) params.set('cursor', this.list.next);
    return '?' + params.toString();
  }

  /** Loads the first page (append false) or the next one. With the switch off nothing is requested. */
  async loadAlerts(append, opts) {
    if (!this.alertsBody) return;
    if (!this.enabled()) {
      this.renderOff();
      this.renderSummary();
      return;
    }
    if (this.list.loading && !(opts && opts.force)) return;
    this.toolbarShown(true);
    const seq = (this.list.seq += 1);
    if (append) {
      this.moreButton.disabled = true;
      this.moreButton.replaceChildren(MONITOR_GATES.gatesUiSpinner(), this.t('action.more'));
    } else this.setBusy(true);
    const result = await this.request(MONITOR_ALERTS_API + this.query(append), { method: 'GET' });
    if (append) {
      this.moreButton.disabled = false;
      this.moreButton.replaceChildren(this.t('action.more'));
    } else this.setBusy(false);
    if (seq !== this.list.seq) return;
    if (!result.ok) return this.loadFailed(result);
    const body = monitorObject(result.body);
    const alerts = (Array.isArray(body.alerts) ? body.alerts : []).filter((a) => a && typeof a === 'object' && typeof a.id === 'string');
    this.list.alerts = append ? this.list.alerts.concat(alerts.filter((a) => !this.list.alerts.some((b) => b.id === a.id))) : alerts;
    this.list.next = typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : null;
    this.list.monitor = monitorObject(body.monitor);
    const counts = monitorObject(body.counts);
    this.list.counts = { open: monitorFinite(counts.open) ? counts.open : 0, acknowledged: monitorFinite(counts.acknowledged) ? counts.acknowledged : 0 };
    this.list.data = true;
    this.list.updatedAt = new Date();
    for (const a of alerts) if (typeof a.tenant_key === 'string' && !this.tenants.includes(a.tenant_key)) this.tenants.push(a.tenant_key);
    this.alertsAlert.replaceChildren();
    this.renderSummary();
    this.renderNeedsLog();
    this.renderWorkspaceOptions();
    this.renderAlerts();
    if (!(opts && opts.quiet)) {
      const { gatesUiNumber } = MONITOR_GATES;
      this.setStatus(this.t('alerts.loaded', { open: gatesUiNumber(this.list.counts.open, this.locale), acknowledged: gatesUiNumber(this.list.counts.acknowledged, this.locale) }));
    }
  }

  loadFailed(result) {
    const { gatesUiErrorAlert, gatesUiSetBusy } = MONITOR_GATES;
    const mapped = this.mapError(result);
    this.alertsAlert.replaceChildren(gatesUiErrorAlert(mapped, this.locale, () => this.loadAlerts(false)));
    if (mapped.kind === 'signIn' || mapped.kind === 'switchedOff') {
      this.list.data = false;
      this.toolbarShown(false);
      this.alertsBody.replaceChildren();
    } else if (this.list.data) gatesUiSetBusy(this.alertsBody, true);
    else this.alertsBody.replaceChildren();
    this.setStatus(mapped, true);
  }

  workspaceName(tenantKey) {
    if (typeof tenantKey !== 'string') return null;
    const id = tenantKey.replace(/^[uo]:/, '');
    const selector = document.getElementById('workspace-selector');
    if (!selector) return null;
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === id);
    const name = option ? String(option.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').trim() : '';
    return name || null;
  }

  renderWorkspaceOptions() {
    if (!this.multiTenant()) return;
    const options = [this.el('option', { text: this.t('filter.allWorkspaces'), attrs: { value: '' } })];
    for (const key of this.tenants) {
      const name = this.workspaceName(key);
      options.push(this.el('option', { text: name || key, attrs: { value: key } }));
    }
    this.workspaceSelect.replaceChildren(...options);
    this.workspaceSelect.value = this.tenant;
  }

  renderAlerts() {
    const { gatesUiEmptyBlock, gatesUiDate, gatesUiAppendMessage, gatesUiNumber } = MONITOR_GATES;
    this.updated.replaceChildren();
    const time = this.list.updatedAt ? gatesUiDate(this.list.updatedAt.toISOString(), this.locale, 'time') : null;
    if (time) gatesUiAppendMessage(this.updated, this.m('updatedAt', { time: { time } }));
    if (this.list.alerts.length === 0) {
      const monitor = this.list.monitor || {};
      let block;
      if (!monitor.last_run_at) block = gatesUiEmptyBlock(this.t('alerts.empty.title'), this.t('alerts.empty.neverRan'));
      else if (this.filter !== 'active' || this.tenant) block = gatesUiEmptyBlock(this.t('alerts.empty.filtered'), '');
      else block = gatesUiEmptyBlock(this.t('alerts.empty.title'), this.t('alerts.empty.body', { count: gatesUiNumber(monitorFinite(monitor.groups_insufficient) ? monitor.groups_insufficient : 0, this.locale) }));
      if (this.filter !== 'active' || this.tenant) {
        const body = block.querySelector('p');
        if (body && !body.textContent) body.remove();
      }
      this.alertsBody.replaceChildren(block);
      return;
    }
    this.listEl.replaceChildren(...this.list.alerts.map((a) => this.entryEl(a)));
    const nodes = [this.listEl];
    if (this.list.next) nodes.push(this.moreButton);
    this.alertsBody.replaceChildren(...nodes);
  }

  entryCtx() {
    return { multiTenant: this.multiTenant(), workspaceName: (key) => this.workspaceName(key) };
  }

  /** One alert entry: li.py-4 > article labelled by its h4 (UI-SPEC 6.7, 9.7). */
  entryEl(alert) {
    const { gatesUiIcon, gatesUiMessageEl } = MONITOR_GATES;
    const v = monitorAlertView(alert, this.locale, this.entryCtx());
    this.entrySeq += 1;
    const headingId = 'rag-monitor-alert-' + this.entrySeq;
    const heading = this.el('h4', {
      className: 'text-base font-semibold text-balance break-words min-w-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      attrs: { id: headingId, tabindex: '-1' },
    });
    if (v.measure.code) heading.appendChild(this.el('code', { className: 'font-mono text-sm break-all', text: v.measure.text, attrs: { translate: 'no', lang: 'en' } }));
    else heading.textContent = v.measure.text;
    const severity = this.el('span', { className: 'badge badge-sm gap-1 shrink-0 ' + v.severity.tone }, [gatesUiIcon(v.severity.icon), v.severity.label]);
    const statusTone = v.status.key === 'open' ? 'badge-outline' : 'badge-ghost';
    const statusBadge = gatesUiMessageEl('span', 'badge badge-sm gap-1 h-auto ' + statusTone, v.status.message);
    if (v.status.key === 'resolved') statusBadge.insertBefore(gatesUiIcon('bi-check'), statusBadge.firstChild);
    const actions = this.el('div', { className: 'flex flex-col md:flex-row flex-wrap gap-2 w-full md:w-auto', attrs: { 'data-monitor-actions': '' } });
    const article = this.el('article', { className: 'flex flex-col gap-2 min-w-0', attrs: { 'aria-labelledby': headingId, 'data-monitor-alert-id': v.id } });
    const buttons = {};
    if (v.actions.includes('ack')) {
      buttons.ack = this.el('button', { className: 'btn btn-primary md:btn-sm w-full md:w-auto', text: this.t('action.ack'), attrs: { type: 'button', 'aria-label': v.ackAria } });
      actions.appendChild(buttons.ack);
    }
    if (v.actions.includes('resolve')) {
      buttons.resolve = this.el('button', { className: 'btn btn-outline md:btn-sm w-full md:w-auto', text: this.t('action.resolve'), attrs: { type: 'button', 'aria-label': v.resolveAria } });
      actions.appendChild(buttons.resolve);
    }
    if (buttons.ack) buttons.ack.addEventListener('click', () => this.acknowledge(alert, article, buttons));
    if (buttons.resolve) buttons.resolve.addEventListener('click', () => this.resolve(alert, article, buttons, v));
    const end = this.el('div', { className: 'flex flex-col md:flex-row md:items-center gap-2 md:ml-auto w-full md:w-auto' }, [this.el('div', null, [statusBadge]), actions]);
    const head = this.el('div', { className: 'flex flex-wrap items-center gap-2' }, [severity, heading, end]);
    const meta = this.el('p', { className: 'text-sm flex flex-col md:flex-row md:flex-wrap gap-x-4 gap-y-1' }, v.meta.map((message) => gatesUiMessageEl('span', 'break-words min-w-0', message)));
    const parts = [head, meta];
    if (v.measurement) parts.push(gatesUiMessageEl('p', 'text-sm tabular-nums max-w-prose break-words', v.measurement));
    if (v.crossed) parts.push(gatesUiMessageEl('p', 'text-sm tabular-nums max-w-prose break-words', v.crossed));
    parts.push(this.evidenceEl(alert));
    article.replaceChildren(...parts);
    return this.el('li', { className: 'py-4' }, [article]);
  }

  actionBusy(buttons, pressed, busy) {
    const { gatesUiSpinner } = MONITOR_GATES;
    for (const [name, button] of Object.entries(buttons)) {
      button.disabled = busy;
      const label = this.t(name === 'ack' ? 'action.ack' : 'action.resolve');
      if (name === pressed) button.replaceChildren(...(busy ? [gatesUiSpinner(), label] : [label]));
    }
  }

  async actionFailed(result) {
    if (result && (result.status === 404 || result.status === 409)) {
      await this.loadAlerts(false, { force: true, quiet: true });
      this.setStatus(this.m('error.alertGone'), true);
      return;
    }
    this.setStatus(this.mapError(result), true);
  }

  async postAction(alert, action) {
    return this.request(MONITOR_ALERTS_API + '/' + encodeURIComponent(alert.id) + '/' + action, { method: 'POST', body: JSON.stringify({}) });
  }

  replaceAlert(id, next) {
    this.list.alerts = this.list.alerts.map((a) => (a.id === id ? next : a));
  }

  async acknowledge(alert, article, buttons) {
    this.actionBusy(buttons, 'ack', true);
    const result = await this.postAction(alert, 'acknowledge');
    this.actionBusy(buttons, 'ack', false);
    if (!result.ok) return this.actionFailed(result);
    const updated = monitorObject(result.body).alert;
    const next = updated && typeof updated === 'object' && updated.id === alert.id ? updated : { ...alert, status: 'acknowledged' };
    this.replaceAlert(alert.id, next);
    if (this.list.counts) this.list.counts = { open: Math.max(0, this.list.counts.open - 1), acknowledged: this.list.counts.acknowledged + 1 };
    const li = article.parentNode;
    const fresh = this.entryEl(next);
    if (li && li.parentNode) {
      li.parentNode.insertBefore(fresh, li);
      li.remove();
    }
    this.setStatus(this.t('ack.done'));
    const resolveButton = fresh.querySelectorAll('button').find((b) => b.textContent === this.t('action.resolve'));
    if (resolveButton) resolveButton.focus();
    this.refreshBanner();
  }

  async resolve(alert, article, buttons, view) {
    const confirmed = await MONITOR_GATES.gatesUiConfirm({
      title: this.t('confirm.resolve.title'),
      body: view.confirmBody,
      keepLabel: this.t('confirm.resolve.keep'),
      confirmLabel: this.t('action.resolve'),
      opener: buttons.resolve,
      fallbackFocus: this.hosts.status,
      locale: this.locale,
    });
    if (!confirmed) return;
    this.actionBusy(buttons, 'resolve', true);
    const result = await this.postAction(alert, 'resolve');
    this.actionBusy(buttons, 'resolve', false);
    if (!result.ok) return this.actionFailed(result);
    const updated = monitorObject(result.body).alert;
    const next = updated && typeof updated === 'object' && updated.id === alert.id ? updated : { ...alert, status: 'resolved' };
    if (this.list.counts) {
      const wasOpen = alert.status === 'open';
      this.list.counts = { open: Math.max(0, this.list.counts.open - (wasOpen ? 1 : 0)), acknowledged: Math.max(0, this.list.counts.acknowledged - (wasOpen ? 0 : 1)) };
    }
    const li = article.parentNode;
    if (this.filter === 'active') {
      const index = this.list.alerts.findIndex((a) => a.id === alert.id);
      this.list.alerts = this.list.alerts.filter((a) => a.id !== alert.id);
      const siblings = this.listEl.querySelectorAll('article');
      const nextArticle = siblings[siblings.indexOf(article) + 1] || siblings[siblings.indexOf(article) - 1] || null;
      if (li) li.remove();
      this.setStatus(this.t('resolve.done'));
      if (this.list.alerts.length === 0 && index >= 0) this.renderAlerts();
      const target = nextArticle ? nextArticle.querySelector('h4') : this.hosts.status;
      if (target && typeof target.focus === 'function') target.focus();
    } else {
      this.replaceAlert(alert.id, next);
      const fresh = this.entryEl(next);
      if (li && li.parentNode) {
        li.parentNode.insertBefore(fresh, li);
        li.remove();
      }
      this.setStatus(this.t('resolve.done'));
      const heading = fresh.querySelector('h4');
      if (heading) heading.focus();
    }
    this.refreshBanner();
  }

  async runMonitor() {
    if (this.list.running) return;
    const { gatesUiSpinner } = MONITOR_GATES;
    this.list.running = true;
    this.runButton.disabled = true;
    this.runButton.replaceChildren(gatesUiSpinner(), this.t('run.running'));
    this.setStatus(this.t('run.running'));
    const result = await this.request(MONITOR_RUN_API, { method: 'POST', body: JSON.stringify({}) }, MONITOR_RUN_TIMEOUT_MS);
    this.list.running = false;
    this.runButton.disabled = false;
    this.runButton.replaceChildren(this.t('action.run'));
    if (!result.ok) {
      const mapped = this.mapError(result);
      if (mapped.kind === 'signIn' || mapped.kind === 'switchedOff') return this.loadFailed(result);
      this.setStatus(this.m('run.failed'), true);
      return;
    }
    const body = monitorObject(result.body);
    const { gatesUiNumber } = MONITOR_GATES;
    const count = (v) => gatesUiNumber(monitorFinite(v) ? v : 0, this.locale);
    await this.loadAlerts(false, { force: true, quiet: true });
    this.setStatus(this.t('run.done', { days: count(body.days_aggregated), opened: count(body.alerts_opened), updated: count(body.alerts_updated) }));
    this.refreshBanner();
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Evidence (UI-SPEC 6.7): ids and counts only; tables in focusable scroll regions.

  regionEl(label, table) {
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded-lg max-w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': label },
      },
      [table],
    );
  }

  tableEl(caption, headers, rows) {
    const head = this.el(
      'tr',
      null,
      headers.map((h) => this.el('th', { className: 'text-xs font-semibold' + (h.numeric ? ' text-right' : ''), text: h.label, attrs: { scope: 'col' } })),
    );
    const body = this.el('tbody', null, rows);
    return this.regionEl(caption, this.el('table', { className: 'table table-sm' }, [this.el('caption', { className: 'sr-only', text: caption }), this.el('thead', null, [head]), body]));
  }

  cell(tag, content, extra, attrs) {
    const el = this.el(tag, { className: 'text-sm' + (extra ? ' ' + extra : ''), attrs: attrs || (tag === 'th' ? { scope: 'row' } : undefined) });
    if (content !== null && content !== undefined) {
      if (typeof content === 'string') el.textContent = content;
      else el.appendChild(content);
    }
    return el;
  }

  mono(textValue, tag) {
    return this.el(tag || 'span', { className: 'font-mono text-xs break-all', text: textValue, attrs: { translate: 'no' } });
  }

  blockEl(title, children) {
    return this.el('div', { className: 'mt-4 flex flex-col gap-2 min-w-0' }, [this.el('h5', { className: 'text-sm font-semibold text-balance', text: title }), ...children]);
  }

  evidenceEl(alert) {
    const { gatesUiMessageEl, gatesUiAppendMessage } = MONITOR_GATES;
    const v = monitorEvidenceView(alert, this.locale);
    const blocks = [];
    if (v.breakdown.length > 0) {
      const tables = v.breakdown.map((dim) =>
        this.tableEl(
          dim.title,
          [{ label: dim.title }, { label: this.t('breakdown.col.requests'), numeric: true }, { label: this.t('breakdown.col.count'), numeric: true }, { label: this.t('breakdown.col.rate'), numeric: true }],
          dim.rows.map((row) =>
            this.el('tr', null, [
              this.cell('th', row.mono ? this.mono(row.label) : row.label, 'font-normal'),
              this.cell('td', row.requests, 'text-right tabular-nums'),
              this.cell('td', row.count, 'text-right tabular-nums'),
              this.cell('td', row.rate, 'text-right tabular-nums'),
            ]),
          ),
        ),
      );
      blocks.push(this.blockEl(this.t('evidence.breakdown'), tables));
    }
    if (v.companions.length > 0) {
      const title = this.t('evidence.companions');
      blocks.push(
        this.blockEl(title, [
          this.tableEl(
            title,
            [{ label: this.t('companions.col.measure') }, { label: MONITOR_GATES.gatesUiLabel('col.measured', this.locale), numeric: true }, { label: this.t('companions.col.usual'), numeric: true }],
            v.companions.map((row) =>
              this.el('tr', null, [
                this.cell('th', row.code ? this.mono(row.measure, 'code') : row.measure, 'font-normal'),
                this.cell('td', row.measured, 'text-right tabular-nums'),
                this.cell('td', row.usual, 'text-right tabular-nums'),
              ]),
            ),
          ),
        ]),
      );
    }
    const changesTitle = this.t('evidence.changes');
    if (v.changes.empty) blocks.push(this.blockEl(changesTitle, [gatesUiMessageEl('p', 'text-sm max-w-prose', v.changes.empty)]));
    else {
      const rows = v.changes.rows.map((row) => {
        const when = row.when ? this.el('time', { text: row.when.text, attrs: { datetime: row.when.iso } }) : '';
        const source = row.source.code ? this.mono(row.source.text, 'code') : row.source.text;
        if (row.unrecorded) {
          return this.el('tr', null, [
            this.cell('th', when, 'font-normal whitespace-nowrap'),
            this.cell('td', source),
            this.cell('td', gatesUiMessageEl('span', 'block max-w-prose break-words', row.unrecorded), '', { colspan: '2' }),
            this.cell('td', row.config ? gatesUiMessageEl('span', 'whitespace-nowrap', row.config) : ''),
          ]);
        }
        const keys = this.el('span', { className: 'flex flex-wrap gap-x-1' });
        row.keys.forEach((key, i) => {
          keys.appendChild(this.mono(key + (i < row.keys.length - 1 ? ',' : ''), 'code'));
        });
        return this.el('tr', null, [
          this.cell('th', when, 'font-normal whitespace-nowrap'),
          this.cell('td', source),
          this.cell('td', keys),
          this.cell('td', row.config ? gatesUiMessageEl('span', 'whitespace-nowrap', row.config) : ''),
          this.cell('td', row.record ? this.mono(row.record) : ''),
        ]);
      });
      blocks.push(
        this.blockEl(changesTitle, [
          this.tableEl(
            changesTitle,
            [{ label: this.t('changes.col.when') }, { label: this.t('changes.col.source') }, { label: this.t('changes.col.keys') }, { label: this.t('changes.col.config') }, { label: this.t('changes.col.record') }],
            rows,
          ),
        ]),
      );
    }
    if (v.traces.ids.length === 0) blocks.push(this.blockEl(v.traces.title, [this.el('p', { className: 'text-sm', text: this.t('traces.none') })]));
    else {
      const list = this.el(
        'ul',
        { className: 'max-h-40 overflow-y-auto flex flex-col gap-1 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', 'aria-label': v.traces.title } },
        v.traces.ids.map((id) => this.el('li', { className: 'min-w-0' }, [this.mono(id, 'code')])),
      );
      const children = [list];
      if (this.clipboard && typeof this.clipboard.writeText === 'function') {
        children.push(
          this.el('div', null, [
            this.el('button', {
              className: 'btn btn-ghost btn-sm',
              text: this.t('action.copyIds'),
              attrs: { type: 'button' },
              on: { click: () => this.copyIds(v.traces.ids) },
            }),
          ]),
        );
      }
      blocks.push(this.blockEl(v.traces.title, children));
    }
    if (v.suggestion) {
      const children = [gatesUiMessageEl('p', 'text-sm max-w-prose break-words', v.suggestion.message)];
      if (v.suggestion.refusalLink) {
        children.push(
          this.el('div', null, [
            this.el('button', { className: 'btn btn-link btn-sm px-0', text: MONITOR_GATES.gatesUiLabel('banner.uncalAction', this.locale), attrs: { type: 'button' }, on: { click: () => this.openRefusal() } }),
          ]),
        );
      }
      blocks.push(this.blockEl(this.t('evidence.suggestion'), children));
    }
    const dl = this.el('dl', { className: 'grid grid-cols-1 md:grid-cols-[auto_1fr] gap-x-6 gap-y-1' });
    for (const row of v.delivery) {
      dl.appendChild(this.el('dt', { className: 'text-xs text-base-content/70 md:text-sm md:text-base-content', text: row.label }));
      dl.appendChild(gatesUiAppendMessage(this.el('dd', { className: 'text-sm mb-1 md:mb-0' }), row.message));
    }
    blocks.push(this.blockEl(this.t('evidence.delivery'), [dl]));
    const summary = this.el('summary', {
      className: 'cursor-pointer text-sm font-semibold w-fit rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      text: this.t('evidence.show'),
    });
    return this.el('details', { className: 'min-w-0' }, [summary, ...blocks]);
  }

  async copyIds(ids) {
    try {
      await this.clipboard.writeText(ids.join('\n'));
      this.setStatus(this.t('copy.done'));
    } catch {
      this.setStatus(MONITOR_GATES.gatesUiMessage('error.generic', this.locale, { status: 'clipboard' }), true);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Settings (UI-SPEC 6.12, decision 28): the monitor group moved from #rag-phase053-settings.

  mountSettings() {
    const view = this.views.settings;
    if (!view) return;
    this.settingsWarnings = this.el('div', { className: 'flex flex-col gap-2 mb-4 empty:mb-0' });
    view.replaceChildren(this.settingsWarnings);
    const block = document.getElementById('rag-phase053-settings');
    const group = (block && block.querySelector('[data-rag-settings-group="monitor"]')) || document.querySelector('[data-rag-settings-group="monitor"]');
    if (group) {
      view.appendChild(group);
      for (const el of group.querySelectorAll('[data-rag-i18n]')) {
        const key = el.getAttribute('data-rag-i18n');
        if (monitorHas(MONITOR_LABELS.en, key) || monitorHas(monitorSharedLabels().en, key)) el.textContent = this.t(key);
      }
      const reveal = group.querySelector('[data-for="RAG_MONITOR_WEBHOOK_SECRET"]');
      if (reveal) reveal.setAttribute('aria-label', MONITOR_GATES.gatesUiLabel('settings.secret.reveal', this.locale));
    }
    const url = document.getElementById('RAG_MONITOR_WEBHOOK_URL');
    this.webhookState = this.el('div', { className: 'flex flex-wrap items-center gap-2 mb-2', attrs: { 'data-monitor-webhook-state': '' } });
    if (url && url.parentNode) url.parentNode.insertBefore(this.webhookState, url);
    else view.appendChild(this.webhookState);
    for (const id of ['RAG_MONITOR', 'RAG_RETRIEVAL_LOG', 'RAG_MONITOR_WEBHOOK_URL']) {
      const input = document.getElementById(id);
      if (input) input.addEventListener('change', () => this.renderSettingsWarnings());
    }
    if (url) url.addEventListener('input', () => this.renderSettingsWarnings());
    this.renderWebhookState();
    this.renderSettingsWarnings();
  }

  renderWebhookState() {
    if (!this.webhookState) return;
    const secrets = this.secrets();
    const urlSet = secrets.has('RAG_MONITOR_WEBHOOK_URL');
    const state = this.el('p', { className: 'text-sm', text: this.t('settings.webhook.state', { state: this.t(urlSet ? 'settings.webhook.stateSet' : 'settings.webhook.stateUnset') }) });
    const children = [state];
    if (urlSet) {
      this.removeButton = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.removeWebhook'), attrs: { type: 'button' }, on: { click: () => this.removeWebhook() } });
      children.push(this.removeButton);
    } else this.removeButton = null;
    this.webhookState.replaceChildren(...children);
    const urlHelp = document.getElementById('rag-monitor-webhook-url-help');
    if (urlHelp) urlHelp.textContent = this.t(urlSet ? 'settings.webhook.set' : 'settings.webhook.help');
    const secretHelp = document.getElementById('rag-monitor-webhook-secret-help');
    if (secretHelp) secretHelp.textContent = secrets.has('RAG_MONITOR_WEBHOOK_SECRET') ? MONITOR_GATES.gatesUiLabel('settings.secret.set', this.locale) : this.t('settings.secret.help');
  }

  async configRequest(path, init) {
    const fetcher =
      this.configFetcher ||
      (async (p, i) => {
        const response = await fetch(p, { ...i, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { ok: response.ok, status: response.status, body };
      });
    return MONITOR_GATES.gatesUiFetch(path, init, { fetcher });
  }

  async removeWebhook() {
    const opener = this.removeButton;
    const confirmed = await MONITOR_GATES.gatesUiConfirm({
      title: this.t('confirm.webhook.title'),
      body: this.t('confirm.webhook.body'),
      keepLabel: this.t('confirm.webhook.keep'),
      confirmLabel: this.t('action.removeWebhook'),
      opener,
      fallbackFocus: this.hosts.status,
      locale: this.locale,
    });
    if (!confirmed) return;
    if (opener) opener.disabled = true;
    const result = await this.configRequest(MONITOR_CONFIG_API, { method: 'POST', body: JSON.stringify({ clear: [MONITOR_WEBHOOK_NAME] }) });
    if (!result.ok) {
      if (opener) opener.disabled = false;
      this.setStatus(this.m('webhook.removeFailed'), true);
      return;
    }
    const secrets = this.secrets();
    if (secrets && typeof secrets.delete === 'function') secrets.delete(MONITOR_WEBHOOK_NAME);
    if (typeof window !== 'undefined' && window.configManager && window.configManager.savedConfig) window.configManager.savedConfig[MONITOR_WEBHOOK_NAME] = '';
    this.renderWebhookState();
    this.setStatus(this.t('webhook.removed'));
    if (this.hosts.status && typeof this.hosts.status.focus === 'function') this.hosts.status.focus();
  }

  renderSettingsWarnings() {
    if (!this.settingsWarnings) return;
    const { gatesUiAlert } = MONITOR_GATES;
    const byId = (id) => document.getElementById(id);
    const monitor = byId('RAG_MONITOR');
    const log = byId('RAG_RETRIEVAL_LOG');
    const url = byId('RAG_MONITOR_WEBHOOK_URL');
    const keys = monitorSettingsWarnings({ monitor: monitor ? monitor.value : 'false', log: log ? log.value : undefined, url: url ? url.value : '' });
    if (url) {
      const invalid = keys.includes('warn.webhookHttps');
      url.classList.toggle('input-error', invalid);
      if (invalid) url.setAttribute('aria-invalid', 'true');
      else url.removeAttribute('aria-invalid');
    }
    this.settingsWarnings.replaceChildren(...keys.map((key) => gatesUiAlert('warning', 'bi-exclamation-triangle', this.m(key), [])));
  }
}

let MONITOR_PANEL_INSTANCE = null;

/** Idempotent: the first call mounts, later calls refresh the selected sub-view and keep its state. */
function initMonitorPanel() {
  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
  const root = document.getElementById('rag-administration-monitor');
  if (!root) return;
  if (!MONITOR_PANEL_INSTANCE) {
    MONITOR_PANEL_INSTANCE = new MonitorPanel(root);
    if (typeof window !== 'undefined') window.monitorPanel = MONITOR_PANEL_INSTANCE;
    MONITOR_PANEL_INSTANCE.mount();
    return;
  }
  MONITOR_PANEL_INSTANCE.refresh();
}

function bindMonitorPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-monitor-bound')) return;
    link.setAttribute('data-monitor-bound', '1');
    link.addEventListener('click', () => initMonitorPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initMonitorPanel = initMonitorPanel;
  bindMonitorPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindMonitorPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initMonitorPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MONITOR_LABELS,
    monitorLabel,
    monitorMessage,
    monitorSummaryView,
    monitorSettingsWarnings,
    monitorAlertView,
    monitorEvidenceView,
    MonitorPanel,
    initMonitorPanel,
  };
}
