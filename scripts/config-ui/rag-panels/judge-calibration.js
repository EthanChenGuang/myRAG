/**
 * Judge calibration panel (EVAL-24, D-28 to D-32, UI-SPEC 6.9 and 12.5): read-only. Shows the floors a judge must meet, the running
 * judge versions and one table per judge role with the status of each language and measure. One GET through ragFetch; a value is
 * flagged only because the route named it in a reason, the browser compares nothing. DOM through the gates-ui helpers (cuiEl,
 * createElement, textContent).
 */

const JUDGE_CAL_GATES =
  typeof gatesUiMessageFrom === 'function'
    ? {
        gatesUiMessageFrom,
        gatesUiLocale,
        gatesUiLabel,
        gatesUiNumber,
        gatesUiScore,
        gatesUiSigned,
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
      }
    : require('./gates-ui.js');

const JUDGE_CAL_API = '/api/rag/admin/judge-calibration';
const JUDGE_CAL_COMMAND = 'python -m rag_eval.judge_calibration run';
const JUDGE_CAL_ROLES = ['nightly', 'online'];
const JUDGE_CAL_LANGUAGE_ORDER = ['zh', 'en', 'it'];
const JUDGE_CAL_STATUS_STYLE = {
  gating: { classes: 'badge-success badge-outline', icon: 'bi-check-circle' },
  report_only: { classes: 'badge-ghost', icon: 'bi-eye' },
  uncalibrated: { classes: 'badge-warning badge-outline', icon: 'bi-clock-history' },
};
const JUDGE_CAL_WARNING_STYLE = {
  none_enforced: { tone: 'info', icon: 'bi-info-circle' },
  calibration_invalid: { tone: 'error', icon: 'bi-x-octagon' },
  expired_cells: { tone: 'warning', icon: 'bi-exclamation-triangle' },
  judge_changed: { tone: 'warning', icon: 'bi-exclamation-triangle' },
};
/** Route reason codes (calibration-status.ts) to the label keys of UI-SPEC 12.5. */
const JUDGE_CAL_REASON_KEYS = {
  kappa_below_floor: 'reason.kappa_below_floor',
  accuracy_below_floor: 'reason.accuracy_below_floor',
  n_below_minimum: 'reason.too_few_labels',
  labels_not_confirmed: 'reason.labels_unconfirmed',
  length_bias: 'reason.length_bias',
  perturbation: 'reason.perturbation',
  expired: 'reason.expired',
  fingerprint_mismatch: 'reason.fingerprint_mismatch',
  holistic: 'reason.holistic',
};
const JUDGE_CAL_MEASURE_KEYS = { faithfulness: 'check.faithfulness', answer_relevance: 'check.answer_relevance', partial_answer: 'measure.partial_answer' };

const JUDGE_CAL_LABELS = {
  en: {
    'panel.title': 'Judge calibration',
    'panel.description':
      "Read-only. The model judges that score answers are compared with human labels every month. A judge’s score counts towards a limit only for the language and measure where it agrees with people. Results change only through the calibration tool and a pull request. Applies to every workspace in this deployment.",
    'status.loading': 'Loading judge calibration…',
    'status.loaded': 'Judge calibration loaded. Rows: {cells}. Enforced: {enforced}.',
    'action.refresh': 'Refresh status',
    'floors.line':
      'Needed to be enforced: kappa at least {kappa}, accuracy at least {accuracy}, labels at least {n} per language ({seed} from the starter set), checked within the last {days} days.',
    'warnings.heading': 'Warnings',
    'warnings.none': 'No warnings.',
    'warning.none_enforced': 'No judge is enforced: every judge score is report only, and no limit depends on a judge.',
    'warning.calibration_invalid': 'The committed judge calibration file does not validate, so every judge is report only. Run {command} again and commit the result.',
    'warning.expired_cells': 'Calibrations older than {days} days: {count}. They are report only until {command} runs again.',
    'warning.judge_changed': 'The judge model, prompt or rubric changed since the last calibration, so its rows are report only. Run {command}.',
    'role.nightly': 'Nightly judge',
    'role.online': 'Online judge',
    'judge.version': 'Judge version: {fingerprint}',
    'table.caption': '{role}: calibration by language and measure',
    'col.language': 'Language',
    'col.measure': 'Measure',
    'col.status': 'Status',
    'col.kappa': 'Kappa',
    'col.accuracy': 'Accuracy',
    'col.labels': 'Labels',
    'col.unsupported': 'Unsupported content found',
    'col.lengthBias': 'Length bias',
    'col.probes': 'Same answer, reworded',
    'col.checked': 'Checked',
    'measure.partial_answer': 'Partial answer',
    'status.gating': 'Enforced',
    'status.report_only': 'Report only',
    'status.uncalibrated': 'Out of date',
    'legend.summary': 'What the statuses mean',
    'legend.gating': 'Enforced: the judge agrees with people here, so its limit applies on the nightly run.',
    'legend.report_only': 'Report only: the score is shown and never fails a run.',
    'legend.uncalibrated': 'Out of date: the check is too old or the judge changed. Treated as report only.',
    'reason.kappa_below_floor': 'Agreement (kappa) is below the floor.',
    'reason.accuracy_below_floor': 'Accuracy is below the floor.',
    'reason.too_few_labels': 'Too few labels for this language.',
    'reason.labels_unconfirmed': 'The labels are not yet confirmed by a person.',
    'reason.length_bias': 'Longer correct answers score differently, beyond the tolerance.',
    'reason.perturbation': 'Rewording the same answer changes the score beyond the tolerance.',
    'reason.expired': 'Last checked more than {days} days ago.',
    'reason.fingerprint_mismatch': 'The judge model, prompt or rubric changed since this check.',
    'reason.holistic': 'Whole-answer scores are report only by rule.',
    'reason.other': 'Reason code: {code}.',
    'source.seed': 'Starter set',
    'source.review_queue': 'Review queue',
    'source.mixed': 'Starter set and review queue',
    'cell.belowFloor': 'Named in the reasons below',
    'cell.recallPrecision': 'recall {recall}, precision {precision}',
    'cell.probes': 'longer {expanded}, more assertive {assertive}',
    'cell.validUntil': 'Valid until {date}',
    'cell.showAll': 'Show all measures',
    'holistic.note': 'Whole-answer scores on a 1 to 5 scale are reported and never count towards a limit.',
    'empty.title': 'No judge calibration yet',
    'empty.body': 'Until a calibration is recorded, every judge score is report only and no limit depends on a judge. Run {command}, commit the result and redeploy.',
  },
  zh: {
    'panel.title': '评判模型校准',
    'panel.description':
      '只读。为回答打分的评判模型每月与人工标注对比一次。只有在评判与人工一致的语言和指标上，它的分数才计入限值。结果只能通过校准工具和 pull request 更改。对本部署的所有工作区生效。',
    'status.loading': '正在加载评判模型校准…',
    'status.loaded': '评判模型校准已加载。行数：{cells}。计入限值：{enforced}。',
    'action.refresh': '刷新状态',
    'floors.line': '计入限值的条件：kappa 不低于 {kappa}，准确率不低于 {accuracy}，每种语言的标注不少于 {n} 条（来自起始集时为 {seed} 条），并在最近 {days} 天内检查过。',
    'warnings.heading': '警告',
    'warnings.none': '没有警告。',
    'warning.none_enforced': '没有评判模型计入限值：所有评判分数均为仅报告，任何限值都不依赖评判。',
    'warning.calibration_invalid': '已提交的评判校准文件未通过校验，因此所有评判均为仅报告。请重新运行 {command} 并提交结果。',
    'warning.expired_cells': '超过 {days} 天的校准：{count}。在再次运行 {command} 之前，它们为仅报告。',
    'warning.judge_changed': '自上次校准以来，评判模型、提示词或评分标准发生了变化，因此相关行为仅报告。请运行 {command}。',
    'role.nightly': '夜间评判',
    'role.online': '在线评判',
    'judge.version': '评判版本：{fingerprint}',
    'table.caption': '{role}：按语言和指标列出的校准',
    'col.language': '语言',
    'col.measure': '指标',
    'col.status': '状态',
    'col.kappa': 'Kappa',
    'col.accuracy': '准确率',
    'col.labels': '标注数',
    'col.unsupported': '发现缺乏依据的内容',
    'col.lengthBias': '长度偏差',
    'col.probes': '同一回答改写后',
    'col.checked': '检查日期',
    'measure.partial_answer': '部分回答',
    'status.gating': '计入限值',
    'status.report_only': '仅报告',
    'status.uncalibrated': '已过期',
    'legend.summary': '状态说明',
    'legend.gating': '计入限值：评判在这里与人工一致，因此其限值在夜间运行中生效。',
    'legend.report_only': '仅报告：分数会显示，但不会导致运行失败。',
    'legend.uncalibrated': '已过期：检查时间过久或评判已变更。按仅报告处理。',
    'reason.kappa_below_floor': '一致性（kappa）低于下限。',
    'reason.accuracy_below_floor': '准确率低于下限。',
    'reason.too_few_labels': '该语言的标注数量不足。',
    'reason.labels_unconfirmed': '标注尚未经人工确认。',
    'reason.length_bias': '较长的正确回答得分差异超出容差。',
    'reason.perturbation': '同一回答改写后，分数变化超出容差。',
    'reason.expired': '上次检查已超过 {days} 天。',
    'reason.fingerprint_mismatch': '自这次检查以来，评判模型、提示词或评分标准已变更。',
    'reason.holistic': '按规则，整体评分仅用于报告。',
    'reason.other': '原因代码：{code}。',
    'source.seed': '起始集',
    'source.review_queue': '审核队列',
    'source.mixed': '起始集和审核队列',
    'cell.belowFloor': '见下方原因',
    'cell.recallPrecision': '召回率 {recall}，精确率 {precision}',
    'cell.probes': '更长 {expanded}，语气更肯定 {assertive}',
    'cell.validUntil': '有效期至 {date}',
    'cell.showAll': '显示全部指标',
    'holistic.note': '1 到 5 分的整体评分只用于报告，不计入任何限值。',
    'empty.title': '尚无评判模型校准',
    'empty.body': '在记录校准结果之前，所有评判分数均为仅报告，任何限值都不依赖评判。请运行 {command}，提交结果并重新部署。',
  },
  it: {
    'panel.title': 'Calibrazione dei giudici',
    'panel.description':
      'Sola lettura. I modelli giudice che valutano le risposte vengono confrontati ogni mese con etichette umane. Il punteggio di un giudice conta per un limite solo per la lingua e la misura in cui concorda con le persone. I risultati cambiano solo tramite lo strumento di calibrazione e una pull request. Vale per tutte le aree di lavoro di questa installazione.',
    'status.loading': 'Caricamento della calibrazione dei giudici…',
    'status.loaded': 'Calibrazione dei giudici caricata. Righe: {cells}. Vincolanti: {enforced}.',
    'action.refresh': 'Aggiorna stato',
    'floors.line':
      'Per essere vincolante: kappa almeno {kappa}, accuratezza almeno {accuracy}, almeno {n} etichette per lingua ({seed} dal set iniziale), controllo negli ultimi {days} giorni.',
    'warnings.heading': 'Avvisi',
    'warnings.none': 'Nessun avviso.',
    'warning.none_enforced': 'Nessun giudice è vincolante: ogni punteggio dei giudici è solo report e nessun limite dipende da un giudice.',
    'warning.calibration_invalid': 'Il file di calibrazione dei giudici non è valido, quindi ogni giudice è solo report. Esegui di nuovo {command} e fai commit del risultato.',
    'warning.expired_cells': 'Calibrazioni più vecchie di {days} giorni: {count}. Restano solo report finché non si riesegue {command}.',
    'warning.judge_changed': "Il modello, il prompt o la griglia del giudice sono cambiati dall’ultima calibrazione: le sue righe sono solo report. Esegui {command}.",
    'role.nightly': 'Giudice notturno',
    'role.online': 'Giudice online',
    'judge.version': 'Versione del giudice: {fingerprint}',
    'table.caption': '{role}: calibrazione per lingua e misura',
    'col.language': 'Lingua',
    'col.measure': 'Misura',
    'col.status': 'Stato',
    'col.kappa': 'Kappa',
    'col.accuracy': 'Accuratezza',
    'col.labels': 'Etichette',
    'col.unsupported': 'Contenuti non supportati rilevati',
    'col.lengthBias': 'Effetto della lunghezza',
    'col.probes': 'Stessa risposta, riformulata',
    'col.checked': 'Controllato',
    'measure.partial_answer': 'Risposta parziale',
    'status.gating': 'Vincolante',
    'status.report_only': 'Solo report',
    'status.uncalibrated': 'Scaduta',
    'legend.summary': 'Significato degli stati',
    'legend.gating': "Vincolante: qui il giudice concorda con le persone, quindi il suo limite vale nell’esecuzione notturna.",
    'legend.report_only': "Solo report: il punteggio viene mostrato e non fa mai fallire un’esecuzione.",
    'legend.uncalibrated': 'Scaduta: il controllo è troppo vecchio o il giudice è cambiato. Trattata come solo report.',
    'reason.kappa_below_floor': "L’accordo (kappa) è sotto il minimo.",
    'reason.accuracy_below_floor': "L’accuratezza è sotto il minimo.",
    'reason.too_few_labels': 'Troppe poche etichette per questa lingua.',
    'reason.labels_unconfirmed': 'Le etichette non sono ancora confermate da una persona.',
    'reason.length_bias': 'Le risposte corrette più lunghe ottengono punteggi diversi oltre la tolleranza.',
    'reason.perturbation': 'Riformulare la stessa risposta cambia il punteggio oltre la tolleranza.',
    'reason.expired': 'Ultimo controllo più di {days} giorni fa.',
    'reason.fingerprint_mismatch': 'Il modello, il prompt o la griglia del giudice sono cambiati dopo questo controllo.',
    'reason.holistic': "I punteggi sull’intera risposta sono solo report per regola.",
    'reason.other': 'Codice del motivo: {code}.',
    'source.seed': 'Set iniziale',
    'source.review_queue': 'Coda di revisione',
    'source.mixed': 'Set iniziale e coda di revisione',
    'cell.belowFloor': 'Indicato nei motivi sotto',
    'cell.recallPrecision': 'richiamo {recall}, precisione {precision}',
    'cell.probes': 'più lunga {expanded}, più assertiva {assertive}',
    'cell.validUntil': 'Valida fino al {date}',
    'cell.showAll': 'Mostra tutte le misure',
    'holistic.note': "I punteggi sull’intera risposta, su scala da 1 a 5, sono riportati e non contano mai per un limite.",
    'empty.title': 'Nessuna calibrazione dei giudici',
    'empty.body':
      'Finché non viene registrata una calibrazione, ogni punteggio dei giudici è solo report e nessun limite dipende da un giudice. Esegui {command}, fai commit del risultato e ridistribuisci.',
  },
};

function judgeCalMessage(key, locale, vars) {
  if (key.startsWith('check.')) return { ...JUDGE_CAL_GATES.gatesUiMessageFrom(GATES_UI_LABELS_FOR_JUDGE(), key, locale, vars) };
  return JUDGE_CAL_GATES.gatesUiMessageFrom(JUDGE_CAL_LABELS, key, locale, vars);
}

/** The shared table, for the two measure names it already holds (check.faithfulness, check.answer_relevance). */
function GATES_UI_LABELS_FOR_JUDGE() {
  if (typeof GATES_UI_LABELS !== 'undefined') return GATES_UI_LABELS;
  return JUDGE_CAL_GATES.GATES_UI_LABELS;
}

function judgeCalLabel(key, locale, vars) {
  return judgeCalMessage(key, locale, vars).text;
}

function judgeCalCount(value, locale) {
  return JUDGE_CAL_GATES.gatesUiNumber(value, locale);
}

function judgeCalReasonMessage(reason, locale, floors) {
  const key = typeof reason === 'string' && Object.prototype.hasOwnProperty.call(JUDGE_CAL_REASON_KEYS, reason) ? JUDGE_CAL_REASON_KEYS[reason] : null;
  if (!key) return judgeCalMessage('reason.other', locale, { code: String(reason) });
  if (key === 'reason.expired') {
    const days = floors && typeof floors.max_age_days === 'number' ? judgeCalCount(floors.max_age_days, locale) : '';
    return judgeCalMessage(key, locale, { days });
  }
  return judgeCalMessage(key, locale);
}

function judgeCalMeasure(metric, locale) {
  const name = String(metric);
  const key = Object.prototype.hasOwnProperty.call(JUDGE_CAL_MEASURE_KEYS, name) ? JUDGE_CAL_MEASURE_KEYS[name] : null;
  if (!key) return { text: name, mono: true };
  return { text: judgeCalLabel(key, locale), mono: false };
}

function judgeCalLanguageRank(code) {
  const i = JUDGE_CAL_LANGUAGE_ORDER.indexOf(code);
  return i < 0 ? JUDGE_CAL_LANGUAGE_ORDER.length : i;
}

function judgeCalFlagged(value, reasons, reason, locale, format) {
  return { text: format(value, locale), flagged: reasons.includes(reason) };
}

/**
 * Pure: one entry per judge role ({ role, title, version, rows }) with languages zh, en, it, then others. Only the fields of UI-SPEC 6.9
 * and 8.1 are read; the cell key and the cell fingerprint are never part of a row.
 */
function judgeCalRows(status, locale) {
  const s = status && typeof status === 'object' ? status : {};
  const floors = s.floors && typeof s.floors === 'object' ? s.floors : null;
  const running = s.running && typeof s.running === 'object' ? s.running : {};
  const cells = Array.isArray(s.cells) ? s.cells.filter((c) => c && typeof c === 'object') : [];
  const { gatesUiScore, gatesUiSigned, gatesUiDate, gatesUiLanguageName } = JUDGE_CAL_GATES;
  const out = [];
  for (const role of JUDGE_CAL_ROLES) {
    const own = cells
      .map((cell, index) => ({ cell, index }))
      .filter((entry) => entry.cell.role === role)
      .sort((a, b) => judgeCalLanguageRank(a.cell.language) - judgeCalLanguageRank(b.cell.language) || a.index - b.index)
      .map((entry) => entry.cell);
    if (own.length === 0) continue;
    const seen = new Map();
    for (const cell of own) {
      const id = String(cell.language) + '|' + String(cell.metric);
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    const fingerprint = typeof running[role] === 'string' ? running[role] : null;
    out.push({
      role,
      title: judgeCalLabel('role.' + role, locale),
      version: fingerprint ? { short: fingerprint.slice(0, 8), full: fingerprint } : null,
      rows: own.map((cell) => {
        const reasons = Array.isArray(cell.reasons) ? cell.reasons.map(String) : [];
        const statusKey = Object.prototype.hasOwnProperty.call(JUDGE_CAL_STATUS_STYLE, cell.status) ? cell.status : null;
        const measure = judgeCalMeasure(cell.metric, locale);
        const sourceKey = ['seed', 'review_queue', 'mixed'].includes(cell.source) ? 'source.' + cell.source : null;
        const recall = gatesUiScore(cell.unsupported_recall, locale);
        const precision = gatesUiScore(cell.unsupported_precision, locale);
        const expanded = gatesUiSigned(cell.expanded_delta, locale);
        const assertive = gatesUiSigned(cell.assertive_delta, locale);
        return {
          language: String(cell.language),
          languageName: gatesUiLanguageName(cell.language, locale),
          measure: measure.text,
          measureMono: measure.mono,
          library: seen.get(String(cell.language) + '|' + String(cell.metric)) > 1 ? String(cell.library) : null,
          statusKey,
          statusLabel: statusKey ? judgeCalLabel('status.' + statusKey, locale) : String(cell.status),
          statusClasses: statusKey ? JUDGE_CAL_STATUS_STYLE[statusKey].classes : 'badge-ghost',
          statusIcon: statusKey ? JUDGE_CAL_STATUS_STYLE[statusKey].icon : 'bi-question-circle',
          reasons: reasons.map((r) => judgeCalReasonMessage(r, locale, floors)),
          kappa: judgeCalFlagged(cell.kappa, reasons, 'kappa_below_floor', locale, gatesUiScore),
          accuracy: judgeCalFlagged(cell.accuracy, reasons, 'accuracy_below_floor', locale, gatesUiScore),
          labels: { count: judgeCalCount(cell.n, locale), source: sourceKey ? judgeCalLabel(sourceKey, locale) : cell.source ? String(cell.source) : '' },
          unsupported: recall || precision ? judgeCalLabel('cell.recallPrecision', locale, { recall: recall || '—', precision: precision || '—' }) : '',
          lengthBias: { text: gatesUiSigned(cell.length_bias_delta, locale), flagged: reasons.includes('length_bias') },
          probes: {
            text: expanded || assertive ? judgeCalLabel('cell.probes', locale, { expanded: expanded || '—', assertive: assertive || '—' }) : '',
            flagged: reasons.includes('perturbation'),
          },
          checked: gatesUiDate(cell.recorded_at, locale),
          validUntil: gatesUiDate(cell.valid_until, locale),
        };
      }),
    });
  }
  return out;
}

/** A route warning as a localized message with its tone; an unknown code shows the route's own message in English. */
function judgeCalWarningView(warning, locale) {
  const w = warning && typeof warning === 'object' ? warning : {};
  const code = String(w.code);
  const style = Object.prototype.hasOwnProperty.call(JUDGE_CAL_WARNING_STYLE, code) ? JUDGE_CAL_WARNING_STYLE[code] : null;
  if (!style) {
    const text = typeof w.message === 'string' ? w.message : code;
    return { key: 'warning.other', code, tone: 'warning', icon: 'bi-exclamation-triangle', segments: [{ text }], text, lang: 'en' };
  }
  const vars = { command: JUDGE_CAL_COMMAND };
  if (code === 'expired_cells') {
    vars.days = judgeCalCount(w.days, locale);
    vars.count = judgeCalCount(typeof w.count === 'number' ? w.count : Array.isArray(w.keys) ? w.keys.length : 0, locale);
  }
  return { ...judgeCalMessage('warning.' + code, locale, vars), code, tone: style.tone, icon: style.icon };
}

function judgeCalFloorsMessage(floors, locale) {
  if (!floors || typeof floors !== 'object') return null;
  const { gatesUiScore } = JUDGE_CAL_GATES;
  return judgeCalMessage('floors.line', locale, {
    kappa: gatesUiScore(floors.kappa, locale),
    accuracy: gatesUiScore(floors.accuracy, locale),
    n: judgeCalCount(floors.min_labels, locale),
    seed: judgeCalCount(floors.seed_min_labels, locale),
    days: judgeCalCount(floors.max_age_days, locale),
  });
}

class JudgeCalPanel {
  constructor(root, deps) {
    const d = deps || {};
    this.root = root;
    this.locale = JUDGE_CAL_GATES.gatesUiLocale(d.locale);
    this.fetcher = d.fetcher || null;
    this.appUrl = d.appUrl || null;
    this.mounted = false;
    this.status = null;
    this.loading = false;
    this.hosts = {
      title: root.querySelector('[data-judge-cal-title]'),
      description: root.querySelector('[data-judge-cal-description]'),
      alert: root.querySelector('[data-judge-cal-alert]'),
      content: root.querySelector('[data-judge-cal-content]'),
      status: root.querySelector('[data-judge-cal-status]'),
    };
  }

  t(key, vars) {
    return judgeCalLabel(key, this.locale, vars);
  }

  el(tag, opts, children) {
    return JUDGE_CAL_GATES.gatesUiEl(tag, opts, children);
  }

  async mount() {
    if (!this.mounted) {
      this.mounted = true;
      this.root.setAttribute('lang', this.locale);
      if (this.hosts.title) this.hosts.title.textContent = this.t('panel.title');
      if (this.hosts.description) this.hosts.description.textContent = this.t('panel.description');
      if (this.hosts.status) this.hosts.status.setAttribute('tabindex', '-1');
      this.buildChrome();
    }
    return this.load();
  }

  buildChrome() {
    const content = this.hosts.content;
    if (!content) return;
    const { gatesUiIcon } = JUDGE_CAL_GATES;
    this.updatedEl = this.el('span', { className: 'text-xs text-base-content/70' });
    this.refreshButton = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.load() } }, [
      gatesUiIcon('bi-arrow-clockwise'),
      this.t('action.refresh'),
    ]);
    this.body = this.el('div', { className: 'flex flex-col gap-6 min-w-0' });
    content.replaceChildren(this.el('div', { className: 'flex flex-wrap items-center justify-end gap-2 mb-4' }, [this.updatedEl, this.refreshButton]), this.body);
  }

  setBusy(busy) {
    const { gatesUiSetBusy, gatesUiSpinner, gatesUiIcon, gatesUiLoadingBlock, gatesUiStatus } = JUDGE_CAL_GATES;
    this.loading = busy;
    if (!this.body) return;
    const hasContent = Boolean(this.status);
    gatesUiSetBusy(this.body, busy && hasContent);
    this.refreshButton.disabled = busy;
    this.refreshButton.replaceChildren(busy ? gatesUiSpinner() : gatesUiIcon('bi-arrow-clockwise'), this.t('action.refresh'));
    if (busy && !hasContent) {
      this.body.replaceChildren(gatesUiLoadingBlock(this.t('status.loading')));
      gatesUiStatus(this.hosts.status, this.t('status.loading'));
    }
  }

  reload() {
    if (this.hosts.content) this.hosts.content.hidden = false;
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
    return this.load();
  }

  async load() {
    if (this.loading || !this.body) return;
    const { gatesUiFetch, gatesUiMapError, gatesUiErrorAlert, gatesUiStatus, gatesUiSetBusy } = JUDGE_CAL_GATES;
    this.setBusy(true);
    const result = await gatesUiFetch(JUDGE_CAL_API, { method: 'GET' }, { fetcher: this.fetcher || undefined });
    this.setBusy(false);
    if (!result.ok) {
      const mapped = gatesUiMapError(result, this.locale, { view: this.t('panel.title'), appUrl: this.appUrl });
      if (this.hosts.alert) this.hosts.alert.replaceChildren(gatesUiErrorAlert(mapped, this.locale, () => this.reload()));
      if (mapped.kind === 'signIn') {
        if (this.hosts.content) this.hosts.content.hidden = true;
      } else if (this.status) gatesUiSetBusy(this.body, true);
      else this.body.replaceChildren();
      gatesUiStatus(this.hosts.status, mapped, true);
      return;
    }
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
    if (this.hosts.content) this.hosts.content.hidden = false;
    this.status = result.body && typeof result.body === 'object' ? result.body : {};
    this.updatedAt = new Date();
    this.render();
    const cells = Array.isArray(this.status.cells) ? this.status.cells : [];
    const enforced = cells.filter((c) => c && c.status === 'gating').length;
    gatesUiStatus(this.hosts.status, this.t('status.loaded', { cells: judgeCalCount(cells.length, this.locale), enforced: judgeCalCount(enforced, this.locale) }));
  }

  render() {
    const { gatesUiDate, gatesUiAppendMessage, gatesUiMessageFrom, gatesUiSetBusy } = JUDGE_CAL_GATES;
    this.updatedEl.replaceChildren();
    const time = gatesUiDate(this.updatedAt.toISOString(), this.locale, 'time');
    if (time) gatesUiAppendMessage(this.updatedEl, gatesUiMessageFrom(GATES_UI_LABELS_FOR_JUDGE(), 'updatedAt', this.locale, { time: { time } }));
    gatesUiSetBusy(this.body, false);
    const nodes = [];
    const floors = judgeCalFloorsMessage(this.status.floors, this.locale);
    if (floors) nodes.push(JUDGE_CAL_GATES.gatesUiMessageEl('p', 'text-sm max-w-prose', floors));
    nodes.push(this.renderWarnings());
    const roles = judgeCalRows(this.status, this.locale);
    if (roles.length === 0) {
      nodes.push(JUDGE_CAL_GATES.gatesUiEmptyBlock(this.t('empty.title'), judgeCalMessage('empty.body', this.locale, { command: JUDGE_CAL_COMMAND })));
    } else {
      for (const role of roles) nodes.push(this.renderRole(role));
      nodes.push(this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('holistic.note') }));
      nodes.push(this.renderLegend());
    }
    this.body.replaceChildren(...nodes);
  }

  renderWarnings() {
    const warnings = Array.isArray(this.status.warnings) ? this.status.warnings : [];
    const block = this.el('div', { className: 'flex flex-col gap-2' }, [this.el('h4', { className: 'text-base font-semibold', text: this.t('warnings.heading') })]);
    if (warnings.length === 0) {
      block.appendChild(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('warnings.none') }));
      return block;
    }
    for (const warning of warnings) {
      const view = judgeCalWarningView(warning, this.locale);
      block.appendChild(JUDGE_CAL_GATES.gatesUiAlert(view.tone, view.icon, view, [], view.lang));
    }
    return block;
  }

  flaggedCell(view, extraClass) {
    const { gatesUiIcon } = JUDGE_CAL_GATES;
    const td = this.el('td', { className: 'align-top text-sm text-right tabular-nums whitespace-nowrap' + (extraClass ? ' ' + extraClass : '') });
    if (view.flagged && view.text) {
      td.appendChild(gatesUiIcon('bi-exclamation-triangle', 'text-warning mr-1'));
      td.appendChild(this.el('span', { className: 'sr-only', text: this.t('cell.belowFloor') + ': ' }));
    }
    td.appendChild(document.createTextNode(view.text || '—'));
    return td;
  }

  renderRole(role) {
    const { gatesUiIcon, gatesUiMessageEl } = JUDGE_CAL_GATES;
    const caption = this.t('table.caption', { role: role.title });
    const heading = this.el('div', { className: 'flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2' }, [this.el('h4', { className: 'text-base font-semibold', text: role.title })]);
    if (role.version) {
      const versionMessage = judgeCalMessage('judge.version', this.locale, { fingerprint: { mono: role.version.short } });
      const version = gatesUiMessageEl('span', 'text-xs text-base-content/70', versionMessage);
      version.setAttribute('title', role.version.full);
      heading.appendChild(version);
    }
    const col = (key, cls) => this.el('th', { className: 'text-xs font-semibold align-bottom' + (cls ? ' ' + cls : ''), text: this.t(key), attrs: { scope: 'col' } });
    const head = this.el('tr', null, [
      col('col.language'),
      col('col.measure'),
      col('col.status', 'min-w-48'),
      col('col.kappa', 'text-right'),
      col('col.accuracy', 'text-right'),
      col('col.labels', 'text-right'),
      col('col.unsupported', 'max-lg:hidden'),
      col('col.lengthBias', 'text-right max-lg:hidden'),
      col('col.probes', 'max-lg:hidden'),
      col('col.checked', 'max-md:hidden'),
    ]);
    const body = this.el('tbody');
    for (const row of role.rows) {
      const measureEl = this.el('div', {
        className: row.measureMono ? 'font-mono text-xs break-all' : 'text-sm',
        text: row.measure,
        attrs: row.measureMono ? { translate: 'no' } : null,
      });
      const measureCell = this.el('td', { className: 'align-top min-w-32' }, [measureEl]);
      if (row.library) measureCell.appendChild(this.el('div', { className: 'font-mono text-xs text-base-content/70 break-all', text: row.library, attrs: { translate: 'no' } }));
      const statusCell = this.el('td', { className: 'align-top' }, [
        this.el('span', { className: 'badge badge-sm gap-1 h-auto whitespace-nowrap ' + row.statusClasses }, [
          gatesUiIcon(row.statusIcon),
          row.statusKey ? row.statusLabel : this.el('code', { className: 'font-mono text-xs break-all', text: row.statusLabel, attrs: { translate: 'no' } }),
        ]),
      ]);
      if (row.reasons.length > 0) {
        const list = this.el('ul', { className: 'flex flex-col gap-1 mt-1 text-xs text-base-content/70 max-w-prose' });
        for (const reason of row.reasons) list.appendChild(gatesUiMessageEl('li', 'break-words', reason));
        statusCell.appendChild(list);
      }
      if (row.checked) {
        statusCell.appendChild(
          this.el('div', { className: 'text-xs text-base-content/70 mt-1 md:hidden' }, [
            this.t('col.checked') + ': ',
            this.el('time', { text: row.checked.text, attrs: { datetime: row.checked.iso } }),
          ]),
        );
      }
      const wide = this.el('dl', { className: 'grid gap-1 mt-1 text-xs' }, [
        this.el('dt', { className: 'font-semibold', text: this.t('col.unsupported') }),
        this.el('dd', { className: 'tabular-nums', text: row.unsupported || '—' }),
        this.el('dt', { className: 'font-semibold', text: this.t('col.lengthBias') }),
        this.el('dd', { className: 'tabular-nums', text: row.lengthBias.text || '—' }),
        this.el('dt', { className: 'font-semibold', text: this.t('col.probes') }),
        this.el('dd', { className: 'tabular-nums', text: row.probes.text || '—' }),
      ]);
      statusCell.appendChild(
        this.el('details', { className: 'lg:hidden mt-1' }, [
          this.el('summary', {
            className: 'text-xs cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
            text: this.t('cell.showAll'),
          }),
          wide,
        ]),
      );
      const labelsCell = this.el('td', { className: 'align-top text-right' }, [
        this.el('div', { className: 'text-sm tabular-nums', text: row.labels.count }),
        this.el('div', { className: 'text-xs text-base-content/70', text: row.labels.source }),
      ]);
      const checkedCell = this.el('td', { className: 'align-top text-sm max-md:hidden whitespace-nowrap' });
      if (row.checked) checkedCell.appendChild(this.el('time', { text: row.checked.text, attrs: { datetime: row.checked.iso } }));
      if (row.validUntil) {
        const until = gatesUiMessageEl('div', 'text-xs text-base-content/70', judgeCalMessage('cell.validUntil', this.locale, { date: { time: row.validUntil } }));
        checkedCell.appendChild(until);
      }
      const probes = this.el('td', { className: 'align-top text-sm tabular-nums max-lg:hidden' });
      if (row.probes.flagged && row.probes.text) {
        probes.appendChild(gatesUiIcon('bi-exclamation-triangle', 'text-warning mr-1'));
        probes.appendChild(this.el('span', { className: 'sr-only', text: this.t('cell.belowFloor') + ': ' }));
      }
      probes.appendChild(document.createTextNode(row.probes.text || '—'));
      body.appendChild(
        this.el('tr', null, [
          this.el('th', { className: 'font-normal text-sm align-top', text: row.languageName, attrs: { scope: 'row' } }),
          measureCell,
          statusCell,
          this.flaggedCell(row.kappa),
          this.flaggedCell(row.accuracy),
          labelsCell,
          this.el('td', { className: 'align-top text-sm tabular-nums max-lg:hidden', text: row.unsupported || '—' }),
          this.flaggedCell(row.lengthBias, 'max-lg:hidden'),
          probes,
          checkedCell,
        ]),
      );
    }
    const region = this.el(
      'div',
      {
        className: 'overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': caption },
      },
      [this.el('table', { className: 'table table-sm' }, [this.el('caption', { className: 'sr-only', text: caption }), this.el('thead', null, [head]), body])],
    );
    return this.el('div', { className: 'min-w-0' }, [heading, region]);
  }

  renderLegend() {
    const list = this.el('ul', { className: 'flex flex-col gap-1 mt-2 text-xs max-w-prose' });
    for (const key of ['gating', 'report_only', 'uncalibrated']) list.appendChild(this.el('li', { text: this.t('legend.' + key) }));
    return this.el('details', null, [
      this.el('summary', {
        className: 'text-sm cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        text: this.t('legend.summary'),
      }),
      list,
    ]);
  }
}

let JUDGE_CAL_PANEL_INSTANCE = null;

/** Idempotent: the first call mounts, later calls refresh. */
function initJudgeCalPanel() {
  const root = document.getElementById('rag-administration-judge');
  if (!root) return;
  if (!JUDGE_CAL_PANEL_INSTANCE) {
    JUDGE_CAL_PANEL_INSTANCE = new JudgeCalPanel(root);
    window.judgeCalibrationPanel = JUDGE_CAL_PANEL_INSTANCE;
    JUDGE_CAL_PANEL_INSTANCE.mount();
    return;
  }
  JUDGE_CAL_PANEL_INSTANCE.load();
}

function bindJudgeCalPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-judge-cal-bound')) return;
    link.setAttribute('data-judge-cal-bound', '1');
    link.addEventListener('click', () => initJudgeCalPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initJudgeCalPanel = initJudgeCalPanel;
  window.judgeCalRows = judgeCalRows;
  bindJudgeCalPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindJudgeCalPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initJudgeCalPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { JUDGE_CAL_LABELS, judgeCalLabel, judgeCalMessage, judgeCalRows, judgeCalWarningView, JudgeCalPanel, initJudgeCalPanel };
}
