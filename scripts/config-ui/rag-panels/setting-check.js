/**
 * Phase 5.3 pre-save setting check (UI-SPEC 6.3, 9, 12.3): the state machine, the dialog view model, the dialog itself and the save
 * guard window.ragSettingCheck = { beforeSave, required, saved, saveFailed }. The dialog lists names of changed settings, never a value,
 * and never saves on its own: it hands a decision back to the caller, which posts and reports the outcome. Built with cuiEl and
 * textContent only.
 */

const SETTING_CHECK_LABELS = {
  en: {
    "dialog.title.checking": "Checking these settings",
    "dialog.title.passedSaved": "Check passed. Settings saved.",
    "dialog.title.passed": "Check passed",
    "dialog.title.failed": "Check failed",
    "dialog.title.error": "The check gave no result",
    "dialog.title.busy": "Another check is running",
    "dialog.title.saved": "Settings saved",
    "dialog.title.notSaved": "Not saved",
    "checking.body": "These settings change how answers are produced, so they are tried on a fixed set of test questions before they apply. This usually takes a few minutes and stops after 10.",
    "checking.barLabel": "Setting check in progress",
    "checking.stage": "Now running: {layer}",
    "checking.elapsed": "Elapsed: {time}",
    "checking.cached": "Result from {time}, for the same settings.",
    "changed.heading": "Changed settings: {count}",
    "changed.more": "And others: {count}",
    "result.heading": "Result",
    "failed.heading": "What failed",
    "failed.warnNote": "Setting checks are in warn mode: a check that fails or gives no result does not block saving. The result is recorded with the change.",
    "failed.enforceNote": "Saving these settings needs a reason. It is stored with the change and listed in the weekly report.",
    "error.body": "Without a result the check counts as not passed.",
    "busy.body": "Only one check runs at a time on this machine. The other one started at {time}.",
    "untested.heading": "Changed settings this check could not test: {count}",
    "untested.body": "The result says nothing about these settings. Try them in a test deployment, or switch on the live model check, before relying on them.",
    "untested.reason.fixture_generator": "The built-in questions are answered by a stand-in model, not by the chat model.",
    "untested.reason.fixture_embedder": "The built-in questions use their own embedding model.",
    "untested.reason.needs_credentials": "Testing this needs a key that the check does not use.",
    "notCovered": "Not covered by the workspace test set: {names}",
    "uncal.heading": "Refusal thresholds that stop applying: {count}",
    "uncal.body": "They were calibrated for the previous value. Until {command} records a live result for the new one, the similarity floor decides instead.",
    "uncal.item": "{model}, questions in {language}",
    "uncal.more": "And others: {count}",
    "reason.label": "Reason for saving without a passed check",
    "reason.help": "10 to 500 characters. Write what you checked and why this cannot wait. Do not include customer data.",
    "reason.count": "Characters: {count}",
    "reason.tooShort": "The reason needs more characters: {missing}",
    "action.edit": "Edit settings",
    "action.save": "Save settings",
    "action.saveAnyway": "Save settings anyway",
    "action.saveReason": "Save settings with reason",
    "action.saveWithout": "Save settings without result",
    "action.rerun": "Run check again",
    "action.close": "Close check",
    "saving": "Saving…",
    "outcome.savedOverride": "Settings saved with your reason. Recorded as change {id}.",
    "outcome.savedWarn": "Settings saved. The check result is recorded as change {id}.",
    "outcome.savedSkipped": "Settings saved without a result. Recorded as change {id}.",
    "outcome.held": "Nothing was saved. Your edits are still in the form.",
    "indicator.held": "Not saved",
    "error.changed": "Not saved. The settings changed after the check, so its result no longer matches. Select Run check again.",
    "error.required": "Not saved. These settings need a passed check or a reason. Reload the page, then save again to start the check.",
    "error.recordFailed": "Not saved. The reason could not be recorded because the database did not answer, and a save without its record is refused. Try again in a moment.",
    "error.saveFailed": "Not saved. The config server did not accept the settings ({status}). Your edits are still in the form.",
    "panel.title": "Setting checks",
    "panel.description": "Settings that change how answers are produced are tried on test questions before they apply. A finished bulk import or re-embedding run requests an evaluation run for that workspace. Applies to every workspace in this deployment.",
    "panel.tabsLabel": "Setting check views",
    "tab.last": "Last check",
    "tab.runs": "Evaluation runs",
    "tab.settings": "Settings",
    "summary.mode": "Mode",
    "summary.live": "Live model check",
    "mode.off": "Off: settings are saved at once, as before",
    "mode.warn": "Warn: the result is shown, saving is never blocked",
    "mode.enforce": "Enforce: a save needs a passed check or a reason",
    "mode.pending": "The mode you selected applies after you save it.",
    "settings.gate.label": "Check settings before saving",
    "settings.gate.help": "Covers settings that change how answers are produced. Other settings are saved without a check.",
    "settings.live.label": "Also ask the live chat model",
    "settings.live.off": "Off: built-in test questions only, no model call",
    "settings.live.on": "On: the proposed chat model also answers a fixed sample (uses model credit)",
    "warn.liveNeedsGate": "The live model check has no effect while setting checks are off.",
    "warn.enforceFirst": "Consider running in warn mode first: it shows how often a save would have been blocked without blocking anyone.",
    "last.loading": "Loading the last check…",
    "last.checkedAt": "Checked {time}",
    "last.savedAs": "Saved: {how}",
    "how.pass": "after a passed check",
    "how.override": "with a reason",
    "how.warn": "in warn mode",
    "how.skipped": "without a result",
    "how.not_saved": "not saved",
    "last.empty.title": "No check yet",
    "last.empty.body": "A check runs when you save a setting that changes how answers are produced, such as the system prompt, the RAG mode, the chat model or a retrieval switch. Its result appears here.",
    "off.title": "Setting checks are off",
    "off.body": "Settings are saved at once, as before. To try a change on test questions first, choose Warn under Settings and save.",
    "action.refreshLast": "Refresh check",
    "action.refreshRuns": "Refresh runs",
    "action.moreRuns": "Load more runs",
    "runs.loading": "Loading evaluation runs…",
    "runs.caption": "Evaluation runs requested after imports",
    "runs.col.workspace": "Workspace",
    "runs.col.reason": "Started by",
    "runs.col.requested": "Requested",
    "runs.reason.backfill_completed": "After a bulk import",
    "runs.reason.reembed_completed": "After re-embedding",
    "runs.reason.manual": "Started by hand",
    "runs.showFailed": "Show failed checks: {count}",
    "runs.drainHint": "Waiting runs start with the nightly job, or by hand with {command}.",
    "runs.empty.title": "No evaluation runs requested",
    "runs.empty.body": "When a bulk import or a re-embedding run finishes, a run on that workspace's own test set is requested and listed here.",
  },
  zh: {
    "dialog.title.checking": "正在检查这些设置",
    "dialog.title.passedSaved": "检查通过，设置已保存。",
    "dialog.title.passed": "检查通过",
    "dialog.title.failed": "检查未通过",
    "dialog.title.error": "检查没有得出结果",
    "dialog.title.busy": "另一项检查正在运行",
    "dialog.title.saved": "设置已保存",
    "dialog.title.notSaved": "未保存",
    "checking.body": "这些设置会改变回答的生成方式，因此在生效前会先用一组固定的测试问题检验。通常需要几分钟，最长 10 分钟。",
    "checking.barLabel": "设置检查进行中",
    "checking.stage": "正在运行：{layer}",
    "checking.elapsed": "已用时：{time}",
    "checking.cached": "{time} 的结果，设置相同。",
    "changed.heading": "已更改的设置：{count}",
    "changed.more": "其他：{count}",
    "result.heading": "结果",
    "failed.heading": "未通过的项目",
    "failed.warnNote": "设置检查处于提醒模式：检查未通过或没有结果都不会阻止保存。结果会随本次更改一起记录。",
    "failed.enforceNote": "保存这些设置需要填写原因。原因会随本次更改一起保存，并列入每周报告。",
    "error.body": "没有结果时，检查按未通过处理。",
    "busy.body": "本机一次只运行一项检查。另一项检查开始于 {time}。",
    "untested.heading": "本次检查无法检验的已更改设置：{count}",
    "untested.body": "检查结果不能说明这些设置的影响。在依赖它们之前，请先在测试部署中试用，或开启真实模型检查。",
    "untested.reason.fixture_generator": "内置问题由替代模型作答，而不是对话模型。",
    "untested.reason.fixture_embedder": "内置问题使用自带的向量模型。",
    "untested.reason.needs_credentials": "检验此项需要检查不会使用的密钥。",
    "notCovered": "工作区测试集未覆盖：{names}",
    "uncal.heading": "将停止生效的拒答阈值：{count} 个",
    "uncal.body": "它们是针对之前的取值校准的。在 {command} 为新取值记录真实结果之前，将改由相似度下限决定是否拒答。",
    "uncal.item": "{model}，{language}问题",
    "uncal.more": "其他：{count}",
    "reason.label": "未通过检查仍要保存的原因",
    "reason.help": "10 到 500 个字符。请写明你核实了什么，以及为什么不能等。不要包含客户数据。",
    "reason.count": "字符数：{count}",
    "reason.tooShort": "原因还需要的字符数：{missing}",
    "action.edit": "编辑设置",
    "action.save": "保存设置",
    "action.saveAnyway": "仍然保存设置",
    "action.saveReason": "填写原因并保存设置",
    "action.saveWithout": "不等结果保存设置",
    "action.rerun": "重新运行检查",
    "action.close": "关闭检查",
    "saving": "正在保存…",
    "outcome.savedOverride": "设置已保存，原因已记录。更改记录：{id}。",
    "outcome.savedWarn": "设置已保存。检查结果已记录，更改记录：{id}。",
    "outcome.savedSkipped": "设置已在没有结果的情况下保存。更改记录：{id}。",
    "outcome.held": "未保存任何内容。你的修改仍在表单中。",
    "indicator.held": "未保存",
    "error.changed": "未保存。检查之后设置又有改动，结果已不匹配。请点击“重新运行检查”。",
    "error.required": "未保存。这些设置需要通过检查或填写原因。请重新加载页面，然后再次保存以开始检查。",
    "error.recordFailed": "未保存。数据库没有响应，原因无法记录；没有记录的保存会被拒绝。请稍后再试。",
    "error.saveFailed": "未保存。配置服务器没有接受这些设置（{status}）。你的修改仍在表单中。",
    "panel.title": "设置检查",
    "panel.description": "会改变回答生成方式的设置，在生效前先用测试问题检验。批量导入或重新生成向量完成后，会为该工作区请求一次评估运行。对本部署的所有工作区生效。",
    "panel.tabsLabel": "设置检查视图",
    "tab.last": "最近一次检查",
    "tab.runs": "评估运行",
    "tab.settings": "设置",
    "summary.mode": "模式",
    "summary.live": "真实模型检查",
    "mode.off": "关闭：设置立即保存，与以前一样",
    "mode.warn": "提醒：显示结果，但不阻止保存",
    "mode.enforce": "强制：保存需要通过检查或填写原因",
    "mode.pending": "所选模式在保存后生效。",
    "settings.gate.label": "保存前检查设置",
    "settings.gate.help": "适用于会改变回答生成方式的设置。其他设置不经检查直接保存。",
    "settings.live.label": "同时用真实对话模型检验",
    "settings.live.off": "关闭：只用内置测试问题，不调用模型",
    "settings.live.on": "开启：拟用的对话模型也回答一组固定样本（会消耗模型额度）",
    "warn.liveNeedsGate": "设置检查关闭时，真实模型检查不起作用。",
    "warn.enforceFirst": "建议先使用提醒模式：它会显示保存本会被阻止的次数，但不会真的阻止。",
    "last.loading": "正在加载最近一次检查…",
    "last.checkedAt": "检查于 {time}",
    "last.savedAs": "保存情况：{how}",
    "how.pass": "检查通过后保存",
    "how.override": "填写原因后保存",
    "how.warn": "在提醒模式下保存",
    "how.skipped": "没有结果时保存",
    "how.not_saved": "未保存",
    "last.empty.title": "尚无检查",
    "last.empty.body": "保存会改变回答生成方式的设置（如系统提示词、RAG 模式、对话模型或检索开关）时会运行检查，结果显示在这里。",
    "off.title": "设置检查已关闭",
    "off.body": "设置会立即保存，与以前一样。若要先用测试问题检验改动，请在“设置”中选择“提醒”并保存。",
    "action.refreshLast": "刷新检查",
    "action.refreshRuns": "刷新运行",
    "action.moreRuns": "加载更多运行",
    "runs.loading": "正在加载评估运行…",
    "runs.caption": "导入后请求的评估运行",
    "runs.col.workspace": "工作区",
    "runs.col.reason": "触发原因",
    "runs.col.requested": "请求时间",
    "runs.reason.backfill_completed": "批量导入完成后",
    "runs.reason.reembed_completed": "重新生成向量后",
    "runs.reason.manual": "手动启动",
    "runs.showFailed": "显示未通过的检查项：{count}",
    "runs.drainHint": "等待中的运行由夜间任务启动，也可以用 {command} 手动启动。",
    "runs.empty.title": "没有请求过评估运行",
    "runs.empty.body": "批量导入或重新生成向量完成后，会在该工作区自己的测试集上请求一次运行，并列在这里。",
  },
  it: {
    "dialog.title.checking": "Controllo delle impostazioni in corso",
    "dialog.title.passedSaved": "Controllo superato. Impostazioni salvate.",
    "dialog.title.passed": "Controllo superato",
    "dialog.title.failed": "Controllo non superato",
    "dialog.title.error": "Il controllo non ha dato un esito",
    "dialog.title.busy": "Un altro controllo è in corso",
    "dialog.title.saved": "Impostazioni salvate",
    "dialog.title.notSaved": "Non salvato",
    "checking.body": "Queste impostazioni cambiano il modo in cui vengono prodotte le risposte, quindi vengono provate su un insieme fisso di domande di test prima di essere applicate. Di solito bastano pochi minuti; il controllo si ferma dopo 10.",
    "checking.barLabel": "Controllo delle impostazioni in corso",
    "checking.stage": "In esecuzione: {layer}",
    "checking.elapsed": "Tempo trascorso: {time}",
    "checking.cached": "Esito delle {time}, per le stesse impostazioni.",
    "changed.heading": "Impostazioni modificate: {count}",
    "changed.more": "E altre: {count}",
    "result.heading": "Esito",
    "failed.heading": "Cosa non è stato superato",
    "failed.warnNote": "I controlli sono in modalità avviso: un controllo non superato o senza esito non blocca il salvataggio. L'esito viene registrato con la modifica.",
    "failed.enforceNote": "Per salvare queste impostazioni serve un motivo. Viene conservato con la modifica ed elencato nel report settimanale.",
    "error.body": "Senza un esito il controllo conta come non superato.",
    "busy.body": "Su questa macchina viene eseguito un solo controllo alla volta. L'altro è iniziato alle {time}.",
    "untested.heading": "Impostazioni modificate che questo controllo non ha potuto provare: {count}",
    "untested.body": "L'esito non dice nulla su queste impostazioni. Provale in un ambiente di test, o attiva il controllo con il modello reale, prima di farvi affidamento.",
    "untested.reason.fixture_generator": "Alle domande integrate risponde un modello sostitutivo, non il modello di chat.",
    "untested.reason.fixture_embedder": "Le domande integrate usano un proprio modello di embedding.",
    "untested.reason.needs_credentials": "Per provarla serve una chiave che il controllo non usa.",
    "notCovered": "Non coperto dal set di test dell'area di lavoro: {names}",
    "uncal.heading": "Soglie di rifiuto che smettono di valere: {count}",
    "uncal.body": "Sono state calibrate per il valore precedente. Finché {command} non registra un risultato reale per quello nuovo, decide la soglia minima di similarità.",
    "uncal.item": "{model}, domande in {language}",
    "uncal.more": "E altre: {count}",
    "reason.label": "Motivo del salvataggio senza un controllo superato",
    "reason.help": "Da 10 a 500 caratteri. Scrivi che cosa hai verificato e perché non si può aspettare. Non inserire dati dei clienti.",
    "reason.count": "Caratteri: {count}",
    "reason.tooShort": "Al motivo mancano caratteri: {missing}",
    "action.edit": "Modifica impostazioni",
    "action.save": "Salva impostazioni",
    "action.saveAnyway": "Salva comunque le impostazioni",
    "action.saveReason": "Salva impostazioni con motivo",
    "action.saveWithout": "Salva impostazioni senza esito",
    "action.rerun": "Ripeti controllo",
    "action.close": "Chiudi controllo",
    "saving": "Salvataggio…",
    "outcome.savedOverride": "Impostazioni salvate con il tuo motivo. Registrate come modifica {id}.",
    "outcome.savedWarn": "Impostazioni salvate. L'esito del controllo è registrato come modifica {id}.",
    "outcome.savedSkipped": "Impostazioni salvate senza esito. Registrate come modifica {id}.",
    "outcome.held": "Non è stato salvato nulla. Le modifiche sono ancora nel modulo.",
    "indicator.held": "Non salvato",
    "error.changed": "Non salvato. Le impostazioni sono cambiate dopo il controllo e l'esito non corrisponde più. Seleziona Ripeti controllo.",
    "error.required": "Non salvato. Queste impostazioni richiedono un controllo superato o un motivo. Ricarica la pagina e salva di nuovo per avviare il controllo.",
    "error.recordFailed": "Non salvato. Il database non ha risposto e il motivo non è stato registrato; un salvataggio senza registrazione viene rifiutato. Riprova tra poco.",
    "error.saveFailed": "Non salvato. Il server di configurazione non ha accettato le impostazioni ({status}). Le modifiche sono ancora nel modulo.",
    "panel.title": "Controlli delle impostazioni",
    "panel.description": "Le impostazioni che cambiano il modo in cui vengono prodotte le risposte vengono provate su domande di test prima di essere applicate. Al termine di un'importazione in blocco o di un ricalcolo degli embedding viene richiesta una valutazione per quell'area di lavoro. Vale per tutte le aree di lavoro di questa installazione.",
    "panel.tabsLabel": "Viste dei controlli delle impostazioni",
    "tab.last": "Ultimo controllo",
    "tab.runs": "Valutazioni",
    "tab.settings": "Impostazioni",
    "summary.mode": "Modalità",
    "summary.live": "Controllo con il modello reale",
    "mode.off": "Disattivato: le impostazioni si salvano subito, come prima",
    "mode.warn": "Avviso: l'esito viene mostrato, il salvataggio non è mai bloccato",
    "mode.enforce": "Obbligatorio: per salvare serve un controllo superato o un motivo",
    "mode.pending": "La modalità selezionata vale dopo il salvataggio.",
    "settings.gate.label": "Controlla le impostazioni prima di salvare",
    "settings.gate.help": "Riguarda le impostazioni che cambiano il modo in cui vengono prodotte le risposte. Le altre si salvano senza controllo.",
    "settings.live.label": "Interroga anche il modello di chat reale",
    "settings.live.off": "Disattivato: solo domande di test integrate, nessuna chiamata al modello",
    "settings.live.on": "Attivo: anche il modello di chat proposto risponde a un campione fisso (consuma credito del modello)",
    "warn.liveNeedsGate": "Il controllo con il modello reale non ha effetto finché i controlli delle impostazioni sono disattivati.",
    "warn.enforceFirst": "Valuta di usare prima la modalità avviso: mostra quante volte un salvataggio sarebbe stato bloccato, senza bloccare nessuno.",
    "last.loading": "Caricamento dell'ultimo controllo…",
    "last.checkedAt": "Controllato il {time}",
    "last.savedAs": "Salvataggio: {how}",
    "how.pass": "dopo un controllo superato",
    "how.override": "con un motivo",
    "how.warn": "in modalità avviso",
    "how.skipped": "senza esito",
    "how.not_saved": "non salvato",
    "last.empty.title": "Nessun controllo finora",
    "last.empty.body": "Un controllo parte quando salvi un'impostazione che cambia il modo in cui vengono prodotte le risposte, come il prompt di sistema, la modalità RAG, il modello di chat o un'opzione di recupero. L'esito compare qui.",
    "off.title": "I controlli delle impostazioni sono disattivati",
    "off.body": "Le impostazioni si salvano subito, come prima. Per provare prima una modifica sulle domande di test, scegli Avviso in Impostazioni e salva.",
    "action.refreshLast": "Aggiorna controllo",
    "action.refreshRuns": "Aggiorna valutazioni",
    "action.moreRuns": "Carica altre valutazioni",
    "runs.loading": "Caricamento delle valutazioni…",
    "runs.caption": "Valutazioni richieste dopo le importazioni",
    "runs.col.workspace": "Area di lavoro",
    "runs.col.reason": "Avviata da",
    "runs.col.requested": "Richiesta",
    "runs.reason.backfill_completed": "Dopo un'importazione in blocco",
    "runs.reason.reembed_completed": "Dopo il ricalcolo degli embedding",
    "runs.reason.manual": "Avviata a mano",
    "runs.showFailed": "Mostra i controlli non superati: {count}",
    "runs.drainHint": "Le valutazioni in attesa partono con il job notturno, oppure a mano con {command}.",
    "runs.empty.title": "Nessuna valutazione richiesta",
    "runs.empty.body": "Quando termina un'importazione in blocco o un ricalcolo degli embedding, viene richiesta una valutazione sul set di test di quell'area di lavoro, elencata qui.",
  },
};

const SETTING_CHECK_LAYERS = ['deterministic', 'live', 'real_set'];
const SETTING_CHECK_CHANGED_CAP = 12;
const SETTING_CHECK_UNCAL_CAP = 6;
const SETTING_CHECK_REASON_MIN = 10;
const SETTING_CHECK_REASON_MAX = 500;
const SETTING_CHECK_CALIBRATE_COMMAND = 'python -m rag_eval.calibrate refusal';
const SETTING_CHECK_BUTTONS = {
  edit: { labelKey: 'action.edit', className: 'btn' },
  close: { labelKey: 'action.close', className: 'btn' },
  rerun: { labelKey: 'action.rerun', className: 'btn btn-outline' },
  save: { labelKey: 'action.save', className: 'btn btn-primary' },
  saveAnyway: { labelKey: 'action.saveAnyway', className: 'btn btn-warning' },
  saveReason: { labelKey: 'action.saveReason', className: 'btn btn-warning' },
  saveWithout: { labelKey: 'action.saveWithout', className: 'btn btn-warning' },
};
const SETTING_CHECK_SAVE_BUTTONS = ['save', 'saveAnyway', 'saveReason', 'saveWithout'];

/** The shared helpers of gates-ui.js: page globals in the browser, the module under Node. */
function settingCheckGates() {
  if (typeof window !== 'undefined' && typeof window.gatesUiMessageFrom === 'function' && typeof window.gatesUiEvidenceRows === 'function') return window;
  return require('./gates-ui.js');
}

function settingCheckMessage(key, locale, vars) {
  const g = settingCheckGates();
  if (g.gatesUiTemplateFrom && g.gatesUiTemplateFrom(SETTING_CHECK_LABELS, key, locale) === null) return g.gatesUiMessage(key, locale, vars);
  return g.gatesUiMessageFrom(SETTING_CHECK_LABELS, key, locale, vars);
}

function settingCheckLabel(key, locale, vars) {
  return settingCheckMessage(key, locale, vars).text;
}

function settingCheckMode(mode) {
  return mode === 'warn' ? 'warn' : 'enforce';
}

function settingCheckList(value) {
  return Array.isArray(value) ? value : [];
}

/** pass, fail or error: anything unknown or missing is No result, never Passed. */
function settingCheckOutcome(check) {
  const result = check && typeof check === 'object' ? check.result : undefined;
  if (result === 'pass' || result === 'passed') return 'pass';
  if (result === 'fail' || result === 'failed') return 'fail';
  return 'error';
}

function settingCheckHasNotice(check) {
  return settingCheckList(check && check.not_evaluated).length > 0 || settingCheckList(check && check.uncalibrated_cells).length > 0;
}

function settingCheckButtons(list) {
  return list.map((id) => ({ id, labelKey: SETTING_CHECK_BUTTONS[id].labelKey, className: SETTING_CHECK_BUTTONS[id].className }));
}

/** The save button of a state without a passed result: warn saves anyway (with a check id) or without a result; enforce needs a reason. */
function settingCheckModeSave(mode, check) {
  if (mode === 'enforce') return 'saveReason';
  return check && typeof check.check_id === 'string' && check.check_id ? 'saveAnyway' : 'saveWithout';
}

function settingCheckBaseState(mode, phase, check) {
  const note = mode === 'warn' ? 'failed.warnNote' : 'failed.enforceNote';
  if (phase === 'checking') {
    return { titleKey: 'dialog.title.checking', ids: mode === 'warn' ? ['edit', 'saveWithout'] : ['edit'], reasonField: false, autoSave: false, noteKey: mode === 'warn' ? 'failed.warnNote' : null };
  }
  if (phase === 'busy') {
    const save = mode === 'warn' ? 'saveWithout' : 'saveReason';
    return { titleKey: 'dialog.title.busy', ids: ['edit', 'rerun', save], reasonField: mode === 'enforce', autoSave: false, noteKey: note };
  }
  if (phase === 'noResult') {
    const save = settingCheckModeSave(mode, check);
    return { titleKey: 'dialog.title.error', ids: ['edit', 'rerun', save], reasonField: save === 'saveReason', autoSave: false, noteKey: note };
  }
  const outcome = settingCheckOutcome(check);
  if (outcome === 'pass') {
    if (settingCheckHasNotice(check)) return { titleKey: 'dialog.title.passed', ids: ['edit', 'save'], reasonField: false, autoSave: false, noteKey: null };
    return { titleKey: 'dialog.title.passedSaved', ids: ['close'], reasonField: false, autoSave: true, noteKey: null };
  }
  if (outcome === 'fail') {
    if (mode === 'warn') return { titleKey: 'dialog.title.failed', ids: ['edit', 'saveAnyway'], reasonField: false, autoSave: false, noteKey: note };
    return { titleKey: 'dialog.title.failed', ids: ['edit', 'saveReason'], reasonField: true, autoSave: false, noteKey: note };
  }
  return settingCheckBaseState(mode, 'noResult', check);
}

/**
 * Pure (UI-SPEC 6.3.4): the title key, the buttons and what is shown for one state. input: { mode, phase, check, from, pressed,
 * failure }. Phases: checking, result, noResult, busy, saving (keeps the state it came from), saved, notSaved.
 */
function settingCheckState(input) {
  const i = input || {};
  const mode = settingCheckMode(i.mode);
  const check = i.check && typeof i.check === 'object' ? i.check : null;
  let base;
  if (i.phase === 'saving') {
    base = settingCheckBaseState(mode, i.from || 'result', check);
    base = { ...base, autoSave: false, saving: true, pressed: i.pressed };
  } else if (i.phase === 'saved') {
    const passed = i.pressed === 'save' && settingCheckOutcome(check) === 'pass';
    base = { titleKey: passed ? 'dialog.title.passedSaved' : 'dialog.title.saved', ids: ['close'], reasonField: false, autoSave: false, noteKey: null };
  } else if (i.phase === 'notSaved') {
    const pressed = SETTING_CHECK_SAVE_BUTTONS.includes(i.pressed) ? i.pressed : settingCheckModeSave(mode, check);
    const ids = i.failure === 'changed' ? ['edit', 'rerun'] : ['edit', pressed];
    base = { titleKey: 'dialog.title.notSaved', ids, reasonField: pressed === 'saveReason', autoSave: false, noteKey: null };
  } else {
    base = settingCheckBaseState(mode, i.phase, check);
  }
  const { ids, ...rest } = base;
  return { ...rest, buttons: settingCheckButtons(ids), focus: ids.includes('edit') ? 'edit' : ids[0] };
}

function settingCheckLayerLabel(layer, locale, setHash, named) {
  if (layer === 'real_set' && named && typeof setHash === 'string' && setHash) return settingCheckLabel('layer.real_set.named', locale, { hash: setHash.slice(0, 8) });
  return settingCheckLabel('layer.' + layer, locale);
}

function settingCheckLayers(check, locale) {
  const given = settingCheckList(check && check.layers).filter((l) => l && typeof l === 'object');
  const out = [];
  for (const layer of SETTING_CHECK_LAYERS) {
    const entries = given.filter((l) => l.layer === layer);
    if (entries.length === 0) {
      out.push({ layer, label: settingCheckLayerLabel(layer, locale), result: 'skipped', reason: 'no_answer', checks: [] });
      continue;
    }
    const named = entries.length > 1;
    for (const entry of entries) {
      out.push({
        layer,
        label: settingCheckLayerLabel(layer, locale, entry.set_hash, named),
        result: typeof entry.result === 'string' ? entry.result : 'error',
        reason: typeof entry.reason === 'string' && entry.reason ? entry.reason : null,
        checks: settingCheckList(entry.checks),
      });
    }
  }
  return out;
}

function settingCheckEvidence(layers, locale) {
  const g = settingCheckGates();
  const ran = layers.filter((l) => l.checks.length > 0);
  const visible = [];
  const hidden = [];
  for (const layer of ran) {
    const rows = g.gatesUiEvidenceRows(layer.checks, locale);
    const tag = (row) => (ran.length > 1 ? { ...row, layerLabel: layer.label } : row);
    visible.push(...rows.visible.map(tag));
    hidden.push(...rows.hidden.map(tag));
  }
  return { visible, hidden };
}

function settingCheckUncalItem(key, locale) {
  const parts = String(key).split('|');
  if (parts.length < 4 || !parts[1] || !parts[2]) return { text: String(key), segments: [{ code: String(key) }] };
  const g = settingCheckGates();
  return settingCheckMessage('uncal.item', locale, { model: { mono: parts[1] }, language: g.gatesUiLanguageName(parts[2], locale) });
}

function settingCheckUntestedReason(reason, locale) {
  const key = 'untested.reason.' + String(reason);
  if (typeof reason === 'string' && settingCheckGates().gatesUiTemplateFrom(SETTING_CHECK_LABELS, key, locale) !== null) return settingCheckMessage(key, locale);
  return settingCheckGates().gatesUiMessage('reason.other', locale, { code: String(reason) });
}

function settingCheckNumber(value, locale) {
  return settingCheckGates().gatesUiNumber(value, locale);
}

/** The lead sentence: why checks happen, or the explanation of the state. */
function settingCheckLead(phase, check, locale, ctx) {
  const g = settingCheckGates();
  if (phase === 'busy') {
    const since = g.gatesUiDate(ctx.runningSince, locale, 'time');
    return settingCheckMessage('busy.body', locale, { time: since ? { time: since } : '—' });
  }
  if (phase === 'noResult' || (phase === 'result' && settingCheckOutcome(check) === 'error')) return settingCheckMessage('error.body', locale);
  return settingCheckMessage('checking.body', locale);
}

/**
 * Pure (UI-SPEC 6.3.2, 6.3.5): what the dialog shows. input: { mode, phase, check, locale, changed (names of the request while the
 * check has none), labelFor(name) -> visible label or null, runningSince }. Names only: no setting value is ever read.
 */
function settingCheckDialogView(input) {
  const i = input || {};
  const locale = settingCheckGates().gatesUiLocale(i.locale);
  const check = i.check && typeof i.check === 'object' ? i.check : null;
  const state = settingCheckState(i);
  const labelFor = typeof i.labelFor === 'function' ? i.labelFor : () => null;
  const names = settingCheckList(check && check.changed_keys).length > 0 ? check.changed_keys : settingCheckList(i.changed);
  const envNames = names.filter((n) => typeof n === 'string');
  const rows = envNames.slice(0, SETTING_CHECK_CHANGED_CAP).map((env) => {
    const label = labelFor(env);
    return { label: typeof label === 'string' && label.trim() ? label.trim() : env, env };
  });
  const changed = {
    heading: settingCheckLabel('changed.heading', locale, { count: settingCheckNumber(envNames.length, locale) }),
    rows,
    more: envNames.length > SETTING_CHECK_CHANGED_CAP ? settingCheckLabel('changed.more', locale, { count: settingCheckNumber(envNames.length - SETTING_CHECK_CHANGED_CAP, locale) }) : null,
  };
  const layers = settingCheckLayers(check, locale);
  const notCoveredNames = settingCheckList(check && check.not_evaluated_on_real_set).filter((n) => typeof n === 'string');
  const untestedList = settingCheckList(check && check.not_evaluated).filter((e) => e && typeof e.key === 'string');
  const cells = settingCheckList(check && check.uncalibrated_cells).filter((k) => typeof k === 'string');
  return {
    titleKey: state.titleKey,
    title: settingCheckLabel(state.titleKey, locale),
    lead: settingCheckLead(i.phase, check, locale, i),
    changed,
    layers: layers.map((l) => ({ layer: l.layer, label: l.label, result: l.result, reason: l.reason })),
    evidence: settingCheckEvidence(layers, locale),
    notCovered: notCoveredNames.length > 0 ? settingCheckMessage('notCovered', locale, { names: notCoveredNames.join(', ') }) : null,
    untested:
      untestedList.length > 0
        ? {
            heading: settingCheckLabel('untested.heading', locale, { count: settingCheckNumber(untestedList.length, locale) }),
            body: settingCheckMessage('untested.body', locale),
            items: untestedList.map((e) => {
              const label = labelFor(e.key);
              return { label: typeof label === 'string' && label.trim() ? label.trim() : e.key, env: e.key, reason: settingCheckUntestedReason(e.reason, locale) };
            }),
          }
        : null,
    uncal:
      cells.length > 0
        ? {
            heading: settingCheckLabel('uncal.heading', locale, { count: settingCheckNumber(cells.length, locale) }),
            body: settingCheckMessage('uncal.body', locale, { command: { code: SETTING_CHECK_CALIBRATE_COMMAND } }),
            items: cells.slice(0, SETTING_CHECK_UNCAL_CAP).map((key) => settingCheckUncalItem(key, locale)),
            more: cells.length > SETTING_CHECK_UNCAL_CAP ? settingCheckLabel('uncal.more', locale, { count: settingCheckNumber(cells.length - SETTING_CHECK_UNCAL_CAP, locale) }) : null,
          }
        : null,
    modeNote: state.noteKey ? settingCheckMessage(state.noteKey, locale) : null,
  };
}

/** Pure: the reason is counted after trimming and must hold 10 to 500 characters. */
function settingCheckReason(value, locale) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const length = Array.from(trimmed).length;
  const missing = Math.max(0, SETTING_CHECK_REASON_MIN - length);
  const valid = length >= SETTING_CHECK_REASON_MIN && length <= SETTING_CHECK_REASON_MAX;
  return {
    value: trimmed,
    length,
    valid,
    missing,
    tooShort: missing > 0 ? settingCheckLabel('reason.tooShort', locale, { missing: settingCheckNumber(missing, locale) }) : null,
  };
}

/** Pure: the ragGate body of each save button (UI-SPEC 6.3.4, 8.1). */
function settingCheckSaveBody(button, ctx) {
  const c = ctx || {};
  const checkId = typeof c.checkId === 'string' && c.checkId ? c.checkId : null;
  if (button === 'saveWithout') return { skipped: true };
  if (button === 'saveReason') {
    const body = { override: { reason: typeof c.reason === 'string' ? c.reason.trim() : '' } };
    if (checkId) body.check_id = checkId;
    return body;
  }
  return checkId ? { check_id: checkId } : { skipped: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The dialog and the guard (UI-SPEC 6.3.1 to 6.3.4, 9)

const SETTING_CHECK_API = '/api/config/rag-gate/check';
const SETTING_CHECK_TIMEOUT_MS = 15000;
const SETTING_CHECK_FAST_POLL_MS = 2000;
const SETTING_CHECK_SLOW_POLL_MS = 5000;
const SETTING_CHECK_FAST_WINDOW_MS = 30000;
const SETTING_CHECK_DEADLINE_MS = 630000;
const SETTING_CHECK_MAX_POLL_FAILURES = 3;
const SETTING_CHECK_ID = 'rag-setting-check';

function settingCheckEl(tag, opts, children) {
  return settingCheckGates().gatesUiEl(tag, opts, children);
}

function settingCheckMessageEl(tag, cls, message) {
  return settingCheckGates().gatesUiMessageEl(tag, cls, message);
}

/** The mode of the last loaded or saved configuration: off, warn or enforce. Never the unsaved select. */
function settingCheckConfiguredMode(config) {
  const raw = config && typeof config === 'object' ? String(config.RAG_CONFIG_GATE || '').trim().toLowerCase() : '';
  return raw === 'warn' || raw === 'enforce' ? raw : 'off';
}

/** The body of POST /api/config/rag-gate/check for a guard request (config, prompt or models). */
function settingCheckStartBody(request, force) {
  const r = request || {};
  let body;
  if (r.kind === 'prompt') body = { kind: 'prompt', prompt: { preContext: r.preContext, postContext: r.postContext } };
  else if (r.kind === 'models') body = { kind: 'models', models: r.models };
  else body = { kind: 'config', config: r.config };
  if (force) body.force = true;
  return body;
}

function settingCheckElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

/** The visible label of the control for an env name, or null when the page has none. */
function settingCheckPageLabel(name) {
  if (typeof document === 'undefined' || typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
  const label = document.querySelector('label[for="' + name + '"]');
  const value = label && typeof label.textContent === 'string' ? label.textContent.replace(/\s+/g, ' ').trim() : '';
  return value || null;
}

function settingCheckBadgeEl(value, locale) {
  const g = settingCheckGates();
  const view = g.gatesUiVerdictView(value);
  return settingCheckEl('span', { className: 'badge badge-sm gap-1 h-auto whitespace-nowrap ' + view.classes }, [g.gatesUiIcon(view.icon), g.gatesUiLabel(view.key, locale)]);
}

/** The evidence table of the dialog: Questions and Limit move under the check below 768px; the layer is a second line. */
function settingCheckEvidenceTableEl(rows, locale) {
  const g = settingCheckGates();
  const caption = g.gatesUiLabel('checks.caption', locale);
  const th = (key, extra) => settingCheckEl('th', { className: 'text-xs font-semibold ' + (extra || ''), text: g.gatesUiLabel(key, locale), attrs: { scope: 'col' } });
  const head = settingCheckEl('tr', null, [th('col.check'), th('col.questions', 'max-md:hidden'), th('col.measured', 'text-right'), th('col.limit', 'text-right max-md:hidden'), th('col.result')]);
  const body = settingCheckEl('tbody');
  for (const row of rows) {
    const cell = settingCheckMessageEl('th', 'font-normal text-sm align-top break-words', row.checkMessage);
    cell.setAttribute('scope', 'row');
    if (row.layerLabel) cell.appendChild(settingCheckEl('span', { className: 'block text-xs text-base-content/70', text: row.layerLabel }));
    cell.appendChild(settingCheckEl('span', { className: 'block text-xs text-base-content/70 md:hidden', text: row.slice }));
    cell.appendChild(settingCheckEl('span', { className: 'block text-xs text-base-content/70 md:hidden tabular-nums', text: row.limit }));
    body.appendChild(
      settingCheckEl('tr', null, [
        cell,
        settingCheckEl('td', { className: 'text-sm align-top break-words max-md:hidden', text: row.slice }),
        settingCheckEl('td', { className: 'text-sm align-top text-right tabular-nums', text: row.measured }),
        settingCheckEl('td', { className: 'text-sm align-top text-right tabular-nums max-md:hidden', text: row.limit }),
        settingCheckEl('td', { className: 'align-top' }, [settingCheckBadgeEl(row.result, locale)]),
      ]),
    );
  }
  return settingCheckEl(
    'div',
    { className: 'overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': caption } },
    [settingCheckEl('table', { className: 'table table-sm' }, [settingCheckEl('caption', { className: 'sr-only', text: caption }), settingCheckEl('thead', null, [head]), body])],
  );
}

function settingCheckNoticeEl(heading, body, items) {
  const g = settingCheckGates();
  return settingCheckEl('div', { className: 'alert alert-warning items-start justify-items-start text-left mt-4' }, [
    g.gatesUiIcon('bi-exclamation-triangle', 'mt-0.5'),
    settingCheckEl('div', { className: 'flex flex-col gap-1 min-w-0 max-w-prose' }, [
      settingCheckEl('p', { className: 'text-sm font-semibold', text: heading }),
      settingCheckMessageEl('p', 'text-sm', body),
      settingCheckEl('ul', { className: 'text-xs flex flex-col gap-1' }, items),
    ]),
  ]);
}

/**
 * The guard behind window.ragSettingCheck. deps: { fetch, savedConfig() (the last loaded or saved configuration), locale, showToast,
 * labelFor(name) }. One dialog at a time; the dialog never posts a save, it resolves the caller's decision.
 */
function settingCheckCreateGuard(deps) {
  const d = deps || {};
  const g = () => settingCheckGates();
  const locale = () => g().gatesUiLocale(d.locale);
  const fetcher = (url, init) => (typeof d.fetch === 'function' ? d.fetch(url, init) : window.fetch(url, init));
  const savedConfig = () => {
    if (typeof d.savedConfig === 'function') return d.savedConfig();
    return typeof window !== 'undefined' && window.configManager ? window.configManager.savedConfig || null : null;
  };
  const labelFor = typeof d.labelFor === 'function' ? d.labelFor : settingCheckPageLabel;
  const toast = (message, type) => {
    if (typeof d.showToast === 'function') d.showToast(message, type);
    else if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast(message, type);
  };

  let run = null;

  async function call(url, init) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 0, body: null }), SETTING_CHECK_TIMEOUT_MS);
    });
    const request = (async () => {
      try {
        const response = await fetcher(url, {
          method: init.method,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-config-ui': '1' },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        });
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { status: response.status, body };
      } catch {
        return { status: 0, body: null };
      }
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function stopTimers() {
    if (!run) return;
    if (run.pollTimer !== null) clearTimeout(run.pollTimer);
    if (run.tickTimer !== null) clearInterval(run.tickTimer);
    run.pollTimer = null;
    run.tickTimer = null;
  }

  function settle(decision) {
    if (!run || !run.resolve) return;
    const resolve = run.resolve;
    run.resolve = null;
    resolve(decision);
  }

  function announce(message) {
    if (run && run.status) run.status.textContent = message;
  }

  function close(held) {
    if (!run) return;
    const current = run;
    stopTimers();
    settle({ proceed: false });
    run = null;
    if (current.dialog.open) current.dialog.close();
    current.dialog.remove();
    const fallback = typeof document !== 'undefined' ? document.querySelector('[data-action="save-config"]') : null;
    const target = current.opener && current.opener.isConnected !== false ? current.opener : fallback;
    if (target && typeof target.focus === 'function') target.focus();
    if (held) toast(settingCheckLabel('outcome.held', current.locale), 'info');
  }

  function stateInput() {
    return { mode: run.mode, phase: run.phase, check: run.check, from: run.from, pressed: run.pressed, failure: run.failure };
  }

  function reasonInfo() {
    return settingCheckReason(run.reasonArea ? run.reasonArea.value : '', run.locale);
  }

  function updateReason() {
    if (!run || !run.reasonArea) return;
    const info = reasonInfo();
    run.reasonCount.textContent = settingCheckLabel('reason.count', run.locale, { count: g().gatesUiNumber(info.length, run.locale) });
    const showShort = run.touched && !info.valid;
    run.reasonShort.textContent = showShort ? info.tooShort || settingCheckLabel('reason.help', run.locale) : '';
    run.reasonShort.classList.toggle('hidden', !showShort);
    if (showShort) run.reasonArea.setAttribute('aria-invalid', 'true');
    else run.reasonArea.removeAttribute('aria-invalid');
    if (showShort && !run.shortAnnounced) {
      run.shortAnnounced = true;
      announce(run.reasonShort.textContent);
    }
    if (info.valid) run.shortAnnounced = false;
    const button = run.buttons && run.buttons.saveReason;
    if (button && !run.saving) {
      button.disabled = !info.valid;
      if (info.valid) button.removeAttribute('disabled');
      else button.setAttribute('disabled', '');
    }
  }

  function ensureReasonField() {
    if (run.reasonField) return run.reasonField;
    const id = SETTING_CHECK_ID + '-reason';
    run.reasonArea = settingCheckEl('textarea', {
      className: 'textarea textarea-bordered textarea-sm w-full max-w-full',
      attrs: {
        id,
        name: 'rag-gate-reason',
        rows: '3',
        required: true,
        minlength: String(SETTING_CHECK_REASON_MIN),
        maxlength: String(SETTING_CHECK_REASON_MAX),
        autocomplete: 'off',
        spellcheck: 'true',
        'aria-describedby': id + '-help ' + id + '-short',
      },
      on: {
        input: () => {
          if (!run) return;
          run.touched = true;
          updateReason();
        },
        blur: () => {
          if (!run) return;
          run.touched = true;
          updateReason();
        },
      },
    });
    run.reasonCount = settingCheckEl('p', { className: 'text-xs tabular-nums text-right text-base-content/70', attrs: { 'aria-live': 'off' } });
    run.reasonShort = settingCheckEl('p', { className: 'text-xs text-warning hidden', attrs: { id: id + '-short' } });
    run.reasonField = settingCheckEl('div', { className: 'form-control mt-4 gap-1' }, [
      settingCheckEl('label', { className: 'text-sm', text: settingCheckLabel('reason.label', run.locale), attrs: { for: id } }),
      run.reasonArea,
      settingCheckEl('p', { className: 'text-xs text-base-content/70 max-w-prose', text: settingCheckLabel('reason.help', run.locale), attrs: { id: id + '-help' } }),
      run.reasonCount,
      run.reasonShort,
    ]);
    return run.reasonField;
  }

  function sectionHeading(text) {
    return settingCheckEl('h4', { className: 'text-sm font-semibold mt-4', text });
  }

  function render(moveFocus) {
    if (!run) return;
    const locale = run.locale;
    const state = settingCheckState(stateInput());
    const view = settingCheckDialogView({ ...stateInput(), locale, changed: run.request.changed, labelFor, runningSince: run.runningSince });
    run.saving = Boolean(state.saving);
    const box = run.box;
    const keepFocus = run.reasonArea && typeof document !== 'undefined' && document.activeElement === run.reasonArea;
    box.replaceChildren();
    run.title = settingCheckEl('h3', { className: 'text-base font-semibold text-balance', text: view.title, attrs: { id: SETTING_CHECK_ID + '-title', tabindex: '-1' } });
    box.appendChild(run.title);
    if (run.check && run.check.cached === true && ['result', 'saving', 'noResult'].includes(run.phase)) {
      const at = g().gatesUiDate(run.check.finished_at || run.check.started_at, locale, 'time');
      box.appendChild(settingCheckMessageEl('p', 'text-xs text-base-content/70 mt-1', settingCheckMessage('checking.cached', locale, { time: at ? { time: at } : '—' })));
    }
    const lead = settingCheckMessageEl('p', 'text-sm mt-2 max-w-prose', view.lead);
    lead.setAttribute('id', SETTING_CHECK_ID + '-lead');
    box.appendChild(lead);

    if (view.changed.rows.length > 0) {
      box.appendChild(sectionHeading(view.changed.heading));
      const list = settingCheckEl('dl', { className: 'grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 mt-1 text-sm' });
      for (const row of view.changed.rows) {
        list.appendChild(settingCheckEl('dt', { className: 'min-w-0 break-words', text: row.label }));
        list.appendChild(settingCheckEl('dd', { className: 'min-w-0' }, [settingCheckEl('code', { className: 'font-mono text-xs break-all', text: row.env, attrs: { translate: 'no' } })]));
      }
      box.appendChild(list);
      if (view.changed.more) box.appendChild(settingCheckEl('p', { className: 'text-xs text-base-content/70 mt-1', text: view.changed.more }));
    }

    const checking = run.phase === 'checking' || (run.phase === 'saving' && run.from === 'checking');
    const showResult = run.check && run.check.status === 'done' && !checking && run.phase !== 'busy';
    if (checking) {
      box.appendChild(settingCheckEl('progress', { className: 'progress progress-primary w-full mt-4 motion-reduce:hidden', attrs: { 'aria-label': settingCheckLabel('checking.barLabel', locale) } }));
      const stage = run.check && typeof run.check.stage === 'string' && SETTING_CHECK_LAYERS.includes(run.check.stage) ? run.check.stage : null;
      if (stage) box.appendChild(settingCheckEl('p', { className: 'text-sm mt-2', text: settingCheckLabel('checking.stage', locale, { layer: g().gatesUiLabel('layer.' + stage, locale) }) }));
      run.elapsedEl = settingCheckEl('p', { className: 'text-sm tabular-nums text-base-content/70 mt-1', attrs: { 'aria-hidden': 'true' } });
      run.elapsedEl.textContent = settingCheckLabel('checking.elapsed', locale, { time: settingCheckElapsed(Date.now() - run.startedAt) });
      box.appendChild(run.elapsedEl);
    } else {
      run.elapsedEl = null;
    }
    if (run.phase === 'noResult' || (showResult && settingCheckOutcome(run.check) === 'error')) {
      const reason = (run.check && typeof run.check.error_reason === 'string' && run.check.error_reason) || run.errorReason || 'no_answer';
      box.appendChild(settingCheckEl('div', { className: 'mt-4' }, [g().gatesUiVerdict('error', locale, reason)]));
    }
    if (showResult && run.phase !== 'saved') {
      box.appendChild(sectionHeading(settingCheckLabel('result.heading', locale)));
      const list = settingCheckEl('ul', { className: 'flex flex-col gap-2 mt-1' });
      for (const layer of view.layers) {
        list.appendChild(
          settingCheckEl('li', { className: 'flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm' }, [
            settingCheckEl('span', { className: 'min-w-0 break-words', text: layer.label }),
            g().gatesUiVerdict(layer.result, locale, layer.reason),
          ]),
        );
      }
      box.appendChild(list);
      if (view.evidence.visible.length > 0) {
        box.appendChild(sectionHeading(settingCheckLabel('failed.heading', locale)));
        box.appendChild(settingCheckEl('div', { className: 'mt-1' }, [settingCheckEvidenceTableEl(view.evidence.visible, locale)]));
      }
      if (view.evidence.hidden.length > 0) {
        box.appendChild(
          settingCheckEl('details', { className: 'mt-2' }, [
            settingCheckEl('summary', {
              className: 'text-sm cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
              text: g().gatesUiLabel('checks.showAll', locale, { count: g().gatesUiNumber(view.evidence.hidden.length, locale) }),
            }),
            settingCheckEvidenceTableEl(view.evidence.hidden, locale),
          ]),
        );
      }
      if (view.notCovered) box.appendChild(settingCheckMessageEl('p', 'text-xs text-base-content/70 mt-2 break-words', view.notCovered));
    }
    if (showResult && run.phase !== 'saved' && view.untested) {
      box.appendChild(
        settingCheckNoticeEl(
          view.untested.heading,
          view.untested.body,
          view.untested.items.map((item) => {
            const li = settingCheckEl('li', { className: 'break-words' }, [
              item.label + ' ',
              settingCheckEl('code', { className: 'font-mono text-xs break-all', text: item.env, attrs: { translate: 'no' } }),
              ': ',
            ]);
            settingCheckGates().gatesUiAppendMessage(li, item.reason);
            return li;
          }),
        ),
      );
    }
    if (showResult && run.phase !== 'saved' && view.uncal) {
      const items = view.uncal.items.map((item) => settingCheckMessageEl('li', 'break-words', item));
      if (view.uncal.more) items.push(settingCheckEl('li', { text: view.uncal.more }));
      box.appendChild(settingCheckNoticeEl(view.uncal.heading, view.uncal.body, items));
    }
    if (run.phase === 'saved' && run.outcome) {
      box.appendChild(settingCheckMessageEl('p', 'text-sm mt-4 max-w-prose', run.outcome));
    }
    if (run.phase === 'notSaved' && run.failureMessage) {
      const failure = settingCheckMessageEl('p', 'text-sm text-error mt-4 max-w-prose', run.failureMessage);
      failure.setAttribute('role', 'alert');
      box.appendChild(failure);
    }
    if (state.reasonField) {
      box.appendChild(ensureReasonField());
    } else if (run.reasonField && run.phase === 'saved') {
      run.reasonField = null;
      run.reasonArea = null;
    }
    if (view.modeNote && run.phase !== 'saved' && run.phase !== 'notSaved') box.appendChild(settingCheckMessageEl('p', 'text-xs text-base-content/70 mt-4 max-w-prose', view.modeNote));
    box.appendChild(run.status);

    run.buttons = {};
    const actions = settingCheckEl('div', { className: 'modal-action flex-wrap gap-2 max-md:flex-col max-md:items-stretch' });
    for (const spec of state.buttons) {
      const pressed = state.saving && spec.id === state.pressed;
      const children = pressed ? [g().gatesUiSpinner(), settingCheckLabel('saving', locale)] : [settingCheckLabel(spec.labelKey, locale)];
      const attrs = { type: 'button' };
      if (spec.id === 'saveReason') attrs['aria-describedby'] = SETTING_CHECK_ID + '-reason-short';
      const button = settingCheckEl('button', { className: spec.className + ' max-md:w-full', attrs, on: { click: () => onButton(spec.id) } }, children);
      if (state.saving) {
        button.disabled = true;
        button.setAttribute('disabled', '');
      }
      run.buttons[spec.id] = button;
      actions.appendChild(button);
    }
    box.appendChild(actions);
    if (run.reasonArea) {
      run.reasonArea.disabled = Boolean(state.saving);
      if (state.saving) run.reasonArea.setAttribute('disabled', '');
      else run.reasonArea.removeAttribute('disabled');
      updateReason();
    }
    if (keepFocus) return;
    if (moveFocus === 'default') {
      const target = run.buttons[state.focus];
      if (target) target.focus();
    } else if (moveFocus !== false) {
      run.title.focus();
    }
  }

  function setPhase(phase, extra) {
    if (!run) return;
    Object.assign(run, extra || {});
    run.phase = phase;
    render(true);
    if (phase !== 'saving') announce(run.title.textContent);
    if (phase === 'result' && settingCheckState(stateInput()).autoSave) decide('save');
  }

  function decide(id) {
    if (!run) return;
    const info = run.reasonArea ? reasonInfo() : null;
    if (id === 'saveReason' && (!info || !info.valid)) {
      run.touched = true;
      updateReason();
      return;
    }
    const from = run.phase === 'notSaved' ? run.from || 'result' : run.phase;
    const gate = settingCheckSaveBody(id, { checkId: run.check && run.check.check_id, reason: info ? info.value : '' });
    stopTimers();
    run.from = from === 'saving' ? run.from : from;
    run.pressed = id;
    run.phase = 'saving';
    render(false);
    announce(settingCheckLabel('saving', run.locale));
    settle({ proceed: true, gate });
  }

  function onButton(id) {
    if (!run || run.saving) return;
    if (id === 'edit') return close(true);
    if (id === 'close') return close(false);
    if (id === 'rerun') return startCheck(true);
    return decide(id);
  }

  function schedulePoll() {
    if (!run) return;
    const elapsed = Date.now() - run.startedAt;
    const wait = elapsed < SETTING_CHECK_FAST_WINDOW_MS ? SETTING_CHECK_FAST_POLL_MS : SETTING_CHECK_SLOW_POLL_MS;
    run.pollTimer = setTimeout(() => {
      if (run) run.pollTimer = null;
      void poll();
    }, wait);
  }

  function giveUp(reason) {
    stopTimers();
    setPhase('noResult', { errorReason: reason || 'no_answer', check: run.check && run.check.status === 'done' ? run.check : null });
  }

  async function poll() {
    if (!run || run.phase !== 'checking') return;
    const token = run.token;
    if (Date.now() - run.startedAt >= SETTING_CHECK_DEADLINE_MS) return giveUp('no_answer');
    const answer = await call(SETTING_CHECK_API + '/' + encodeURIComponent(run.checkId), { method: 'GET' });
    if (!run || run.token !== token || run.phase !== 'checking') return;
    if (answer.status === 200 && answer.body && typeof answer.body === 'object' && answer.body.check_id) {
      run.pollFailures = 0;
      const previousStage = run.check ? run.check.stage : null;
      run.check = answer.body;
      if (answer.body.status === 'done') {
        stopTimers();
        return setPhase('result');
      }
      if (answer.body.started_at) {
        const started = Date.parse(answer.body.started_at);
        if (Number.isFinite(started) && started < run.startedAt) run.startedAt = started;
      }
      render(false);
      if (answer.body.stage && answer.body.stage !== previousStage && SETTING_CHECK_LAYERS.includes(answer.body.stage)) {
        announce(settingCheckLabel('checking.stage', run.locale, { layer: g().gatesUiLabel('layer.' + answer.body.stage, run.locale) }));
      }
    } else if (answer.status === 404) {
      return giveUp('no_answer');
    } else {
      run.pollFailures += 1;
      if (run.pollFailures >= SETTING_CHECK_MAX_POLL_FAILURES) return giveUp('no_answer');
    }
    if (Date.now() - run.startedAt >= SETTING_CHECK_DEADLINE_MS) return giveUp('no_answer');
    schedulePoll();
  }

  function tick() {
    if (!run || !run.elapsedEl) return;
    const elapsed = Date.now() - run.startedAt;
    run.elapsedEl.textContent = settingCheckLabel('checking.elapsed', run.locale, { time: settingCheckElapsed(elapsed) });
    const minutes = Math.floor(elapsed / 60000);
    if (minutes > run.announcedMinute) {
      run.announcedMinute = minutes;
      announce(settingCheckLabel('checking.elapsed', run.locale, { time: settingCheckElapsed(elapsed) }));
    }
    if (elapsed >= SETTING_CHECK_DEADLINE_MS && run.phase === 'checking') giveUp('no_answer');
  }

  async function startCheck(force) {
    if (!run) return;
    stopTimers();
    run.token += 1;
    const token = run.token;
    run.check = null;
    run.failure = null;
    run.failureMessage = null;
    run.errorReason = null;
    run.pollFailures = 0;
    run.startedAt = Date.now();
    run.announcedMinute = 0;
    run.phase = 'checking';
    run.from = null;
    run.pressed = null;
    if (force) render(true);
    const answer = await call(SETTING_CHECK_API, { method: 'POST', body: settingCheckStartBody(run.request, force) });
    if (!run || run.token !== token) return;
    const body = answer.body && typeof answer.body === 'object' ? answer.body : {};
    if (answer.status === 200 && body.required === false) {
      const current = run;
      settle({ proceed: true });
      run = null;
      current.dialog.remove();
      return;
    }
    if (typeof body.mode === 'string' && (body.mode === 'warn' || body.mode === 'enforce')) run.mode = body.mode;
    if ((answer.status === 200 || answer.status === 202) && body.check_id && body.status === 'done') {
      run.check = body;
      return setPhase('result');
    }
    if (answer.status === 202 && body.check_id) {
      run.checkId = body.check_id;
      run.check = { check_id: body.check_id, status: 'queued' };
      setPhase('checking');
      run.tickTimer = setInterval(tick, 1000);
      schedulePoll();
      return;
    }
    if (answer.status === 409 && body.error === 'rag_gate_busy') {
      return setPhase('busy', { runningSince: typeof body.running_since === 'string' ? body.running_since : null });
    }
    return setPhase('noResult', { errorReason: 'no_answer' });
  }

  function open(request, mode, forced) {
    const loc = locale();
    const status = settingCheckEl('div', { className: 'text-sm mt-4', attrs: { role: 'status', 'aria-live': 'polite' } });
    const box = settingCheckEl('div', { className: 'modal-box w-11/12 max-w-2xl overscroll-contain' });
    const dialog = settingCheckEl('dialog', {
      className: 'modal',
      attrs: { id: SETTING_CHECK_ID, 'aria-labelledby': SETTING_CHECK_ID + '-title', 'aria-describedby': SETTING_CHECK_ID + '-lead', lang: loc },
    }, [box]);
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    return new Promise((resolve) => {
      run = {
        request,
        mode,
        forced,
        locale: loc,
        dialog,
        box,
        status,
        opener,
        resolve,
        check: null,
        checkId: null,
        phase: 'starting',
        from: null,
        pressed: null,
        failure: null,
        failureMessage: null,
        outcome: null,
        errorReason: null,
        runningSince: null,
        startedAt: Date.now(),
        announcedMinute: 0,
        pollFailures: 0,
        pollTimer: null,
        tickTimer: null,
        token: 0,
        saving: false,
        touched: false,
        shortAnnounced: false,
        reasonField: null,
        reasonArea: null,
        buttons: {},
        opened: false,
      };
      dialog.addEventListener('cancel', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!run || run.dialog !== dialog || run.saving) return;
        if (settingCheckState(stateInput()).buttons.some((b) => b.id === 'edit')) close(true);
        else close(false);
      });
      const show = () => {
        if (!run || run.opened) return;
        run.opened = true;
        document.body.appendChild(dialog);
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      };
      void startCheck(false).then(() => {
        if (run && run.dialog === dialog && !run.opened) {
          show();
          const state = settingCheckState(stateInput());
          const target = run.buttons[state.focus];
          if (target) target.focus();
        }
      });
    });
  }

  function beforeSave(request) {
    if (run) return Promise.resolve({ proceed: false, ignored: true });
    const mode = settingCheckConfiguredMode(savedConfig());
    if (mode === 'off') return Promise.resolve({ proceed: true });
    const r = request && typeof request === 'object' ? request : {};
    if (Array.isArray(r.changed) && r.changed.length === 0) return Promise.resolve({ proceed: true });
    return open(r, mode, false);
  }

  function required(request) {
    if (run) return Promise.resolve({ proceed: false, ignored: true });
    const mode = settingCheckConfiguredMode(savedConfig());
    return open(request && typeof request === 'object' ? request : {}, mode === 'warn' ? 'warn' : 'enforce', true);
  }

  function saved(body) {
    if (!run) return;
    const record = body && typeof body === 'object' && body.ragGate && typeof body.ragGate.record_id === 'string' ? body.ragGate.record_id : null;
    const key = run.pressed === 'saveReason' ? 'outcome.savedOverride' : run.pressed === 'saveAnyway' ? 'outcome.savedWarn' : run.pressed === 'saveWithout' ? 'outcome.savedSkipped' : null;
    const outcome = key && record ? settingCheckMessage(key, run.locale, { id: { mono: record } }) : null;
    if (run.reasonArea) run.reasonArea.value = '';
    run.reasonField = null;
    run.reasonArea = null;
    setPhase('saved', { outcome });
    const target = run && run.buttons.close;
    if (target) target.focus();
  }

  function saveFailed(status, body) {
    if (!run) return Promise.resolve({ proceed: false });
    const error = body && typeof body === 'object' ? body.error : null;
    let failure = 'other';
    let message = settingCheckMessage('error.saveFailed', run.locale, { status: String(status || '?') });
    if (status === 409 && error === 'rag_gate_required') {
      failure = 'changed';
      message = settingCheckMessage('error.changed', run.locale);
    } else if (status === 503 && error === 'rag_gate_record_failed') {
      failure = 'recordFailed';
      message = settingCheckMessage('error.recordFailed', run.locale);
    }
    return new Promise((resolve) => {
      run.resolve = resolve;
      if (status === 400 && error === 'invalid_reason' && run.pressed === 'saveReason') {
        run.touched = true;
        setPhase(run.from || 'result', { pressed: null });
        updateReason();
        return;
      }
      setPhase('notSaved', { failure, failureMessage: message });
    });
  }

  return { beforeSave, required, saved, saveFailed, isOpen: () => run !== null };
}

if (typeof window !== 'undefined') {
  window.SETTING_CHECK_LABELS = SETTING_CHECK_LABELS;
  window.settingCheckLabel = settingCheckLabel;
  window.ragSettingCheck = settingCheckCreateGuard({});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTING_CHECK_LABELS,
    SETTING_CHECK_LAYERS,
    settingCheckLabel,
    settingCheckState,
    settingCheckDialogView,
    settingCheckReason,
    settingCheckSaveBody,
    settingCheckCreateGuard,
  };
}
