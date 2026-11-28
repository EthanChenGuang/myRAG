/**
 * Upload approvals panel (UI-SPEC 6.6; D-36, D-37, D-50, D-56). Pending uploads of the workspace chosen under Document
 * Processing, the exemptions of that workspace and the RAG_UPLOAD_APPROVAL setting. Every server string is set as text
 * through the rag-ui.js element builder.
 */

const UPLOAD_APPROVALS_LABELS = {
  en: {
    'panel.title': 'Upload approvals',
    'panel.description':
      'Uploads that wait for an admin before they can be searched. A waiting upload is fully processed and held out of answers. Follows the workspace chosen under Document Processing.',
    'panel.workspaceDefault': 'Default workspace',
    'tabs.label': 'Upload approval views',
    'tab.pending': 'Pending: {count}',
    'tab.exemptions': 'Exemptions',
    'tab.settings': 'Settings',
    'col.file': 'File',
    'col.uploader': 'Uploaded by',
    'col.source': 'Source',
    'col.docType': 'Document type',
    'col.uploaded': 'Uploaded',
    'col.actions': 'Actions',
    'list.caption': 'Uploads awaiting approval',
    'pending.reason': 'Held out of answers until an admin approves it.',
    'pending.newVersion': 'New version of a document in use. The current version keeps answering until you approve.',
    'action.approve': 'Approve upload',
    'action.approveAria': 'Approve upload: {file}',
    'approve.running': 'Approving…',
    'approve.done': '{file} is approved and searchable.',
    'action.reject': 'Reject upload',
    'action.rejectAria': 'Reject upload: {file}',
    'action.keepUpload': 'Keep upload',
    'reject.title': 'Reject {file}?',
    'reject.body': 'The upload is removed and never becomes searchable. The uploader is not notified. This can’t be undone.',
    'reject.running': 'Rejecting…',
    'reject.done': '{file} is rejected and removed.',
    'pending.off': 'Upload approval is off, so uploads become searchable as soon as they are processed.',
    'pending.openSettings': 'Open approval settings',
    'pending.quarantineNote': 'Uploads that are also quarantined are listed under Quarantine. Releasing one there approves it.',
    'pending.empty.title': 'No uploads awaiting approval',
    'pending.empty.body': 'Uploads that need approval appear here. Until approved they are held out of answers.',
    'list.loading': 'Loading uploads…',
    'list.unavailable': 'Upload approvals are unavailable right now. Select Reload panel in a moment.',
    'action.refresh': 'Refresh uploads',
    'action.loadMore': 'Load more uploads',
    'uploader.none': 'Unknown uploader',
    'source.upload': 'Upload',
    'source.chat_upload': 'Chat upload',
    'source.config_upload': 'Config UI upload',
    'source.image_upload': 'Image upload',
    'source.nango': 'Cloud connector',
    'source.whatsapp': 'WhatsApp',
    'exempt.caption': 'Exemptions of this workspace',
    'exempt.formLabel': 'New exemption',
    'exempt.kindLabel': 'Kind',
    'exempt.kind.connector': 'Connector',
    'exempt.kind.uploader': 'Uploader',
    'exempt.nameLabel': 'Name',
    'exempt.addedBy': 'Added by',
    'exempt.added': 'Added',
    'exempt.chooseKind': 'Choose a kind',
    'exempt.chooseName': 'Choose a name',
    'exempt.needBoth': 'Choose a kind and a name to add an exemption.',
    'exempt.noChoices': 'Nothing of this kind can be exempted in this workspace.',
    'exempt.help': 'Uploads from an exempt connector or uploader skip approval and become searchable when processed.',
    'exempt.empty': 'No exemptions. Every gated upload waits for approval.',
    'exempt.loading': 'Loading exemptions…',
    'exempt.unavailable': 'Exemptions are unavailable right now. Select Reload panel in a moment.',
    'exempt.loaded': 'Exemptions: {count}',
    'action.addExemption': 'Add exemption',
    'exempt.adding': 'Adding…',
    'action.removeExemption': 'Remove exemption',
    'action.removeExemptionAria': 'Remove exemption: {name}',
    'exempt.removing': 'Removing…',
    'exempt.addedDone': 'Exemption added: {name}.',
    'exempt.exists': 'Already exempt: {name}.',
    'exempt.removed': 'Exemption removed: {name}. Their next uploads wait for approval.',
    'warn.approvalLegacy':
      'Upload approval needs the unified ingest pipeline. With the legacy pipeline, knowledge-base uploads are refused while approval is on.',
  },
  zh: {
    'panel.title': '上传审批',
    'panel.description': '需要管理员批准后才能被检索的上传。等待中的上传已处理完毕，但不会进入回答。跟随“文档处理”中选择的工作区。',
    'panel.workspaceDefault': '默认工作区',
    'tabs.label': '上传审批视图',
    'tab.pending': '待批准：{count}',
    'tab.exemptions': '免审批',
    'tab.settings': '设置',
    'col.file': '文件',
    'col.uploader': '上传者',
    'col.source': '来源',
    'col.docType': '文档类型',
    'col.uploaded': '上传时间',
    'col.actions': '操作',
    'list.caption': '等待批准的上传',
    'pending.reason': '在管理员批准之前不会进入回答。',
    'pending.newVersion': '这是一份使用中文档的新版本。批准之前，仍由当前版本回答。',
    'action.approve': '批准上传',
    'action.approveAria': '批准上传：{file}',
    'approve.running': '正在批准…',
    'approve.done': '{file} 已批准，可以检索。',
    'action.reject': '拒绝上传',
    'action.rejectAria': '拒绝上传：{file}',
    'action.keepUpload': '保留上传',
    'reject.title': '要拒绝 {file} 吗？',
    'reject.body': '该上传将被移除，永远不会被检索到。系统不会通知上传者。此操作无法撤销。',
    'reject.running': '正在拒绝…',
    'reject.done': '{file} 已拒绝并移除。',
    'pending.off': '上传审批已关闭，上传处理完成后立即可以检索。',
    'pending.openSettings': '打开审批设置',
    'pending.quarantineNote': '同时被隔离的上传列在“隔离区”中。在那里解除隔离即表示批准。',
    'pending.empty.title': '没有等待批准的上传',
    'pending.empty.body': '需要批准的上传会显示在这里。批准之前它们不会进入回答。',
    'list.loading': '正在加载上传…',
    'list.unavailable': '暂时无法获取上传审批。请稍后选择“重新加载面板”。',
    'action.refresh': '刷新上传列表',
    'action.loadMore': '加载更多上传',
    'uploader.none': '未知上传者',
    'source.upload': '上传',
    'source.chat_upload': '聊天上传',
    'source.config_upload': '配置界面上传',
    'source.image_upload': '图片上传',
    'source.nango': '云盘连接器',
    'source.whatsapp': 'WhatsApp',
    'exempt.caption': '此工作区的免审批项',
    'exempt.formLabel': '新的免审批',
    'exempt.kindLabel': '类型',
    'exempt.kind.connector': '连接器',
    'exempt.kind.uploader': '上传者',
    'exempt.nameLabel': '名称',
    'exempt.addedBy': '添加者',
    'exempt.added': '添加时间',
    'exempt.chooseKind': '选择类型',
    'exempt.chooseName': '选择名称',
    'exempt.needBoth': '请选择类型和名称后再添加免审批。',
    'exempt.noChoices': '此工作区中没有可免审批的此类项目。',
    'exempt.help': '来自免审批连接器或上传者的上传无需批准，处理完成后即可检索。',
    'exempt.empty': '没有免审批项。所有受管控的上传都需等待批准。',
    'exempt.loading': '正在加载免审批项…',
    'exempt.unavailable': '暂时无法获取免审批项。请稍后选择“重新加载面板”。',
    'exempt.loaded': '免审批项：{count}',
    'action.addExemption': '添加免审批',
    'exempt.adding': '正在添加…',
    'action.removeExemption': '移除免审批',
    'action.removeExemptionAria': '移除免审批：{name}',
    'exempt.removing': '正在移除…',
    'exempt.addedDone': '已添加免审批：{name}。',
    'exempt.exists': '已在免审批中：{name}。',
    'exempt.removed': '已移除免审批：{name}。其后续上传需等待批准。',
    'warn.approvalLegacy': '上传审批需要统一入库流程。在旧版流程下，开启审批期间知识库上传会被拒绝。',
    'RAG_UPLOAD_APPROVAL.label': '需要批准的上传',
    'RAG_UPLOAD_APPROVAL.help': '管理员自己的上传以及免审批的连接器或上传者无需等待。',
    'RAG_UPLOAD_APPROVAL.opt.off': '无',
    'RAG_UPLOAD_APPROVAL.opt.members': '成员的上传',
    'RAG_UPLOAD_APPROVAL.opt.all': '所有上传',
  },
  it: {
    'panel.title': 'Approvazione dei caricamenti',
    'panel.description':
      'Caricamenti che attendono un amministratore prima di poter essere cercati. Un caricamento in attesa è già elaborato ma escluso dalle risposte. Segue lo spazio di lavoro scelto in Document Processing.',
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'tabs.label': 'Viste dell’approvazione dei caricamenti',
    'tab.pending': 'In attesa: {count}',
    'tab.exemptions': 'Esenzioni',
    'tab.settings': 'Impostazioni',
    'col.file': 'File',
    'col.uploader': 'Caricato da',
    'col.source': 'Origine',
    'col.docType': 'Tipo di documento',
    'col.uploaded': 'Caricato il',
    'col.actions': 'Azioni',
    'list.caption': 'Caricamenti in attesa di approvazione',
    'pending.reason': 'Escluso dalle risposte finché un amministratore non lo approva.',
    'pending.newVersion': 'Nuova versione di un documento in uso. La versione attuale continua a rispondere finché non approvi.',
    'action.approve': 'Approva caricamento',
    'action.approveAria': 'Approva caricamento: {file}',
    'approve.running': 'Approvazione…',
    'approve.done': '{file} è approvato e ricercabile.',
    'action.reject': 'Rifiuta caricamento',
    'action.rejectAria': 'Rifiuta caricamento: {file}',
    'action.keepUpload': 'Mantieni caricamento',
    'reject.title': 'Rifiutare {file}?',
    'reject.body':
      'Il caricamento viene rimosso e non diventerà mai ricercabile. Chi lo ha caricato non riceve notifiche. L’operazione non può essere annullata.',
    'reject.running': 'Rifiuto in corso…',
    'reject.done': '{file} è stato rifiutato e rimosso.',
    'pending.off': 'L’approvazione dei caricamenti è disattivata: i caricamenti diventano ricercabili appena elaborati.',
    'pending.openSettings': 'Apri le impostazioni di approvazione',
    'pending.quarantineNote': 'I caricamenti che sono anche in quarantena sono elencati in Quarantena. Rilasciarli lì li approva.',
    'pending.empty.title': 'Nessun caricamento in attesa di approvazione',
    'pending.empty.body': 'Qui appaiono i caricamenti che richiedono approvazione. Finché non sono approvati restano esclusi dalle risposte.',
    'list.loading': 'Caricamento dei caricamenti in attesa…',
    'list.unavailable': 'Le approvazioni non sono disponibili. Seleziona Ricarica pannello tra poco.',
    'action.refresh': 'Aggiorna i caricamenti',
    'action.loadMore': 'Carica altri caricamenti',
    'uploader.none': 'Utente sconosciuto',
    'source.upload': 'Caricamento',
    'source.chat_upload': 'Caricamento in chat',
    'source.config_upload': 'Caricamento da Config UI',
    'source.image_upload': 'Caricamento di immagini',
    'source.nango': 'Connettore cloud',
    'source.whatsapp': 'WhatsApp',
    'exempt.caption': 'Esenzioni di questo spazio di lavoro',
    'exempt.formLabel': 'Nuova esenzione',
    'exempt.kindLabel': 'Tipo',
    'exempt.kind.connector': 'Connettore',
    'exempt.kind.uploader': 'Utente',
    'exempt.nameLabel': 'Nome',
    'exempt.addedBy': 'Aggiunta da',
    'exempt.added': 'Aggiunta il',
    'exempt.chooseKind': 'Scegli un tipo',
    'exempt.chooseName': 'Scegli un nome',
    'exempt.needBoth': 'Scegli un tipo e un nome per aggiungere un’esenzione.',
    'exempt.noChoices': 'In questo spazio di lavoro non c’è nulla di questo tipo da esentare.',
    'exempt.help':
      'I caricamenti di un connettore o di un utente esente saltano l’approvazione e diventano ricercabili dopo l’elaborazione.',
    'exempt.empty': 'Nessuna esenzione. Ogni caricamento soggetto a controllo attende l’approvazione.',
    'exempt.loading': 'Caricamento delle esenzioni…',
    'exempt.unavailable': 'Le esenzioni non sono disponibili. Seleziona Ricarica pannello tra poco.',
    'exempt.loaded': 'Esenzioni: {count}',
    'action.addExemption': 'Aggiungi esenzione',
    'exempt.adding': 'Aggiunta…',
    'action.removeExemption': 'Rimuovi esenzione',
    'action.removeExemptionAria': 'Rimuovi esenzione: {name}',
    'exempt.removing': 'Rimozione…',
    'exempt.addedDone': 'Esenzione aggiunta: {name}.',
    'exempt.exists': 'Già esente: {name}.',
    'exempt.removed': 'Esenzione rimossa: {name}. I prossimi caricamenti attenderanno l’approvazione.',
    'warn.approvalLegacy':
      'L’approvazione dei caricamenti richiede la pipeline di ingestione unificata. Con la pipeline legacy, i caricamenti nella knowledge base vengono rifiutati mentre l’approvazione è attiva.',
    'RAG_UPLOAD_APPROVAL.label': 'Caricamenti che richiedono approvazione',
    'RAG_UPLOAD_APPROVAL.help': 'I caricamenti degli amministratori e dei connettori o utenti esenti non attendono mai.',
    'RAG_UPLOAD_APPROVAL.opt.off': 'Nessuno',
    'RAG_UPLOAD_APPROVAL.opt.members': 'Caricamenti dei membri',
    'RAG_UPLOAD_APPROVAL.opt.all': 'Tutti i caricamenti',
  },
};

const UPLOAD_APPROVALS_PATH = '/api/rag/admin/upload-approvals';
const UPLOAD_APPROVALS_PAGE = 50;
const UPLOAD_APPROVALS_MODES = ['off', 'members', 'all'];
const UPLOAD_APPROVALS_KINDS = ['connector', 'uploader'];
const UPLOAD_APPROVALS_SOURCES = ['upload', 'chat_upload', 'config_upload', 'image_upload', 'nango', 'whatsapp'];
/** 409 words that mean someone else decided first: the list is reloaded (UI-SPEC 8.2). */
const UPLOAD_APPROVALS_CHANGED = new Set(['not_pending', 'superseded_by_newer']);

let uploadApprovalsUi = null;
if (typeof require !== 'undefined') {
  try {
    uploadApprovalsUi = require('./rag-ui.js');
  } catch {
    uploadApprovalsUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function uploadApprovalsUiLib() {
  if (uploadApprovalsUi) return uploadApprovalsUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function uploadApprovalsLabel(key, locale, vars) {
  const ui = uploadApprovalsUiLib();
  const text = ui.ragUiLookup(UPLOAD_APPROVALS_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function uploadApprovalsText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function uploadApprovalsUser(value) {
  if (!value || typeof value !== 'object') return null;
  const id = uploadApprovalsText(value.id);
  const display = uploadApprovalsText(value.display);
  if (!id && !display) return null;
  return { id, display: display || id, isId: !display || display === id };
}

function uploadApprovalsDocTypeLabel(docType, locale) {
  if (!docType) return '';
  if (typeof window !== 'undefined' && typeof window.docTypeLabelForLocale === 'function') return window.docTypeLabelForLocale(docType, locale);
  return docType;
}

/** One pending row from the route answer (UI-SPEC 8.1). Named fields only; anything else the server adds stays invisible. */
function uploadApprovalsPendingRow(item, locale) {
  if (!item || typeof item !== 'object') return null;
  const id = uploadApprovalsText(item.id);
  if (!id) return null;
  const source = uploadApprovalsText(item.source);
  const docType = uploadApprovalsText(item.doc_type);
  return {
    id,
    file: uploadApprovalsText(item.file_name),
    uploader: uploadApprovalsUser(item.uploader),
    source,
    sourceKnown: UPLOAD_APPROVALS_SOURCES.includes(source),
    docType,
    docTypeLabel: uploadApprovalsDocTypeLabel(docType, locale),
    uploadedAt: uploadApprovalsText(item.uploaded_at),
    newVersion: item.new_version === true,
  };
}

/** The GET upload-approvals answer as the Pending view needs it. An unknown mode is treated as on: rows are never hidden. */
function uploadApprovalsPendingView(body, locale) {
  const data = body && typeof body === 'object' ? body : {};
  const mode = UPLOAD_APPROVALS_MODES.includes(data.mode) ? data.mode : 'unknown';
  const rows = (Array.isArray(data.items) ? data.items : []).map((item) => uploadApprovalsPendingRow(item, locale)).filter(Boolean);
  const total = Number.isFinite(Number(data.total)) ? Math.max(Number(data.total), rows.length) : rows.length;
  return { mode, total, rows };
}

function uploadApprovalsExemptionRow(item) {
  if (!item || typeof item !== 'object') return null;
  const id = uploadApprovalsText(item.id);
  if (!id) return null;
  const ref = uploadApprovalsText(item.ref);
  const display = uploadApprovalsText(item.display);
  return {
    id,
    kind: uploadApprovalsText(item.kind),
    display: display || ref,
    displayIsId: !display || display === ref,
    addedBy: uploadApprovalsUser(item.added_by),
    addedAt: uploadApprovalsText(item.added_at),
  };
}

function uploadApprovalsChoices(list) {
  return (Array.isArray(list) ? list : [])
    .map((choice) => (choice && typeof choice === 'object' ? { ref: uploadApprovalsText(choice.ref), display: uploadApprovalsText(choice.display) } : null))
    .filter((choice) => choice && choice.ref)
    .map((choice) => ({ ref: choice.ref, display: choice.display || choice.ref }));
}

/** The GET exemptions answer: rows and the choices for a new exemption. */
function uploadApprovalsExemptionsView(body) {
  const data = body && typeof body === 'object' ? body : {};
  const items = (Array.isArray(data.items) ? data.items : []).map(uploadApprovalsExemptionRow).filter(Boolean);
  const choices = data.choices && typeof data.choices === 'object' ? data.choices : {};
  return {
    items,
    total: Number.isFinite(Number(data.total)) ? Number(data.total) : items.length,
    choices: { connector: uploadApprovalsChoices(choices.connector), uploader: uploadApprovalsChoices(choices.uploader) },
  };
}

/** warn.approvalLegacy (D-56): approval on while the ingest pipeline is not unified. */
function uploadApprovalsLegacyWarning(mode, pipeline) {
  const value = uploadApprovalsText(mode).trim() || 'off';
  return value !== 'off' && uploadApprovalsText(pipeline).trim() !== 'unified';
}

/**
 * The hold-line badge with base-content text, an info border and an info icon: outline info text on the light theme's base
 * colours is below 4.5:1 (the call plans 56 and 57 made for their badges).
 */
function uploadApprovalsReadableBadge(holdLine) {
  const badge = holdLine && holdLine.querySelector('.badge');
  if (!badge) return;
  badge.classList.remove('badge-info');
  badge.classList.add('border-info', 'text-base-content');
  const icon = badge.querySelector('i');
  if (icon) icon.classList.add('text-info');
}

class UploadApprovalsPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = uploadApprovalsUiLib().ragUiBrowserLocale();
    this.organizationId = null;
    this.tabs = null;
    this.pendingHost = null;
    this.exemptHost = null;
    this.view = null;
    this.exemptions = null;
    this.exemptionsWanted = false;
    this.loadSeq = 0;
    this.exemptSeq = 0;
    this.loading = false;
    this.loadAlert = null;
    this.refreshButton = null;
    this.updatedAt = null;
    this.form = { kind: '', ref: '' };
  }

  t(key, vars) {
    return uploadApprovalsLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return uploadApprovalsUiLib().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-upload-approvals-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(uploadApprovalsUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  focusStatus() {
    const host = this.statusEl();
    if (host && typeof host.focus === 'function') host.focus();
  }

  query(extra) {
    const params = new URLSearchParams();
    if (this.organizationId) params.set('organizationId', this.organizationId);
    for (const [key, value] of Object.entries(extra || {})) params.set(key, String(value));
    const text = params.toString();
    return text ? '?' + text : '';
  }

  async mount() {
    const ui = uploadApprovalsUiLib();
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-upload-approvals-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-upload-approvals-description]');
    if (description) description.textContent = this.t('panel.description');
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-upload-approvals',
      tabs: [
        { id: 'pending', label: this.t('tab.pending', { count: '…' }) },
        { id: 'exemptions', label: this.t('tab.exemptions') },
        { id: 'settings', label: this.t('tab.settings') },
      ],
      selected: 'pending',
      onSelect: (id) => {
        if (id === 'exemptions' && !this.exemptions) this.loadExemptions('first');
      },
    });
    this.pendingHost = this.el('div', { className: 'min-w-0' });
    this.exemptHost = this.el('div', { className: 'min-w-0' });
    this.tabs.panels.pending.appendChild(this.pendingHost);
    this.tabs.panels.exemptions.appendChild(this.exemptHost);
    const group = this.doc.querySelector('[data-rag-settings-group="approval"]');
    if (group) {
      this.tabs.panels.settings.appendChild(group);
      this.localizeSettings(group);
    }
    const content = this.root.querySelector('[data-upload-approvals-content]');
    if (content) content.replaceChildren(this.tabs.tablist, this.tabs.panels.pending, this.tabs.panels.exemptions, this.tabs.panels.settings);
    for (const id of ['RAG_UPLOAD_APPROVAL', 'RAG_INGEST_PIPELINE']) {
      const control = this.doc.getElementById(id);
      if (control) control.addEventListener('change', () => this.renderAlerts());
    }
    this.bindWorkspace();
    this.renderAlerts();
    await this.loadPending('first');
  }

  async refresh() {
    this.readWorkspace();
    this.renderAlerts();
    await this.loadPending('refresh');
    if (this.exemptions || this.exemptionsWanted) await this.loadExemptions('refresh');
  }

  /** zh and it through data-rag-i18n; English is the static markup (UI-SPEC 6.3). */
  localizeSettings(group) {
    if (this.locale === 'en') return;
    const table = UPLOAD_APPROVALS_LABELS[this.locale] || {};
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const text = table[node.getAttribute('data-rag-i18n')];
      if (text !== undefined) node.textContent = text;
    }
  }

  selector() {
    return this.doc.getElementById('workspace-selector');
  }

  readWorkspace() {
    const selector = this.selector();
    this.organizationId = selector && selector.value ? String(selector.value) : null;
    this.renderWorkspace();
  }

  workspaceName() {
    const selector = this.selector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? option.textContent.trim() : '';
    return name || this.t('panel.workspaceDefault');
  }

  renderWorkspace() {
    const line = this.root.querySelector('[data-upload-approvals-workspace]');
    if (line) line.textContent = this.t('panel.workspace', { name: this.workspaceName() });
  }

  bindWorkspace() {
    const selector = this.selector();
    this.readWorkspace();
    if (!selector) return;
    selector.addEventListener('change', () => {
      this.readWorkspace();
      this.view = null;
      this.exemptions = null;
      this.form = { kind: '', ref: '' };
      this.loadPending('first');
      if (this.tabs && this.tabs.current() === 'exemptions') this.loadExemptions('first');
    });
  }

  controlValue(id) {
    const control = this.doc.getElementById(id);
    return control ? uploadApprovalsText(control.value) : '';
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-upload-approvals-alert]');
    if (!host) return;
    const ui = uploadApprovalsUiLib();
    const nodes = [];
    if (uploadApprovalsLegacyWarning(this.controlValue('RAG_UPLOAD_APPROVAL'), this.controlValue('RAG_INGEST_PIPELINE'))) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t('warn.approvalLegacy')] }));
    }
    if (this.loadAlert) nodes.push(this.loadAlert);
    host.replaceChildren(...nodes);
  }

  setPendingCount(total) {
    const tab = this.doc.getElementById('rag-upload-approvals-tab-pending');
    if (tab) tab.textContent = this.t('tab.pending', { count: uploadApprovalsUiLib().ragUiFormatNumber(total, this.locale) });
  }

  formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return uploadApprovalsText(value);
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  timeEl(value, className) {
    const date = new Date(value);
    const valid = !Number.isNaN(date.getTime());
    return this.el('time', { className, text: this.formatTime(value), attrs: { datetime: valid ? date.toISOString() : null } });
  }

  userEl(user, className) {
    if (!user) return this.el('span', { className, text: this.t('uploader.none') });
    if (user.isId) return this.el('span', { className: 'font-mono text-xs break-all', text: user.id, attrs: { translate: 'no' } });
    return this.el('span', { className: '[overflow-wrap:anywhere]' + (className ? ' ' + className : ''), text: user.display });
  }

  sourceEl(row) {
    if (!row.source) return this.el('span', { text: '—' });
    if (row.sourceKnown) return this.el('span', { text: this.t('source.' + row.source) });
    return uploadApprovalsUiLib().ragUiCodeSentence(this.doc, this.locale, row.source);
  }

  emptyBlock(title, body) {
    return this.el('div', { className: 'py-8 text-center' }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: title }),
      this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: body }),
    ]);
  }

  tableRegion(label, table) {
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': label },
      },
      [table],
    );
  }

  th(text, extra) {
    return this.el('th', { className: 'font-semibold' + (extra ? ' ' + extra : ''), text, attrs: { scope: 'col' } });
  }

  async loadPending(source, offset) {
    if (!this.pendingHost) return;
    const ui = uploadApprovalsUiLib();
    const append = source === 'more';
    if (this.loading && !append && source !== 'first') return;
    const seq = ++this.loadSeq;
    this.loading = true;
    const hadContent = Boolean(this.view);
    if (append) {
      // Load more keeps the rows; the button shows the running state.
    } else if (hadContent) ui.ragUiListBusy(this.pendingHost, true);
    else ui.ragUiListLoading(this.doc, this.pendingHost, this.t('list.loading'));
    let restore = null;
    if (hadContent && source === 'refresh' && this.refreshButton && this.refreshButton.isConnected !== false) {
      restore = ui.ragUiButtonBusy(this.doc, this.refreshButton, this.t('list.loading'));
    }
    const moreButton = append ? this.root.querySelector('[data-upload-approvals-more]') : null;
    if (moreButton) restore = ui.ragUiButtonBusy(this.doc, moreButton, this.t('list.loading'));
    let result;
    try {
      result = await ui.ragUiRagRequest(UPLOAD_APPROVALS_PATH + this.query({ limit: UPLOAD_APPROVALS_PAGE, offset: append ? offset || 0 : 0 }), { method: 'GET' });
    } finally {
      if (seq === this.loadSeq) this.loading = false;
      if (restore) restore();
    }
    if (seq !== this.loadSeq) return;
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const next = uploadApprovalsPendingView(result.body, this.locale);
      let firstNew = null;
      if (append && this.view) {
        const known = new Set(this.view.rows.map((row) => row.id));
        const added = next.rows.filter((row) => !known.has(row.id));
        firstNew = added[0] ? added[0].id : null;
        this.view = { mode: next.mode, total: next.total, rows: [...this.view.rows, ...added] };
      } else {
        this.view = next;
      }
      this.updatedAt = new Date();
      this.loadAlert = null;
      this.renderAlerts();
      ui.ragUiListBusy(this.pendingHost, false);
      this.setPendingCount(this.view.total);
      this.renderPending();
      if (firstNew) this.focusRowAction(firstNew);
      if (source === 'first' || source === 'refresh') this.announce(this.t('tab.pending', { count: ui.ragUiFormatNumber(this.view.total, this.locale) }));
      return;
    }
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('list.unavailable') });
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.view = null;
      this.loadAlert = null;
      this.renderAlerts();
      ui.ragUiListBusy(this.pendingHost, false);
      this.pendingHost.replaceChildren(
        mapped.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.refresh())
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.refresh())] }),
      );
      this.setPendingCount('—');
    } else {
      this.loadAlert = ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, () => this.refresh());
      this.renderAlerts();
      if (this.view) ui.ragUiListBusy(this.pendingHost, true, true);
      else this.pendingHost.replaceChildren();
    }
    this.announce(mapped.message, true);
  }

  renderToolbar() {
    const ui = uploadApprovalsUiLib();
    this.refreshButton = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.refresh'), attrs: { type: 'button' } });
    this.refreshButton.addEventListener('click', () => this.loadPending('refresh'));
    return this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mb-4' }, [
      this.el('p', { className: 'text-xs text-base-content/70', text: this.updatedAt ? ui.ragUiLabel('panel.updated', this.locale, { time: this.formatTime(this.updatedAt) }) : '' }),
      this.refreshButton,
    ]);
  }

  renderPending() {
    const view = this.view;
    if (!view || !this.pendingHost) return;
    if (view.mode === 'off') {
      const open = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('pending.openSettings'), attrs: { type: 'button' } });
      open.addEventListener('click', () => this.openSettings());
      this.pendingHost.replaceChildren(
        this.el('div', { className: 'py-8 text-center' }, [
          this.el('p', { className: 'text-sm max-w-prose mx-auto', text: this.t('pending.off') }),
          this.el('div', { className: 'mt-2' }, [open]),
        ]),
      );
      return;
    }
    const nodes = [this.renderToolbar()];
    if (!view.rows.length) {
      nodes.push(this.emptyBlock(this.t('pending.empty.title'), this.t('pending.empty.body')));
    } else {
      nodes.push(this.tableRegion(this.t('list.caption'), this.renderTable(view.rows)));
      if (view.rows.length < view.total) {
        const more = this.el('button', { className: 'btn btn-outline btn-sm mt-4', text: this.t('action.loadMore'), attrs: { type: 'button', 'data-upload-approvals-more': '' } });
        more.addEventListener('click', () => this.loadPending('more', this.view ? this.view.rows.length : 0));
        nodes.push(more);
      }
    }
    nodes.push(this.el('p', { className: 'text-xs text-base-content/70 mt-4 max-w-prose', text: this.t('pending.quarantineNote') }));
    this.pendingHost.replaceChildren(...nodes);
  }

  renderTable(rows) {
    const table = this.el('table', { className: 'table table-sm' });
    table.appendChild(this.el('caption', { className: 'sr-only', text: this.t('list.caption') }));
    table.appendChild(
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('col.file')),
          this.th(this.t('col.uploader'), 'hidden md:table-cell'),
          this.th(this.t('col.source'), 'hidden lg:table-cell'),
          this.th(this.t('col.docType'), 'hidden md:table-cell'),
          this.th(this.t('col.uploaded'), 'hidden md:table-cell'),
          this.th(this.t('col.actions'), 'hidden md:table-cell'),
        ]),
      ]),
    );
    const body = this.el('tbody', {});
    for (const row of rows) body.appendChild(this.renderRow(row));
    table.appendChild(body);
    return table;
  }

  renderRow(row) {
    const ui = uploadApprovalsUiLib();
    const holdLine = ui.ragUiHoldLine(this.doc, {
      tone: 'info',
      icon: 'hourglass',
      word: ui.ragUiLabel('status.pending_review', this.locale),
      reason: this.el('span', { className: 'text-xs min-w-0 break-words', text: this.t(row.newVersion ? 'pending.newVersion' : 'pending.reason') }),
    });
    uploadApprovalsReadableBadge(holdLine);
    const fileCell = this.el('th', { className: 'block md:table-cell align-top font-normal min-w-0 lg:min-w-48', attrs: { scope: 'row' } }, [
      this.el('span', { className: 'block text-sm font-semibold [overflow-wrap:anywhere]', text: row.file }),
      this.el('div', { className: 'mt-1' }, [holdLine]),
      this.el('div', { className: 'md:hidden mt-1 flex flex-col gap-1 text-xs text-base-content/70' }, [
        this.userEl(row.uploader),
        this.timeEl(row.uploadedAt),
      ]),
    ]);
    const approve = this.el('button', {
      className: 'btn btn-primary md:btn-sm',
      text: this.t('action.approve'),
      attrs: { type: 'button', 'aria-label': this.t('action.approveAria', { file: row.file }), 'data-upload-approvals-approve': row.id },
    });
    const reject = this.el('button', {
      className: 'btn btn-outline btn-error md:btn-sm',
      text: this.t('action.reject'),
      attrs: { type: 'button', 'aria-label': this.t('action.rejectAria', { file: row.file }), 'data-upload-approvals-reject': row.id },
    });
    approve.addEventListener('click', () => this.approve(row, approve, reject));
    reject.addEventListener('click', () => this.reject(row, reject, approve));
    return this.el('tr', { className: 'flex flex-col md:table-row', attrs: { 'data-upload-approvals-row': row.id } }, [
      fileCell,
      this.el('td', { className: 'align-top hidden md:table-cell' }, [this.userEl(row.uploader, 'text-sm')]),
      this.el('td', { className: 'align-top hidden lg:table-cell' }, [this.sourceEl(row)]),
      this.el('td', { className: 'align-top hidden md:table-cell break-words', text: row.docTypeLabel || '—' }),
      this.el('td', { className: 'align-top hidden md:table-cell tabular-nums lg:whitespace-nowrap' }, [this.timeEl(row.uploadedAt)]),
      this.el('td', { className: 'block md:table-cell align-top pt-0 md:pt-2' }, [this.el('div', { className: 'flex flex-col gap-2 md:min-w-max' }, [approve, reject])]),
    ]);
  }

  openSettings() {
    if (!this.tabs) return;
    this.tabs.select('settings');
    const tab = this.doc.getElementById('rag-upload-approvals-tab-settings');
    if (tab && typeof tab.focus === 'function') tab.focus();
  }

  focusRowAction(id) {
    const button = this.root.querySelector('[data-upload-approvals-approve="' + id + '"]');
    if (button && typeof button.focus === 'function') button.focus();
  }

  /** Removes a decided row and moves focus to the next row's Approve upload, or to the status region (UI-SPEC 6.6). */
  removeRow(id) {
    if (!this.view) return;
    const index = this.view.rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    this.view.rows.splice(index, 1);
    this.view.total = Math.max(0, this.view.total - 1);
    this.setPendingCount(this.view.total);
    this.renderPending();
    const next = this.view.rows[index] || this.view.rows[index - 1];
    if (next) this.focusRowAction(next.id);
    else this.focusStatus();
  }

  actionPath(id, action) {
    return UPLOAD_APPROVALS_PATH + '/' + encodeURIComponent(id) + '/' + action + this.query();
  }

  /** A failed approve or reject: someone else decided, a sign-in is needed, or the error sentence is shown. */
  async actionFailed(result, action) {
    const ui = uploadApprovalsUiLib();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('list.unavailable'), action });
    const word = result && result.body && typeof result.body.error === 'string' ? result.body.error : '';
    if (mapped.kind === 'changed' || (result && result.status === 409 && UPLOAD_APPROVALS_CHANGED.has(word))) {
      const message = ui.ragUiLabel('error.changed', this.locale);
      await this.loadPending('refresh');
      this.announce(message, true);
      this.focusStatus();
      return;
    }
    if (mapped.kind === 'signIn') {
      await this.loadPending('first');
      return;
    }
    this.announce(mapped.message, true);
  }

  async approve(row, button, sibling) {
    const ui = uploadApprovalsUiLib();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('approve.running'), [sibling]);
    let result;
    try {
      result = await ui.ragUiRagRequest(this.actionPath(row.id, 'approve'), { method: 'POST' });
    } catch {
      result = { ok: false, thrown: true, status: 0, body: null };
    }
    if (result && result.ok) {
      this.announce(this.t('approve.done', { file: row.file }));
      this.removeRow(row.id);
      return;
    }
    restore();
    await this.actionFailed(result, 'approve');
  }

  async reject(row, button, sibling) {
    const ui = uploadApprovalsUiLib();
    let result = null;
    const confirmed = await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('reject.title', { file: row.file }),
      body: [this.t('reject.body')],
      keepLabel: this.t('action.keepUpload'),
      confirmLabel: this.t('action.reject'),
      runningLabel: this.t('reject.running'),
      tone: 'error',
      opener: button,
      fallbackFocus: this.statusEl(),
      onConfirm: async () => {
        result = await ui.ragUiRagRequest(this.actionPath(row.id, 'reject'), { method: 'POST' });
      },
    });
    if (!confirmed || !result) return;
    if (result.ok) {
      this.announce(this.t('reject.done', { file: row.file }));
      this.removeRow(row.id);
      return;
    }
    if (sibling) sibling.disabled = false;
    await this.actionFailed(result, 'reject');
  }

  async loadExemptions(source) {
    if (!this.exemptHost) return;
    const ui = uploadApprovalsUiLib();
    this.exemptionsWanted = true;
    const seq = ++this.exemptSeq;
    if (this.exemptions) ui.ragUiListBusy(this.exemptHost, true);
    else ui.ragUiListLoading(this.doc, this.exemptHost, this.t('exempt.loading'));
    const result = await ui.ragUiRagRequest(UPLOAD_APPROVALS_PATH + '/exemptions' + this.query({ limit: 100, offset: 0 }), { method: 'GET' });
    if (seq !== this.exemptSeq) return;
    ui.ragUiListBusy(this.exemptHost, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      this.exemptions = uploadApprovalsExemptionsView(result.body);
      this.renderExemptions();
      if (source === 'first' || source === 'refresh') this.announce(this.t('exempt.loaded', { count: ui.ragUiFormatNumber(this.exemptions.total, this.locale) }));
      return;
    }
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('exempt.unavailable') });
    const reload = () => this.loadExemptions('refresh');
    let alert;
    if (mapped.kind === 'signIn') alert = ui.ragUiSignInAlert(this.doc, this.locale, () => this.refresh());
    else if (mapped.kind === 'workspace') alert = ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] });
    else alert = ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, reload);
    if (this.exemptions && mapped.kind !== 'signIn' && mapped.kind !== 'workspace') {
      this.renderExemptions(alert);
      ui.ragUiListBusy(this.exemptHost, true, true);
    } else {
      this.exemptions = null;
      this.exemptHost.replaceChildren(alert);
    }
    this.announce(mapped.message, true);
  }

  kindText(kind) {
    return UPLOAD_APPROVALS_KINDS.includes(kind) ? this.el('span', { text: this.t('exempt.kind.' + kind) }) : uploadApprovalsUiLib().ragUiCodeSentence(this.doc, this.locale, kind);
  }

  renderExemptions(alert) {
    const view = this.exemptions;
    if (!view || !this.exemptHost) return;
    const nodes = [];
    if (alert) nodes.push(this.el('div', { className: 'mb-4' }, [alert]));
    nodes.push(this.renderExemptionForm());
    if (!view.items.length) {
      nodes.push(this.el('p', { className: 'text-sm text-base-content/70 mt-4 max-w-prose', text: this.t('exempt.empty') }));
    } else {
      nodes.push(this.el('div', { className: 'mt-6' }, [this.tableRegion(this.t('exempt.caption'), this.renderExemptionTable(view.items))]));
    }
    this.exemptHost.replaceChildren(...nodes);
  }

  /**
   * The two selects are panel state, not settings: their change events stop here so the page's auto-save does not record
   * them as config keys.
   */
  renderExemptionForm() {
    const kindId = 'rag-upload-approvals-exempt-kind';
    const refId = 'rag-upload-approvals-exempt-ref';
    const reasonId = 'rag-upload-approvals-exempt-reason';
    const helpId = 'rag-upload-approvals-exempt-help';
    const kind = this.el('select', { className: 'select select-bordered select-sm w-full', id: kindId, attrs: { name: 'exemption-kind', autocomplete: 'off', 'aria-describedby': helpId } }, [
      this.el('option', { text: this.t('exempt.chooseKind'), attrs: { value: '' } }),
      ...UPLOAD_APPROVALS_KINDS.map((k) => this.el('option', { text: this.t('exempt.kind.' + k), attrs: { value: k } })),
    ]);
    kind.value = this.form.kind;
    const choices = this.form.kind ? this.exemptions.choices[this.form.kind] || [] : [];
    const ref = this.el('select', { className: 'select select-bordered select-sm w-full', id: refId, attrs: { name: 'exemption-name', autocomplete: 'off' } }, [
      this.el('option', { text: this.t('exempt.chooseName'), attrs: { value: '' } }),
      ...choices.map((c) => this.el('option', { text: c.display, attrs: { value: c.ref, translate: c.display === c.ref ? 'no' : null } })),
    ]);
    ref.disabled = !this.form.kind || choices.length === 0;
    if (choices.some((c) => c.ref === this.form.ref)) ref.value = this.form.ref;
    else {
      this.form.ref = '';
      ref.value = '';
    }
    const ready = Boolean(this.form.kind && this.form.ref);
    const add = this.el('button', {
      className: 'btn btn-primary btn-sm',
      text: this.t('action.addExemption'),
      attrs: { type: 'button', 'aria-describedby': ready ? null : reasonId, 'data-upload-approvals-add': '' },
    });
    add.disabled = !ready;
    const reasonText = this.form.kind && choices.length === 0 ? this.t('exempt.noChoices') : this.t('exempt.needBoth');
    const reason = this.el('p', { className: 'text-xs text-base-content/70 mt-2', id: reasonId, text: reasonText, attrs: { hidden: ready } });
    kind.addEventListener('change', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      this.form = { kind: UPLOAD_APPROVALS_KINDS.includes(kind.value) ? kind.value : '', ref: '' };
      this.renderExemptions();
      const next = this.doc.getElementById(kindId);
      if (next && typeof next.focus === 'function') next.focus();
    });
    ref.addEventListener('change', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      this.form = { kind: this.form.kind, ref: uploadApprovalsText(ref.value) };
      this.renderExemptions();
      const next = this.doc.getElementById(refId);
      if (next && typeof next.focus === 'function') next.focus();
    });
    add.addEventListener('click', () => this.addExemption(add));
    return this.el('fieldset', { className: 'bg-base-100 rounded-lg p-4 min-w-0' }, [
      this.el('legend', { className: 'text-base font-semibold px-1', text: this.t('exempt.formLabel') }),
      this.el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' }, [
        this.el('div', { className: 'form-control min-w-0' }, [
          this.el('label', { className: 'label', attrs: { for: kindId } }, [this.el('span', { className: 'label-text', text: this.t('exempt.kindLabel') })]),
          kind,
        ]),
        this.el('div', { className: 'form-control min-w-0' }, [
          this.el('label', { className: 'label', attrs: { for: refId } }, [this.el('span', { className: 'label-text', text: this.t('exempt.nameLabel') })]),
          ref,
        ]),
      ]),
      this.el('div', { className: 'mt-4' }, [add, reason]),
      this.el('p', { className: 'text-xs text-base-content/70 mt-2 max-w-prose', id: helpId, text: this.t('exempt.help') }),
    ]);
  }

  renderExemptionTable(items) {
    const table = this.el('table', { className: 'table table-sm' });
    table.appendChild(this.el('caption', { className: 'sr-only', text: this.t('exempt.caption') }));
    table.appendChild(
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('exempt.kindLabel')),
          this.th(this.t('exempt.nameLabel')),
          this.th(this.t('exempt.addedBy'), 'hidden md:table-cell'),
          this.th(this.t('exempt.added'), 'hidden md:table-cell'),
          this.th(this.t('col.actions')),
        ]),
      ]),
    );
    const body = this.el('tbody', {});
    for (const item of items) {
      const remove = this.el('button', {
        className: 'btn btn-outline md:btn-sm',
        text: this.t('action.removeExemption'),
        attrs: { type: 'button', 'aria-label': this.t('action.removeExemptionAria', { name: item.display }), 'data-upload-approvals-remove': item.id },
      });
      remove.addEventListener('click', () => this.removeExemption(item, remove));
      body.appendChild(
        this.el('tr', { attrs: { 'data-upload-approvals-exemption': item.id } }, [
          this.el('td', { className: 'align-top' }, [this.kindText(item.kind)]),
          this.el('th', { className: 'align-top font-normal', attrs: { scope: 'row' } }, [
            item.displayIsId
              ? this.el('span', { className: 'font-mono text-xs break-all', text: item.display, attrs: { translate: 'no' } })
              : this.el('span', { className: 'text-sm break-words', text: item.display }),
          ]),
          this.el('td', { className: 'align-top hidden md:table-cell' }, [this.userEl(item.addedBy, 'text-sm')]),
          this.el('td', { className: 'align-top hidden md:table-cell tabular-nums' }, [this.timeEl(item.addedAt)]),
          this.el('td', { className: 'align-top' }, [remove]),
        ]),
      );
    }
    table.appendChild(body);
    return table;
  }

  choiceName(kind, ref) {
    const list = (this.exemptions && this.exemptions.choices[kind]) || [];
    const found = list.find((c) => c.ref === ref);
    return found ? found.display : ref;
  }

  async addExemption(button) {
    const ui = uploadApprovalsUiLib();
    const { kind, ref } = this.form;
    if (!kind || !ref) return;
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('exempt.adding'));
    const result = await ui.ragUiRagRequest(UPLOAD_APPROVALS_PATH + '/exemptions' + this.query(), { method: 'POST', body: JSON.stringify({ kind, ref }) });
    if (result && result.ok) {
      const item = result.body && result.body.item ? uploadApprovalsExemptionRow(result.body.item) : null;
      const name = item ? item.display : this.choiceName(kind, ref);
      const exists = result.body && result.body.outcome === 'exists';
      this.form = { kind: '', ref: '' };
      await this.loadExemptions('action');
      this.announce(this.t(exists ? 'exempt.exists' : 'exempt.addedDone', { name }));
      const kindSelect = this.doc.getElementById('rag-upload-approvals-exempt-kind');
      if (kindSelect && typeof kindSelect.focus === 'function') kindSelect.focus();
      return;
    }
    restore();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('exempt.unavailable') });
    if (mapped.kind === 'changed') {
      await this.loadExemptions('action');
      this.announce(mapped.message, true);
      return;
    }
    if (mapped.kind === 'signIn') {
      await this.loadExemptions('first');
      return;
    }
    this.announce(mapped.message, true);
  }

  async removeExemption(item, button) {
    const ui = uploadApprovalsUiLib();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('exempt.removing'));
    const index = this.exemptions ? this.exemptions.items.findIndex((row) => row.id === item.id) : -1;
    const result = await ui.ragUiRagRequest(UPLOAD_APPROVALS_PATH + '/exemptions' + this.query({ id: item.id }), { method: 'DELETE' });
    if (result && result.ok) {
      await this.loadExemptions('action');
      this.announce(this.t('exempt.removed', { name: item.display }));
      const items = this.exemptions ? this.exemptions.items : [];
      const next = items[index] || items[index - 1];
      const target = next
        ? this.root.querySelector('[data-upload-approvals-remove="' + next.id + '"]')
        : this.doc.getElementById('rag-upload-approvals-exempt-kind');
      if (target && typeof target.focus === 'function') target.focus();
      return;
    }
    restore();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('exempt.unavailable') });
    if (mapped.kind === 'changed' || mapped.kind === 'signIn') {
      await this.loadExemptions('action');
      if (mapped.kind === 'changed') this.announce(mapped.message, true);
      return;
    }
    this.announce(mapped.message, true);
  }
}

let uploadApprovalsPanelInstance = null;

function initUploadApprovalsPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-approvals');
  if (!root) return null;
  if (!uploadApprovalsPanelInstance) {
    uploadApprovalsPanelInstance = new UploadApprovalsPanel(root);
    if (typeof window !== 'undefined') window.uploadApprovalsPanel = uploadApprovalsPanelInstance;
    return uploadApprovalsPanelInstance.mount();
  }
  return uploadApprovalsPanelInstance.refresh();
}

function uploadApprovalsBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-upload-approvals-bound')) return;
    link.setAttribute('data-upload-approvals-bound', '1');
    link.addEventListener('click', () => initUploadApprovalsPanel());
  });
}

if (typeof window !== 'undefined') {
  window.UPLOAD_APPROVALS_LABELS = UPLOAD_APPROVALS_LABELS;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initUploadApprovalsPanel = initUploadApprovalsPanel;
  uploadApprovalsBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    uploadApprovalsBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initUploadApprovalsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UPLOAD_APPROVALS_LABELS,
    uploadApprovalsLabel,
    uploadApprovalsPendingRow,
    uploadApprovalsPendingView,
    uploadApprovalsExemptionsView,
    uploadApprovalsLegacyWarning,
    UploadApprovalsPanel,
    initUploadApprovalsPanel,
  };
}
