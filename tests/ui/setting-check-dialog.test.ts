import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type Button = { id: string; labelKey: string; className: string };
type State = {
  titleKey: string;
  buttons: Button[];
  reasonField: boolean;
  autoSave: boolean;
  noteKey: string | null;
  focus: string;
  saving?: boolean;
  pressed?: string;
};
type Message = { key: string; text: string; segments: Array<Record<string, unknown>> };

interface SettingCheck {
  SETTING_CHECK_LABELS: Record<Locale, Record<string, string>>;
  settingCheckLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
  settingCheckState: (input: Record<string, unknown>) => State;
  settingCheckDialogView: (input: Record<string, unknown>) => {
    titleKey: string;
    title: string;
    lead: Message;
    changed: { heading: string; rows: Array<{ label: string; env: string }>; more: string | null };
    layers: Array<{ layer: string; label: string; result: string; reason: string | null }>;
    evidence: { visible: Array<Record<string, unknown>>; hidden: Array<Record<string, unknown>> };
    notCovered: Message | null;
    untested: { heading: string; body: Message; items: Array<{ label: string; env: string; reason: Message }> } | null;
    uncal: { heading: string; body: Message; items: Array<{ text: string; segments: Array<Record<string, unknown>> }>; more: string | null } | null;
    modeNote: Message | null;
  };
  settingCheckReason: (value: unknown, locale: Locale) => { value: string; length: number; valid: boolean; missing: number; tooShort: string | null };
  settingCheckSaveBody: (button: string, ctx: { checkId?: string | null; reason?: string }) => Record<string, unknown>;
}

function load(): SettingCheck {
  return require('../../scripts/config-ui/rag-panels/setting-check.js') as SettingCheck;
}

const CHECK_ID = '00000000-0000-4000-8000-000000000001';

function check(extra: Record<string, unknown> = {}) {
  return {
    check_id: CHECK_ID,
    status: 'done',
    mode: 'enforce',
    changed_keys: ['RAG_EXAMPLE_SETTING'],
    result: 'pass',
    error_reason: null,
    layers: [
      { layer: 'deterministic', result: 'pass', checks: [{ check: 'false_answer_rate', slice: 'overall', measured: 0.01, limit: 0.05, limit_kind: 'max', result: 'passed' }] },
      { layer: 'live', result: 'skipped', reason: 'live_off', checks: [] },
      { layer: 'real_set', result: 'skipped', reason: 'no_real_set', checks: [] },
    ],
    not_evaluated: [],
    not_evaluated_on_real_set: [],
    uncalibrated_cells: [],
    ...extra,
  };
}

const ids = (state: State) => state.buttons.map((b) => b.id);

describe('SETTING_CHECK_LABELS', () => {
  it('has the same keys in en, zh and it, each non-empty', () => {
    const { SETTING_CHECK_LABELS } = load();
    const en = Object.keys(SETTING_CHECK_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(60);
    for (const locale of ['zh', 'it'] as const) expect(Object.keys(SETTING_CHECK_LABELS[locale]).sort()).toEqual(en);
    for (const locale of ['en', 'zh', 'it'] as const) for (const key of en) expect(SETTING_CHECK_LABELS[locale][key], `${locale} ${key}`).not.toBe('');
  });

  it('keeps every placeholder of the English string in zh and it', () => {
    const { SETTING_CHECK_LABELS } = load();
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(SETTING_CHECK_LABELS.en)) {
      for (const locale of ['zh', 'it'] as const) expect(vars(SETTING_CHECK_LABELS[locale][key]!), `${locale} ${key}`).toEqual(vars(SETTING_CHECK_LABELS.en[key]!));
    }
  });
});

describe('settingCheckState (UI-SPEC 6.3.4)', () => {
  it('checking in enforce has only Edit settings; in warn it adds Save settings without result', () => {
    const { settingCheckState } = load();
    const enforce = settingCheckState({ mode: 'enforce', phase: 'checking', check: null });
    expect(enforce.titleKey).toBe('dialog.title.checking');
    expect(ids(enforce)).toEqual(['edit']);
    const warn = settingCheckState({ mode: 'warn', phase: 'checking', check: null });
    expect(ids(warn)).toEqual(['edit', 'saveWithout']);
    expect(warn.noteKey).toBe('failed.warnNote');
    expect(warn.buttons[1]!.className).toBe('btn btn-warning');
  });

  it('a pass without a notice is saved at once and ends on Close check', () => {
    const { settingCheckState } = load();
    const state = settingCheckState({ mode: 'enforce', phase: 'result', check: check() });
    expect(state.autoSave).toBe(true);
    expect(state.titleKey).toBe('dialog.title.passedSaved');
    expect(ids(state)).toEqual(['close']);
    expect(state.focus).toBe('close');
  });

  it('a pass with an untested setting or uncalibrated cells waits for Save settings', () => {
    const { settingCheckState } = load();
    for (const extra of [
      { not_evaluated: [{ key: 'RAG_EXAMPLE_SETTING', reason: 'fixture_generator' }] },
      { uncalibrated_cells: ['provider-a|model-a|en|same'] },
    ]) {
      const state = settingCheckState({ mode: 'enforce', phase: 'result', check: check(extra) });
      expect(state.autoSave).toBe(false);
      expect(state.titleKey).toBe('dialog.title.passed');
      expect(ids(state)).toEqual(['edit', 'save']);
      expect(state.buttons[1]!.className).toBe('btn btn-primary');
      expect(state.reasonField).toBe(false);
    }
  });

  it('failed in warn offers Save settings anyway; in enforce the reason field and Save settings with reason', () => {
    const { settingCheckState } = load();
    const warn = settingCheckState({ mode: 'warn', phase: 'result', check: check({ result: 'fail', mode: 'warn' }) });
    expect(warn.titleKey).toBe('dialog.title.failed');
    expect(ids(warn)).toEqual(['edit', 'saveAnyway']);
    expect(warn.reasonField).toBe(false);
    expect(warn.noteKey).toBe('failed.warnNote');
    const enforce = settingCheckState({ mode: 'enforce', phase: 'result', check: check({ result: 'fail' }) });
    expect(ids(enforce)).toEqual(['edit', 'saveReason']);
    expect(enforce.reasonField).toBe(true);
    expect(enforce.noteKey).toBe('failed.enforceNote');
    expect(enforce.focus).toBe('edit');
  });

  it('No result and an unknown result offer Run check again and the mode save button', () => {
    const { settingCheckState } = load();
    for (const result of ['error', 'something_new', undefined]) {
      const enforce = settingCheckState({ mode: 'enforce', phase: 'result', check: check({ result, error_reason: 'timeout' }) });
      expect(enforce.titleKey).toBe('dialog.title.error');
      expect(ids(enforce)).toEqual(['edit', 'rerun', 'saveReason']);
      expect(enforce.reasonField).toBe(true);
      expect(enforce.autoSave).toBe(false);
    }
    const warn = settingCheckState({ mode: 'warn', phase: 'noResult', check: null });
    expect(ids(warn)).toEqual(['edit', 'rerun', 'saveWithout']);
    const warnWithId = settingCheckState({ mode: 'warn', phase: 'result', check: check({ result: 'error' }) });
    expect(ids(warnWithId)).toEqual(['edit', 'rerun', 'saveAnyway']);
  });

  it('Busy offers Run check again and the mode save button', () => {
    const { settingCheckState } = load();
    expect(ids(settingCheckState({ mode: 'warn', phase: 'busy', check: null }))).toEqual(['edit', 'rerun', 'saveWithout']);
    const enforce = settingCheckState({ mode: 'enforce', phase: 'busy', check: null });
    expect(enforce.titleKey).toBe('dialog.title.busy');
    expect(ids(enforce)).toEqual(['edit', 'rerun', 'saveReason']);
    expect(enforce.reasonField).toBe(true);
  });

  it('Saving keeps the buttons of the state it came from and marks the pressed one', () => {
    const { settingCheckState } = load();
    const state = settingCheckState({ mode: 'enforce', phase: 'saving', from: 'result', pressed: 'saveReason', check: check({ result: 'fail' }) });
    expect(state.saving).toBe(true);
    expect(state.pressed).toBe('saveReason');
    expect(ids(state)).toEqual(['edit', 'saveReason']);
    expect(state.titleKey).toBe('dialog.title.failed');
  });

  it('Saved and Not saved', () => {
    const { settingCheckState } = load();
    expect(settingCheckState({ mode: 'enforce', phase: 'saved', pressed: 'save', check: check() }).titleKey).toBe('dialog.title.passedSaved');
    const saved = settingCheckState({ mode: 'enforce', phase: 'saved', pressed: 'saveReason', check: check({ result: 'fail' }) });
    expect(saved.titleKey).toBe('dialog.title.saved');
    expect(ids(saved)).toEqual(['close']);
    const changed = settingCheckState({ mode: 'enforce', phase: 'notSaved', failure: 'changed', pressed: 'saveReason', check: check({ result: 'fail' }) });
    expect(changed.titleKey).toBe('dialog.title.notSaved');
    expect(ids(changed)).toEqual(['edit', 'rerun']);
    const record = settingCheckState({ mode: 'enforce', phase: 'notSaved', failure: 'recordFailed', pressed: 'saveReason', check: check({ result: 'fail' }) });
    expect(ids(record)).toEqual(['edit', 'saveReason']);
    expect(record.reasonField).toBe(true);
    const other = settingCheckState({ mode: 'warn', phase: 'notSaved', failure: 'other', pressed: 'saveAnyway', check: check({ result: 'fail' }) });
    expect(ids(other)).toEqual(['edit', 'saveAnyway']);
  });

  it('the three saves without a passed check are btn-warning, never primary', () => {
    const { settingCheckState } = load();
    const all = [
      settingCheckState({ mode: 'warn', phase: 'checking', check: null }),
      settingCheckState({ mode: 'warn', phase: 'result', check: check({ result: 'fail' }) }),
      settingCheckState({ mode: 'enforce', phase: 'result', check: check({ result: 'fail' }) }),
    ].flatMap((s) => s.buttons);
    for (const button of all.filter((b) => ['saveWithout', 'saveAnyway', 'saveReason'].includes(b.id))) expect(button.className).toBe('btn btn-warning');
    expect(all.find((b) => b.id === 'edit')!.className).toBe('btn');
  });
});

describe('settingCheckDialogView (UI-SPEC 6.3.2, 6.3.5)', () => {
  it('lists the three layers in order; a missing layer is Skipped with no_answer', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({
      mode: 'enforce',
      phase: 'result',
      locale: 'en',
      check: check({ layers: [{ layer: 'live', result: 'skipped', reason: 'live_off', checks: [] }] }),
    });
    expect(view.layers.map((l) => l.layer)).toEqual(['deterministic', 'live', 'real_set']);
    expect(view.layers[0]).toMatchObject({ result: 'skipped', reason: 'no_answer', label: 'Built-in test questions' });
    expect(view.layers[2]).toMatchObject({ result: 'skipped', reason: 'no_answer' });
    expect(view.layers[1]).toMatchObject({ result: 'skipped', reason: 'live_off' });
  });

  it('names several workspace test sets by the first 8 characters of their hash', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({
      mode: 'enforce',
      phase: 'result',
      locale: 'en',
      check: check({
        layers: [
          { layer: 'deterministic', result: 'pass', checks: [] },
          { layer: 'live', result: 'skipped', reason: 'live_off', checks: [] },
          { layer: 'real_set', result: 'pass', set_hash: 'abcdef0123456789', checks: [] },
          { layer: 'real_set', result: 'fail', set_hash: '0123456789abcdef', checks: [] },
        ],
      }),
    });
    expect(view.layers.map((l) => l.label)).toEqual(['Built-in test questions', 'Live model', 'Workspace test set abcdef01', 'Workspace test set 01234567']);
  });

  it('caps changed settings at 12 rows plus changed.more, with labels from labelFor and env names', () => {
    const { settingCheckDialogView } = load();
    const keys = Array.from({ length: 15 }, (_, i) => `RAG_EXAMPLE_SETTING_${i + 1}`);
    const view = settingCheckDialogView({
      mode: 'enforce',
      phase: 'result',
      locale: 'en',
      check: check({ changed_keys: keys }),
      labelFor: (name: string) => (name === 'RAG_EXAMPLE_SETTING_1' ? 'Example setting' : null),
    });
    expect(view.changed.heading).toBe('Changed settings: 15');
    expect(view.changed.rows).toHaveLength(12);
    expect(view.changed.rows[0]).toEqual({ label: 'Example setting', env: 'RAG_EXAMPLE_SETTING_1' });
    expect(view.changed.rows[1]).toEqual({ label: 'RAG_EXAMPLE_SETTING_2', env: 'RAG_EXAMPLE_SETTING_2' });
    expect(view.changed.more).toBe('And others: 3');
  });

  it('uses the request names while the check has none yet', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({ mode: 'enforce', phase: 'checking', locale: 'en', check: null, changed: ['RAG_EXAMPLE_SETTING'] });
    expect(view.changed.rows.map((r) => r.env)).toEqual(['RAG_EXAMPLE_SETTING']);
    expect(view.lead.text).toContain('fixed set of test questions');
  });

  it('caps uncalibrated cells at 6 plus uncal.more; a key that does not parse is shown whole in code', () => {
    const { settingCheckDialogView } = load();
    const cells = ['bad-key', ...Array.from({ length: 7 }, (_, i) => `provider-a|model-${i}|en|same`)];
    const view = settingCheckDialogView({ mode: 'enforce', phase: 'result', locale: 'en', check: check({ uncalibrated_cells: cells }) });
    expect(view.uncal!.heading).toBe('Refusal thresholds that stop applying: 8');
    expect(view.uncal!.items).toHaveLength(6);
    expect(view.uncal!.items[0]!.segments).toEqual([{ code: 'bad-key' }]);
    expect(view.uncal!.items[1]!.segments[0]).toEqual({ mono: 'model-0' });
    expect(view.uncal!.items[1]!.text).toBe('model-0, questions in English');
    expect(view.uncal!.more).toBe('And others: 2');
    expect(view.uncal!.body.segments.some((s) => s.code === 'python -m rag_eval.calibrate refusal')).toBe(true);
  });

  it('lists untested settings with their reasons; an unknown reason is a code in a sentence', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({
      mode: 'enforce',
      phase: 'result',
      locale: 'en',
      check: check({ not_evaluated: [{ key: 'RAG_EXAMPLE_SETTING', reason: 'fixture_generator' }, { key: 'RAG_EXAMPLE_KEY', reason: 'secret' }] }),
    });
    expect(view.untested!.heading).toBe('Changed settings this check could not test: 2');
    expect(view.untested!.items[0]!.reason.text).toContain('stand-in model');
    expect(view.untested!.items[1]!.reason.segments).toContainEqual({ code: 'secret' });
  });

  it('the not-covered line lists the names, and is null when the list is empty', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({ mode: 'enforce', phase: 'result', locale: 'en', check: check({ not_evaluated_on_real_set: ['RAG_A', 'RAG_B'] }) });
    expect(view.notCovered!.text).toBe('Not covered by the workspace test set: RAG_A, RAG_B');
    expect(settingCheckDialogView({ mode: 'enforce', phase: 'result', locale: 'en', check: check() }).notCovered).toBeNull();
  });

  it('merges the evidence of every layer, failed rows first, and names the layer when more than one ran', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({
      mode: 'enforce',
      phase: 'result',
      locale: 'en',
      check: check({
        result: 'fail',
        layers: [
          { layer: 'deterministic', result: 'fail', checks: [
            { check: 'false_answer_rate', slice: 'overall', measured: 0.15, numerator: 3, denominator: 20, limit: 0.05, limit_kind: 'max', result: 'failed' },
            { check: 'false_refusal_rate', slice: 'overall', measured: 0.01, limit: 0.1, limit_kind: 'max', result: 'passed' },
          ] },
          { layer: 'live', result: 'pass', checks: [{ check: 'faithfulness', slice: 'overall', measured: 0.9, limit: 0.8, limit_kind: 'min', result: 'passed' }] },
          { layer: 'real_set', result: 'skipped', reason: 'no_real_set', checks: [] },
        ],
      }),
    });
    expect(view.evidence.visible).toHaveLength(1);
    expect(view.evidence.visible[0]).toMatchObject({ checkLabel: 'False answers', measured: '15.0% (3 of 20)', limit: 'at most 5.0%', layerLabel: 'Built-in test questions' });
    expect(view.evidence.hidden.map((r) => r.layerLabel)).toEqual(['Built-in test questions', 'Live model']);
  });

  it('the mode note follows the mode; the title follows the state', () => {
    const { settingCheckDialogView } = load();
    const warn = settingCheckDialogView({ mode: 'warn', phase: 'result', locale: 'en', check: check({ result: 'fail', mode: 'warn' }) });
    expect(warn.modeNote!.key).toBe('failed.warnNote');
    expect(warn.title).toBe('Check failed');
    const zh = settingCheckDialogView({ mode: 'enforce', phase: 'result', locale: 'zh', check: check({ result: 'fail' }) });
    expect(zh.modeNote!.key).toBe('failed.enforceNote');
    expect(zh.title).toBe('检查未通过');
  });

  it('never carries a setting value, only names', () => {
    const { settingCheckDialogView } = load();
    const view = settingCheckDialogView({
      mode: 'enforce',
      phase: 'result',
      locale: 'en',
      check: check({ changed_keys: ['RAG_EXAMPLE_SETTING'] }),
      config: { RAG_EXAMPLE_SETTING: 'SYNTHETIC-VALUE-0001' },
    });
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC-VALUE-0001');
  });
});

describe('settingCheckReason and settingCheckSaveBody', () => {
  it('trims and accepts 10 to 500 characters, naming the number still missing', () => {
    const { settingCheckReason } = load();
    expect(settingCheckReason('   short   ', 'en')).toMatchObject({ value: 'short', length: 5, valid: false, missing: 5, tooShort: 'The reason needs more characters: 5' });
    expect(settingCheckReason('a'.repeat(10), 'en')).toMatchObject({ valid: true, missing: 0, tooShort: null });
    expect(settingCheckReason('a'.repeat(500), 'en').valid).toBe(true);
    expect(settingCheckReason('a'.repeat(501), 'en').valid).toBe(false);
    expect(settingCheckReason(undefined, 'en')).toMatchObject({ value: '', length: 0, valid: false, missing: 10 });
    expect(settingCheckReason('abc', 'zh').tooShort).toBe('原因还需要的字符数：7');
  });

  it('builds exactly the three save bodies', () => {
    const { settingCheckSaveBody } = load();
    expect(settingCheckSaveBody('save', { checkId: CHECK_ID })).toEqual({ check_id: CHECK_ID });
    expect(settingCheckSaveBody('saveAnyway', { checkId: CHECK_ID })).toEqual({ check_id: CHECK_ID });
    expect(settingCheckSaveBody('saveReason', { checkId: CHECK_ID, reason: '  a synthetic reason text  ' })).toEqual({ override: { reason: 'a synthetic reason text' }, check_id: CHECK_ID });
    expect(settingCheckSaveBody('saveReason', { checkId: null, reason: 'a synthetic reason text' })).toEqual({ override: { reason: 'a synthetic reason text' } });
    expect(settingCheckSaveBody('saveWithout', { checkId: CHECK_ID })).toEqual({ skipped: true });
  });
});
