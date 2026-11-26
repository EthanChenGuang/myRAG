/**
 * Feedback loop admin card (Phase 5.1.1, UI-SPEC 6.7): operator admins grant domain experts per workspace, set a workspace's
 * retrieval-log level, and run mining or the expired-data purge by hand. Every call goes through ragFetch to an admin-guarded
 * route; a 401 or 403 leaves only the sign-in alert on screen. Server values are inserted with textContent, never as markup.
 * Shared helpers come from review-labelling.js.
 */

let reviewAdminSharedModule = null;
if (typeof require !== 'undefined') {
  try {
    reviewAdminSharedModule = require('./review-labelling.js');
  } catch {
    reviewAdminSharedModule = null;
  }
}

const REVIEW_ADMIN_LABELS = {
  en: {
    "panel.title": "Feedback loop",
    "panel.description": "Decide who may review each workspace’s failed questions and how much the retrieval log keeps for a workspace, and run mining or cleanup by hand. For operator admins.",
    "panel.loading": "Loading…",
    "panel.unavailable": "The feedback loop routes are unavailable right now. Select Reload panel in a moment.",
    "error.changed": "This changed in the meantime. The list has been reloaded.",
    "access.heading": "Experts and logging for one workspace",
    "tenant.label": "Workspace",
    "tenant.other": "Enter a tenant key…",
    "tenant.keyLabel": "Tenant key",
    "tenant.keyHelp": "{o} followed by an organization ID, or {u} followed by a user ID.",
    "tenant.keyInvalid": "This is not a tenant key. Use {o} or {u} followed by an ID.",
    "action.loadTenant": "Load workspace",
    "tenant.single": "This deployment has one knowledge base. Its admins review it without a grant; grant other users here.",
    "tenant.idle": "Enter a tenant key to see its experts and its logging level.",
    "experts.heading": "Experts",
    "experts.caption": "Experts of this workspace",
    "col.expert": "Expert",
    "col.userId": "User ID",
    "col.granted": "Granted",
    "col.noDate": "No date recorded",
    "experts.empty.title": "No experts yet",
    "experts.empty.body": "Nobody can review this workspace’s cases. Enter a user ID below and select Grant access.",
    "experts.multiNote": "In multi-tenant mode nobody sees a workspace’s queue without a grant, admins included. Every grant is recorded with the admin who made it.",
    "grant.label": "User ID",
    "grant.help": "The user’s ID from the Supabase dashboard (Authentication, Users). E-mail addresses are not accepted.",
    "grant.invalid": "A user ID has 36 characters, such as {sample}.",
    "action.grant": "Grant access",
    "grant.running": "Granting…",
    "grant.done": "Access granted.",
    "grant.exists": "This user already has access.",
    "grant.refused": "The server did not accept this grant: {detail}",
    "action.revoke": "Revoke access",
    "action.revokeAria": "Revoke access: {expert}",
    "revoke.title": "Revoke access for {expert}?",
    "revoke.body": "This user stops seeing this workspace’s review cases. Labels already saved are kept. You can grant access again later.",
    "revoke.keep": "Keep access",
    "revoke.running": "Revoking…",
    "revoke.done": "Access revoked.",
    "log.heading": "Retrieval log for this workspace",
    "log.label": "Logging level",
    "log.inherit": "Follow the deployment setting",
    "log.ids": "IDs and scores only: never store the question",
    "log.off": "Off: record nothing for this workspace",
    "log.help": "A workspace can lower the deployment’s level, never raise it. A change applies within a minute.",
    "log.noMining": "With this level, weekly mining adds no new review cases for this workspace.",
    "action.saveLog": "Save logging level",
    "log.saving": "Saving…",
    "log.saved": "Logging level saved: {level}",
    "log.updated": "Last changed: {date}",
    "mining.heading": "Weekly mining",
    "mining.description": "Finds failed questions in the retrieval log and adds them to each workspace’s review queue. Runs for every workspace of this deployment.",
    "mining.uncalibrated": "The score limits behind “Weak matches only” and “Refused despite a close match” are starting values and are not calibrated.",
    "mining.since": "From",
    "mining.until": "To",
    "mining.windowHelp": "31 days at most.",
    "mining.windowInvalid": "Choose a start date before the end date, 31 days apart at most.",
    "action.mine": "Run mining now",
    "mine.title": "Run mining for {since} to {until}?",
    "mine.body": "Expired log rows are deleted first. Then new cases are added to each workspace’s review queue, up to the configured limit per workspace. Running it again for the same week adds nothing twice.",
    "mine.keep": "Keep queues as they are",
    "mine.confirm": "Run mining",
    "mine.running": "Mining…",
    "mine.done": "Mining finished. New cases: {count}",
    "mine.none": "No new cases. Nothing in this window matched, or everything was already in the queues.",
    "mine.off": "Mining is switched off. It needs expert review on and the retrieval log at {level} ({tab}, {card}).",
    "mine.unknown": "No answer from the server. Mining may still be running; look at the review queue in a minute before running it again.",
    "result.caption": "Mining result",
    "col.workspaceHash": "Workspace (hash)",
    "col.reason": "Reason",
    "col.newCases": "New cases",
    "result.hashHelp": "Workspaces are shown as hashes here, never by key or name.",
    "purge.heading": "Expired data",
    "purge.description": "Deletes retrieval log rows older than the retention period and open review cases past their expiry. Labelled cases are kept.",
    "action.purge": "Purge expired data",
    "purge.title": "Purge expired data?",
    "purge.body": "Log rows older than {period} and open review cases past their expiry are deleted for every workspace. This can’t be undone.",
    "purge.period.days": "{days} days",
    "purge.period.generic": "the retention period",
    "purge.keep": "Keep data",
    "purge.running": "Purging…",
    "purge.done": "Purge finished.",
    "purge.caption": "Purge result",
    "col.deleted": "Deleted",
    "col.count": "Count",
    "purge.logRows": "Retrieval log rows",
    "purge.reviewItems": "Open review cases",
    "purge.unknown": "No answer from the server. The purge may still be running; wait a minute before running it again.",
  },
  zh: {
    "panel.title": "反馈闭环",
    "panel.description": "决定谁可以复核各工作区的失败问题、检索日志为某个工作区保留多少内容，并手动运行挖掘或清理。仅供运维管理员使用。",
    "panel.loading": "正在加载…",
    "panel.unavailable": "反馈闭环接口暂时不可用。请稍后选择“重新加载面板”。",
    "error.changed": "此项已被更改，列表已重新加载。",
    "access.heading": "单个工作区的专家与日志",
    "tenant.label": "工作区",
    "tenant.other": "输入租户键…",
    "tenant.keyLabel": "租户键",
    "tenant.keyHelp": "{o} 后接组织 ID，或 {u} 后接用户 ID。",
    "tenant.keyInvalid": "这不是有效的租户键。请使用 {o} 或 {u} 加 ID。",
    "action.loadTenant": "加载工作区",
    "tenant.single": "此部署只有一个知识库。管理员无需授权即可复核；可在此为其他用户授权。",
    "tenant.idle": "输入租户键以查看其专家和日志级别。",
    "experts.heading": "专家",
    "experts.caption": "此工作区的专家",
    "col.expert": "专家",
    "col.userId": "用户 ID",
    "col.granted": "授权时间",
    "col.noDate": "未记录日期",
    "experts.empty.title": "还没有专家",
    "experts.empty.body": "目前没有人能复核此工作区的案例。在下方输入用户 ID，然后选择“授予权限”。",
    "experts.multiNote": "多租户模式下，未经授权任何人都看不到工作区的队列，管理员也不例外。每次授权都会记录操作的管理员。",
    "grant.label": "用户 ID",
    "grant.help": "用户 ID 可在 Supabase 控制台（Authentication，Users）中找到。不接受邮箱地址。",
    "grant.invalid": "用户 ID 为 36 个字符，例如 {sample}。",
    "action.grant": "授予权限",
    "grant.running": "正在授权…",
    "grant.done": "已授予权限。",
    "grant.exists": "该用户已有权限。",
    "grant.refused": "服务器未接受此授权：{detail}",
    "action.revoke": "撤销权限",
    "action.revokeAria": "撤销权限：{expert}",
    "revoke.title": "撤销 {expert} 的权限？",
    "revoke.body": "该用户将不再看到此工作区的复核案例。已保存的标注会保留。之后可以重新授权。",
    "revoke.keep": "保留权限",
    "revoke.running": "正在撤销…",
    "revoke.done": "已撤销权限。",
    "log.heading": "此工作区的检索日志",
    "log.label": "日志级别",
    "log.inherit": "跟随部署设置",
    "log.ids": "仅 ID 和分数：从不保存问题",
    "log.off": "关闭：不为此工作区记录任何内容",
    "log.help": "工作区只能降低部署的级别，不能提高。更改会在一分钟内生效。",
    "log.noMining": "在此级别下，每周挖掘不会为此工作区新增复核案例。",
    "action.saveLog": "保存日志级别",
    "log.saving": "正在保存…",
    "log.saved": "日志级别已保存：{level}",
    "log.updated": "上次更改：{date}",
    "mining.heading": "每周挖掘",
    "mining.description": "在检索日志中找出失败的问题，并加入各工作区的复核队列。对本部署的所有工作区运行。",
    "mining.uncalibrated": "“只有弱匹配”和“有接近的匹配却拒答”所用的分数界限是初始值，尚未校准。",
    "mining.since": "起始日期",
    "mining.until": "结束日期",
    "mining.windowHelp": "最多 31 天。",
    "mining.windowInvalid": "起始日期须早于结束日期，且间隔不超过 31 天。",
    "action.mine": "立即运行挖掘",
    "mine.title": "对 {since} 至 {until} 运行挖掘？",
    "mine.body": "先删除过期的日志行，然后把新案例加入各工作区的复核队列，每个工作区不超过配置的上限。对同一周重复运行不会重复添加。",
    "mine.keep": "保持队列不变",
    "mine.confirm": "运行挖掘",
    "mine.running": "正在挖掘…",
    "mine.done": "挖掘完成。新案例：{count}",
    "mine.none": "没有新案例。此时间段内没有匹配项，或都已在队列中。",
    "mine.off": "挖掘已关闭。需要开启专家复核，并把检索日志设为 {level}（{tab}，{card}）。",
    "mine.unknown": "服务器没有响应。挖掘可能仍在运行；请一分钟后查看复核队列，再决定是否重新运行。",
    "result.caption": "挖掘结果",
    "col.workspaceHash": "工作区（哈希）",
    "col.reason": "原因",
    "col.newCases": "新案例",
    "result.hashHelp": "此处工作区以哈希显示，不显示键或名称。",
    "purge.heading": "过期数据",
    "purge.description": "删除超过保留期的检索日志行，以及已过期的待处理复核案例。已标注的案例会保留。",
    "action.purge": "清除过期数据",
    "purge.title": "清除过期数据？",
    "purge.body": "所有工作区中超过{period}的日志行和已过期的待处理复核案例都将被删除。此操作无法撤销。",
    "purge.period.days": "{days} 天",
    "purge.period.generic": "保留期",
    "purge.keep": "保留数据",
    "purge.running": "正在清除…",
    "purge.done": "清除完成。",
    "purge.caption": "清除结果",
    "col.deleted": "已删除",
    "col.count": "数量",
    "purge.logRows": "检索日志行",
    "purge.reviewItems": "待处理复核案例",
    "purge.unknown": "服务器没有响应。清除可能仍在运行；请等一分钟再重新运行。",
  },
  it: {
    "panel.title": "Ciclo di feedback",
    "panel.description": "Decidi chi può rivedere le domande non riuscite di ogni spazio di lavoro e quanto conserva il registro dei recuperi per uno spazio di lavoro, ed esegui a mano l’estrazione o la pulizia. Per gli amministratori operatori.",
    "panel.loading": "Caricamento…",
    "panel.unavailable": "Le funzioni del ciclo di feedback non sono disponibili in questo momento. Seleziona Ricarica pannello tra poco.",
    "error.changed": "Nel frattempo questo dato è cambiato. L’elenco è stato ricaricato.",
    "access.heading": "Esperti e registro di uno spazio di lavoro",
    "tenant.label": "Spazio di lavoro",
    "tenant.other": "Inserisci una chiave tenant…",
    "tenant.keyLabel": "Chiave tenant",
    "tenant.keyHelp": "{o} seguito dall’ID di un’organizzazione, oppure {u} seguito dall’ID di un utente.",
    "tenant.keyInvalid": "Questa non è una chiave tenant. Usa {o} oppure {u} seguito da un ID.",
    "action.loadTenant": "Carica spazio di lavoro",
    "tenant.single": "Questa installazione ha una sola knowledge base. I suoi amministratori la rivedono senza concessione; concedi qui l’accesso ad altri utenti.",
    "tenant.idle": "Inserisci una chiave tenant per vederne gli esperti e il livello del registro.",
    "experts.heading": "Esperti",
    "experts.caption": "Esperti di questo spazio di lavoro",
    "col.expert": "Esperto",
    "col.userId": "ID utente",
    "col.granted": "Concesso",
    "col.noDate": "Nessuna data registrata",
    "experts.empty.title": "Ancora nessun esperto",
    "experts.empty.body": "Nessuno può rivedere i casi di questo spazio di lavoro. Inserisci un ID utente qui sotto e seleziona Concedi accesso.",
    "experts.multiNote": "In modalità multi-tenant nessuno vede la coda di uno spazio di lavoro senza concessione, amministratori compresi. Ogni concessione viene registrata con l’amministratore che l’ha fatta.",
    "grant.label": "ID utente",
    "grant.help": "L’ID dell’utente dalla dashboard di Supabase (Authentication, Users). Gli indirizzi e-mail non sono accettati.",
    "grant.invalid": "Un ID utente ha 36 caratteri, ad esempio {sample}.",
    "action.grant": "Concedi accesso",
    "grant.running": "Concessione…",
    "grant.done": "Accesso concesso.",
    "grant.exists": "Questo utente ha già l’accesso.",
    "grant.refused": "Il server non ha accettato questa concessione: {detail}",
    "action.revoke": "Revoca accesso",
    "action.revokeAria": "Revoca accesso: {expert}",
    "revoke.title": "Revocare l’accesso a {expert}?",
    "revoke.body": "Questo utente non vedrà più i casi di revisione di questo spazio di lavoro. Le etichette già salvate restano. Potrai concedere di nuovo l’accesso in seguito.",
    "revoke.keep": "Mantieni accesso",
    "revoke.running": "Revoca…",
    "revoke.done": "Accesso revocato.",
    "log.heading": "Registro dei recuperi di questo spazio di lavoro",
    "log.label": "Livello del registro",
    "log.inherit": "Segui l’impostazione dell’installazione",
    "log.ids": "Solo ID e punteggi: la domanda non viene mai salvata",
    "log.off": "Disattivato: non registrare nulla per questo spazio di lavoro",
    "log.help": "Uno spazio di lavoro può abbassare il livello dell’installazione, mai alzarlo. La modifica vale entro un minuto.",
    "log.noMining": "Con questo livello l’estrazione settimanale non aggiunge nuovi casi di revisione per questo spazio di lavoro.",
    "action.saveLog": "Salva livello del registro",
    "log.saving": "Salvataggio…",
    "log.saved": "Livello del registro salvato: {level}",
    "log.updated": "Ultima modifica: {date}",
    "mining.heading": "Estrazione settimanale",
    "mining.description": "Trova nel registro dei recuperi le domande non riuscite e le aggiunge alla coda di revisione di ogni spazio di lavoro. Viene eseguita per tutti gli spazi di lavoro dell’installazione.",
    "mining.uncalibrated": "I limiti di punteggio dietro «Solo corrispondenze deboli» e «Rifiutata nonostante una corrispondenza vicina» sono valori iniziali, non calibrati.",
    "mining.since": "Dal",
    "mining.until": "Al",
    "mining.windowHelp": "Al massimo 31 giorni.",
    "mining.windowInvalid": "Scegli una data di inizio precedente a quella di fine, a non più di 31 giorni di distanza.",
    "action.mine": "Esegui estrazione ora",
    "mine.title": "Eseguire l’estrazione dal {since} al {until}?",
    "mine.body": "Prima vengono eliminate le righe scadute del registro. Poi i nuovi casi vengono aggiunti alla coda di revisione di ogni spazio di lavoro, fino al limite configurato. Rieseguirla per la stessa settimana non aggiunge nulla due volte.",
    "mine.keep": "Lascia le code come sono",
    "mine.confirm": "Esegui estrazione",
    "mine.running": "Estrazione…",
    "mine.done": "Estrazione completata. Nuovi casi: {count}",
    "mine.none": "Nessun nuovo caso. In questo periodo non c’erano corrispondenze, oppure erano già tutte nelle code.",
    "mine.off": "L’estrazione è disattivata. Richiede la revisione degli esperti attiva e il registro dei recuperi su {level} ({tab}, {card}).",
    "mine.unknown": "Nessuna risposta dal server. L’estrazione potrebbe essere ancora in corso: controlla la coda di revisione tra un minuto prima di rieseguirla.",
    "result.caption": "Risultato dell’estrazione",
    "col.workspaceHash": "Spazio di lavoro (hash)",
    "col.reason": "Motivo",
    "col.newCases": "Nuovi casi",
    "result.hashHelp": "Qui gli spazi di lavoro compaiono come hash, mai per chiave o nome.",
    "purge.heading": "Dati scaduti",
    "purge.description": "Elimina le righe del registro dei recuperi più vecchie del periodo di conservazione e i casi di revisione aperti scaduti. I casi etichettati restano.",
    "action.purge": "Elimina dati scaduti",
    "purge.title": "Eliminare i dati scaduti?",
    "purge.body": "Le righe del registro più vecchie di {period} e i casi di revisione aperti scaduti vengono eliminati per tutti gli spazi di lavoro. L’operazione non può essere annullata.",
    "purge.period.days": "{days} giorni",
    "purge.period.generic": "il periodo di conservazione",
    "purge.keep": "Mantieni dati",
    "purge.running": "Eliminazione…",
    "purge.done": "Eliminazione completata.",
    "purge.caption": "Risultato dell’eliminazione",
    "col.deleted": "Eliminato",
    "col.count": "Numero",
    "purge.logRows": "Righe del registro dei recuperi",
    "purge.reviewItems": "Casi di revisione aperti",
    "purge.unknown": "Nessuna risposta dal server. L’eliminazione potrebbe essere ancora in corso: attendi un minuto prima di rieseguirla.",
  },
};

const REVIEW_ADMIN_TIMEOUT_MS = 15000;
const REVIEW_ADMIN_LONG_TIMEOUT_MS = 60000;
const REVIEW_ADMIN_EXPERTS_PATH = '/api/rag/admin/domain-experts';
const REVIEW_ADMIN_SETTINGS_PATH = '/api/rag/admin/feedback-loop/tenant-settings';
const REVIEW_ADMIN_LOG_LEVELS = ['inherit', 'ids', 'off'];
const REVIEW_ADMIN_OTHER = '__other__';
const REVIEW_ADMIN_SINGLE_KEY = 's:default';
const REVIEW_ADMIN_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REVIEW_ADMIN_UUID_RE = new RegExp(`^${REVIEW_ADMIN_UUID}$`, 'i');
const REVIEW_ADMIN_TENANT_RE = new RegExp(`^[ou]:${REVIEW_ADMIN_UUID}$`, 'i');
const REVIEW_ADMIN_SAMPLE_ID = '00000000-0000-0000-0000-000000000000';

function reviewAdminHelpers() {
  if (typeof window !== 'undefined' && typeof window.reviewLabellingEl === 'function') {
    return {
      label: window.reviewLabellingLabel,
      el: window.reviewLabellingEl,
      icon: window.reviewLabellingIcon,
      spinner: window.reviewLabellingSpinner,
      alert: window.reviewLabellingAlert,
      shared: window.reviewLabellingShared,
      resolveLocale: window.reviewLabellingResolveLocale,
      templateNodes: window.reviewLabellingTemplateNodes,
      reasonText: window.reviewLabellingReasonText,
      formatNumber: window.reviewLabellingFormatNumber,
      formatDate: window.reviewLabellingFormatDate,
      nextId: window.reviewLabellingNextId,
      reasons: window.REVIEW_LABELLING_REASONS || [],
    };
  }
  const m = reviewAdminSharedModule;
  if (!m) return null;
  return {
    label: m.reviewLabellingLabel,
    el: m.reviewLabellingEl,
    icon: m.reviewLabellingIcon,
    spinner: m.reviewLabellingSpinner,
    alert: m.reviewLabellingAlert,
    shared: m.reviewLabellingShared,
    resolveLocale: m.reviewLabellingResolveLocale,
    templateNodes: m.reviewLabellingTemplateNodes,
    reasonText: m.reviewLabellingReasonText,
    formatNumber: m.reviewLabellingFormatNumber,
    formatDate: m.reviewLabellingFormatDate,
    nextId: m.reviewLabellingNextId,
    reasons: m.REVIEW_LABELLING_REASONS || [],
  };
}

function reviewAdminLabel(key, locale, vars) {
  const row = REVIEW_ADMIN_LABELS[locale] || REVIEW_ADMIN_LABELS.en;
  const text = row[key] !== undefined ? row[key] : REVIEW_ADMIN_LABELS.en[key] !== undefined ? REVIEW_ADMIN_LABELS.en[key] : key;
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined || vars[name] === null ? match : String(vars[name])));
}

function reviewAdminIsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reviewAdminText(value) {
  return typeof value === 'string' ? value : '';
}

/** Multi-tenant when the Config UI's loaded configuration says so; the page reads the same keys in loadWorkspaces. */
function reviewAdminIsMultiTenant() {
  const config = typeof window !== 'undefined' && reviewAdminIsObject(window.currentConfig) ? window.currentConfig : {};
  return (config.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE || config.MYRAG_DEPLOYMENT_MODE) === 'multi-tenant';
}

/** Workspaces from #workspace-selector: options with an organization id become o:<id>; leading symbols are dropped from the name. */
function reviewAdminWorkspaceOptions(doc) {
  const selector = doc && typeof doc.getElementById === 'function' ? doc.getElementById('workspace-selector') : null;
  if (!selector) return [];
  const seen = new Set();
  const out = [];
  for (const option of selector.querySelectorAll('option')) {
    const value = String(option.getAttribute('value') || '').trim().toLowerCase();
    if (!value || option.hasAttribute('disabled') || !REVIEW_ADMIN_UUID_RE.test(value)) continue;
    const key = `o:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = String(option.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    out.push({ key, name: name || key });
  }
  return out;
}

/** One grant row, named fields only (UI-SPEC 11.3): masked e-mail, user id, creation date. */
function reviewAdminGrantRow(raw) {
  if (!reviewAdminIsObject(raw)) return null;
  const userId = reviewAdminText(raw.user_id);
  if (!userId) return null;
  return { userId, email: reviewAdminText(raw.email) || '***', createdAt: reviewAdminText(raw.created_at) || null };
}

function reviewAdminSettingsRow(body) {
  const settings = reviewAdminIsObject(body) && reviewAdminIsObject(body.settings) ? body.settings : {};
  const level = REVIEW_ADMIN_LOG_LEVELS.includes(settings.retrieval_log) ? settings.retrieval_log : 'inherit';
  return { retrievalLog: level, updatedAt: reviewAdminText(settings.updated_at) || null };
}

function reviewAdminDetail(body) {
  if (!reviewAdminIsObject(body)) return '';
  const details = Array.isArray(body.details) ? body.details : [];
  const first = details.length && reviewAdminIsObject(details[0]) ? reviewAdminText(details[0].message) : '';
  return first || reviewAdminText(body.error);
}

class ReviewAdminPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.h = reviewAdminHelpers();
    this.locale = this.h.resolveLocale(typeof navigator !== 'undefined' && navigator ? navigator.language : 'en');
    this.multi = false;
    this.tenantKey = null;
    this.choice = null;
    this.customKey = '';
    this.rendered = false;
    this.loadToken = 0;
    this.busy = false;
    this.grants = [];
    this.settings = null;
    this.titleEl = root.querySelector('[data-review-admin-title]');
    this.descriptionEl = root.querySelector('[data-review-admin-description]');
    this.alertHost = root.querySelector('[data-review-admin-alert]');
    this.contentHost = root.querySelector('[data-review-admin-content]');
    this.statusHost = root.querySelector('[data-review-admin-status]');
  }

  t(key, vars) {
    return reviewAdminLabel(key, this.locale, vars);
  }

  lt(key, vars) {
    return this.h.label(key, this.locale, vars);
  }

  el(tag, options, children) {
    return this.h.el(this.doc, tag, options, children);
  }

  icon(name, extra) {
    return this.h.icon(this.doc, name, extra);
  }

  mount() {
    this.root.setAttribute('lang', this.locale);
    if (this.titleEl) this.titleEl.textContent = this.t('panel.title');
    if (this.descriptionEl) this.descriptionEl.textContent = this.t('panel.description');
    return this.start();
  }

  refresh() {
    if (!this.rendered) return this.start();
    if (this.tenantKey) return this.loadWorkspace();
    return Promise.resolve(null);
  }

  /** Builds the three blocks and loads the chosen workspace; also the "Reload panel" path after a sign-in or outage alert. */
  start() {
    this.setAlert(null);
    this.announce('');
    this.multi = reviewAdminIsMultiTenant();
    this.render();
    if (this.tenantKey) return this.loadWorkspace();
    return Promise.resolve(null);
  }

  announce(text, options) {
    if (!this.statusHost) return;
    const opts = options || {};
    if (!text) {
      this.statusHost.replaceChildren();
      this.statusHost.classList.remove('text-error');
      return;
    }
    this.statusHost.classList.toggle('text-error', Boolean(opts.error));
    this.statusHost.replaceChildren(
      this.el('span', { className: 'inline-flex items-start gap-1' }, [opts.error ? this.icon('bi-exclamation-circle') : null, this.el('span', { text })]),
    );
  }

  setAlert(node) {
    if (this.alertHost) this.alertHost.replaceChildren(...(node ? [node] : []));
  }

  async request(path, init, timeoutMs) {
    const fetcher = typeof window !== 'undefined' && typeof window.ragFetch === 'function' ? window.ragFetch : null;
    if (!fetcher) return { thrown: true };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || REVIEW_ADMIN_TIMEOUT_MS) : null;
    try {
      const result = await fetcher(path, { ...(init || {}), ...(controller ? { signal: controller.signal } : {}) });
      return result && typeof result === 'object' ? result : { thrown: true };
    } catch {
      return { thrown: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  reloadButton() {
    const button = this.el('button', { className: 'btn btn-sm', text: this.lt('action.reload'), attrs: { type: 'button', 'data-review-admin-reload': true } });
    button.addEventListener('click', () => {
      void this.start();
    });
    return button;
  }

  /** 401 or 403 from any call: the card's content goes, only the shared sign-in sentence stays (UI-SPEC 8.3). */
  showSignIn() {
    this.loadToken += 1;
    this.rendered = false;
    this.busy = false;
    this.grants = [];
    this.settings = null;
    for (const dialog of this.root.querySelectorAll('dialog[data-review-admin-dialog]')) dialog.remove();
    this.contentHost.replaceChildren();
    const sentence = this.h.shared('error.signIn', this.locale);
    this.setAlert(this.h.alert(this.doc, { tone: 'warning', icon: 'bi-person-lock', body: sentence, actions: [this.reloadButton()] }));
    this.announce(sentence, { error: true });
  }

  showUnavailable(sentence) {
    this.setAlert(this.h.alert(this.doc, { tone: 'error', icon: 'bi-exclamation-triangle', body: sentence, actions: [this.reloadButton()] }));
    if (this.workspaceHost) this.workspaceHost.classList.add('opacity-60');
    this.announce(sentence, { error: true });
  }

  /** Shared failure mapping (UI-SPEC 8.3) for statuses no caller handles itself. */
  failure(result) {
    if (result.thrown) {
      this.showUnavailable(this.h.shared('error.network', this.locale));
      return;
    }
    if (result.status === 401 || result.status === 403) {
      this.showSignIn();
      return;
    }
    if (result.status === 503) {
      this.showUnavailable(this.t('panel.unavailable'));
      return;
    }
    if (result.status === 400) {
      this.announce(this.lt('error.invalid', { detail: reviewAdminDetail(result.body) || String(result.status) }), { error: true });
      return;
    }
    this.announce(this.h.shared('error.generic', this.locale, { status: result.status }), { error: true });
  }

  render() {
    this.rendered = true;
    this.contentHost.classList.remove('opacity-60');
    const blocks = [this.renderAccessBlock()];
    for (const extra of this.renderExtraBlocks()) blocks.push(extra);
    this.contentHost.replaceChildren(...blocks);
  }

  renderExtraBlocks() {
    return [];
  }

  heading(text, level) {
    return this.el(level || 'h4', { className: level === 'h5' ? 'text-sm font-semibold mb-2' : 'text-base font-semibold mb-2', text });
  }

  fieldError(id) {
    return this.el('p', { className: 'text-xs text-error mt-1 hidden', attrs: { id, 'data-review-admin-error': true } });
  }

  setFieldError(field, errorEl, nodesOrText) {
    if (!field || !errorEl) return;
    if (!nodesOrText) {
      field.removeAttribute('aria-invalid');
      errorEl.replaceChildren();
      errorEl.classList.add('hidden');
      return;
    }
    field.setAttribute('aria-invalid', 'true');
    errorEl.replaceChildren(...(Array.isArray(nodesOrText) ? nodesOrText : [this.doc.createTextNode(nodesOrText)]));
    errorEl.classList.remove('hidden');
  }

  keyTemplate(key, vars) {
    const code = (text) => this.el('code', { className: 'font-mono text-xs', text, attrs: { translate: 'no' } });
    const template = this.t(key);
    const nodes = [];
    const re = /\{(\w+)\}/g;
    let last = 0;
    let match;
    while ((match = re.exec(template))) {
      if (match.index > last) nodes.push(this.doc.createTextNode(template.slice(last, match.index)));
      const name = match[1];
      if (name === 'o') nodes.push(code('o:'));
      else if (name === 'u') nodes.push(code('u:'));
      else if (name === 'sample') nodes.push(code(REVIEW_ADMIN_SAMPLE_ID));
      else nodes.push(this.doc.createTextNode(vars && vars[name] !== undefined ? String(vars[name]) : match[0]));
      last = re.lastIndex;
    }
    if (last < template.length) nodes.push(this.doc.createTextNode(template.slice(last)));
    return nodes;
  }

  renderAccessBlock() {
    const block = this.el('div', { attrs: { 'data-review-admin-block': 'access' } }, [this.heading(this.t('access.heading'))]);
    if (!this.multi) {
      this.tenantKey = REVIEW_ADMIN_SINGLE_KEY;
      block.appendChild(this.el('p', { className: 'text-sm text-base-content/70 mb-4 max-w-prose', text: this.t('tenant.single') }));
    } else {
      block.appendChild(this.renderTenantChooser());
    }
    this.workspaceHost = this.el('div', { attrs: { 'data-review-admin-workspace': true } });
    if (this.multi && !this.tenantKey) {
      this.workspaceHost.appendChild(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('tenant.idle'), attrs: { 'data-review-admin-idle': true } }));
    }
    block.appendChild(this.workspaceHost);
    return block;
  }

  renderTenantChooser() {
    const workspaces = reviewAdminWorkspaceOptions(this.doc);
    const keys = workspaces.map((w) => w.key);
    if (this.choice === null || (this.choice !== REVIEW_ADMIN_OTHER && !keys.includes(this.choice))) {
      this.choice = workspaces.length ? workspaces[0].key : REVIEW_ADMIN_OTHER;
      this.tenantKey = workspaces.length ? workspaces[0].key : null;
    }
    const wrap = this.el('div', { className: 'flex flex-col gap-4 mb-4' });
    const selectId = this.h.nextId('review-admin-tenant');
    const select = this.el('select', { className: 'select select-bordered select-sm w-full max-w-md', attrs: { id: selectId, 'data-review-admin-tenant': true } });
    for (const workspace of workspaces) select.appendChild(this.el('option', { text: workspace.name, attrs: { value: workspace.key } }));
    select.appendChild(this.el('option', { text: this.t('tenant.other'), attrs: { value: REVIEW_ADMIN_OTHER } }));
    select.value = this.choice;
    wrap.appendChild(
      this.el('div', { className: 'form-control' }, [
        this.el('label', { className: 'label', attrs: { for: selectId } }, [this.el('span', { className: 'label-text', text: this.t('tenant.label') })]),
        select,
      ]),
    );
    const keyHost = this.el('div', { attrs: { 'data-review-admin-key-host': true } });
    wrap.appendChild(keyHost);
    const renderKey = () => {
      keyHost.replaceChildren();
      if (this.choice !== REVIEW_ADMIN_OTHER) return;
      const inputId = this.h.nextId('review-admin-key');
      const helpId = `${inputId}-help`;
      const errorId = `${inputId}-error`;
      const field = this.el('input', {
        className: 'input input-bordered input-sm w-full max-w-md font-mono',
        attrs: { id: inputId, type: 'text', autocomplete: 'off', spellcheck: 'false', translate: 'no', 'aria-describedby': `${helpId} ${errorId}`, 'data-review-admin-key': true },
      });
      field.value = this.customKey;
      const error = this.fieldError(errorId);
      const load = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.loadTenant'), attrs: { type: 'button', 'data-review-admin-load': true } });
      const submit = () => {
        const value = String(field.value || '').trim();
        this.customKey = value;
        if (!REVIEW_ADMIN_TENANT_RE.test(value)) {
          this.setFieldError(field, error, this.keyTemplate('tenant.keyInvalid'));
          field.focus();
          return;
        }
        this.setFieldError(field, error, null);
        this.tenantKey = value.toLowerCase();
        void this.loadWorkspace();
      };
      field.addEventListener('input', () => {
        this.customKey = String(field.value || '');
      });
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      load.addEventListener('click', submit);
      keyHost.appendChild(
        this.el('div', { className: 'form-control' }, [
          this.el('label', { className: 'label', attrs: { for: inputId } }, [this.el('span', { className: 'label-text', text: this.t('tenant.keyLabel') })]),
          this.el('div', { className: 'flex flex-wrap items-start gap-2' }, [field, load]),
          this.el('p', { className: 'text-xs text-base-content/70 mt-1', attrs: { id: helpId } }, this.keyTemplate('tenant.keyHelp')),
          error,
        ]),
      );
    };
    select.addEventListener('change', () => {
      this.choice = String(select.value || '');
      this.announce('');
      renderKey();
      if (this.choice === REVIEW_ADMIN_OTHER) {
        this.tenantKey = null;
        this.loadToken += 1;
        if (this.workspaceHost) {
          this.workspaceHost.classList.remove('opacity-60');
          this.workspaceHost.replaceChildren(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('tenant.idle'), attrs: { 'data-review-admin-idle': true } }));
        }
        return;
      }
      this.tenantKey = this.choice;
      void this.loadWorkspace();
    });
    renderKey();
    return wrap;
  }

  tenantQuery(base) {
    return `${base}?tenantKey=${encodeURIComponent(this.tenantKey)}`;
  }

  /** Reads the grants and the logging level of the chosen workspace; a newer load drops an older one's answers. */
  async loadWorkspace() {
    if (!this.tenantKey || !this.workspaceHost) return null;
    const token = ++this.loadToken;
    const host = this.workspaceHost;
    if (host.querySelector('[data-review-admin-experts-block]')) {
      host.classList.add('opacity-60');
      host.setAttribute('aria-busy', 'true');
    } else {
      host.replaceChildren(this.h.spinner(this.doc, this.t('panel.loading')));
    }
    this.announce(this.t('panel.loading'));
    const experts = await this.request(this.tenantQuery(REVIEW_ADMIN_EXPERTS_PATH), { method: 'GET' });
    if (token !== this.loadToken) return null;
    if (!experts.ok) return this.loadFailed(experts);
    const settings = await this.request(this.tenantQuery(REVIEW_ADMIN_SETTINGS_PATH), { method: 'GET' });
    if (token !== this.loadToken) return null;
    if (!settings.ok && settings.status !== 404) return this.loadFailed(settings);
    host.classList.remove('opacity-60');
    host.removeAttribute('aria-busy');
    this.setAlert(null);
    const list = reviewAdminIsObject(experts.body) && Array.isArray(experts.body.grants) ? experts.body.grants : [];
    this.grants = list.map(reviewAdminGrantRow).filter(Boolean);
    this.settings = settings.ok ? reviewAdminSettingsRow(settings.body) : { retrievalLog: 'inherit', updatedAt: null };
    this.renderWorkspace();
    this.announce('');
    return null;
  }

  loadFailed(result) {
    if (this.workspaceHost) {
      this.workspaceHost.removeAttribute('aria-busy');
      if (!this.workspaceHost.querySelector('[data-review-admin-experts-block]')) this.workspaceHost.replaceChildren();
    }
    this.failure(result);
    return null;
  }

  renderWorkspace() {
    this.workspaceHost.replaceChildren(this.renderExperts(), this.renderLogLevel());
  }

  renderExperts() {
    const block = this.el('div', { attrs: { 'data-review-admin-experts-block': true } }, [this.heading(this.t('experts.heading'), 'h5')]);
    if (!this.grants.length) {
      block.appendChild(
        this.el('div', { className: 'py-8 text-center', attrs: { 'data-review-admin-experts-empty': true } }, [
          this.el('p', { className: 'text-base font-semibold', text: this.t('experts.empty.title') }),
          this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: this.t('experts.empty.body') }),
        ]),
      );
    } else {
      const head = this.el('tr', {}, [
        this.el('th', { className: 'text-xs font-semibold', text: this.t('col.expert'), attrs: { scope: 'col' } }),
        this.el('th', { className: 'text-xs font-semibold', text: this.t('col.userId'), attrs: { scope: 'col' } }),
        this.el('th', { className: 'text-xs font-semibold', text: this.t('col.granted'), attrs: { scope: 'col' } }),
        this.el('th', { attrs: { scope: 'col' } }, [this.el('span', { className: 'sr-only', text: this.t('action.revoke') })]),
      ]);
      const rows = this.grants.map((grant) => this.renderGrantRow(grant));
      const table = this.el('table', { className: 'table table-sm', attrs: { 'data-review-admin-experts': true } }, [
        this.el('caption', { className: 'sr-only', text: this.t('experts.caption') }),
        this.el('thead', {}, [head]),
        this.el('tbody', {}, rows),
      ]);
      block.appendChild(
        this.el(
          'div',
          {
            className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
            attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('experts.caption') },
          },
          [table],
        ),
      );
    }
    if (this.multi) block.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-2 max-w-prose', text: this.t('experts.multiNote') }));
    block.appendChild(this.renderGrantForm());
    return block;
  }

  renderGrantRow(grant) {
    const granted = grant.createdAt
      ? this.el('time', { text: this.h.formatDate(grant.createdAt, this.locale), attrs: { datetime: grant.createdAt } })
      : this.el('span', {}, [this.el('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), this.el('span', { className: 'sr-only', text: this.t('col.noDate') })]);
    const revoke = this.el('button', {
      className: 'btn btn-outline md:btn-sm',
      text: this.t('action.revoke'),
      attrs: { type: 'button', 'aria-label': this.t('action.revokeAria', { expert: grant.email }), 'data-review-admin-revoke': true, 'data-review-admin-action': true },
    });
    revoke.addEventListener('click', () => this.confirmRevoke(grant, revoke));
    return this.el('tr', { attrs: { 'data-review-admin-expert': true } }, [
      this.el('th', { className: 'font-normal break-words', text: grant.email, attrs: { scope: 'row', translate: 'no' } }),
      this.el('td', { className: 'font-mono text-xs break-all', text: grant.userId, attrs: { translate: 'no' } }),
      this.el('td', { className: 'whitespace-nowrap' }, [granted]),
      this.el('td', { className: 'text-right' }, [revoke]),
    ]);
  }

  renderGrantForm() {
    const inputId = this.h.nextId('review-admin-grant');
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;
    const field = this.el('input', {
      className: 'input input-bordered input-sm w-full max-w-md font-mono',
      attrs: { id: inputId, type: 'text', autocomplete: 'off', spellcheck: 'false', translate: 'no', 'aria-describedby': `${helpId} ${errorId}`, 'data-review-admin-grant-input': true },
    });
    const error = this.fieldError(errorId);
    const button = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.grant'), attrs: { type: 'button', 'data-review-admin-grant': true, 'data-review-admin-action': true } });
    const submit = () => this.grant(field, error, button);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    });
    button.addEventListener('click', () => {
      void submit();
    });
    return this.el('div', { className: 'form-control mt-4' }, [
      this.el('label', { className: 'label', attrs: { for: inputId } }, [this.el('span', { className: 'label-text', text: this.t('grant.label') })]),
      this.el('div', { className: 'flex flex-wrap items-start gap-2' }, [field, button]),
      this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', text: this.t('grant.help'), attrs: { id: helpId } }),
      error,
    ]);
  }

  setBusy(busy, button, text) {
    this.busy = busy;
    for (const control of this.contentHost.querySelectorAll('[data-review-admin-action]')) control.disabled = busy;
    if (!button) return;
    if (busy) {
      button.setAttribute('data-review-admin-label', button.textContent);
      button.replaceChildren(this.h.spinner(this.doc, text));
    } else if (button.hasAttribute('data-review-admin-label')) {
      button.textContent = button.getAttribute('data-review-admin-label');
      button.removeAttribute('data-review-admin-label');
    }
  }

  async grant(field, error, button) {
    if (this.busy || !this.tenantKey) return;
    const value = String(field.value || '').trim();
    if (!REVIEW_ADMIN_UUID_RE.test(value)) {
      this.setFieldError(field, error, this.keyTemplate('grant.invalid'));
      field.focus();
      return;
    }
    this.setFieldError(field, error, null);
    this.setBusy(true, button, this.t('grant.running'));
    const result = await this.request(REVIEW_ADMIN_EXPERTS_PATH, { method: 'POST', body: JSON.stringify({ tenantKey: this.tenantKey, userId: value }) });
    this.setBusy(false, button);
    if (result.ok) {
      const message = result.status === 201 ? this.t('grant.done') : this.t('grant.exists');
      await this.loadWorkspace();
      this.announce(message);
      return;
    }
    if (result.status === 400) {
      this.setFieldError(field, error, this.t('grant.refused', { detail: reviewAdminDetail(result.body) || String(result.status) }));
      field.focus();
      return;
    }
    if (result.thrown) {
      await this.loadWorkspace();
      if (this.rendered) this.announce(this.h.shared('error.network', this.locale), { error: true });
      return;
    }
    this.failure(result);
  }

  /** A confirmation dialog (UI-SPEC 9.9, 12.1): focus starts on the "Keep…" button; while the action runs, Escape does nothing. */
  confirmAction({ kind, title, body, keep, confirm, confirmClass, runningText, opener, action }) {
    const titleId = this.h.nextId(`review-admin-${kind}-title`);
    const bodyId = this.h.nextId(`review-admin-${kind}-body`);
    const keepButton = this.el('button', { className: 'btn btn-sm btn-ghost', text: keep, attrs: { type: 'button', autofocus: true, 'data-review-admin-dialog-keep': true } });
    const confirmButton = this.el('button', { className: `btn btn-sm ${confirmClass}`, text: confirm, attrs: { type: 'button', 'data-review-admin-dialog-confirm': true } });
    const backdropButton = this.el('button', { text: keep, attrs: { type: 'button', tabindex: '-1' } });
    const dialog = this.el('dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': bodyId, 'data-review-admin-dialog': kind } }, [
      this.el('div', { className: 'modal-box overscroll-contain' }, [
        this.el('h3', { className: 'text-base font-semibold break-words', text: title, attrs: { id: titleId } }),
        this.el('p', { className: 'text-sm mt-2 max-w-prose', text: body, attrs: { id: bodyId } }),
        this.el('div', { className: 'modal-action flex-wrap' }, [keepButton, confirmButton]),
      ]),
      this.el('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]),
    ]);
    if (typeof dialog.showModal !== 'function') return;
    let running = false;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (opener && opener.isConnected) opener.focus();
      else if (this.statusHost) {
        this.statusHost.setAttribute('tabindex', '-1');
        this.statusHost.focus();
      }
    };
    const cancel = () => {
      if (!running) finish();
    };
    keepButton.addEventListener('click', cancel);
    backdropButton.addEventListener('click', cancel);
    dialog.addEventListener('cancel', (event) => {
      if (running && event && typeof event.preventDefault === 'function') event.preventDefault();
      else cancel();
    });
    dialog.addEventListener('close', () => {
      if (!running) finish();
    });
    confirmButton.addEventListener('click', async () => {
      if (running) return;
      running = true;
      keepButton.disabled = true;
      confirmButton.disabled = true;
      confirmButton.replaceChildren(this.h.spinner(this.doc, runningText));
      try {
        await action();
      } finally {
        running = false;
        finish();
      }
    });
    this.root.appendChild(dialog);
    dialog.showModal();
    keepButton.focus();
  }

  confirmRevoke(grant, opener) {
    if (this.busy) return;
    this.confirmAction({
      kind: 'revoke',
      title: this.t('revoke.title', { expert: grant.email }),
      body: this.t('revoke.body'),
      keep: this.t('revoke.keep'),
      confirm: this.t('action.revoke'),
      confirmClass: 'btn-primary',
      runningText: this.t('revoke.running'),
      opener,
      action: () => this.revoke(grant),
    });
  }

  async revoke(grant) {
    this.setBusy(true);
    const result = await this.request(REVIEW_ADMIN_EXPERTS_PATH, { method: 'DELETE', body: JSON.stringify({ tenantKey: this.tenantKey, userId: grant.userId }) });
    this.setBusy(false);
    if (result.ok) {
      await this.loadWorkspace();
      if (this.rendered) this.announce(this.t('revoke.done'));
      return;
    }
    if (result.status === 404) {
      await this.loadWorkspace();
      if (this.rendered) this.announce(this.t('error.changed'), { error: true });
      return;
    }
    if (result.thrown) {
      await this.loadWorkspace();
      if (this.rendered) this.announce(this.h.shared('error.network', this.locale), { error: true });
      return;
    }
    this.failure(result);
  }

  levelText(level) {
    return this.t(`log.${level}`);
  }

  renderLogLevel() {
    const selectId = this.h.nextId('review-admin-log');
    const helpId = `${selectId}-help`;
    const select = this.el('select', { className: 'select select-bordered select-sm w-full max-w-md', attrs: { id: selectId, 'aria-describedby': helpId, 'data-review-admin-log': true } });
    for (const level of REVIEW_ADMIN_LOG_LEVELS) select.appendChild(this.el('option', { text: this.levelText(level), attrs: { value: level } }));
    select.value = this.settings.retrievalLog;
    const noMining = this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', text: this.t('log.noMining'), attrs: { 'data-review-admin-no-mining': true } });
    const noMiningHost = this.el('div');
    const updated = this.el('p', { className: 'text-xs text-base-content/70 mt-1', attrs: { 'data-review-admin-updated': true } });
    const sync = () => {
      noMiningHost.replaceChildren(...(select.value === 'inherit' ? [] : [noMining]));
      if (this.settings.updatedAt) updated.textContent = this.t('log.updated', { date: this.h.formatDate(this.settings.updatedAt, this.locale) });
      else updated.textContent = '';
    };
    const save = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.saveLog'), attrs: { type: 'button', 'data-review-admin-save-log': true, 'data-review-admin-action': true } });
    save.addEventListener('click', () => {
      void this.saveLogLevel(select, save, sync);
    });
    select.addEventListener('change', sync);
    const control = this.el('div', { className: 'form-control' }, [
      this.el('label', { className: 'label', attrs: { for: selectId } }, [this.el('span', { className: 'label-text', text: this.t('log.label') })]),
      select,
      noMiningHost,
      this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', text: this.t('log.help'), attrs: { id: helpId } }),
    ]);
    const block = this.el('div', { className: 'mt-6', attrs: { 'data-review-admin-log-block': true } }, [
      this.heading(this.t('log.heading'), 'h5'),
      control,
      updated,
      this.el('div', { className: 'mt-4' }, [save]),
    ]);
    sync();
    return block;
  }

  async saveLogLevel(select, button, sync) {
    if (this.busy || !this.tenantKey) return;
    const level = REVIEW_ADMIN_LOG_LEVELS.includes(select.value) ? select.value : 'inherit';
    this.setBusy(true, button, this.t('log.saving'));
    const result = await this.request(REVIEW_ADMIN_SETTINGS_PATH, { method: 'PUT', body: JSON.stringify({ tenantKey: this.tenantKey, retrievalLog: level }) });
    this.setBusy(false, button);
    if (result.ok) {
      this.settings = reviewAdminSettingsRow(result.body);
      select.value = this.settings.retrievalLog;
      sync();
      this.announce(this.t('log.saved', { level: this.levelText(this.settings.retrievalLog) }));
      return;
    }
    if (result.thrown) {
      await this.loadWorkspace();
      if (this.rendered) this.announce(this.h.shared('error.network', this.locale), { error: true });
      return;
    }
    this.failure(result);
  }
}

let reviewAdminPanelInstance = null;

function initReviewAdminPanel() {
  if (typeof document === 'undefined') return Promise.resolve(null);
  const root = document.getElementById('rag-administration-feedback-loop');
  if (!root || !reviewAdminHelpers()) return Promise.resolve(null);
  if (!reviewAdminPanelInstance) {
    reviewAdminPanelInstance = new ReviewAdminPanel(root);
    if (typeof window !== 'undefined') window.reviewAdminPanel = reviewAdminPanelInstance;
    return reviewAdminPanelInstance.mount();
  }
  return reviewAdminPanelInstance.refresh();
}

function reviewAdminBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-review-admin-bound')) return;
    link.setAttribute('data-review-admin-bound', '1');
    link.addEventListener('click', () => {
      void initReviewAdminPanel();
    });
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initReviewAdminPanel = initReviewAdminPanel;
  reviewAdminBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    reviewAdminBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) void initReviewAdminPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REVIEW_ADMIN_LABELS,
    ReviewAdminPanel,
    initReviewAdminPanel,
    reviewAdminLabel,
    reviewAdminWorkspaceOptions,
    reviewAdminGrantRow,
    reviewAdminSettingsRow,
  };
}
