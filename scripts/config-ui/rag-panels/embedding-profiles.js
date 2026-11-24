/**
 * Embedding profiles admin panel.
 */

function formatActivationRefusal(body) {
  if (body && typeof body.reason === 'string' && body.reason.length > 0) {
    return body.reason;
  }
  if (body && typeof body.error === 'string' && body.error.includes('activation_refused')) {
    return body.error;
  }
  return 'activation_refused: unknown';
}

function buildProfileRowView(profile) {
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
  };
}

class EmbeddingProfilesPanel {
  constructor() {
    this.listEl = null;
    this.statusEl = null;
    this.profiles = [];
    this.activeId = null;
  }

  mount(root) {
    this.listEl = root.querySelector('[data-rag-profiles-list]');
    this.statusEl = root.querySelector('[data-rag-profiles-status]');
    root.querySelector('[data-rag-profiles-refresh]')?.addEventListener('click', () => this.load());
    root.querySelector('[data-rag-profiles-rollback]')?.addEventListener('click', () => this.rollback());
    this.load();
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
    for (const profile of this.profiles) {
      const view = buildProfileRowView(profile);
      const row = document.createElement('article');
      row.className = 'border border-base-300 rounded-lg p-4 mb-3';

      const title = document.createElement('h4');
      title.className = 'font-semibold';
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
  const panel = new EmbeddingProfilesPanel();
  panel.mount(root);
  window.embeddingProfilesPanel = panel;
}

if (typeof window !== 'undefined') {
  window.initEmbeddingProfilesPanel = initEmbeddingProfilesPanel;
  window.formatActivationRefusal = formatActivationRefusal;
  document.addEventListener('DOMContentLoaded', () => {
    const tab = document.querySelector('[data-tab="rag-administration"]');
    if (tab) {
      tab.addEventListener('click', () => {
        initEmbeddingProfilesPanel();
      });
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildProfileRowView, formatActivationRefusal };
}