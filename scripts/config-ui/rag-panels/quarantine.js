/**
 * Quarantine admin panel — renders snippets as plain text only.
 */

function buildQuarantineItemView(item) {
  const ruleIds = Array.isArray(item.rule_ids) ? item.rule_ids.join(', ') : String(item.rule_ids || '');
  const snippets = Array.isArray(item.snippets) ? item.snippets.map((s) => String(s)) : [];
  return {
    filename: String(item.filename || 'Unknown file'),
    ruleIds,
    snippets,
    tenant: String(item.tenant_key || ''),
    id: String(item.id || ''),
  };
}

class QuarantinePanel {
  constructor() {
    this.listEl = null;
    this.statusEl = null;
    this.items = [];
  }

  mount(root) {
    this.listEl = root.querySelector('[data-rag-quarantine-list]');
    this.statusEl = root.querySelector('[data-rag-quarantine-status]');
    root.querySelector('[data-rag-quarantine-refresh]')?.addEventListener('click', () => this.load());
    this.load();
  }

  setStatus(text, isError) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('text-error', Boolean(isError));
  }

  async load() {
    this.setStatus('Loading quarantined documents…', false);
    if (this.listEl) this.listEl.replaceChildren();
    const result = await ragFetch('admin/quarantine?limit=50', { method: 'GET' });
    if (!result.ok) {
      this.setStatus(result.message || authMessage(result.status), true);
      return;
    }
    this.items = (result.body && result.body.items) || [];
    this.render();
    this.setStatus(this.items.length ? '' : 'No quarantined documents.', false);
  }

  render() {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    for (const raw of this.items) {
      const view = buildQuarantineItemView(raw);
      const card = document.createElement('article');
      card.className = 'border border-base-300 rounded-lg p-4 mb-3';

      const title = document.createElement('h4');
      title.className = 'font-semibold';
      title.textContent = view.filename;
      card.appendChild(title);

      const meta = document.createElement('p');
      meta.className = 'text-sm text-base-content/70';
      meta.textContent = `Tenant: ${view.tenant} · Rules: ${view.ruleIds}`;
      card.appendChild(meta);

      for (const snippet of view.snippets) {
        const pre = document.createElement('pre');
        pre.className = 'text-xs bg-base-200 rounded p-2 mt-2 whitespace-pre-wrap';
        pre.textContent = snippet;
        card.appendChild(pre);
      }

      const actions = document.createElement('div');
      actions.className = 'flex gap-2 mt-3';
      const releaseBtn = document.createElement('button');
      releaseBtn.className = 'btn btn-sm btn-primary';
      releaseBtn.type = 'button';
      releaseBtn.textContent = 'Release';
      releaseBtn.addEventListener('click', () => this.release(view.id, view.filename));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-error';
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => this.remove(view.id, view.filename));
      actions.appendChild(releaseBtn);
      actions.appendChild(deleteBtn);
      card.appendChild(actions);

      this.listEl.appendChild(card);
    }
  }

  async release(id, filename) {
    if (!globalThis.confirm(`Release "${filename}" from quarantine?`)) return;
    const result = await ragFetch(`admin/quarantine/${encodeURIComponent(id)}/release`, { method: 'POST', body: '{}' });
    if (!result.ok) {
      this.setStatus(result.message || `Release failed (${result.status})`, true);
      return;
    }
    await this.load();
  }

  async remove(id, filename) {
    if (!globalThis.confirm(`Delete quarantined document "${filename}"? This cannot be undone.`)) return;
    const result = await ragFetch(`admin/quarantine/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!result.ok) {
      this.setStatus(result.message || `Delete failed (${result.status})`, true);
      return;
    }
    await this.load();
  }
}

function initQuarantinePanel() {
  const root = document.getElementById('rag-administration-quarantine');
  if (!root) return;
  const panel = new QuarantinePanel();
  panel.mount(root);
  window.quarantinePanel = panel;
}

if (typeof window !== 'undefined') {
  window.initQuarantinePanel = initQuarantinePanel;
  document.addEventListener('DOMContentLoaded', () => {
    const tab = document.querySelector('[data-tab="rag-administration"]');
    if (tab) tab.addEventListener('click', () => initQuarantinePanel());
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildQuarantineItemView };
}