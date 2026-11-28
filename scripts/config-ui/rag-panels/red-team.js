/**
 * Red-team runs panel (SEC-11; 07-UI-SPEC 6.3, 7.3, 8.4, 12.3). Starts one red-team run through the Config UI server, which asks the
 * main app whether the caller is an admin before it starts the runner on this machine, and shows the attacks that got through per
 * technique and language. Renders counts, technique ids and labels, language codes and states only: never an attack's text, a
 * question, an answer, an item or trace id, a tenant key or a path. DOM through the rag-ui helpers (createElement, textContent).
 */

const RED_TEAM_UI =
  typeof ragUiEl === 'function'
    ? {
        ragUiEl,
        ragUiIcon,
        ragUiSpinner,
        ragUiAlert,
        ragUiLookup,
        ragUiSharedLabel,
        ragUiFormatNumber,
        ragUiCount,
        ragUiFetchJson,
        ragUiTemplateNodes,
        ragUiConfirmDialog,
        ragUiListLoading,
        ragUiListBusy,
        ragUiButtonBusy,
        ragUiBrowserLocale,
        ragUiNextId,
      }
    : require('./rag-ui.js');

const RED_TEAM_POLL_MS = 5000;
const RED_TEAM_START_TIMEOUT_MS = 30000;
const RED_TEAM_MAX_POLL_FAILURES = 3;
const RED_TEAM_RUNS_PATH = '/api/red-team/runs';

const RED_TEAM_LABELS = {
  en: {
    'panel.title': 'Red-team runs',
    'panel.description':
      'Replays the stored attack set and the attack corpus through the full pipeline and counts the attacks that got through, per technique and language. Every success opens a case in the Review queue.',
    'note.workspace': 'Runs only in the workspace marked for red-team tests. That workspace is set in the runner’s configuration, not here.',
    'start.configLabel': 'Run configuration',
    'start.configCurrent': 'Current deployment settings',
    'start.configHelp': 'Choose a saved run configuration to test settings other than the ones in use.',
    'action.start': 'Start red-team run',
    'start.starting': 'Starting…',
    'confirm.start.title': 'Start a red-team run?',
    'confirm.start.body':
      'Synthetic attack documents and questions are sent through the full pipeline in the red-team workspace, using the answering model. A run can take several minutes and may be billed by your providers. Every attack that succeeds opens a review case.',
    'confirm.start.reviewOff': 'Expert review is switched off, so no review case will be opened. The run still reports its results.',
    'confirm.start.keep': 'Close without starting',
    'review.off': 'Expert review is switched off. A run still reports its results, but opens no review case. An operator switches it on under RAG Modes.',
    'latest.title': 'Latest run',
    'list.loading': 'Loading the latest run…',
    'load.failed': 'The red-team runs could not be read from the Config UI server. Check that it is running, then select Reload panel.',
    'empty.title': 'No red-team run yet',
    'empty.body': 'Select Start red-team run to replay the attack set. The results appear here.',
    'state.running': 'Running',
    'state.finished': 'Finished',
    'state.failed': 'Failed',
    'meta.started': 'Started: {time}',
    'meta.finished': 'Finished: {time}',
    'meta.attacks': 'Attacks replayed',
    'meta.successes': 'Attacks that succeeded',
    'meta.cases': 'Review cases opened',
    'meta.casesSkipped': 'Review cases opened: none, because expert review is switched off',
    'progress.label': 'Replayed: {done} of {total}',
    'progress.unknown': 'Running…',
    'run.started': 'Red-team run started.',
    'run.finished': 'Red-team run finished. Attacks that succeeded: {count}.',
    'run.failed':
      'The red-team run failed ({code}). Nothing more was replayed. Check the Config UI server’s log, then select Start red-team run to try again.',
    'result.none': 'No attack succeeded in this run.',
    'table.caption': 'Attack results by technique and language',
    'col.technique': 'Technique',
    'col.language': 'Language',
    'col.attacks': 'Attacks',
    'col.succeeded': 'Succeeded',
    'col.rate': 'Success rate',
    'row.total': 'All techniques',
    'note.small': 'Counts are small. Read each rate together with its number of attacks.',
    'lang.und': 'Undetermined',
    'action.refresh': 'Refresh status',
    'action.openQueue': 'Open Review queue',
    'action.reload': 'Reload panel',
    'poll.stalled': 'The status could not be read three times in a row. The run may still be going. Select Refresh status.',
    'error.adminOnly':
      'Only an operator admin can start a red-team run. Sign in to the main app at {appUrl} with an admin account, then select Reload panel.',
    'error.busy': 'A red-team run is already in progress. Its status is shown below.',
    'error.config': 'That run configuration is not available. Choose another one, then start again.',
    'error.unavailable': 'The admin check is unavailable right now, so no run was started. Check that the main app is running, then try again.',
    'error.gone': 'That run’s results are no longer on this machine.',
    'error.outcomeUnknown': 'No answer from the Config UI server. A run may or may not have started; the status has been reloaded.',
  },
  zh: {
    'panel.title': '红队测试',
    'panel.description': '把已保存的攻击集和攻击语料在完整流程中重放一遍，并按手法和语言统计成功的攻击。每次成功都会在复核队列中新建一个案例。',
    'note.workspace': '只在标记为红队测试专用的工作区中运行。该工作区在运行器的配置中设置，不在此处设置。',
    'start.configLabel': '运行配置',
    'start.configCurrent': '当前部署设置',
    'start.configHelp': '选择已保存的运行配置，可以测试与当前不同的设置。',
    'action.start': '开始红队测试',
    'start.starting': '正在启动…',
    'confirm.start.title': '要开始红队测试吗？',
    'confirm.start.body': '合成的攻击文档和问题会在红队工作区中走完整个流程，并调用回答模型。一次运行可能需要几分钟，服务商可能会收费。每次成功的攻击都会新建一个复核案例。',
    'confirm.start.reviewOff': '专家复核已关闭，因此不会新建复核案例。运行仍会给出结果。',
    'confirm.start.keep': '不启动并关闭',
    'review.off': '专家复核已关闭。运行仍会给出结果，但不会新建复核案例。可由运维人员在 RAG Modes 中开启。',
    'latest.title': '最近一次运行',
    'list.loading': '正在加载最近一次运行…',
    'load.failed': '无法从 Config UI 服务器读取红队测试。请确认它正在运行，然后选择“重新加载面板”。',
    'empty.title': '尚未运行过红队测试',
    'empty.body': '选择“开始红队测试”来重放攻击集，结果会显示在这里。',
    'state.running': '运行中',
    'state.finished': '已完成',
    'state.failed': '失败',
    'meta.started': '开始时间：{time}',
    'meta.finished': '完成时间：{time}',
    'meta.attacks': '已重放的攻击',
    'meta.successes': '成功的攻击',
    'meta.cases': '新建的复核案例',
    'meta.casesSkipped': '新建的复核案例：无（专家复核已关闭）',
    'progress.label': '已重放：{done}/{total}',
    'progress.unknown': '运行中…',
    'run.started': '红队测试已开始。',
    'run.finished': '红队测试已完成。成功的攻击：{count}。',
    'run.failed': '红队测试失败（{code}），之后的攻击没有重放。请查看 Config UI 服务器的日志，然后选择“开始红队测试”重试。',
    'result.none': '这次运行中没有攻击成功。',
    'table.caption': '按手法和语言统计的攻击结果',
    'col.technique': '手法',
    'col.language': '语言',
    'col.attacks': '攻击数',
    'col.succeeded': '成功数',
    'col.rate': '成功率',
    'row.total': '全部手法',
    'note.small': '样本量较小，请结合攻击数一起看成功率。',
    'lang.und': '未确定',
    'action.refresh': '刷新状态',
    'action.openQueue': '打开复核队列',
    'action.reload': '重新加载面板',
    'poll.stalled': '连续三次无法读取状态，运行可能仍在继续。请选择“刷新状态”。',
    'error.adminOnly': '只有运维管理员可以开始红队测试。请用管理员账号在 {appUrl} 登录主应用，然后选择“重新加载面板”。',
    'error.busy': '已有一次红队测试正在进行，状态显示在下方。',
    'error.config': '该运行配置不可用。请另选一个，然后重新开始。',
    'error.unavailable': '暂时无法完成管理员校验，因此没有启动运行。请确认主应用正在运行，然后重试。',
    'error.gone': '这次运行的结果已不在这台机器上。',
    'error.outcomeUnknown': 'Config UI 服务器没有响应。运行可能已启动，也可能没有；状态已重新加载。',
  },
  it: {
    'panel.title': 'Esecuzioni red team',
    'panel.description':
      'Riproduce l’insieme di attacchi salvato e il corpus di attacchi attraverso l’intera pipeline e conta gli attacchi riusciti, per tecnica e lingua. Ogni attacco riuscito apre un caso nella Coda di revisione.',
    'note.workspace':
      'Viene eseguita solo nello spazio di lavoro contrassegnato per i test red team. Quello spazio si imposta nella configurazione del runner, non qui.',
    'start.configLabel': 'Configurazione dell’esecuzione',
    'start.configCurrent': 'Impostazioni attuali dell’installazione',
    'start.configHelp': 'Scegli una configurazione salvata per provare impostazioni diverse da quelle in uso.',
    'action.start': 'Avvia esecuzione red team',
    'start.starting': 'Avvio…',
    'confirm.start.title': 'Avviare un’esecuzione red team?',
    'confirm.start.body':
      'Documenti e domande di attacco sintetici attraversano l’intera pipeline nello spazio di lavoro red team, usando il modello di risposta. Un’esecuzione può durare diversi minuti e può essere fatturata dai tuoi provider. Ogni attacco riuscito apre un caso di revisione.',
    'confirm.start.reviewOff': 'La revisione degli esperti è disattivata, quindi non verrà aperto alcun caso. L’esecuzione riporta comunque i risultati.',
    'confirm.start.keep': 'Chiudi senza avviare',
    'review.off':
      'La revisione degli esperti è disattivata. Un’esecuzione riporta comunque i risultati, ma non apre casi di revisione. Un operatore la attiva in RAG Modes.',
    'latest.title': 'Ultima esecuzione',
    'list.loading': 'Caricamento dell’ultima esecuzione…',
    'load.failed': 'Le esecuzioni red team non sono state lette dal server della Config UI. Verifica che sia in esecuzione, poi seleziona Ricarica pannello.',
    'empty.title': 'Nessuna esecuzione red team',
    'empty.body': 'Seleziona Avvia esecuzione red team per riprodurre l’insieme di attacchi. I risultati compaiono qui.',
    'state.running': 'In corso',
    'state.finished': 'Terminata',
    'state.failed': 'Non riuscita',
    'meta.started': 'Avviata: {time}',
    'meta.finished': 'Terminata: {time}',
    'meta.attacks': 'Attacchi riprodotti',
    'meta.successes': 'Attacchi riusciti',
    'meta.cases': 'Casi di revisione aperti',
    'meta.casesSkipped': 'Casi di revisione aperti: nessuno, perché la revisione degli esperti è disattivata',
    'progress.label': 'Riprodotti: {done} di {total}',
    'progress.unknown': 'In corso…',
    'run.started': 'Esecuzione red team avviata.',
    'run.finished': 'Esecuzione red team terminata. Attacchi riusciti: {count}.',
    'run.failed':
      'L’esecuzione red team non è riuscita ({code}). Non è stato riprodotto altro. Controlla il log del server della Config UI, poi seleziona Avvia esecuzione red team per riprovare.',
    'result.none': 'Nessun attacco è riuscito in questa esecuzione.',
    'table.caption': 'Risultati degli attacchi per tecnica e lingua',
    'col.technique': 'Tecnica',
    'col.language': 'Lingua',
    'col.attacks': 'Attacchi',
    'col.succeeded': 'Riusciti',
    'col.rate': 'Tasso di riuscita',
    'row.total': 'Tutte le tecniche',
    'note.small': 'I numeri sono piccoli. Leggi ogni tasso insieme al numero di attacchi.',
    'lang.und': 'Non determinata',
    'action.refresh': 'Aggiorna stato',
    'action.openQueue': 'Apri la Coda di revisione',
    'action.reload': 'Ricarica pannello',
    'poll.stalled': 'Lo stato non è stato letto per tre volte di seguito. L’esecuzione potrebbe essere ancora in corso. Seleziona Aggiorna stato.',
    'error.adminOnly':
      'Solo un amministratore operatore può avviare un’esecuzione red team. Accedi all’app principale su {appUrl} con un account amministratore, poi seleziona Ricarica pannello.',
    'error.busy': 'Un’esecuzione red team è già in corso. Il suo stato è mostrato qui sotto.',
    'error.config': 'Quella configurazione non è disponibile. Scegline un’altra, poi riavvia.',
    'error.unavailable':
      'La verifica dell’amministratore non è disponibile, quindi non è stata avviata alcuna esecuzione. Verifica che l’app principale sia in esecuzione, poi riprova.',
    'error.gone': 'I risultati di quell’esecuzione non sono più su questa macchina.',
    'error.outcomeUnknown': 'Nessuna risposta dal server della Config UI. Un’esecuzione potrebbe essere partita oppure no; lo stato è stato ricaricato.',
  },
};

function redTeamLabel(key, locale, vars) {
  const own = RED_TEAM_UI.ragUiLookup(RED_TEAM_LABELS, key, locale, vars);
  return own === undefined ? RED_TEAM_UI.ragUiSharedLabel(key, locale, vars) : own;
}

function redTeamAppUrl() {
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') {
    const url = window.getConfiguredMyRAGAppUrl();
    if (url) return url;
  }
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

function redTeamDate(value, locale) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function redTeamRate(successes, attacks, locale) {
  if (!attacks) return '–';
  const value = successes / attacks;
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  } catch {
    return (value * 100).toFixed(1) + '%';
  }
}

function redTeamLanguageName(code, locale) {
  if (code === 'und') return redTeamLabel('lang.und', locale);
  try {
    if (typeof Intl.DisplayNames === 'function') {
      const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
      if (name && name !== code) return name;
    }
  } catch {
    // unknown code: shown as the code
  }
  return code;
}

function redTeamCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The finished-run view model: rows sorted by technique label, then by language in the report's order, plus the total row.
 * Reads named fields only; an unknown technique or language is kept and shown by its code.
 */
function redTeamResultView(run) {
  const cells = run && Array.isArray(run.cells) ? run.cells : [];
  const indexed = cells
    .filter((cell) => cell && typeof cell.technique === 'string' && typeof cell.language === 'string')
    .map((cell, index) => ({
      technique: cell.technique,
      techniqueLabel: typeof cell.techniqueLabel === 'string' && cell.techniqueLabel ? cell.techniqueLabel : cell.technique,
      language: cell.language,
      attacks: redTeamCount(cell.attacks),
      successes: redTeamCount(cell.successes),
      index,
    }));
  indexed.sort((a, b) => {
    const byLabel = a.techniqueLabel.localeCompare(b.techniqueLabel, 'en');
    return byLabel !== 0 ? byLabel : a.index - b.index;
  });
  const attacks = indexed.reduce((sum, row) => sum + row.attacks, 0);
  const successes = indexed.reduce((sum, row) => sum + row.successes, 0);
  return {
    rows: indexed.map(({ index: _index, ...row }) => row),
    total: { attacks, successes },
    reviewCasesOpened: Number.isInteger(run && run.reviewCasesOpened) ? run.reviewCasesOpened : null,
    casesSkipped: Boolean(run && run.casesSkippedReason),
  };
}

/** The panel's state for a run object: no-run, running, finished or failed. */
function redTeamRunState(run) {
  if (!run || typeof run !== 'object') return 'none';
  return run.state === 'running' || run.state === 'finished' || run.state === 'failed' ? run.state : 'failed';
}

class RedTeamPanel {
  constructor(root, deps) {
    const options = deps || {};
    this.root = root;
    this.doc = options.doc || (typeof document !== 'undefined' ? document : null);
    this.locale = options.locale || RED_TEAM_UI.ragUiBrowserLocale();
    this.fetcher = options.configFetcher || ((url, init, timeoutMs) => RED_TEAM_UI.ragUiFetchJson(url, init, timeoutMs));
    this.config = options.config || (() => (typeof window !== 'undefined' && window.currentConfig ? window.currentConfig : {}));
    this.schedule = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.clearTimeout || ((handle) => clearTimeout(handle));
    this.isVisible = options.isVisible || RedTeamPanel.defaultVisible;
    this.run = null;
    this.runConfigs = [];
    this.selectedConfig = '';
    this.loaded = false;
    this.notice = null;
    this.pollTimer = null;
    this.pollFailures = 0;
    this.stalled = false;
    this.mounted = false;
    this.busyNoteId = RED_TEAM_UI.ragUiNextId('red-team-busy');
  }

  static defaultVisible() {
    if (typeof document === 'undefined' || !document) return true;
    if (document.visibilityState === 'hidden') return false;
    const tab = typeof document.getElementById === 'function' ? document.getElementById('rag-administration') : null;
    return !tab || !tab.classList || tab.classList.contains('active');
  }

  el(tag, options, children) {
    return RED_TEAM_UI.ragUiEl(this.doc, tag, options, children);
  }

  t(key, vars) {
    return redTeamLabel(key, this.locale, vars);
  }

  part(name) {
    return this.root ? this.root.querySelector('[data-red-team-' + name + ']') : null;
  }

  announce(text, tone) {
    const status = this.part('status');
    if (!status) return;
    const children = tone === 'error' ? [RED_TEAM_UI.ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text })] : [this.el('span', { text })];
    status.className = 'text-sm mt-4' + (tone === 'error' ? ' text-error' : '');
    status.replaceChildren(...children);
  }

  async mount() {
    if (this.mounted) return this.refresh();
    this.mounted = true;
    if (this.root && typeof this.root.setAttribute === 'function') this.root.setAttribute('lang', this.locale);
    const title = this.part('title');
    if (title) title.textContent = this.t('panel.title');
    const description = this.part('description');
    if (description) description.textContent = this.t('panel.description');
    RED_TEAM_UI.ragUiListLoading(this.doc, this.part('content'), this.t('list.loading'));
    return this.load();
  }

  refresh() {
    return this.load();
  }

  async load() {
    const content = this.part('content');
    if (this.loaded) RED_TEAM_UI.ragUiListBusy(content, true);
    const result = await this.fetcher(RED_TEAM_RUNS_PATH, { method: 'GET' });
    RED_TEAM_UI.ragUiListBusy(content, false);
    if (!result || result.thrown || !result.ok || !result.body || typeof result.body !== 'object') {
      this.notice = { kind: 'loadFailed' };
      this.render();
      return;
    }
    this.loaded = true;
    if (this.notice && this.notice.kind === 'loadFailed') this.notice = null;
    this.runConfigs = Array.isArray(result.body.runConfigs) ? result.body.runConfigs.filter((name) => typeof name === 'string' && !/[\\/]/.test(name)) : [];
    if (!this.runConfigs.includes(this.selectedConfig)) this.selectedConfig = '';
    this.run = result.body.latest && typeof result.body.latest === 'object' ? result.body.latest : null;
    this.stalled = false;
    this.render();
    if (redTeamRunState(this.run) === 'running') this.startPolling();
    else this.stopPolling();
  }

  startPolling() {
    this.stopPolling();
    this.pollFailures = 0;
    this.stalled = false;
    this.pollTimer = this.schedule(() => this.poll(), RED_TEAM_POLL_MS);
  }

  stopPolling() {
    if (this.pollTimer !== null) this.cancel(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    this.pollTimer = null;
    if (!this.run || redTeamRunState(this.run) !== 'running') return;
    if (!this.isVisible()) {
      this.pollTimer = this.schedule(() => this.poll(), RED_TEAM_POLL_MS);
      return;
    }
    const result = await this.fetcher(RED_TEAM_RUNS_PATH + '/' + encodeURIComponent(this.run.id), { method: 'GET' });
    if (result && !result.thrown && result.status === 404) {
      this.run = null;
      this.notice = { kind: 'gone' };
      this.render();
      return;
    }
    if (!result || result.thrown || !result.ok || !result.body || !result.body.run) {
      this.pollFailures += 1;
      if (this.pollFailures >= RED_TEAM_MAX_POLL_FAILURES) {
        this.stalled = true;
        this.render();
        this.announce(this.t('poll.stalled'), 'error');
        return;
      }
      this.pollTimer = this.schedule(() => this.poll(), RED_TEAM_POLL_MS);
      return;
    }
    this.pollFailures = 0;
    this.run = result.body.run;
    const state = redTeamRunState(this.run);
    this.render();
    if (state === 'running') {
      this.pollTimer = this.schedule(() => this.poll(), RED_TEAM_POLL_MS);
      return;
    }
    if (state === 'finished') this.announce(this.t('run.finished', { count: RED_TEAM_UI.ragUiFormatNumber(redTeamResultView(this.run).total.successes, this.locale) }));
    else this.announce(this.t('run.failed', { code: this.run.errorCode || 'runner_failed' }), 'error');
  }

  reviewOn() {
    const config = this.config() || {};
    return String(config.RAG_DOMAIN_EXPERT_REVIEW ?? '').trim().toLowerCase() === 'true';
  }

  async openStartDialog(opener) {
    const body = [this.t('confirm.start.body')];
    if (!this.reviewOn()) body.push(this.t('confirm.start.reviewOff'));
    await RED_TEAM_UI.ragUiConfirmDialog(this.doc, {
      title: this.t('confirm.start.title'),
      body,
      keepLabel: this.t('confirm.start.keep'),
      confirmLabel: this.t('action.start'),
      runningLabel: this.t('start.starting'),
      opener,
      fallbackFocus: this.part('status'),
      onConfirm: () => this.start(),
    });
  }

  async start() {
    const payload = this.selectedConfig ? { runConfig: this.selectedConfig } : {};
    const result = await this.fetcher(RED_TEAM_RUNS_PATH, { method: 'POST', body: JSON.stringify(payload) }, RED_TEAM_START_TIMEOUT_MS);
    if (!result || result.thrown) {
      this.notice = { kind: 'outcomeUnknown' };
      await this.load();
      return { keepOpen: false };
    }
    const status = result.status;
    if ((status === 202 || status === 200) && result.body && result.body.run) {
      this.notice = null;
      this.run = result.body.run;
      this.render();
      if (redTeamRunState(this.run) === 'running') {
        this.announce(this.t('run.started'));
        this.startPolling();
      } else if (redTeamRunState(this.run) === 'failed') {
        this.announce(this.t('run.failed', { code: this.run.errorCode || 'runner_failed' }), 'error');
      }
      return { keepOpen: false };
    }
    if (status === 409) {
      this.notice = { kind: 'busy' };
      const runningId = result.body && typeof result.body.runningRunId === 'string' ? result.body.runningRunId : null;
      const read = runningId ? await this.fetcher(RED_TEAM_RUNS_PATH + '/' + encodeURIComponent(runningId), { method: 'GET' }) : null;
      if (read && read.ok && read.body && read.body.run) {
        this.run = read.body.run;
        this.render();
        if (redTeamRunState(this.run) === 'running') this.startPolling();
      } else {
        await this.load();
      }
      return { keepOpen: false };
    }
    if (status === 400) this.notice = { kind: 'config' };
    else if (status === 401) this.notice = { kind: 'signIn' };
    else if (status === 403) this.notice = { kind: 'adminOnly' };
    else this.notice = { kind: 'unavailable' };
    this.render();
    return { keepOpen: false };
  }

  noticeAlert() {
    const notice = this.notice;
    if (!notice) return null;
    const reload = () => {
      this.notice = null;
      this.load();
    };
    const reloadButton = () => {
      const button = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.reload'), attrs: { type: 'button' } });
      button.addEventListener('click', reload);
      return button;
    };
    const alert = (tone, icon, body, actions, role) => RED_TEAM_UI.ragUiAlert(this.doc, { tone, icon, body, actions, role });
    switch (notice.kind) {
      case 'loadFailed':
        return alert('error', 'exclamation-circle', [this.t('load.failed')], [reloadButton()]);
      case 'signIn':
        return alert('warning', 'person-lock', [RED_TEAM_UI.ragUiSharedLabel('error.signIn', this.locale)], [reloadButton()], 'alert');
      case 'adminOnly':
        return alert('warning', 'person-lock', [this.t('error.adminOnly', { appUrl: redTeamAppUrl() })], [reloadButton()], 'alert');
      case 'unavailable':
        return alert('error', 'exclamation-circle', [this.t('error.unavailable')], [], 'alert');
      case 'busy':
        return alert('info', 'hourglass-split', [this.t('error.busy')], [], 'alert');
      case 'gone':
        return alert('warning', 'exclamation-triangle', [this.t('error.gone')], []);
      case 'outcomeUnknown':
        return alert('warning', 'question-circle', [this.t('error.outcomeUnknown')], [], 'alert');
      default:
        return null;
    }
  }

  renderAlerts() {
    const host = this.part('alert');
    if (!host) return;
    const nodes = [];
    if (!this.reviewOn()) {
      nodes.push(RED_TEAM_UI.ragUiAlert(this.doc, { tone: 'info', icon: 'toggle-off', body: [this.t('review.off')] }));
    }
    const notice = this.notice && this.notice.kind !== 'config' ? this.noticeAlert() : null;
    if (notice) nodes.push(notice);
    host.className = 'mb-4 empty:mb-0 grid gap-2';
    host.replaceChildren(...nodes);
  }

  renderControls() {
    const running = redTeamRunState(this.run) === 'running';
    const selectId = 'red-team-run-config';
    const helpId = 'red-team-run-config-help';
    const select = this.el('select', {
      className: 'select select-bordered w-full md:select-sm md:max-w-md',
      id: selectId,
      attrs: { name: selectId, autocomplete: 'off', 'aria-describedby': helpId, 'aria-invalid': this.notice && this.notice.kind === 'config' ? 'true' : null },
    });
    select.appendChild(this.el('option', { text: this.t('start.configCurrent'), attrs: { value: '' } }));
    for (const name of this.runConfigs) {
      select.appendChild(this.el('option', { text: name, attrs: { value: name, translate: 'no', selected: name === this.selectedConfig ? true : null } }));
    }
    select.value = this.selectedConfig;
    select.addEventListener('change', () => {
      this.selectedConfig = this.runConfigs.includes(select.value) ? select.value : '';
    });
    const field = this.el('div', { className: 'grid gap-1 min-w-0' }, [
      this.el('label', { className: 'text-sm font-semibold', text: this.t('start.configLabel'), attrs: { for: selectId } }),
      select,
      this.el('p', { className: 'text-xs text-base-content/70', id: helpId, text: this.t('start.configHelp') }),
    ]);
    if (this.notice && this.notice.kind === 'config') {
      field.appendChild(this.el('p', { className: 'text-sm text-error', text: this.t('error.config'), attrs: { role: 'alert' } }));
    }
    const startButton = this.el('button', {
      className: 'btn btn-primary md:btn-sm',
      text: this.t('action.start'),
      id: 'red-team-start',
      attrs: { type: 'button', 'data-red-team-start': '', 'aria-describedby': running ? this.busyNoteId : null },
    });
    startButton.disabled = running;
    startButton.addEventListener('click', () => {
      if (!startButton.disabled) this.openStartDialog(startButton);
    });
    const actions = this.el('div', { className: 'flex flex-wrap items-center gap-2' }, [startButton]);
    if (running) actions.appendChild(this.el('p', { className: 'text-xs text-base-content/70', id: this.busyNoteId, text: this.t('error.busy') }));
    const controls = this.el('div', { className: 'grid gap-4', attrs: { 'data-red-team-controls': '' } }, [field, actions]);
    controls.addEventListener('change', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    });
    return controls;
  }

  stateBadge(state) {
    const tone = state === 'running' ? 'info' : state === 'finished' ? 'success' : 'error';
    const icon = state === 'running' ? 'hourglass-split' : state === 'finished' ? 'check-circle' : 'x-circle';
    return this.el('span', { className: 'badge badge-sm badge-outline badge-' + tone + ' gap-1 shrink-0' }, [
      RED_TEAM_UI.ragUiIcon(this.doc, icon),
      this.el('span', { text: this.t('state.' + state) }),
    ]);
  }

  renderTable(view) {
    const cell = (tag, text, className, attrs) => this.el(tag, { className, text, attrs });
    const head = this.el('tr', {}, [
      cell('th', this.t('col.technique'), '', { scope: 'col' }),
      cell('th', this.t('col.language'), 'hidden md:table-cell', { scope: 'col' }),
      cell('th', this.t('col.attacks'), 'text-right', { scope: 'col' }),
      cell('th', this.t('col.succeeded'), 'text-right', { scope: 'col' }),
      cell('th', this.t('col.rate'), 'hidden md:table-cell text-right', { scope: 'col' }),
    ]);
    const body = this.el('tbody');
    const englishData = this.locale === 'en' ? null : 'en';
    for (const row of view.rows) {
      const languageName = redTeamLanguageName(row.language, this.locale);
      const labelled = row.techniqueLabel !== row.technique;
      const technique = this.el('th', { className: 'font-normal min-w-0', attrs: { scope: 'row' } }, [
        labelled
          ? this.el('span', { className: 'block break-words', text: row.techniqueLabel, attrs: { lang: englishData } })
          : this.el('span', { className: 'block text-sm font-mono break-all', text: row.technique, attrs: { translate: 'no' } }),
        labelled ? this.el('span', { className: 'block text-xs font-mono text-base-content/70 break-all', text: row.technique, attrs: { translate: 'no' } }) : null,
        this.el('span', { className: 'block text-xs text-base-content/70 md:hidden' }, [
          languageName + ' ',
          this.el('span', { className: 'font-mono', text: row.language, attrs: { translate: 'no' } }),
        ]),
      ]);
      const language = this.el('td', { className: 'hidden md:table-cell' }, [
        this.el('span', { className: 'block', text: languageName }),
        this.el('span', { className: 'block text-xs font-mono text-base-content/70', text: row.language, attrs: { translate: 'no' } }),
      ]);
      const succeeded =
        row.successes > 0
          ? this.el('td', { className: 'text-right tabular-nums font-semibold text-error' }, [
              this.el('span', { className: 'inline-flex items-center gap-1 justify-end' }, [
                RED_TEAM_UI.ragUiIcon(this.doc, 'shield-exclamation'),
                this.el('span', { text: RED_TEAM_UI.ragUiFormatNumber(row.successes, this.locale) }),
              ]),
              this.el('span', { className: 'block text-xs font-normal text-base-content/70 md:hidden', text: redTeamRate(row.successes, row.attacks, this.locale) }),
            ])
          : this.el('td', { className: 'text-right tabular-nums' }, [
              this.el('span', { text: RED_TEAM_UI.ragUiFormatNumber(0, this.locale) }),
              this.el('span', { className: 'block text-xs text-base-content/70 md:hidden', text: redTeamRate(0, row.attacks, this.locale) }),
            ]);
      body.appendChild(
        this.el('tr', {}, [
          technique,
          language,
          cell('td', RED_TEAM_UI.ragUiFormatNumber(row.attacks, this.locale), 'text-right tabular-nums'),
          succeeded,
          cell('td', redTeamRate(row.successes, row.attacks, this.locale), 'hidden md:table-cell text-right tabular-nums'),
        ]),
      );
    }
    body.appendChild(
      this.el('tr', { className: 'font-semibold' }, [
        this.el('th', { text: this.t('row.total'), attrs: { scope: 'row' } }),
        cell('td', '', 'hidden md:table-cell'),
        cell('td', RED_TEAM_UI.ragUiFormatNumber(view.total.attacks, this.locale), 'text-right tabular-nums'),
        cell('td', RED_TEAM_UI.ragUiFormatNumber(view.total.successes, this.locale), 'text-right tabular-nums'),
        cell('td', redTeamRate(view.total.successes, view.total.attacks, this.locale), 'hidden md:table-cell text-right tabular-nums'),
      ]),
    );
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('table.caption') }),
      this.el('thead', {}, [head]),
      body,
    ]);
    return this.el('div', {
      className: 'overflow-x-auto min-w-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('table.caption') },
    }, [table]);
  }

  renderRun() {
    const run = this.run;
    const state = redTeamRunState(run);
    if (state === 'none') {
      return this.el('div', { className: 'py-8 text-center', attrs: { 'data-red-team-empty': '' } }, [
        this.el('h4', { className: 'text-base font-semibold text-balance', text: this.t('empty.title') }),
        this.el('p', { className: 'text-sm text-base-content/70 mt-2', text: this.t('empty.body') }),
      ]);
    }
    const refresh = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.refresh'), attrs: { type: 'button' } });
    refresh.addEventListener('click', async () => {
      const restore = RED_TEAM_UI.ragUiButtonBusy(this.doc, refresh, this.t('action.refresh'), []);
      try {
        await this.load();
      } finally {
        restore();
      }
    });
    const header = this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2' }, [
      this.el('h4', { className: 'text-base font-semibold text-balance', text: this.t('latest.title') }),
      refresh,
    ]);
    const meta = this.el('div', { className: 'flex flex-wrap items-center gap-x-4 gap-y-1 text-sm' }, [this.stateBadge(state)]);
    if (run.startedAt) meta.appendChild(this.el('span', { text: this.t('meta.started', { time: redTeamDate(run.startedAt, this.locale) }) }));
    if (run.finishedAt && state !== 'running') meta.appendChild(this.el('span', { text: this.t('meta.finished', { time: redTeamDate(run.finishedAt, this.locale) }) }));
    const block = this.el('div', { className: 'grid gap-4 min-w-0', attrs: { 'data-red-team-run': state } }, [header, meta]);

    if (state === 'running') {
      const progress = run.progress || {};
      if (Number.isInteger(progress.total) && progress.total > 0 && Number.isInteger(progress.done)) {
        const label = this.t('progress.label', {
          done: RED_TEAM_UI.ragUiFormatNumber(progress.done, this.locale),
          total: RED_TEAM_UI.ragUiFormatNumber(progress.total, this.locale),
        });
        block.appendChild(
          this.el('div', { className: 'grid gap-1' }, [
            this.el('p', { className: 'text-sm tabular-nums', text: label, attrs: { 'aria-hidden': 'true' } }),
            this.el('progress', { className: 'progress w-full', attrs: { max: String(progress.total), value: String(progress.done), 'aria-label': label } }),
          ]),
        );
      } else {
        block.appendChild(RED_TEAM_UI.ragUiSpinner(this.doc, this.t('progress.unknown')));
      }
    }

    if (state === 'failed') {
      const code = typeof run.errorCode === 'string' && run.errorCode ? run.errorCode : 'runner_failed';
      block.appendChild(
        RED_TEAM_UI.ragUiAlert(this.doc, {
          tone: 'error',
          icon: 'exclamation-circle',
          body: [this.el('p', { className: 'text-sm' }, RED_TEAM_UI.ragUiTemplateNodes(this.doc, this.t('run.failed'), { code }, ['code']))],
        }),
      );
    }

    if (state === 'finished') {
      const view = redTeamResultView(run);
      const counts = this.el('div', { className: 'flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums' }, [
        this.el('span', { text: RED_TEAM_UI.ragUiCount(this.t('meta.attacks'), view.total.attacks, this.locale) }),
        this.el('span', { text: RED_TEAM_UI.ragUiCount(this.t('meta.successes'), view.total.successes, this.locale) }),
        this.el('span', {
          attrs: { 'data-red-team-cases': '' },
          text: view.casesSkipped ? this.t('meta.casesSkipped') : RED_TEAM_UI.ragUiCount(this.t('meta.cases'), view.reviewCasesOpened ?? 0, this.locale),
        }),
      ]);
      const reviewPanel = this.doc && typeof this.doc.getElementById === 'function' ? this.doc.getElementById('rag-administration-review') : null;
      if (reviewPanel && !view.casesSkipped) {
        const open = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('action.openQueue'), attrs: { type: 'button' } });
        open.addEventListener('click', () => {
          if (typeof reviewPanel.scrollIntoView === 'function') reviewPanel.scrollIntoView({ block: 'start' });
          const heading = reviewPanel.querySelector('h3[tabindex="-1"]') || reviewPanel.querySelector('h3');
          if (heading && typeof heading.focus === 'function') heading.focus();
        });
        counts.appendChild(open);
      }
      block.appendChild(counts);
      if (view.total.successes === 0) {
        block.appendChild(
          this.el('p', { className: 'text-sm inline-flex items-center gap-2', attrs: { 'data-red-team-none': '' } }, [
            RED_TEAM_UI.ragUiIcon(this.doc, 'shield-check', 'text-success'),
            this.el('span', { text: this.t('result.none') }),
          ]),
        );
      }
      block.appendChild(this.renderTable(view));
      block.appendChild(this.el('p', { className: 'text-xs text-base-content/70', text: this.t('note.small') }));
    }
    return block;
  }

  render() {
    this.renderAlerts();
    const content = this.part('content');
    if (!content) return;
    if (!this.loaded && this.notice && this.notice.kind === 'loadFailed') {
      content.replaceChildren();
      return;
    }
    const active = this.doc && this.doc.activeElement;
    const focusId = active && content.contains && content.contains(active) && active.id ? active.id : null;
    content.replaceChildren(
      this.el('p', { className: 'text-xs text-base-content/70 mb-4 max-w-prose', text: this.t('note.workspace') }),
      this.renderControls(),
      this.el('div', { className: 'divider my-4' }),
      this.renderRun(),
    );
    if (this.stalled) {
      const refresh = this.el('button', { className: 'btn btn-outline md:btn-sm mt-2', text: this.t('action.refresh'), attrs: { type: 'button' } });
      refresh.addEventListener('click', () => this.load());
      content.appendChild(refresh);
    }
    if (focusId && this.doc && typeof this.doc.getElementById === 'function') {
      const again = this.doc.getElementById(focusId);
      if (again && typeof again.focus === 'function') again.focus();
    }
  }
}

let RED_TEAM_PANEL_INSTANCE = null;

/** Idempotent: the first call mounts, later calls reload the latest run. */
function initRedTeamPanel() {
  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
  const root = document.getElementById('rag-administration-red-team');
  if (!root) return;
  if (!RED_TEAM_PANEL_INSTANCE) {
    RED_TEAM_PANEL_INSTANCE = new RedTeamPanel(root);
    if (typeof window !== 'undefined') window.redTeamPanel = RED_TEAM_PANEL_INSTANCE;
    RED_TEAM_PANEL_INSTANCE.mount();
    return;
  }
  RED_TEAM_PANEL_INSTANCE.refresh();
}

function bindRedTeamPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-red-team-bound')) return;
    link.setAttribute('data-red-team-bound', '1');
    link.addEventListener('click', () => initRedTeamPanel());
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initRedTeamPanel = initRedTeamPanel;
  bindRedTeamPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindRedTeamPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initRedTeamPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RED_TEAM_LABELS,
    RED_TEAM_POLL_MS,
    redTeamLabel,
    redTeamResultView,
    redTeamRunState,
    redTeamRate,
    RedTeamPanel,
    initRedTeamPanel,
  };
}
