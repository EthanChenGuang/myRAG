/**
 * Embedding bindings admin panel (03.1.1-UI-SPEC). Talks only to /api/rag/admin/embedding-bindings and its activate, rollback and
 * deactivate routes. Document type ids and labels come from the API and the existing doc-type label source; this file names none.
 */

const BINDINGS_API = 'admin/embedding-bindings';
const BINDINGS_TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const BINDINGS_STATUS_ORDER = ['active', 'backfilling', 'available', 'retired'];

const BINDINGS_COPY = {
  'action.refresh': 'Refresh',
  'action.new': 'New binding',
  'action.reload': 'Reload panel',
  'action.retry': 'Try again',
  updated: 'Updated {time}',
  loading: 'Loading embedding bindings…',
  'state.switch': 'Domain embeddings',
  'state.on': 'On',
  'state.off': 'Off',
  'state.global': 'Global active profile',
  'state.none': 'None',
  'off.note':
    'Domain embeddings are off. Bindings are stored but not used: questions are answered with the global profile alone, and new documents are not written to binding profiles. To use them, set Domain embeddings (RAG_DOMAIN_EMBEDDINGS) to on in the Ingestion and embedding profiles settings.',
  'off.noteProfiles': 'Embedding profiles are off (RAG_EMBEDDING_PROFILES), which keeps domain embeddings off too. Bindings are stored but not used.',
  'table.caption': 'Bindings for {type}',
  'col.scope': 'Scope',
  'col.profile': 'Profile',
  'col.status': 'Status',
  'col.complete': 'Complete',
  'col.evidence': 'Evidence',
  'col.actions': 'Actions',
  'scope.deployment': 'Whole deployment',
  'scope.tenantLabel': 'Tenant',
  'scope.tenant': 'tenant {key}',
  'row.bindingId': 'Binding id',
  'status.active': 'Active',
  'status.backfilling': 'Backfilling',
  'status.available': 'Available',
  'status.retired': 'Retired',
  'badge.stale': 'Stale',
  'badge.incomplete': 'Incomplete',
  'hint.activated': 'Activated {date}',
  'hint.activatedBy': ' by ',
  'hint.backfilling': 'Fill this profile with the re-embed job: ',
  'hint.stale':
    'Skipped when answering questions. Its evidence was recorded against {baseline}; the global active profile is now {global}. Deactivate it, record new evidence with the CLI, then activate it again.',
  'complete.notMeasured': 'Not measured for this status',
  'complete.unavailable': 'Count unavailable',
  'complete.none': 'No chunks in scope',
  'complete.count': '{have} of {chunks} chunks',
  'complete.missing': '{missing} of {chunks} chunks missing',
  'evidence.yes': 'Yes',
  'evidence.no': 'No',
  'evidence.baseline': 'Baseline ',
  'evidence.noBaseline': 'Baseline not recorded',
  'evidence.outdated': 'Out of date: the global active profile is now {global}. Record new evidence before activating.',
  'action.stage': 'Stage for backfill',
  'action.activate': 'Activate',
  'action.markAvailable': 'Mark available',
  'action.retire': 'Retire',
  'action.rollback': 'Roll back',
  'action.deactivate': 'Deactivate',
  'aria.action': '{action}: {profile} for {type}, {scope}',
  'activate.needsEvidence.short': 'Needs evidence, recorded with the CLI',
  'activate.needsEvidence': 'Activate needs evidence. Record it with the CLI: ',
  'confirm.keep': 'Keep as is',
  'confirm.activate.title': 'Activate {profile} for {type}, {scope}?',
  'confirm.activate.body':
    'Questions about {type} documents will also be searched with this profile. The gate first checks that the profile is complete and that the evidence passes, and may refuse. A binding that is active for the same scope becomes available.',
  'confirm.activate.off': ' Domain embeddings are off, so this has no effect on answers until they are turned on.',
  'confirm.activate.action': 'Activate',
  'confirm.activate.busy': 'Activating…',
  'confirm.rollback.title': 'Roll back {type}, {scope}, to the previous binding?',
  'confirm.rollback.body':
    '{profile} becomes available and the previous binding ({previous}) becomes active again, if its vectors are still complete. No vectors are deleted.',
  'confirm.rollback.notListed': 'not in the list',
  'confirm.rollback.action': 'Roll back',
  'confirm.rollback.busy': 'Rolling back…',
  'confirm.deactivate.title': 'Deactivate the binding for {type}, {scope}?',
  'confirm.deactivate.body':
    '{type} documents are answered with the global profile alone again. {profile} stays available and can be activated again. No vectors are deleted.',
  'confirm.deactivate.action': 'Deactivate',
  'confirm.deactivate.busy': 'Deactivating…',
  'form.title': 'New binding',
  'form.docType': 'Document type',
  'form.docType.placeholder': 'Choose a document type',
  'form.scope': 'Scope',
  'form.scope.deployment': 'Whole deployment',
  'form.scope.tenant': 'One tenant',
  'form.tenant': 'Tenant key',
  'form.tenant.help': 'The key the app stores for the tenant: s:default, or u: or o: followed by the id.',
  'form.tenant.invalid': 'Enter a tenant key: s:default, or u: or o: followed by a UUID.',
  'form.profile': 'Embedding profile',
  'form.profile.placeholder': 'Choose a profile',
  'form.profile.option': '{id} ({model}, {dims} dimensions)',
  'form.profile.help': 'Only profiles scoped to the chosen document type are listed.',
  'form.profile.none': 'No profile is scoped to this document type. Choose another document type; scoped profiles are added by a database migration.',
  'form.required': 'Choose a value.',
  'form.submit': 'Create binding',
  'form.submitting': 'Creating…',
  'form.cancel': 'Cancel',
  'empty.title': 'No bindings yet',
  'empty.body': 'Every document type is answered with the global profile alone. Create a binding to prepare a second profile for one document type.',
  'empty.noProfiles':
    'No embedding profile is scoped to a document type, so no binding can be created. Scoped profiles are added by a database migration.',
  'result.created': 'Binding created: {profile} for {type}, {scope}. It is available. Stage it for backfill next.',
  'result.exists': 'That binding already exists and is {status}. Nothing was changed.',
  'result.staged': 'Staged for backfill: {profile} for {type}, {scope}.',
  'result.available': 'Marked available: {profile} for {type}, {scope}.',
  'result.retired': 'Retired: {profile} for {type}, {scope}.',
  'result.activated': 'Activated: {profile} for {type}, {scope}.',
  'result.activated.previous': ' The binding that was active is now available.',
  'result.activated.off': ' Domain embeddings are off, so it is not used yet.',
  'result.rolledBack': 'Rolled back {type}, {scope}. The list shows the binding that is active now.',
  'result.deactivated': 'Deactivated: {type}, {scope}, is answered with the global profile alone.',
  'refusal.status': 'Refused: {reason}',
  'refusal.lead': 'The gate refused this change. Nothing was changed.',
  'error.registry': 'The embedding registry can’t be reached, so bindings can’t be shown. Try again in a moment.',
  'error.unconfirmed': 'The server did not confirm the change, so it may or may not have been applied. The list shows the current state.',
  'error.network': 'The server can’t be reached. Check that the app is running, then try again.',
};

function bindingsText(key, values) {
  const template = Object.prototype.hasOwnProperty.call(BINDINGS_COPY, key) ? BINDINGS_COPY[key] : key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (values && values[name] !== undefined && values[name] !== null ? String(values[name]) : match));
}

function bindingsLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('it')) return 'it';
  return 'en';
}

function bindingsNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

// -- pure view model --------------------------------------------------------------------------------------------------------------------

/** The label from the doc-type label source; null when there is none beyond the id itself. */
function bindingsDocTypeLabel(id, labelFn, locale) {
  if (typeof labelFn !== 'function') return null;
  const label = labelFn(id, locale || 'en');
  return typeof label === 'string' && label !== '' && label !== id ? label : null;
}

/** The 100% rule: a percent is never shown as complete while chunks are missing. */
function bindingsPercentText(completeness) {
  if (!completeness || completeness.state !== 'measured') return null;
  if (completeness.missing > 0) return Math.min(99, Math.floor(Number(completeness.percent) || 0)) + '%';
  return '100%';
}

function bindingsCompletenessView(completeness) {
  if (!completeness) return { kind: 'none' };
  if (completeness.state !== 'measured') return { kind: 'unavailable', text: bindingsText('complete.unavailable') };
  if (!completeness.chunks) return { kind: 'empty', text: bindingsText('complete.none') };
  const chunks = bindingsNumber(completeness.chunks);
  if (completeness.missing > 0) {
    return { kind: 'missing', percent: bindingsPercentText(completeness), detail: bindingsText('complete.missing', { missing: bindingsNumber(completeness.missing), chunks }) };
  }
  return { kind: 'complete', percent: '100%', detail: bindingsText('complete.count', { have: chunks, chunks }) };
}

/** Badges after the status word: Stale from the API flag, Incomplete only on an active row with missing chunks. */
function bindingsBadges(row) {
  const status = String(row.status || '');
  const known = BINDINGS_STATUS_ORDER.includes(status);
  const badges = [{ tone: known ? status : 'unknown', text: known ? bindingsText('status.' + status) : status }];
  if (row.stale === true) badges.push({ tone: 'stale', text: bindingsText('badge.stale') });
  const c = row.completeness;
  if (status === 'active' && c && c.state === 'measured' && c.missing > 0) badges.push({ tone: 'incomplete', text: bindingsText('badge.incomplete') });
  return badges;
}

/** The actions a row offers, in order; Activate carries `disabled` when the binding has no evidence (the only client-side gate). */
function bindingsActionsFor(row) {
  const status = row.status;
  const out = [];
  if (status === 'available') out.push({ kind: 'stage' });
  if (status === 'available' || status === 'backfilling') out.push({ kind: 'activate', disabled: row.has_evidence !== true });
  if (status === 'backfilling' || status === 'retired') out.push({ kind: 'markAvailable' });
  if (status === 'available' || status === 'backfilling') out.push({ kind: 'retire' });
  if (status === 'active' && row.previous_binding_id) out.push({ kind: 'rollback' });
  if (status === 'active') out.push({ kind: 'deactivate' });
  return out;
}

function bindingsEvidenceView(row, globalActive) {
  if (row.has_evidence !== true) return { has: false, text: bindingsText('evidence.no') };
  const baseline = row.baseline_global_profile || null;
  const outdated = row.status !== 'active' && Boolean(baseline) && Boolean(globalActive) && baseline !== globalActive;
  return { has: true, text: bindingsText('evidence.yes'), baseline, outdated };
}

function bindingsRowOrder(a, b) {
  const scopeA = a.tenant_key === null ? '' : '\u0001' + a.tenant_key;
  const scopeB = b.tenant_key === null ? '' : '\u0001' + b.tenant_key;
  if (scopeA !== scopeB) return scopeA < scopeB ? -1 : 1;
  const rank = (row) => {
    const index = BINDINGS_STATUS_ORDER.indexOf(row.status);
    return index < 0 ? BINDINGS_STATUS_ORDER.length : index;
  };
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return String(a.profile_id).localeCompare(String(b.profile_id));
}

/** One group per document type with at least one binding, in the API order of doc_types; unknown types follow in first-seen order. */
function bindingsGroups(body) {
  const bindings = Array.isArray(body && body.bindings) ? body.bindings : [];
  const order = Array.isArray(body && body.doc_types) ? body.doc_types.slice() : [];
  for (const row of bindings) if (!order.includes(row.doc_type)) order.push(row.doc_type);
  const groups = [];
  for (const docType of order) {
    const rows = bindings.filter((row) => row.doc_type === docType).sort(bindingsRowOrder);
    if (rows.length > 0) groups.push({ docType, rows });
  }
  return groups;
}

/** Profiles a binding of this document type may name: the profiles scoped to it. */
function bindingsProfilesFor(profiles, docType) {
  return (Array.isArray(profiles) ? profiles : []).filter((profile) => Array.isArray(profile.doc_types) && profile.doc_types.includes(docType));
}

function bindingsHasScopedProfile(profiles) {
  return (Array.isArray(profiles) ? profiles : []).some((profile) => Array.isArray(profile.doc_types) && profile.doc_types.length > 0);
}

function bindingsRefusalText(body) {
  if (body && typeof body.reason === 'string' && body.reason.length > 0) return body.reason;
  return 'binding_refused: unknown';
}

/** Validates the create form values; returns field errors keyed by API field name. */
function bindingsValidateForm(values) {
  const errors = {};
  if (!values.doc_type) errors.doc_type = bindingsText('form.required');
  if (!values.profile_id) errors.profile_id = bindingsText('form.required');
  if (values.scope === 'tenant' && !BINDINGS_TENANT_KEY.test(String(values.tenant_key || ''))) errors.tenant_key = bindingsText('form.tenant.invalid');
  return errors;
}

function bindingsCreateBody(values) {
  return { action: 'create', doc_type: values.doc_type, profile_id: values.profile_id, tenant_key: values.scope === 'tenant' ? values.tenant_key : null };
}

// -- DOM helpers (createElement and textContent only) -------------------------------------------------------------------------------------

function bindingsEl(tag, opts, children) {
  const el = document.createElement(tag);
  const o = opts || {};
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined && o.text !== null) el.textContent = String(o.text);
  if (o.attrs) {
    for (const [name, value] of Object.entries(o.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (o.on) for (const [type, fn] of Object.entries(o.on)) el.addEventListener(type, fn);
  if (children) for (const child of children) if (child) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return el;
}

function bindingsIcon(name, extra) {
  return bindingsEl('i', { cls: 'bi ' + name + (extra ? ' ' + extra : ''), attrs: { 'aria-hidden': 'true' } });
}

function bindingsSpinner() {
  return bindingsEl('span', { cls: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } });
}

function bindingsMono(text, cls) {
  return bindingsEl('span', { cls: cls || 'font-mono text-sm break-all', text, attrs: { translate: 'no' } });
}

function bindingsCode(text) {
  return bindingsEl('code', { cls: 'font-mono text-xs break-words', text, attrs: { translate: 'no' } });
}

function bindingsDash(srText) {
  return bindingsEl('span', null, [bindingsEl('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), bindingsEl('span', { cls: 'sr-only', text: srText })]);
}

function bindingsAlert(tone, icon, nodes) {
  const body = bindingsEl('div', { cls: 'flex flex-col gap-2 items-start min-w-0 max-w-prose' }, nodes);
  return bindingsEl('div', { cls: 'alert alert-' + tone + ' items-start text-left' }, [bindingsIcon(icon, 'mt-0.5'), body]);
}

function bindingsTime(iso, style) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return bindingsEl('span', { text: String(iso) });
  return bindingsEl('time', { text: new Intl.DateTimeFormat(undefined, style).format(date), attrs: { datetime: date.toISOString() } });
}

const BINDINGS_BADGE_CLASS = {
  active: 'badge badge-success badge-sm gap-1 h-auto whitespace-nowrap',
  backfilling: 'badge badge-info badge-outline badge-sm h-auto whitespace-nowrap',
  available: 'badge badge-outline badge-sm h-auto whitespace-nowrap',
  retired: 'badge badge-ghost badge-sm h-auto whitespace-nowrap',
  unknown: 'badge badge-outline badge-sm h-auto whitespace-nowrap',
  stale: 'badge badge-warning badge-outline badge-sm h-auto whitespace-nowrap',
  incomplete: 'badge badge-warning badge-sm h-auto whitespace-nowrap',
};

const BINDINGS_ACTION_CLASS = {
  stage: 'btn btn-outline md:btn-sm',
  activate: 'btn btn-primary md:btn-sm',
  markAvailable: 'btn btn-outline md:btn-sm',
  retire: 'btn md:btn-sm',
  rollback: 'btn btn-outline md:btn-sm',
  deactivate: 'btn btn-outline md:btn-sm',
};

// -- panel ----------------------------------------------------------------------------------------------------------------------------------

class EmbeddingBindingsPanel {
  constructor() {
    this.root = null;
    this.data = null;
    this.busy = false;
    this.formOpen = false;
    this.notes = {};
    this.signedOut = false;
  }

  mount(root) {
    this.root = root;
    this.alertEl = root.querySelector('[data-rag-bindings-alert]');
    this.statusEl = root.querySelector('[data-rag-bindings-status]');
    this.contentEl = root.querySelector('[data-rag-bindings-content]');
    this.refreshBtn = root.querySelector('[data-rag-bindings-refresh]');
    this.newBtn = root.querySelector('[data-rag-bindings-new]');
    this.updatedEl = root.querySelector('[data-rag-bindings-updated]');
    this.stateEl = root.querySelector('[data-rag-bindings-state]');
    this.formHost = root.querySelector('[data-rag-bindings-form-host]');
    this.listEl = root.querySelector('[data-rag-bindings-list]');
    this.refreshBtn?.addEventListener('click', () => this.load());
    this.newBtn?.addEventListener('click', () => this.toggleForm());
    this.load();
  }

  typeName(docType) {
    return bindingsDocTypeLabel(docType, typeof window !== 'undefined' ? window.docTypeLabelForLocale : null, bindingsLocale()) || docType;
  }

  scopeName(tenantKey) {
    return tenantKey === null || tenantKey === undefined ? bindingsText('scope.deployment') : bindingsText('scope.tenant', { key: tenantKey });
  }

  rowValues(row) {
    return { profile: row.profile_id, type: this.typeName(row.doc_type), scope: this.scopeName(row.tenant_key) };
  }

  setStatus(text, isError) {
    if (!this.statusEl) return;
    this.statusEl.replaceChildren();
    if (text) {
      if (isError) this.statusEl.appendChild(bindingsIcon('bi-exclamation-circle', 'mr-1'));
      this.statusEl.appendChild(document.createTextNode(text));
    }
    this.statusEl.classList.toggle('text-error', Boolean(isError));
  }

  focusStatus() {
    if (this.statusEl && typeof this.statusEl.focus === 'function') this.statusEl.focus();
  }

  setBusy(busy) {
    this.busy = busy;
    if (!this.root) return;
    for (const button of this.root.querySelectorAll('[data-rag-bindings-action]')) button.disabled = busy || button.getAttribute('data-gated') === '1';
    if (this.refreshBtn) this.refreshBtn.disabled = busy;
    if (this.newBtn) this.newBtn.disabled = busy || !this.canCreate();
  }

  canCreate() {
    return Boolean(this.data) && bindingsHasScopedProfile(this.data.profiles);
  }

  async request(apiPath, init) {
    try {
      return await ragFetch(apiPath, init);
    } catch {
      return { ok: false, status: 0, network: true, message: bindingsText('error.network'), body: null };
    }
  }

  showSignIn(status) {
    this.signedOut = true;
    if (this.contentEl) this.contentEl.hidden = true;
    const reload = bindingsEl('button', { cls: 'btn btn-sm', text: bindingsText('action.reload'), attrs: { type: 'button' }, on: { click: () => this.load() } });
    this.alertEl?.replaceChildren(bindingsAlert('warning', 'bi-person-lock', [bindingsEl('p', { cls: 'text-sm', text: authMessage(status) }), reload]));
  }

  showLoadError(text) {
    const retry = bindingsEl('button', { cls: 'btn btn-sm', text: bindingsText('action.retry'), attrs: { type: 'button' }, on: { click: () => this.load() } });
    this.alertEl?.replaceChildren(bindingsAlert('error', 'bi-exclamation-octagon', [bindingsEl('p', { cls: 'text-sm', text }), retry]));
  }

  async load() {
    const first = !this.data;
    this.setBusy(true);
    if (this.refreshBtn) this.refreshBtn.replaceChildren(bindingsSpinner(), bindingsText('action.refresh'));
    if (first && this.listEl) {
      this.listEl.replaceChildren(bindingsEl('p', { cls: 'flex items-center gap-2 text-sm text-base-content/70 py-4' }, [bindingsSpinner(), bindingsText('loading')]));
      this.setStatus(bindingsText('loading'), false);
    } else if (this.listEl) {
      this.listEl.classList.add('opacity-60');
      this.listEl.setAttribute('aria-busy', 'true');
    }
    const result = await this.request(BINDINGS_API, { method: 'GET' });
    if (this.refreshBtn) this.refreshBtn.replaceChildren(bindingsText('action.refresh'));
    this.listEl?.classList.remove('opacity-60');
    this.listEl?.removeAttribute('aria-busy');
    if (!result.ok) {
      this.setBusy(false);
      if (this.listEl && first) this.listEl.replaceChildren();
      if (result.status === 401 || result.status === 403) {
        this.setStatus('', false);
        this.showSignIn(result.status);
        return;
      }
      if (this.contentEl) this.contentEl.hidden = false;
      if (result.status === 503) {
        if (this.listEl && this.data) this.listEl.classList.add('opacity-60');
        if (this.newBtn) this.newBtn.disabled = true;
        this.setStatus('', false);
        this.showLoadError(bindingsText('error.registry'));
        return;
      }
      if (result.network) {
        this.setStatus('', false);
        this.showLoadError(bindingsText('error.network'));
        return;
      }
      this.setStatus(result.message, true);
      return;
    }
    this.signedOut = false;
    if (this.contentEl) this.contentEl.hidden = false;
    this.alertEl?.replaceChildren();
    this.data = result.body || {};
    this.render();
    if (this.updatedEl) {
      this.updatedEl.replaceChildren();
      const parts = bindingsText('updated').split('{time}');
      this.updatedEl.append(parts[0], bindingsTime(new Date().toISOString(), { timeStyle: 'short' }), parts[1] || '');
    }
    if (first) this.setStatus('', false);
    this.setBusy(false);
  }

  render() {
    this.renderState();
    if (this.formOpen) this.renderForm();
    this.renderList();
  }

  renderState() {
    if (!this.stateEl) return;
    const on = this.data.switch === 'on';
    const dl = bindingsEl('dl', { cls: 'flex flex-wrap gap-x-6 gap-y-1 text-sm' }, [
      bindingsEl('div', { cls: 'flex flex-wrap items-center gap-2' }, [
        bindingsEl('dt', { text: bindingsText('state.switch') }),
        bindingsEl('dd', { cls: 'flex items-center gap-2' }, [
          bindingsEl('span', { cls: on ? 'badge badge-success badge-outline badge-sm' : 'badge badge-ghost badge-sm', text: bindingsText(on ? 'state.on' : 'state.off') }),
          bindingsEl('code', { cls: 'font-mono text-xs break-all', text: 'RAG_DOMAIN_EMBEDDINGS', attrs: { translate: 'no' } }),
        ]),
      ]),
      bindingsEl('div', { cls: 'flex flex-wrap items-center gap-2' }, [
        bindingsEl('dt', { text: bindingsText('state.global') }),
        bindingsEl('dd', null, [this.data.global_active ? bindingsMono(this.data.global_active) : bindingsDash(bindingsText('state.none'))]),
      ]),
    ]);
    const nodes = [dl];
    if (!on) {
      const note = this.data.profiles_switch === 'off' ? 'off.noteProfiles' : 'off.note';
      const alert = bindingsAlert('info', 'bi-info-circle', [bindingsEl('p', { cls: 'text-sm', text: bindingsText(note) })]);
      alert.classList.add('mt-2');
      nodes.push(alert);
    }
    if (!this.canCreate()) nodes.push(bindingsEl('p', { cls: 'text-xs text-base-content/70 mt-2', text: bindingsText('empty.noProfiles') }));
    this.stateEl.replaceChildren(...nodes);
  }

  renderList() {
    if (!this.listEl) return;
    const groups = bindingsGroups(this.data);
    if (groups.length === 0) {
      const children = [
        bindingsEl('h4', { cls: 'text-base font-semibold', text: bindingsText('empty.title') }),
        bindingsEl('p', { cls: 'text-sm text-base-content/70 max-w-prose', text: bindingsText(this.canCreate() ? 'empty.body' : 'empty.noProfiles') }),
      ];
      if (this.canCreate()) {
        children.push(
          bindingsEl('button', { cls: 'btn btn-primary btn-sm', text: bindingsText('action.new'), attrs: { type: 'button' }, on: { click: () => this.openForm() } }),
        );
      }
      this.listEl.replaceChildren(bindingsEl('div', { cls: 'py-8 flex flex-col items-center text-center gap-2' }, children));
      return;
    }
    const wrap = bindingsEl('div', { cls: 'divide-y divide-base-300' });
    for (const group of groups) wrap.appendChild(this.renderGroup(group));
    this.listEl.replaceChildren(wrap);
  }

  renderGroup(group) {
    const headingId = 'rag-bindings-group-' + group.docType.replace(/[^a-z0-9_-]/gi, '');
    const label = bindingsDocTypeLabel(group.docType, typeof window !== 'undefined' ? window.docTypeLabelForLocale : null, bindingsLocale());
    const heading = bindingsEl('h4', { cls: 'text-base font-semibold text-balance', attrs: { id: headingId } }, [
      label ? label + ' ' : null,
      bindingsEl('span', { cls: 'font-mono text-xs text-base-content/70', text: group.docType, attrs: { translate: 'no' } }),
    ]);
    const head = bindingsEl('thead', null, [
      bindingsEl(
        'tr',
        null,
        ['col.scope', 'col.profile', 'col.status', 'col.complete', 'col.evidence', 'col.actions'].map((key) => {
          const cls = key === 'col.actions' ? 'sr-only' : key === 'col.evidence' ? 'text-xs font-semibold hidden md:table-cell' : key === 'col.complete' ? 'text-xs font-semibold text-right' : 'text-xs font-semibold';
          return bindingsEl('th', { cls, text: bindingsText(key), attrs: { scope: 'col' } });
        }),
      ),
    ]);
    const tbody = bindingsEl('tbody');
    for (const row of group.rows) {
      tbody.appendChild(this.renderRow(row));
      const note = this.notes[row.id];
      if (note) tbody.appendChild(this.renderNote(note));
    }
    const table = bindingsEl('table', { cls: 'table table-sm' }, [
      bindingsEl('caption', { cls: 'sr-only', text: bindingsText('table.caption', { type: this.typeName(group.docType) }) }),
      head,
      tbody,
    ]);
    return bindingsEl('div', { cls: 'py-4', attrs: { role: 'group', 'aria-labelledby': headingId } }, [heading, bindingsEl('div', { cls: 'overflow-x-auto mt-4' }, [table])]);
  }

  renderRow(row) {
    const scope =
      row.tenant_key === null
        ? bindingsEl('th', { cls: 'font-normal align-top min-w-40', text: bindingsText('scope.deployment'), attrs: { scope: 'row' } })
        : bindingsEl('th', { cls: 'font-normal align-top min-w-40', attrs: { scope: 'row' } }, [
            bindingsEl('div', { text: bindingsText('scope.tenantLabel') }),
            bindingsMono(row.tenant_key),
          ]);

    const profile = bindingsEl('td', { cls: 'align-top min-w-0' }, [
      bindingsEl('div', null, [bindingsMono(row.profile_id)]),
      row.model ? bindingsEl('div', { cls: 'text-xs text-base-content/70 break-all', text: row.model, attrs: { translate: 'no' } }) : null,
      bindingsEl('div', { cls: 'font-mono text-xs text-base-content/70 break-all', attrs: { translate: 'no' } }, [
        bindingsEl('span', { cls: 'sr-only', text: bindingsText('row.bindingId') + ' ' }),
        String(row.id),
      ]),
    ]);

    const evidence = bindingsEvidenceView(row, this.data.global_active);
    const status = bindingsEl('td', { cls: 'align-top' }, [
      bindingsEl(
        'div',
        { cls: 'flex flex-wrap gap-1' },
        bindingsBadges(row).map((badge) =>
          bindingsEl('span', { cls: BINDINGS_BADGE_CLASS[badge.tone] }, [badge.tone === 'active' ? bindingsIcon('bi-check-circle-fill') : null, badge.text]),
        ),
      ),
      ...this.statusHints(row),
      bindingsEl('div', { cls: 'md:hidden text-xs text-base-content/70 mt-1' }, this.evidenceNodes(evidence)),
    ]);

    const view = bindingsCompletenessView(row.completeness);
    let completeChildren;
    if (view.kind === 'none') completeChildren = [bindingsDash(bindingsText('complete.notMeasured'))];
    else if (view.kind === 'unavailable' || view.kind === 'empty') completeChildren = [bindingsEl('span', { cls: 'text-sm text-base-content/70', text: view.text })];
    else if (view.kind === 'missing') {
      completeChildren = [
        bindingsEl('div', { cls: 'text-sm', text: view.percent }),
        bindingsEl('div', { cls: 'flex items-center justify-end gap-1 text-xs' }, [bindingsIcon('bi-exclamation-triangle-fill', 'text-warning'), view.detail]),
      ];
    } else completeChildren = [bindingsEl('div', { cls: 'text-sm', text: view.percent }), bindingsEl('div', { cls: 'text-xs text-base-content/70', text: view.detail })];
    const complete = bindingsEl('td', { cls: 'text-right tabular-nums align-top' }, completeChildren);

    const evidenceCell = bindingsEl('td', { cls: 'hidden md:table-cell align-top' }, this.evidenceNodes(evidence));
    const actions = bindingsEl('td', { cls: 'text-right align-top' }, this.actionNodes(row));
    return bindingsEl('tr', null, [scope, profile, status, complete, evidenceCell, actions]);
  }

  statusHints(row) {
    const hints = [];
    const hint = (children) => bindingsEl('div', { cls: 'text-xs text-base-content/70 mt-1 max-w-prose' }, children);
    if (row.status === 'active' && row.activated_at) {
      const parts = bindingsText('hint.activated').split('{date}');
      const children = [parts[0], bindingsTime(row.activated_at, { dateStyle: 'medium', timeStyle: 'short' }), parts[1] || ''];
      if (row.activated_by) children.push(bindingsText('hint.activatedBy'), bindingsMono(row.activated_by, 'font-mono break-all'));
      hints.push(hint(children));
    }
    if (row.status === 'backfilling') hints.push(hint([bindingsText('hint.backfilling'), bindingsCode('npm run rag:reembed')]));
    if (row.stale === true) {
      hints.push(hint([bindingsText('hint.stale', { baseline: row.baseline_global_profile || bindingsText('state.none'), global: this.data.global_active || bindingsText('state.none') })]));
    }
    return hints;
  }

  evidenceNodes(evidence) {
    if (!evidence.has) return [bindingsEl('div', { text: evidence.text })];
    const nodes = [
      bindingsEl('div', { text: evidence.text }),
      evidence.baseline
        ? bindingsEl('div', { cls: 'text-xs text-base-content/70' }, [bindingsText('evidence.baseline'), bindingsMono(evidence.baseline, 'font-mono break-all')])
        : bindingsEl('div', { cls: 'text-xs text-base-content/70', text: bindingsText('evidence.noBaseline') }),
    ];
    if (evidence.outdated) {
      nodes.push(
        bindingsEl('div', { cls: 'flex items-start gap-1 text-xs' }, [
          bindingsIcon('bi-exclamation-triangle-fill', 'text-warning mt-0.5'),
          bindingsText('evidence.outdated', { global: this.data.global_active }),
        ]),
      );
    }
    return nodes;
  }

  actionNodes(row) {
    const values = this.rowValues(row);
    const buttons = bindingsEl('div', { cls: 'flex flex-wrap justify-end gap-2' });
    let needsEvidence = null;
    for (const action of bindingsActionsFor(row)) {
      const label = bindingsText('action.' + action.kind);
      const attrs = {
        type: 'button',
        'aria-label': bindingsText('aria.action', { action: label, ...values }),
        'data-rag-bindings-action': action.kind,
        'data-rag-bindings-focus': action.kind + ':' + row.id,
      };
      if (action.disabled) {
        const hintId = 'rag-bindings-evidence-' + String(row.id).replace(/[^a-z0-9-]/gi, '');
        Object.assign(attrs, { disabled: true, 'aria-disabled': 'true', title: bindingsText('activate.needsEvidence.short'), 'aria-describedby': hintId, 'data-gated': '1' });
        needsEvidence = bindingsEl('p', { cls: 'text-xs text-base-content/70 text-right mt-1 max-w-prose ml-auto', attrs: { id: hintId } }, [
          bindingsText('activate.needsEvidence'),
          bindingsCode('npm run rag:embedding -- record-binding-evidence <comparison.json> --binding ' + row.id),
        ]);
      } else if (this.busy) attrs.disabled = true;
      const button = bindingsEl('button', { cls: BINDINGS_ACTION_CLASS[action.kind], attrs }, [
        action.kind === 'rollback' ? bindingsIcon('bi-arrow-counterclockwise') : null,
        label,
      ]);
      button.addEventListener('click', () => this.runAction(action.kind, row, button));
      buttons.appendChild(button);
    }
    return [buttons, needsEvidence];
  }

  renderNote(note) {
    const nodes = [bindingsEl('p', { cls: 'text-sm', text: bindingsText('refusal.lead') }), bindingsCode(note.reason)];
    if (typeof note.detail === 'string' && note.detail !== note.reason) nodes.push(bindingsCode(note.detail));
    return bindingsEl('tr', null, [bindingsEl('td', { attrs: { colspan: '6' } }, [bindingsAlert('error', 'bi-x-octagon', nodes)])]);
  }

  // -- actions ----------------------------------------------------------------------------------------------------------------------------

  runAction(kind, row, opener) {
    if (this.busy) return;
    if (kind === 'activate' || kind === 'rollback' || kind === 'deactivate') {
      this.confirm(kind, row, opener);
      return;
    }
    const status = kind === 'stage' ? 'backfilling' : kind === 'retire' ? 'retired' : 'available';
    const spinnerTarget = opener;
    spinnerTarget.replaceChildren(bindingsSpinner(), bindingsText('action.' + kind));
    this.mutate(kind, row, BINDINGS_API, { action: 'set_status', binding_id: row.id, status });
  }

  confirm(kind, row, opener) {
    const values = this.rowValues(row);
    let body = bindingsText('confirm.' + kind + '.body', values);
    if (kind === 'activate' && this.data.switch !== 'on') body += bindingsText('confirm.activate.off');
    if (kind === 'rollback') {
      const previous = (this.data.bindings || []).find((entry) => entry.id === row.previous_binding_id);
      body = bindingsText('confirm.rollback.body', { ...values, previous: previous ? previous.profile_id : bindingsText('confirm.rollback.notListed') });
    }
    const dialog = bindingsEl('dialog', { cls: 'modal', attrs: { 'aria-labelledby': 'rag-bindings-dialog-title', 'aria-describedby': 'rag-bindings-dialog-body' } });
    const keep = bindingsEl('button', { cls: 'btn', text: bindingsText('confirm.keep'), attrs: { type: 'button', autofocus: true } });
    const confirmBtn = bindingsEl('button', { cls: 'btn btn-primary', text: bindingsText('confirm.' + kind + '.action'), attrs: { type: 'button' } });
    const backdropButton = bindingsEl('button', { text: bindingsText('confirm.keep'), attrs: { type: 'submit', 'aria-label': bindingsText('confirm.keep'), tabindex: '-1' } });
    dialog.appendChild(
      bindingsEl('div', { cls: 'modal-box overscroll-contain' }, [
        bindingsEl('h4', { cls: 'text-base font-semibold break-words text-balance', text: bindingsText('confirm.' + kind + '.title', values), attrs: { id: 'rag-bindings-dialog-title' } }),
        bindingsEl('p', { cls: 'text-sm mt-2 break-words', text: body, attrs: { id: 'rag-bindings-dialog-body' } }),
        bindingsEl('div', { cls: 'modal-action flex-wrap' }, [keep, confirmBtn]),
      ]),
    );
    dialog.appendChild(bindingsEl('form', { cls: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]));
    let running = false;
    dialog.addEventListener('cancel', (event) => {
      if (running) event.preventDefault();
    });
    keep.addEventListener('click', () => dialog.close('cancel'));
    confirmBtn.addEventListener('click', async () => {
      if (running) return;
      running = true;
      keep.disabled = true;
      confirmBtn.disabled = true;
      backdropButton.disabled = true;
      confirmBtn.replaceChildren(bindingsSpinner(), bindingsText('confirm.' + kind + '.busy'));
      const key = { doc_type: row.doc_type, tenant_key: row.tenant_key === undefined ? null : row.tenant_key };
      const path = kind === 'activate' ? BINDINGS_API + '/' + encodeURIComponent(row.id) + '/activate' : BINDINGS_API + '/' + kind;
      await this.mutate(kind, row, path, kind === 'activate' ? {} : key, () => dialog.close('done'));
    });
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        if (dialog.returnValue !== 'done' && opener && typeof opener.focus === 'function') opener.focus();
      },
      { once: true },
    );
    document.body.appendChild(dialog);
    dialog.showModal();
    keep.focus();
  }

  async mutate(kind, row, path, body, onSettled) {
    this.setBusy(true);
    const result = await this.request(path, { method: 'POST', body: JSON.stringify(body) });
    if (onSettled) onSettled();
    delete this.notes[row.id];
    if (result.ok) {
      this.setStatus(this.successText(kind, row, result.body || {}), false);
    } else if (result.status === 409) {
      const reason = bindingsRefusalText(result.body);
      this.notes[row.id] = { reason, detail: result.body && result.body.detail };
      this.setStatus(bindingsText('refusal.status', { reason }), true);
    } else if (result.status === 401 || result.status === 403) {
      this.setBusy(false);
      this.showSignIn(result.status);
      return;
    } else if (result.status === 503 || result.network) {
      this.setStatus(bindingsText('error.unconfirmed'), true);
    } else if (result.status === 400) {
      const details = (result.body && Array.isArray(result.body.details) ? result.body.details : []).map((detail) => detail.message).filter(Boolean);
      this.setStatus([result.body && result.body.error, ...details].filter(Boolean).join('; '), true);
    } else {
      this.setStatus(result.message, true);
    }
    const message = this.statusEl ? this.statusEl.textContent : '';
    const isError = this.statusEl ? this.statusEl.classList.contains('text-error') : false;
    await this.load();
    this.setStatus(message, isError);
    this.focusStatus();
  }

  successText(kind, row, body) {
    const values = this.rowValues(row);
    if (kind === 'stage') return bindingsText('result.staged', values);
    if (kind === 'markAvailable') return bindingsText('result.available', values);
    if (kind === 'retire') return bindingsText('result.retired', values);
    if (kind === 'rollback') return bindingsText('result.rolledBack', values);
    if (kind === 'deactivate') return bindingsText('result.deactivated', values);
    let text = bindingsText('result.activated', values);
    if (body.previous) text += bindingsText('result.activated.previous');
    if (this.data && this.data.switch !== 'on') text += bindingsText('result.activated.off');
    return text;
  }

  // -- create form --------------------------------------------------------------------------------------------------------------------------

  toggleForm() {
    if (this.formOpen) {
      this.formHost?.querySelector('select, input')?.focus();
      return;
    }
    this.openForm();
  }

  openForm() {
    if (!this.canCreate()) return;
    this.formOpen = true;
    this.formValues = { doc_type: '', scope: 'deployment', tenant_key: '', profile_id: '' };
    this.formErrors = {};
    this.formRefusal = null;
    this.renderForm();
    this.newBtn?.setAttribute('aria-expanded', 'true');
    this.formHost?.querySelector('select')?.focus();
  }

  closeForm() {
    this.formOpen = false;
    this.formHost?.replaceChildren();
    this.newBtn?.setAttribute('aria-expanded', 'false');
    this.newBtn?.focus();
  }

  fieldError(name) {
    const message = this.formErrors[name];
    if (!message) return null;
    return bindingsEl('p', { cls: 'flex items-start gap-1 text-sm text-error mt-1', attrs: { id: 'rag-bindings-form-' + name + '-error' } }, [
      bindingsIcon('bi-exclamation-circle', 'mt-0.5'),
      message,
    ]);
  }

  describedBy(name, helpId) {
    return [helpId, this.formErrors[name] ? 'rag-bindings-form-' + name + '-error' : null].filter(Boolean).join(' ') || null;
  }

  renderForm() {
    if (!this.formHost) return;
    const v = this.formValues;
    const docSelect = bindingsEl('select', {
      cls: 'select select-bordered select-sm w-full' + (this.formErrors.doc_type ? ' select-error' : ''),
      attrs: { id: 'rag-bindings-form-doctype', name: 'doc_type', autocomplete: 'off', 'aria-invalid': this.formErrors.doc_type ? 'true' : null, 'aria-describedby': this.describedBy('doc_type') },
    });
    docSelect.appendChild(bindingsEl('option', { text: bindingsText('form.docType.placeholder'), attrs: { value: '', disabled: true, selected: v.doc_type === '' } }));
    for (const id of this.data.doc_types || []) {
      const label = bindingsDocTypeLabel(id, typeof window !== 'undefined' ? window.docTypeLabelForLocale : null, bindingsLocale());
      docSelect.appendChild(bindingsEl('option', { text: label ? label + ' (' + id + ')' : id, attrs: { value: id, selected: v.doc_type === id } }));
    }
    docSelect.addEventListener('change', () => {
      v.doc_type = docSelect.value;
      v.profile_id = '';
      delete this.formErrors.doc_type;
      this.renderForm();
      this.formHost.querySelector('#rag-bindings-form-doctype')?.focus();
    });

    const radio = (value, labelKey) => {
      const input = bindingsEl('input', { cls: 'radio radio-sm', attrs: { type: 'radio', name: 'scope', value, checked: v.scope === value } });
      input.addEventListener('change', () => {
        v.scope = value;
        delete this.formErrors.tenant_key;
        this.renderForm();
        this.formHost.querySelector('input[name="scope"][value="' + value + '"]')?.focus();
      });
      return bindingsEl('label', { cls: 'label cursor-pointer justify-start gap-2' }, [input, bindingsEl('span', { cls: 'label-text', text: bindingsText(labelKey) })]);
    };
    const scope = bindingsEl('fieldset', { cls: 'form-control' }, [
      bindingsEl('legend', { cls: 'label label-text', text: bindingsText('form.scope') }),
      radio('deployment', 'form.scope.deployment'),
      radio('tenant', 'form.scope.tenant'),
    ]);

    let tenant = null;
    if (v.scope === 'tenant') {
      const input = bindingsEl('input', {
        cls: 'input input-bordered input-sm w-full font-mono' + (this.formErrors.tenant_key ? ' input-error' : ''),
        attrs: {
          id: 'rag-bindings-form-tenant',
          type: 'text',
          name: 'tenant_key',
          value: v.tenant_key,
          autocomplete: 'off',
          spellcheck: 'false',
          translate: 'no',
          'aria-invalid': this.formErrors.tenant_key ? 'true' : null,
          'aria-describedby': this.describedBy('tenant_key', 'rag-bindings-form-tenant-help'),
        },
      });
      input.addEventListener('input', () => {
        v.tenant_key = input.value.trim();
      });
      tenant = bindingsEl('div', { cls: 'form-control' }, [
        bindingsEl('label', { cls: 'label', attrs: { for: 'rag-bindings-form-tenant' } }, [bindingsEl('span', { cls: 'label-text', text: bindingsText('form.tenant') })]),
        input,
        bindingsEl('span', { cls: 'label-text-alt text-base-content/70 mt-1', text: bindingsText('form.tenant.help'), attrs: { id: 'rag-bindings-form-tenant-help' } }),
        this.fieldError('tenant_key'),
      ]);
    }

    const candidates = v.doc_type ? bindingsProfilesFor(this.data.profiles, v.doc_type) : [];
    const noProfile = Boolean(v.doc_type) && candidates.length === 0;
    const profileSelect = bindingsEl('select', {
      cls: 'select select-bordered select-sm w-full' + (this.formErrors.profile_id ? ' select-error' : ''),
      attrs: {
        id: 'rag-bindings-form-profile',
        name: 'profile_id',
        autocomplete: 'off',
        disabled: !v.doc_type,
        'aria-invalid': this.formErrors.profile_id ? 'true' : null,
        'aria-describedby': this.describedBy('profile_id', 'rag-bindings-form-profile-help'),
      },
    });
    profileSelect.appendChild(bindingsEl('option', { text: bindingsText('form.profile.placeholder'), attrs: { value: '', disabled: true, selected: v.profile_id === '' } }));
    for (const profile of candidates) {
      profileSelect.appendChild(
        bindingsEl('option', { text: bindingsText('form.profile.option', { id: profile.id, model: profile.model, dims: profile.dims }), attrs: { value: profile.id, selected: v.profile_id === profile.id } }),
      );
    }
    profileSelect.addEventListener('change', () => {
      v.profile_id = profileSelect.value;
      delete this.formErrors.profile_id;
    });
    const profile = bindingsEl('div', { cls: 'form-control' }, [
      bindingsEl('label', { cls: 'label', attrs: { for: 'rag-bindings-form-profile' } }, [bindingsEl('span', { cls: 'label-text', text: bindingsText('form.profile') })]),
      profileSelect,
      bindingsEl('span', { cls: 'label-text-alt text-base-content/70 mt-1', text: bindingsText(noProfile ? 'form.profile.none' : 'form.profile.help'), attrs: { id: 'rag-bindings-form-profile-help' } }),
      this.fieldError('profile_id'),
    ]);

    const submit = bindingsEl('button', { cls: 'btn btn-primary btn-sm', text: bindingsText('form.submit'), attrs: { type: 'submit' } });
    const cancel = bindingsEl('button', { cls: 'btn btn-sm', text: bindingsText('form.cancel'), attrs: { type: 'button' }, on: { click: () => this.closeForm() } });
    const form = bindingsEl('form', { attrs: { novalidate: true } }, [
      bindingsEl('div', { cls: 'grid gap-4 md:grid-cols-2' }, [
        bindingsEl('div', { cls: 'form-control' }, [
          bindingsEl('label', { cls: 'label', attrs: { for: 'rag-bindings-form-doctype' } }, [bindingsEl('span', { cls: 'label-text', text: bindingsText('form.docType') })]),
          docSelect,
          this.fieldError('doc_type'),
        ]),
        profile,
        scope,
        tenant,
      ]),
      this.formErrors._form ? bindingsEl('p', { cls: 'flex items-start gap-1 text-sm text-error mt-4' }, [bindingsIcon('bi-exclamation-circle', 'mt-0.5'), this.formErrors._form]) : null,
      this.formRefusal ? bindingsEl('div', { cls: 'mt-4' }, [this.refusalAlert(this.formRefusal)]) : null,
      bindingsEl('div', { cls: 'flex flex-wrap gap-2 mt-4' }, [submit, cancel]),
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitForm(form, submit);
    });
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeForm();
      }
    });
    this.formHost.replaceChildren(
      bindingsEl('div', { cls: 'bg-base-100 rounded-lg p-4 mb-4', attrs: { id: 'rag-bindings-form', role: 'region', 'aria-labelledby': 'rag-bindings-form-title' } }, [
        bindingsEl('h4', { cls: 'text-base font-semibold mb-4', text: bindingsText('form.title'), attrs: { id: 'rag-bindings-form-title' } }),
        form,
      ]),
    );
  }

  refusalAlert(refusal) {
    const nodes = [bindingsEl('p', { cls: 'text-sm', text: bindingsText('refusal.lead') }), bindingsCode(refusal.reason)];
    if (typeof refusal.detail === 'string' && refusal.detail !== refusal.reason) nodes.push(bindingsCode(refusal.detail));
    return bindingsAlert('error', 'bi-x-octagon', nodes);
  }

  focusFirstInvalid() {
    const order = [
      ['doc_type', '#rag-bindings-form-doctype'],
      ['profile_id', '#rag-bindings-form-profile'],
      ['tenant_key', '#rag-bindings-form-tenant'],
    ];
    for (const [name, selector] of order) {
      if (this.formErrors[name]) {
        this.formHost?.querySelector(selector)?.focus();
        return;
      }
    }
  }

  async submitForm(form, submit) {
    if (this.busy) return;
    const v = this.formValues;
    this.formErrors = bindingsValidateForm(v);
    if (v.doc_type && bindingsProfilesFor(this.data.profiles, v.doc_type).length === 0) this.formErrors.profile_id = bindingsText('form.profile.none');
    this.formRefusal = null;
    if (Object.keys(this.formErrors).length > 0) {
      this.renderForm();
      this.focusFirstInvalid();
      return;
    }
    for (const control of form.querySelectorAll('select, input, button')) control.disabled = true;
    submit.replaceChildren(bindingsSpinner(), bindingsText('form.submitting'));
    this.setBusy(true);
    const body = bindingsCreateBody(v);
    const result = await this.request(BINDINGS_API, { method: 'POST', body: JSON.stringify(body) });
    this.setBusy(false);
    const values = { profile: body.profile_id, type: this.typeName(body.doc_type), scope: this.scopeName(body.tenant_key) };
    if (result.ok) {
      const created = result.body && result.body.created !== false;
      const text = created ? bindingsText('result.created', values) : bindingsText('result.exists', { status: (result.body && result.body.status) || '' });
      this.closeForm();
      await this.load();
      this.setStatus(text, false);
      this.focusStatus();
      return;
    }
    if (result.status === 401 || result.status === 403) {
      this.showSignIn(result.status);
      return;
    }
    if (result.status === 400) {
      const details = result.body && Array.isArray(result.body.details) ? result.body.details : [];
      for (const detail of details) {
        const field = ['doc_type', 'profile_id', 'tenant_key'].includes(detail.path) ? detail.path : '_form';
        this.formErrors[field] = this.formErrors[field] ? this.formErrors[field] + '; ' + detail.message : detail.message;
      }
      if (details.length === 0) this.formErrors._form = (result.body && result.body.error) || result.message;
      this.renderForm();
      this.focusFirstInvalid();
      return;
    }
    if (result.status === 409) {
      this.formRefusal = { reason: bindingsRefusalText(result.body), detail: result.body && result.body.detail };
      this.setStatus(bindingsText('refusal.status', { reason: this.formRefusal.reason }), true);
      this.renderForm();
      return;
    }
    this.renderForm();
    if (result.status === 503 || result.network) {
      this.setStatus(bindingsText('error.unconfirmed'), true);
      await this.load();
      this.setStatus(bindingsText('error.unconfirmed'), true);
    } else {
      this.setStatus(result.message, true);
    }
  }
}

function initEmbeddingBindingsPanel() {
  const root = document.getElementById('rag-administration-bindings');
  if (!root) return;
  if (window.embeddingBindingsPanel) {
    window.embeddingBindingsPanel.load();
    return;
  }
  const panel = new EmbeddingBindingsPanel();
  window.embeddingBindingsPanel = panel;
  panel.mount(root);
}

function bindEmbeddingBindingsPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-bindings-bound')) return;
    link.setAttribute('data-bindings-bound', '1');
    link.addEventListener('click', () => initEmbeddingBindingsPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initEmbeddingBindingsPanel = initEmbeddingBindingsPanel;
  document.addEventListener('DOMContentLoaded', () => bindEmbeddingBindingsPanel());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BINDINGS_COPY,
    bindingsActionsFor,
    bindingsBadges,
    bindingsCompletenessView,
    bindingsCreateBody,
    bindingsDocTypeLabel,
    bindingsEvidenceView,
    bindingsGroups,
    bindingsPercentText,
    bindingsProfilesFor,
    bindingsRefusalText,
    bindingsText,
    bindingsValidateForm,
  };
}
