// Query layer card additions (06.2 UI-SPEC 6.4): routing model selects, their warnings, nested-switch states and the
// Open glossary pointer. Everything is computed from page state; the script sends no request and never changes a saved value.

const QUERY_ADDITIONS_LABELS = {
  'nested.parentOff': 'No effect while “{parent}” is off.',
  'glossary.pointer': 'Entries are edited under RAG administration, Terminology, Glossary.',
  'glossary.open': 'Open glossary',
  'routing.notSet': 'Not set',
  'routing.optionMissing': '{id} (not in the model list)',
  'routing.unknown': 'The {tier} model {id} is not in the OpenRouter model list. Choose a listed model, or add it under AI Models.',
  'routing.unsetQuality': 'The quality model is not set. A user who selects Auto needs it. Choose one.',
  'routing.unsetFast': 'Model routing is auto, but the fast model is not set. Choose one.',
  'routing.same': 'The fast and quality models are the same, so routing changes nothing.',
  'routing.noAutoEntry': 'The model list has no Auto entry, so users cannot select it. Under AI Models, add a model with the ID {id} and the name Auto.',
  'routing.openModels': 'Open AI Models',
  'routing.provider': 'Auto is offered with the OpenRouter provider only. The provider is set to {provider} under AI Models.',
  'tier.fast': 'fast',
  'tier.quality': 'quality',
};

const QUERY_ADDITIONS_AUTO_ID = 'auto';
const QUERY_ADDITIONS_FAST = 'RAG_ROUTING_FAST_MODEL';
const QUERY_ADDITIONS_QUALITY = 'RAG_ROUTING_QUALITY_MODEL';
const QUERY_ADDITIONS_ROUTING = 'RAG_MODEL_ROUTING';
const QUERY_ADDITIONS_HOST_ID = 'query-additions-routing-warnings';
const QUERY_ADDITIONS_NESTED = [
  { parent: 'RAG_QUERY_CONDENSE', parentLabel: 'Condense follow-up questions', children: ['RAG_QUERY_HISTORY_FALLBACK'] },
  {
    parent: 'RAG_QUERY_DECOMPOSE',
    parentLabel: 'Decompose compound questions',
    children: ['RAG_QUERY_DECOMPOSE_COMPLETENESS', 'RAG_QUERY_SUBQ_FILTERS', 'RAG_DECOMPOSED_ANSWER'],
  },
];
// Saved-config retries after load: ConfigManager.init() is async and announces nothing when populateFields has run.
const QUERY_ADDITIONS_RETRY_MS = 250;
const QUERY_ADDITIONS_RETRIES = 20;

function queryAdditionsLabel(key, vars) {
  const template = QUERY_ADDITIONS_LABELS[key] || key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (vars && vars[name] !== undefined ? String(vars[name]) : match));
}

function queryAdditionsText(value) {
  return typeof value === 'string' ? value : '';
}

/** Normalizes a model list (array or saved JSON string) to [{ id, displayName }]; null when it holds no model. */
function queryAdditionsNormalizeModels(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (_error) {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const models = [];
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') continue;
    models.push({ id: entry.id, displayName: queryAdditionsText(entry.displayName) || entry.id });
  }
  return models.length ? models : null;
}

/**
 * The OpenRouter list the page knows: the AI Models tab's list once it was loaded, else the saved
 * NEXT_PUBLIC_OPENROUTER_MODELS. null while neither is known (the loading state of UI-SPEC 7.2).
 */
function queryAdditionsModelList(modelConfigValue, config) {
  const live = modelConfigValue && queryAdditionsNormalizeModels(modelConfigValue.openrouterModels);
  if (live) return { models: live, provider: queryAdditionsText(modelConfigValue.provider) || null };
  const saved = config ? queryAdditionsNormalizeModels(config.NEXT_PUBLIC_OPENROUTER_MODELS) : null;
  if (saved) return { models: saved, provider: queryAdditionsText(config.NEXT_PUBLIC_AI_PROVIDER) || null };
  return { models: null, provider: null };
}

/** Options for one routing select: Not set, the listed models without auto, and the saved id when it is not listed. */
function queryAdditionsSelectOptions(models, saved) {
  const options = [{ value: '', text: queryAdditionsLabel('routing.notSet') }];
  const offered = (models || []).filter((m) => m.id !== QUERY_ADDITIONS_AUTO_ID);
  for (const model of offered) options.push({ value: model.id, text: model.displayName + ' (' + model.id + ')' });
  if (saved && !offered.some((m) => m.id === saved)) {
    options.push({ value: saved, text: models ? queryAdditionsLabel('routing.optionMissing', { id: saved }) : saved, extra: true });
  }
  return { options, selected: saved || '' };
}

/** The routing conditions of UI-SPEC 6.4.3, in table order. None while the model list is not known. */
function queryAdditionsWarnings(state) {
  if (!state || !state.models) return [];
  const offered = new Set(state.models.filter((m) => m.id !== QUERY_ADDITIONS_AUTO_ID).map((m) => m.id));
  const hasAuto = state.models.some((m) => m.id === QUERY_ADDITIONS_AUTO_ID);
  const auto = state.routing === 'auto';
  const out = [];
  for (const [tier, id] of [['fast', state.fast], ['quality', state.quality]]) {
    if (id && !offered.has(id)) out.push({ key: 'routing.unknown', tone: 'warning', vars: { tier: queryAdditionsLabel('tier.' + tier), id }, code: ['id'] });
  }
  if (!state.quality && hasAuto) out.push({ key: 'routing.unsetQuality', tone: 'warning' });
  if (auto && !state.fast) out.push({ key: 'routing.unsetFast', tone: 'warning' });
  if (state.fast && state.quality && state.fast === state.quality) out.push({ key: 'routing.same', tone: 'info' });
  if (!hasAuto) out.push({ key: 'routing.noAutoEntry', tone: auto ? 'warning' : 'info', vars: { id: QUERY_ADDITIONS_AUTO_ID }, code: ['id'], action: 'openModels' });
  if (state.provider && state.provider !== 'openrouter') out.push({ key: 'routing.provider', tone: 'info', vars: { provider: state.provider } });
  return out;
}

function queryAdditionsEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A label template as text nodes, with the named variables as code elements; never markup. */
function queryAdditionsSentence(warning) {
  const span = queryAdditionsEl('span', 'min-w-0');
  const template = QUERY_ADDITIONS_LABELS[warning.key] || warning.key;
  const vars = warning.vars || {};
  const code = new Set(warning.code || []);
  let last = 0;
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(template))) {
    if (m.index > last) span.appendChild(document.createTextNode(template.slice(last, m.index)));
    const value = vars[m[1]] !== undefined ? String(vars[m[1]]) : m[0];
    if (code.has(m[1])) {
      const el = queryAdditionsEl('code', 'font-mono text-xs break-all', value);
      el.setAttribute('translate', 'no');
      span.appendChild(el);
    } else span.appendChild(document.createTextNode(value));
    last = m.index + m[0].length;
  }
  if (last < template.length) span.appendChild(document.createTextNode(template.slice(last)));
  return span;
}

function queryAdditionsAlert(warning) {
  const alert = queryAdditionsEl('div', 'alert ' + (warning.tone === 'warning' ? 'alert-warning' : 'alert-info') + ' text-sm items-start');
  const icon = queryAdditionsEl('i', 'bi ' + (warning.tone === 'warning' ? 'bi-exclamation-triangle' : 'bi-info-circle') + ' shrink-0');
  icon.setAttribute('aria-hidden', 'true');
  const body = queryAdditionsEl('div', 'flex flex-wrap items-center gap-x-2 min-w-0');
  body.appendChild(queryAdditionsSentence(warning));
  if (warning.action === 'openModels') {
    const button = queryAdditionsEl('button', 'btn btn-link btn-xs px-0', queryAdditionsLabel('routing.openModels'));
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => queryAdditionsOpenTab('ai'));
    body.appendChild(button);
  }
  alert.appendChild(icon);
  alert.appendChild(body);
  return alert;
}

function queryAdditionsOpenTab(tab) {
  const link = document.querySelector('.menu-item[data-tab="' + tab + '"]');
  if (link) link.click();
}

function queryAdditionsConfig() {
  const manager = typeof window !== 'undefined' ? window.configManager : null;
  return manager && manager.config ? manager.config : null;
}

function queryAdditionsSaved(config, id, overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) return queryAdditionsText(overrides[id]);
  if (config && id in config) return queryAdditionsText(config[id]);
  const field = document.getElementById(id);
  return field ? queryAdditionsText(field.value) : '';
}

/** Rebuilds one select's options from the view model and re-applies its saved value (UI-SPEC finding 4). */
function queryAdditionsFillSelect(select, view) {
  const nodes = view.options.map((option) => {
    const el = queryAdditionsEl('option', null, option.text);
    el.setAttribute('value', option.value);
    el.selected = option.value === view.selected;
    return el;
  });
  select.replaceChildren(...nodes);
  select.value = view.selected;
}

function queryAdditionsPageState(overrides) {
  const config = queryAdditionsConfig();
  const live = typeof modelConfig !== 'undefined' ? modelConfig : null;
  const list = queryAdditionsModelList(live, config);
  const routing = document.getElementById(QUERY_ADDITIONS_ROUTING);
  return {
    models: list.models,
    provider: list.provider,
    routing: routing ? queryAdditionsText(routing.value) : 'off',
    fast: queryAdditionsSaved(config, QUERY_ADDITIONS_FAST, overrides),
    quality: queryAdditionsSaved(config, QUERY_ADDITIONS_QUALITY, overrides),
  };
}

function queryAdditionsRefreshRouting(overrides) {
  const fast = document.getElementById(QUERY_ADDITIONS_FAST);
  const quality = document.getElementById(QUERY_ADDITIONS_QUALITY);
  if (!fast || !quality) return null;
  const state = queryAdditionsPageState(overrides);
  queryAdditionsFillSelect(fast, queryAdditionsSelectOptions(state.models, state.fast));
  queryAdditionsFillSelect(quality, queryAdditionsSelectOptions(state.models, state.quality));
  const host = document.getElementById(QUERY_ADDITIONS_HOST_ID);
  if (host) host.replaceChildren(...queryAdditionsWarnings(state).map(queryAdditionsAlert));
  return state;
}

function queryAdditionsRefreshNested() {
  for (const group of QUERY_ADDITIONS_NESTED) {
    const parent = document.getElementById(group.parent);
    const off = !!parent && !parent.checked;
    for (const id of group.children) {
      const input = document.getElementById(id);
      if (!input) continue;
      const row = input.closest('.form-control');
      if (row) row.classList.toggle('opacity-60', off);
      const helpId = input.getAttribute('aria-describedby');
      const help = helpId ? document.getElementById(helpId) : null;
      if (!help) continue;
      const existing = help.querySelector('[data-query-additions-parent-off]');
      if (off && !existing) {
        const line = queryAdditionsEl('span', 'block mt-1', queryAdditionsLabel('nested.parentOff', { parent: group.parentLabel }));
        line.setAttribute('data-query-additions-parent-off', '');
        help.appendChild(line);
      } else if (!off && existing) existing.remove();
    }
  }
}

/** Selects the RAG administration tab, scrolls the Terminology panel into view and activates its Glossary tab. No request. */
function queryAdditionsOpenGlossary() {
  queryAdditionsOpenTab('rag-administration');
  const section = document.getElementById('rag-administration-terminology');
  if (!section) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const panel = window.terminologyPanel;
  if (panel && panel.tabs && typeof panel.tabs.select === 'function') panel.tabs.select('glossary');
  const tab = document.getElementById('rag-terminology-tab-glossary');
  const target = tab || section.querySelector('[data-terminology-title]');
  if (target) target.focus({ preventScroll: true });
}

function queryAdditionsBindPointer() {
  const present = !!document.getElementById('rag-administration-terminology');
  document.querySelectorAll('[data-query-additions-glossary-pointer]').forEach((row) => {
    row.hidden = !present;
    const text = row.querySelector('[data-query-additions-glossary-text]');
    if (text) text.textContent = queryAdditionsLabel('glossary.pointer');
    const button = row.querySelector('button');
    if (!button || button.getAttribute('data-query-additions-bound')) return;
    button.setAttribute('data-query-additions-bound', '1');
    button.textContent = queryAdditionsLabel('glossary.open');
    button.addEventListener('click', () => queryAdditionsOpenGlossary());
  });
}

function queryAdditionsRefresh(overrides) {
  queryAdditionsRefreshNested();
  return queryAdditionsRefreshRouting(overrides);
}

function queryAdditionsBind() {
  const once = (el, type, fn) => {
    if (!el) return;
    const mark = 'data-query-additions-' + type;
    if (el.getAttribute(mark)) return;
    el.setAttribute(mark, '1');
    el.addEventListener(type, fn);
  };
  for (const id of [QUERY_ADDITIONS_FAST, QUERY_ADDITIONS_QUALITY]) {
    const select = document.getElementById(id);
    once(select, 'focus', () => queryAdditionsRefreshRouting());
    // The select's own listener runs before the page writes the change into the saved configuration.
    once(select, 'change', () => queryAdditionsRefreshRouting({ [id]: select.value }));
  }
  once(document.getElementById(QUERY_ADDITIONS_ROUTING), 'change', () => queryAdditionsRefreshRouting());
  for (const group of QUERY_ADDITIONS_NESTED) once(document.getElementById(group.parent), 'change', () => queryAdditionsRefreshNested());
  document.querySelectorAll('[data-tab="rag-modes"]').forEach((link) => once(link, 'click', () => queryAdditionsRefresh()));
  queryAdditionsBindPointer();
}

function queryAdditionsInit() {
  if (!document.getElementById('query-layer-card')) return;
  queryAdditionsBind();
  queryAdditionsRefresh();
  let tries = 0;
  const retry = () => {
    const config = queryAdditionsConfig();
    if (config && Object.keys(config).length) {
      queryAdditionsRefresh();
      return;
    }
    tries += 1;
    if (tries < QUERY_ADDITIONS_RETRIES) setTimeout(retry, QUERY_ADDITIONS_RETRY_MS);
  };
  setTimeout(retry, QUERY_ADDITIONS_RETRY_MS);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.queryAdditionsRefresh = queryAdditionsRefresh;
  window.queryAdditionsOpenGlossary = queryAdditionsOpenGlossary;
  document.addEventListener('DOMContentLoaded', () => queryAdditionsInit());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUERY_ADDITIONS_LABELS,
    queryAdditionsLabel,
    queryAdditionsNormalizeModels,
    queryAdditionsModelList,
    queryAdditionsSelectOptions,
    queryAdditionsWarnings,
  };
}
