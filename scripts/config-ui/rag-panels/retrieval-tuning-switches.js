/*
 * Retrieval tuning switches (RAG Modes tab, #rag-tuning-switches), 04.2-UI-SPEC sections 6.2 and 12.2.
 * Shows the three combination notes, binds the pointer to the Identifier patterns panel and gives the box its zh and it copy.
 * Reads the page inputs and never writes them; the page loader sets values without firing change, so the inputs are re-read on
 * DOMContentLoaded, on every RAG Modes tab click and on change. No request, no markup strings: createElement and textContent only.
 */

const RETRIEVAL_TUNING_COMMANDS = {
  relexDict: 'npm run rag:relex -- --tenant <key> --stale-dictionary',
  relex: 'npm run rag:relex -- --tenant <key>',
  tableRows: 'npm run rag:table-rows -- --tenant <key>',
  dupClusters: 'npm run rag:dup-clusters -- --tenant <key>',
  identifiers: 'npm run rag:identifiers -- --tenant <key>',
};

const RETRIEVAL_TUNING_CHECKBOXES = [
  'RAG_LEXICAL_DICTIONARY',
  'RAG_LEXICAL_STEM_IT',
  'RAG_VERSION_SCOPE',
  'RAG_EMBED_VERSION_SCOPE',
  'RAG_TABLE_LOOKUP',
  'RAG_DUP_CLUSTERS',
  'RAG_IDENTIFIER_INDEX',
  'RAG_IDENTIFIER_FILTER',
];

const RETRIEVAL_TUNING_SELECTS = ['RAG_PIPELINE', 'RAG_RESULT_DIVERSITY', 'RAG_ATTRIBUTE_FILTER'];

const RETRIEVAL_TUNING_NOTE_KEYS = ['note.needsV2', 'note.diversityNeedsClusters', 'note.filterNeedsIndex'];

const RETRIEVAL_TUNING_LABELS = {
  en: {
    'pointer.text': 'Patterns for your own identifier formats are under RAG administration, Identifier patterns.',
    'pointer.open': 'Open identifier patterns',
    'note.needsV2': 'These switches are read by the v2 pipeline only. Pipeline is set to legacy above, so they have no effect yet.',
    'note.diversityNeedsClusters':
      'Duplicate clusters are off, so no passages are grouped yet. `collapse` changes nothing; `mmr` still prefers passages that differ. Turn on Duplicate clusters and run its command.',
    'note.filterNeedsIndex':
      'The identifier index is off, so the filter cannot run and retrieval stays unfiltered. Turn on Identifier index and run its command.',
  },
  zh: {
    heading: '检索调优开关（关闭 = 当前行为）',
    intro:
      '其中一些开关会改变随文档一起存储的内容。这些开关各有一行以“已入库文档”开头的说明，并给出重建命令；加上 `--dry-run` 可先查看数量。命令中的 `<key>` 是租户键：单租户模式为 `s:default`，多租户模式为 `o:<组织 ID>`。',
    'RAG_LEXICAL_DICTIONARY.label': '把词典术语作为整体检索词',
    'RAG_LEXICAL_DICTIONARY.help': '工作区术语词典中的术语在关键词检索中作为一个整体匹配，即使它由多个词或多个字组成。',
    'RAG_LEXICAL_DICTIONARY.stored': '已入库文档：在运行 {relexDict} 之前，仍按原来的方式匹配。词典更改后请再次运行。',
    'RAG_LEXICAL_STEM_IT.label': '意大利语词干提取',
    'RAG_LEXICAL_STEM_IT.help': '在意大利语文本中，同一个词的单数和复数形式在关键词检索中可以互相匹配。其他语言不受影响。',
    'RAG_LEXICAL_STEM_IT.stored': '已入库文档：用 {relex} 重建其检索文本。',
    'RAG_VERSION_SCOPE.label': '版本范围过滤',
    'RAG_VERSION_SCOPE.help': '允许请求查询文档的早期版本：全部版本，或某一时段内的版本。未作此要求的请求只使用当前版本。',
    'RAG_EMBED_VERSION_SCOPE.label': '嵌入式聊天中的版本范围',
    'RAG_EMBED_VERSION_SCOPE.help':
      '允许嵌入式聊天组件也查询早期版本。仅在版本范围过滤开启时生效。开启后，该组件的访客可以读取工作区文档的早期版本。',
    'RAG_TABLE_LOOKUP.label': '表格行查找',
    'RAG_TABLE_LOOKUP.help': '找出单元格与问题中提到的值相匹配的表格行，连同表头一起加入检索结果。',
    'RAG_TABLE_LOOKUP.stored': '已入库文档：在运行 {tableRows} 之前，其表格没有可供查找的行。',
    'RAG_DUP_CLUSTERS.label': '重复内容分组',
    'RAG_DUP_CLUSTERS.help': '把同一工作区内在不同文档中完全相同或几乎相同的段落归为一组。每份文档仍保留自己的那一份。',
    'RAG_DUP_CLUSTERS.stored': '已入库文档：在运行 {dupClusters} 之前不会被分组。',
    'RAG_RESULT_DIVERSITY.label': '结果多样性',
    'RAG_RESULT_DIVERSITY.help':
      '`off` 保留所有结果。`collapse` 只保留每个重复分组中排名最高的段落，并在其引用下列出其他文档。`mmr` 在此基础上再优先选择彼此不同的段落。',
    'RAG_IDENTIFIER_INDEX.label': '标识符索引',
    'RAG_IDENTIFIER_INDEX.help': '把每个段落中找到的标识符以一种规范化形式存储，使同一标识符的不同写法可以互相匹配。',
    'RAG_IDENTIFIER_INDEX.stored': '已入库文档：在运行 {identifiers} 之前，索引中没有它们的标识符。',
    'RAG_IDENTIFIER_FILTER.label': '标识符过滤',
    'RAG_IDENTIFIER_FILTER.help':
      '当问题提到本工作区已有的标识符时，检索只限于包含它的段落，并排除与之形似的其他标识符的段落。需要先开启标识符索引。',
    'pointer.text': '自定义标识符格式的模式位于“RAG 管理 → 标识符模式”。',
    'pointer.open': '打开标识符模式',
    'note.needsV2': '这些开关只在 v2 流程中生效。上方的流程目前为 legacy，因此它们暂不起作用。',
    'note.diversityNeedsClusters':
      '重复内容分组处于关闭状态，因此还没有段落被分组。`collapse` 不会有任何变化；`mmr` 仍会优先选择彼此不同的段落。请开启“重复内容分组”并运行其命令。',
    'note.filterNeedsIndex': '标识符索引处于关闭状态，过滤无法运行，检索不会被过滤。请开启“标识符索引”并运行其命令。',
  },
  it: {
    heading: 'Opzioni di regolazione del recupero (disattivate = comportamento attuale)',
    intro:
      'Alcune di queste opzioni cambiano ciò che viene memorizzato con ogni documento. Ognuna di esse ha una riga che inizia con «Documenti archiviati» e indica il comando che li ricostruisce; aggiungi `--dry-run` per vedere prima il conteggio. Nei comandi, `<key>` è la chiave del tenant: `s:default` in modalità single-tenant, `o:<ID organizzazione>` in modalità multi-tenant.',
    'RAG_LEXICAL_DICTIONARY.label': 'Termini del dizionario come termini di ricerca unici',
    'RAG_LEXICAL_DICTIONARY.help':
      'Un termine del dizionario terminologico dello spazio di lavoro corrisponde come un unico termine nella ricerca per parole chiave, anche se è composto da più parole o caratteri.',
    'RAG_LEXICAL_DICTIONARY.stored':
      'Documenti archiviati: corrispondono come prima finché non esegui {relexDict}. Eseguilo di nuovo dopo ogni modifica del dizionario.',
    'RAG_LEXICAL_STEM_IT.label': 'Stemming italiano',
    'RAG_LEXICAL_STEM_IT.help':
      'Nel testo italiano, le forme singolari e plurali di una parola corrispondono tra loro nella ricerca per parole chiave. Le altre lingue non cambiano.',
    'RAG_LEXICAL_STEM_IT.stored': 'Documenti archiviati: ricostruisci il loro testo di ricerca con {relex}.',
    'RAG_VERSION_SCOPE.label': 'Filtro per versione',
    'RAG_VERSION_SCOPE.help':
      'Permette a una richiesta di chiedere le versioni precedenti di un documento: tutte, o quelle di un periodo. Una richiesta che non lo chiede riceve solo le versioni correnti.',
    'RAG_EMBED_VERSION_SCOPE.label': 'Filtro per versione nella chat incorporata',
    'RAG_EMBED_VERSION_SCOPE.help':
      'Permette anche al widget di chat incorporata di chiedere le versioni precedenti. Funziona solo mentre il filtro per versione è attivo. I visitatori del widget possono allora leggere le versioni precedenti dei documenti dello spazio di lavoro.',
    'RAG_TABLE_LOOKUP.label': 'Ricerca nelle righe di tabella',
    'RAG_TABLE_LOOKUP.help':
      'Trova le righe di tabella le cui celle corrispondono ai valori citati nella domanda e le aggiunge ai risultati, con l’intestazione.',
    'RAG_TABLE_LOOKUP.stored': 'Documenti archiviati: le loro tabelle non hanno righe da cercare finché non esegui {tableRows}.',
    'RAG_DUP_CLUSTERS.label': 'Gruppi di duplicati',
    'RAG_DUP_CLUSTERS.help':
      'Raggruppa i passaggi che si ripetono, uguali o quasi, in documenti diversi di uno stesso spazio di lavoro. Ogni documento conserva la propria copia.',
    'RAG_DUP_CLUSTERS.stored': 'Documenti archiviati: non vengono raggruppati finché non esegui {dupClusters}.',
    'RAG_RESULT_DIVERSITY.label': 'Varietà dei risultati',
    'RAG_RESULT_DIVERSITY.help':
      '`off` mantiene tutti i risultati. `collapse` mantiene il passaggio migliore di ogni gruppo di duplicati ed elenca gli altri documenti sotto la sua citazione. `mmr` fa lo stesso, poi preferisce passaggi diversi tra loro.',
    'RAG_IDENTIFIER_INDEX.label': 'Indice degli identificatori',
    'RAG_IDENTIFIER_INDEX.help':
      'Memorizza in un’unica forma normalizzata gli identificatori trovati in ogni passaggio, così le diverse grafie di uno stesso identificatore corrispondono tra loro.',
    'RAG_IDENTIFIER_INDEX.stored': 'Documenti archiviati: non hanno identificatori nell’indice finché non esegui {identifiers}.',
    'RAG_IDENTIFIER_FILTER.label': 'Filtro per identificatore',
    'RAG_IDENTIFIER_FILTER.help':
      'Quando una domanda cita un identificatore presente in questo spazio di lavoro, il recupero si limita ai passaggi che lo contengono ed esclude quelli relativi a un identificatore simile. Richiede l’indice degli identificatori.',
    'pointer.text': 'I modelli per i tuoi formati di identificatore sono in RAG administration, Modelli di identificatori.',
    'pointer.open': 'Apri modelli di identificatori',
    'note.needsV2':
      'Queste opzioni sono lette solo dalla pipeline v2. La pipeline qui sopra è impostata su legacy, quindi per ora non hanno effetto.',
    'note.diversityNeedsClusters':
      'I gruppi di duplicati sono disattivati, quindi nessun passaggio è ancora raggruppato. `collapse` non cambia nulla; `mmr` preferisce comunque passaggi diversi. Attiva Gruppi di duplicati ed esegui il suo comando.',
    'note.filterNeedsIndex':
      'L’indice degli identificatori è disattivato, quindi il filtro non può funzionare e il recupero resta non filtrato. Attiva Indice degli identificatori ed esegui il suo comando.',
  },
};

/** The text for a key in a locale; zh and it fall back to English, unknown keys to undefined. */
function retrievalTuningLabel(key, locale) {
  const table = RETRIEVAL_TUNING_LABELS[locale] || RETRIEVAL_TUNING_LABELS.en;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return RETRIEVAL_TUNING_LABELS.en[key];
}

function retrievalTuningDetectLocale(nav) {
  const lang = nav && typeof nav.language === 'string' ? nav.language.slice(0, 2).toLowerCase() : 'en';
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

/**
 * The note keys to show, in on-screen order (UI-SPEC 6.2). Pure: `values` maps env names to the checkbox state (boolean) or the
 * select value (string). An empty or missing RAG_PIPELINE counts as legacy, as an unset variable serves legacy.
 */
function retrievalTuningWarnings(values) {
  const v = values || {};
  const on = (id) => v[id] === true || v[id] === 'true';
  const choice = (id) => (typeof v[id] === 'string' && v[id] !== '' ? v[id] : 'off');
  const pipeline = typeof v.RAG_PIPELINE === 'string' && v.RAG_PIPELINE !== '' ? v.RAG_PIPELINE : 'legacy';
  const diversity = choice('RAG_RESULT_DIVERSITY');
  const anyOn =
    RETRIEVAL_TUNING_CHECKBOXES.some(on) || diversity !== 'off' || choice('RAG_ATTRIBUTE_FILTER') !== 'off';
  const keys = [];
  if (pipeline === 'legacy' && anyOn) keys.push('note.needsV2');
  if ((diversity === 'collapse' || diversity === 'mmr') && !on('RAG_DUP_CLUSTERS')) keys.push('note.diversityNeedsClusters');
  if (on('RAG_IDENTIFIER_FILTER') && !on('RAG_IDENTIFIER_INDEX')) keys.push('note.filterNeedsIndex');
  return keys;
}

/** The current page values of the inputs the notes depend on; never writes them. */
function retrievalTuningReadValues(doc) {
  const values = {};
  for (const id of RETRIEVAL_TUNING_CHECKBOXES) {
    const el = doc.getElementById(id);
    values[id] = Boolean(el && el.checked);
  }
  for (const id of RETRIEVAL_TUNING_SELECTS) {
    const el = doc.getElementById(id);
    values[id] = el && typeof el.value === 'string' ? el.value : '';
  }
  return values;
}

function retrievalTuningCode(doc, text, command) {
  const code = doc.createElement('code');
  code.className = command ? 'font-mono text-xs break-words' : 'font-mono text-xs';
  code.setAttribute('translate', 'no');
  code.textContent = text;
  return code;
}

/** Replaces an element's children with the text, setting `{command}` placeholders and backtick words as code elements. */
function retrievalTuningFill(doc, el, text) {
  const nodes = [];
  const re = /\{([A-Za-z]+)\}|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push(doc.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const command = RETRIEVAL_TUNING_COMMANDS[m[1]];
      nodes.push(command ? retrievalTuningCode(doc, command, true) : doc.createTextNode(m[0]));
    } else {
      nodes.push(retrievalTuningCode(doc, m[2], false));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(doc.createTextNode(text.slice(last)));
  el.replaceChildren(...nodes);
}

/** zh and it for the box's data-rag-i18n keys; keys without a translation (other phases) keep English and say so with lang. */
function retrievalTuningLocalize(doc, box, locale) {
  if (locale === 'en' || box.getAttribute('data-retrieval-tuning-locale') === locale) return;
  box.setAttribute('data-retrieval-tuning-locale', locale);
  box.setAttribute('lang', locale === 'zh' ? 'zh-Hans' : locale);
  const table = RETRIEVAL_TUNING_LABELS[locale] || {};
  for (const node of Array.from(box.querySelectorAll('[data-rag-i18n]'))) {
    const key = node.getAttribute('data-rag-i18n');
    if (Object.prototype.hasOwnProperty.call(table, key)) retrievalTuningFill(doc, node, table[key]);
    else node.setAttribute('lang', 'en');
  }
}

function retrievalTuningRefresh(doc) {
  const keys = retrievalTuningWarnings(retrievalTuningReadValues(doc));
  for (const key of RETRIEVAL_TUNING_NOTE_KEYS) {
    const note = doc.querySelector('[data-rag-tuning-note="' + key + '"]');
    if (note) note.hidden = !keys.includes(key);
  }
}

/** Selects the RAG administration tab, scrolls the Identifier patterns panel into view and focuses its heading. No request. */
function retrievalTuningOpenIdentifierPatterns(doc, win) {
  const link = doc.querySelector('.menu-item[data-tab="rag-administration"]');
  if (link) link.click();
  const section = doc.getElementById('rag-administration-identifiers');
  if (!section) return;
  const reduce = Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const heading = section.querySelector('[data-identifier-patterns-title]');
  if (heading) heading.focus({ preventScroll: true });
}

function retrievalTuningBindOnce(el, type, fn) {
  if (!el || el.getAttribute('data-retrieval-tuning-bound')) return;
  el.setAttribute('data-retrieval-tuning-bound', '1');
  el.addEventListener(type, fn);
}

function bindRetrievalTuningSwitches(doc, win) {
  const box = doc.getElementById('rag-tuning-switches');
  if (!box) return;
  const locale = retrievalTuningDetectLocale(win && win.navigator);
  for (const key of [...RETRIEVAL_TUNING_NOTE_KEYS, 'pointer.text']) {
    const selector = key === 'pointer.text' ? '[data-identifier-patterns-pointer-text]' : '[data-rag-tuning-note="' + key + '"] [data-rag-tuning-note-text]';
    const el = doc.querySelector(selector);
    if (el) retrievalTuningFill(doc, el, retrievalTuningLabel(key, locale));
  }
  retrievalTuningLocalize(doc, box, locale);
  const refresh = () => retrievalTuningRefresh(doc);
  for (const id of [...RETRIEVAL_TUNING_CHECKBOXES, ...RETRIEVAL_TUNING_SELECTS]) retrievalTuningBindOnce(doc.getElementById(id), 'change', refresh);
  doc.querySelectorAll('[data-tab="rag-modes"]').forEach((tab) => retrievalTuningBindOnce(tab, 'click', refresh));
  const pointer = doc.querySelector('[data-identifier-patterns-pointer]');
  if (pointer) {
    pointer.textContent = retrievalTuningLabel('pointer.open', locale);
    retrievalTuningBindOnce(pointer, 'click', () => retrievalTuningOpenIdentifierPatterns(doc, win));
  }
  refresh();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.bindRetrievalTuningSwitches = bindRetrievalTuningSwitches;
  window.retrievalTuningWarnings = retrievalTuningWarnings;
  document.addEventListener('DOMContentLoaded', () => bindRetrievalTuningSwitches(document, window));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RETRIEVAL_TUNING_COMMANDS,
    RETRIEVAL_TUNING_LABELS,
    retrievalTuningLabel,
    retrievalTuningWarnings,
    retrievalTuningReadValues,
    bindRetrievalTuningSwitches,
  };
}
