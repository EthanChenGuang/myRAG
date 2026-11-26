/**
 * Embedding profiles admin panel.
 */

/** UI-SPEC 12.7 and 12.9: the strings this panel adds; English is the fallback. */
const EMBEDDING_PROFILES_LABELS = {
  en: {
    'profile.languages': 'Languages: {list}',
    'profile.noLanguages': 'none declared',
    'profile.missingLanguage': 'Does not declare {language}, which this deployment supports.',
    'profile.warning': 'Warning:',
    'profile.serving': 'Served by: {mode}',
    'serving.hosted': 'hosted API (DeepInfra)',
    'serving.sidecar': 'the sidecar, in-house',
    'serving.title': '{model} serving',
    'serving.help':
      'Hosted API: document and query text is sent to the hosted API with the existing DeepInfra key. Sidecar: text stays on your servers, and if the sidecar cannot be reached embedding fails; it never falls back to the hosted API. Both modes return the same vectors, so switching needs no re-embedding.',
    'RAG_BGE_M3_SERVING.opt.hosted': 'Hosted API',
    'RAG_BGE_M3_SERVING.opt.sidecar': 'Sidecar, in-house',
    listSeparator: ', ',
  },
  zh: {
    'profile.languages': '语言：{list}',
    'profile.noLanguages': '未声明',
    'profile.missingLanguage': '未声明支持{language}，而此部署支持该语言。',
    'profile.warning': '警告：',
    'profile.serving': '服务方式：{mode}',
    'serving.hosted': '托管 API（DeepInfra）',
    'serving.sidecar': '侧车服务（本地）',
    'serving.title': '{model} 服务方式',
    'serving.help':
      '托管 API：文档和查询文本会使用现有的 DeepInfra 密钥发送到托管 API。侧车服务：文本留在你的服务器上；侧车服务无法连接时向量化会失败，绝不会回退到托管 API。两种方式返回相同的向量，切换时无需重新向量化。',
    'RAG_BGE_M3_SERVING.opt.hosted': '托管 API',
    'RAG_BGE_M3_SERVING.opt.sidecar': '侧车服务（本地）',
    listSeparator: '、',
  },
  it: {
    'profile.languages': 'Lingue: {list}',
    'profile.noLanguages': 'nessuna dichiarata',
    'profile.missingLanguage': 'Non dichiara {language}, che questa installazione supporta.',
    'profile.warning': 'Attenzione:',
    'profile.serving': 'Servito da: {mode}',
    'serving.hosted': 'API ospitata (DeepInfra)',
    'serving.sidecar': 'il sidecar, in sede',
    'serving.title': 'Servizio di {model}',
    'serving.help':
      "API ospitata: il testo di documenti e query viene inviato all'API ospitata con la chiave DeepInfra esistente. Sidecar: il testo resta sui tuoi server e, se il sidecar non è raggiungibile, l'embedding non riesce; non ripiega mai sull'API ospitata. Entrambe le modalità restituiscono gli stessi vettori, quindi il cambio non richiede un nuovo embedding.",
    'RAG_BGE_M3_SERVING.opt.hosted': 'API ospitata',
    'RAG_BGE_M3_SERVING.opt.sidecar': 'Sidecar, in sede',
    listSeparator: ', ',
  },
};

const EMBEDDING_PROFILES_MODEL_NAME = 'BGE-M3';

/** UI-SPEC 6.1: the first two letters of navigator.language, zh or it, otherwise en. */
function embeddingProfilesLocale() {
  const language = typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string' ? navigator.language : '';
  const lang = language.slice(0, 2).toLowerCase();
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

function embeddingProfilesLabel(key, locale, vars) {
  const table = EMBEDDING_PROFILES_LABELS[locale] || EMBEDDING_PROFILES_LABELS.en;
  const text = table[key] !== undefined ? table[key] : EMBEDDING_PROFILES_LABELS.en[key];
  if (typeof text !== 'string' || !vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}

function embeddingProfilesCodes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((code) => typeof code === 'string' && code.length > 0);
}

/** The saved supported languages, from the Languages panel's hidden mirror (UI-SPEC 6.2.2). */
function embeddingProfilesChosenLanguages(doc) {
  const mirror = doc && typeof doc.getElementById === 'function' ? doc.getElementById('RAG_SUPPORTED_LANGUAGES') : null;
  const value = mirror && typeof mirror.value === 'string' ? mirror.value : '';
  return value.split(',').map((code) => code.trim()).filter(Boolean);
}

/** A language's own name: the Languages panel's pack name when loaded, else Intl, else the code. */
function embeddingProfilesNativeName(code) {
  const rows = typeof window !== 'undefined' && window.languagesPanel && window.languagesPanel.view ? window.languagesPanel.view.rows : null;
  if (Array.isArray(rows)) {
    const row = rows.find((r) => r && r.code === code);
    if (row && typeof row.nativeName === 'string' && row.nativeName) return row.nativeName;
  }
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (typeof name === 'string' && name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // An unknown or malformed code keeps its code as the name.
  }
  return code;
}

function formatActivationRefusal(body) {
  if (body && typeof body.reason === 'string' && body.reason.length > 0) {
    return body.reason;
  }
  if (body && typeof body.error === 'string' && body.error.includes('activation_refused')) {
    return body.error;
  }
  return 'activation_refused: unknown';
}

function buildProfileRowView(profile, options) {
  const chosen = embeddingProfilesCodes(options && options.chosenLanguages);
  const languages = embeddingProfilesCodes(profile.supportedLanguages);
  const declared = new Set(languages);
  const completeness = profile.completeness;
  let completenessText = '';
  if (completeness && completeness.state === 'measured') {
    completenessText = `${completeness.percent ?? 0}% complete`;
  } else if (completeness && completeness.state) {
    completenessText = completeness.state;
  } else {
    completenessText = 'not measured';
  }
  return {
    id: String(profile.id || ''),
    summary: `${profile.status || 'unknown'} · ${profile.dims || '?'} dims · ${completenessText}`,
    evidence: profile.has_evidence ? 'Yes — evidence on file' : 'No evidence',
    status: String(profile.status || ''),
    languages,
    missingLanguages: chosen.filter((code) => !declared.has(code)),
    servingMode: profile.servingMode === 'hosted' || profile.servingMode === 'sidecar' ? profile.servingMode : null,
  };
}

class EmbeddingProfilesPanel {
  constructor() {
    this.listEl = null;
    this.statusEl = null;
    this.profiles = [];
    this.activeId = null;
    this.locale = embeddingProfilesLocale();
  }

  t(key, vars) {
    return embeddingProfilesLabel(key, this.locale, vars);
  }

  mount(root) {
    this.listEl = root.querySelector('[data-rag-profiles-list]');
    this.statusEl = root.querySelector('[data-rag-profiles-status]');
    root.querySelector('[data-rag-profiles-refresh]')?.addEventListener('click', () => this.load());
    root.querySelector('[data-rag-profiles-rollback]')?.addEventListener('click', () => this.rollback());
    this.mountServing();
    this.load();
  }

  /** UI-SPEC 6.10: the `bge` settings group moves under the list; it edits .env.local and needs no admin session. */
  mountServing() {
    const group = document.querySelector('[data-rag-settings-group="bge"]');
    if (!group || !this.listEl || !this.listEl.parentElement) return;
    const host = document.createElement('div');
    host.className = 'min-w-0 mt-6 border-t border-base-300 pt-6';
    const title = document.createElement('h4');
    title.className = 'text-base font-semibold mb-4 text-balance';
    this.fillModelLabel(title);
    host.appendChild(title);
    host.appendChild(group);
    this.listEl.parentElement.appendChild(host);
    this.localizeServing(group);
  }

  /** The control's title with the model name kept untranslated. */
  fillModelLabel(node) {
    const [before, after] = String(this.t('serving.title')).split('{model}');
    const name = document.createElement('span');
    name.setAttribute('translate', 'no');
    name.textContent = EMBEDDING_PROFILES_MODEL_NAME;
    node.replaceChildren(before || '', name, after || '');
  }

  localizeServing(group) {
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const key = node.getAttribute('data-rag-i18n');
      if (key === 'serving.title') this.fillModelLabel(node);
      else if (key === 'serving.help') node.textContent = this.t('serving.help');
      else if (this.locale !== 'en' && EMBEDDING_PROFILES_LABELS[this.locale][key] !== undefined) node.textContent = this.t(key);
    }
  }

  setStatus(text, isError) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('text-error', Boolean(isError));
  }

  async load() {
    this.setStatus('Loading embedding profiles…', false);
    if (this.listEl) this.listEl.replaceChildren();
    const result = await ragFetch('admin/embedding-profiles?completeness=true', { method: 'GET' });
    if (!result.ok) {
      this.setStatus(result.message || authMessage(result.status), true);
      return;
    }
    this.activeId = result.body && result.body.active;
    this.profiles = (result.body && result.body.profiles) || [];
    this.render();
    this.setStatus('', false);
  }

  render() {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    const chosenLanguages = embeddingProfilesChosenLanguages(document);
    for (const profile of this.profiles) {
      const view = buildProfileRowView(profile, { chosenLanguages, locale: this.locale });
      const row = document.createElement('article');
      row.className = 'border border-base-300 rounded-lg p-4 mb-3';

      const title = document.createElement('h4');
      title.className = 'font-semibold break-words';
      title.textContent = view.id + (view.id === this.activeId ? ' (active)' : '');
      row.appendChild(title);

      const meta = document.createElement('p');
      meta.className = 'text-sm';
      meta.textContent = view.summary;
      row.appendChild(meta);

      const evidence = document.createElement('p');
      evidence.className = 'text-xs text-base-content/70';
      evidence.textContent = view.evidence;
      row.appendChild(evidence);

      row.appendChild(this.languagesLine(view.languages));
      for (const code of view.missingLanguages) row.appendChild(this.missingLanguageLine(code));
      if (view.servingMode) {
        const serving = document.createElement('p');
        serving.className = 'text-xs text-base-content/70';
        serving.textContent = this.t('profile.serving', { mode: this.t(`serving.${view.servingMode}`) });
        row.appendChild(serving);
      }

      if (view.id !== this.activeId) {
        const activateBtn = document.createElement('button');
        activateBtn.type = 'button';
        activateBtn.className = 'btn btn-sm btn-primary mt-2';
        activateBtn.textContent = 'Activate';
        activateBtn.addEventListener('click', () => this.activate(view.id));
        row.appendChild(activateBtn);
      }

      this.listEl.appendChild(row);
    }
  }

  languageName(code) {
    const name = document.createElement('span');
    name.setAttribute('lang', code);
    name.textContent = embeddingProfilesNativeName(code);
    return name;
  }

  /** "Languages: 中文 (zh), English (en)": native names with `lang`, then the code. */
  languagesLine(codes) {
    const line = document.createElement('p');
    line.className = 'text-xs text-base-content/70 break-words';
    const [before, after] = String(this.t('profile.languages')).split('{list}');
    const parts = [before || ''];
    if (codes.length === 0) parts.push(this.t('profile.noLanguages'));
    codes.forEach((code, index) => {
      if (index > 0) parts.push(this.t('listSeparator'));
      const codeEl = document.createElement('span');
      codeEl.setAttribute('translate', 'no');
      codeEl.textContent = code;
      parts.push(this.languageName(code), ' (', codeEl, ')');
    });
    parts.push(after || '');
    line.replaceChildren(...parts);
    return line;
  }

  missingLanguageLine(code) {
    const line = document.createElement('p');
    line.className = 'flex items-start gap-1 text-xs min-w-0 break-words';
    line.setAttribute('data-rag-profile-warning', '');
    const icon = document.createElement('i');
    icon.className = 'bi bi-exclamation-triangle text-warning shrink-0';
    icon.setAttribute('aria-hidden', 'true');
    const word = document.createElement('span');
    word.className = 'font-medium';
    word.textContent = this.t('profile.warning');
    const [before, after] = String(this.t('profile.missingLanguage')).split('{language}');
    const sentence = document.createElement('span');
    sentence.className = 'min-w-0';
    sentence.replaceChildren(word, ' ', before || '', this.languageName(code), after || '');
    line.replaceChildren(icon, sentence);
    return line;
  }

  async activate(profileId) {
    const result = await ragFetch(`admin/embedding-profiles/${encodeURIComponent(profileId)}/activate`, {
      method: 'POST',
      body: '{}',
    });
    if (!result.ok) {
      const refusal = formatActivationRefusal(result.body || {});
      this.setStatus(result.status === 409 ? refusal : result.message || refusal, true);
      return;
    }
    await this.load();
  }

  async rollback() {
    if (!globalThis.confirm('Rollback to the previous active embedding profile?')) return;
    const result = await ragFetch('admin/embedding-profiles/rollback', { method: 'POST', body: '{}' });
    if (!result.ok) {
      const refusal = formatActivationRefusal(result.body || {});
      this.setStatus(result.status === 409 ? refusal : result.message || refusal, true);
      return;
    }
    await this.load();
  }
}

function initEmbeddingProfilesPanel() {
  const root = document.getElementById('rag-administration-profiles');
  if (!root) return;
  if (window.embeddingProfilesPanel instanceof EmbeddingProfilesPanel) {
    window.embeddingProfilesPanel.load();
    return;
  }
  const panel = new EmbeddingProfilesPanel();
  panel.mount(root);
  window.embeddingProfilesPanel = panel;
}

function bindEmbeddingProfilesPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-profiles-bound')) return;
    link.setAttribute('data-profiles-bound', '1');
    link.addEventListener('click', () => initEmbeddingProfilesPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initEmbeddingProfilesPanel = initEmbeddingProfilesPanel;
  window.formatActivationRefusal = formatActivationRefusal;
  document.addEventListener('DOMContentLoaded', () => bindEmbeddingProfilesPanel());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildProfileRowView, formatActivationRefusal };
}