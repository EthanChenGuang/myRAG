/**
 * Document type defaults panel and Config UI upload picker helpers.
 */

const DOC_TYPE_IDS = [
  'general',
  'financial_report',
  'contract_legal',
  'invoice_receipt',
  'product_technical',
  'scanned_image',
];

const DOC_TYPE_CHOICES = [...DOC_TYPE_IDS, 'auto'];

const CONFIG_UI_DOC_TYPE_LABELS = {
  en: {
    general: 'General',
    financial_report: 'Financial report',
    contract_legal: 'Contract & legal',
    invoice_receipt: 'Invoice & receipt',
    product_technical: 'Product & technical',
    scanned_image: 'Scanned image',
    auto: 'Auto-detect',
  },
  zh: {
    general: '通用文档',
    financial_report: '财务报告',
    contract_legal: '合同与法律',
    invoice_receipt: '发票与收据',
    product_technical: '产品与技术',
    scanned_image: '扫描图像',
    auto: '自动识别',
  },
  it: {
    general: 'Generale',
    financial_report: 'Report finanziario',
    contract_legal: 'Contratto e legale',
    invoice_receipt: 'Fattura e ricevuta',
    product_technical: 'Prodotto e tecnico',
    scanned_image: 'Immagine scansionata',
    auto: 'Rilevamento automatico',
  },
};

function detectUiLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2);
  if (lang === 'zh' || lang === 'it') return lang;
  return 'en';
}

function docTypeLabelForLocale(id, locale) {
  const table = CONFIG_UI_DOC_TYPE_LABELS[locale] || CONFIG_UI_DOC_TYPE_LABELS.en;
  return table[id] || CONFIG_UI_DOC_TYPE_LABELS.en[id] || id;
}

function buildUploadForm(file, docType, pickerEnabled) {
  const form = new FormData();
  form.append('file', file);
  if (pickerEnabled && docType) {
    form.append('doc_type', docType);
  }
  return form;
}

function buildDocTypeSelectOptions(selected, locale) {
  return DOC_TYPE_CHOICES.map((value) => ({
    value,
    label: docTypeLabelForLocale(value, locale),
    selected: value === selected,
  }));
}

async function fetchUploadPickerDefault(organizationId) {
  const params = new URLSearchParams({ source: 'config_upload' });
  if (organizationId) params.set('organizationId', organizationId);
  const result = await ragFetch(`doc-type-defaults?${params.toString()}`, { method: 'GET' });
  if (!result.ok) return { enabled: false, error: result.message };
  const body = result.body || {};
  return {
    enabled: Boolean(body.enabled),
    docType: body.docType || 'auto',
    origin: body.origin,
    error: null,
  };
}

class DocTypesPanel {
  constructor() {
    this.locale = detectUiLocale();
    this.organizationId = null;
    this.items = [];
    this.statusEl = null;
    this.formEl = null;
    this.tenantSelect = null;
  }

  mount(root) {
    this.statusEl = root.querySelector('[data-rag-doc-types-status]');
    this.formEl = root.querySelector('[data-rag-doc-types-form]');
    this.tenantSelect = root.querySelector('[data-rag-doc-types-tenant]');
    const workspaceSelect = document.getElementById('workspace-selector');
    if (workspaceSelect) {
      workspaceSelect.addEventListener('change', () => {
        this.organizationId = workspaceSelect.value || null;
        this.load();
      });
      this.organizationId = workspaceSelect.value || null;
    }
    const saveBtn = root.querySelector('[data-rag-doc-types-save]');
    if (saveBtn) saveBtn.addEventListener('click', () => this.save());
    root.querySelector('[data-rag-doc-types-refresh]')?.addEventListener('click', () => this.load());
    this.load();
  }

  setStatus(text, isError) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('text-error', Boolean(isError));
  }

  async load() {
    this.setStatus('Loading document type defaults…', false);
    if (this.formEl) this.formEl.replaceChildren();
    const params = new URLSearchParams();
    if (this.organizationId) params.set('organizationId', this.organizationId);
    const query = params.toString();
    const result = await ragFetch(`admin/doc-type-defaults${query ? `?${query}` : ''}`, { method: 'GET' });
    if (!result.ok) {
      this.setStatus(result.message || authMessage(result.status), true);
      return;
    }
    this.items = (result.body && result.body.items) || [];
    this.renderForm();
    this.setStatus('', false);
  }

  renderForm() {
    if (!this.formEl) return;
    this.formEl.replaceChildren();
    const tenantRow = this.items.find((row) => row.source_kind === 'tenant');
    const tenantSelectId = 'rag-doc-type-tenant';
    const tenantLabel = document.createElement('label');
    tenantLabel.className = 'label';
    tenantLabel.htmlFor = tenantSelectId;
    tenantLabel.textContent = 'Tenant default';
    const tenantSelect = document.createElement('select');
    tenantSelect.id = tenantSelectId;
    tenantSelect.name = 'tenant_doc_type';
    tenantSelect.className = 'select select-bordered w-full mb-4';
    tenantSelect.dataset.sourceKind = 'tenant';
    const tenantValue = tenantRow ? tenantRow.doc_type : 'auto';
    for (const option of buildDocTypeSelectOptions(tenantValue, this.locale)) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      if (option.selected) el.selected = true;
      tenantSelect.appendChild(el);
    }
    this.formEl.appendChild(tenantLabel);
    this.formEl.appendChild(tenantSelect);

    const sources = ['config_upload', 'chat_upload', 'nango', 'scraper', 'image_upload'];
    for (const kind of sources) {
      const row = this.items.find((item) => item.source_kind === kind && !item.source_ref);
      const wrap = document.createElement('div');
      wrap.className = 'mb-3';
      const selectId = `rag-doc-type-${kind.replace(/_/g, '-')}`;
      const label = document.createElement('label');
      label.className = 'label';
      label.htmlFor = selectId;
      label.textContent = kind.replace(/_/g, ' ');
      const select = document.createElement('select');
      select.id = selectId;
      select.name = kind;
      select.className = 'select select-bordered w-full';
      select.dataset.sourceKind = kind;
      const value = row ? row.doc_type : 'auto';
      for (const option of buildDocTypeSelectOptions(value, this.locale)) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        if (option.selected) el.selected = true;
        select.appendChild(el);
      }
      wrap.appendChild(label);
      wrap.appendChild(select);
      this.formEl.appendChild(wrap);
    }
    this.tenantSelect = tenantSelect;
  }

  async save() {
    if (!this.formEl) return;
    const selects = this.formEl.querySelectorAll('select[data-source-kind]');
    this.setStatus('Saving…', false);
    for (const select of selects) {
      const payload = {
        organizationId: this.organizationId,
        sourceKind: select.dataset.sourceKind,
        docType: select.value,
      };
      const result = await ragFetch('admin/doc-type-defaults', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (!result.ok) {
        this.setStatus(result.message || `Save failed (${result.status})`, true);
        return;
      }
    }
    this.setStatus('Defaults saved.', false);
    await this.load();
  }
}

function initDocTypesPanel() {
  const root = document.getElementById('rag-administration-doc-types');
  if (!root) return;
  const panel = new DocTypesPanel();
  panel.mount(root);
  window.docTypesPanel = panel;
}

if (typeof window !== 'undefined') {
  window.buildUploadForm = buildUploadForm;
  window.buildDocTypeSelectOptions = buildDocTypeSelectOptions;
  window.fetchUploadPickerDefault = fetchUploadPickerDefault;
  window.docTypeLabelForLocale = docTypeLabelForLocale;
  window.initDocTypesPanel = initDocTypesPanel;
  document.addEventListener('DOMContentLoaded', () => {
    const tab = document.querySelector('[data-tab="rag-administration"]');
    if (tab) tab.addEventListener('click', () => initDocTypesPanel());
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG_UI_DOC_TYPE_LABELS,
    DOC_TYPE_CHOICES,
    buildDocTypeSelectOptions,
    buildUploadForm,
    docTypeLabelForLocale,
  };
}