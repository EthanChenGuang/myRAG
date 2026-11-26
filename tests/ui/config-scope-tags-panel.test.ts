import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';
import {
  DEFAULT_VOCAB,
  buttonByText,
  buttonsByText,
  doc,
  docsAnswer,
  entry,
  flush,
  loadScopeTagsPage,
  queueItemTemplate,
  vocabAnswer,
  type Json,
} from './helpers/scope-tags-harness';

const require = createRequire(import.meta.url);
const indexHtml = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/config-ui/index.html'), 'utf8');

type Locale = 'en' | 'zh' | 'it';
interface Module {
  SCOPE_TAGS_LABELS: Record<Locale, Record<string, string>>;
  scopeTagsSlugFromLabel: (label: string) => string;
  scopeTagsValueValid: (value: string) => boolean;
  scopeTagsAliases: (text: string) => string[];
  scopeTagsVocabularyView: (body: Json) => { total: number; dimensions: Array<{ id: string; entries: Array<Record<string, unknown>> }> };
  scopeTagsDocumentsView: (body: Json, vocab: unknown, locale: string) => { total: number; suggestedTotal: number; rows: Array<Record<string, unknown>> };
  scopeTagsSettingsWarnings: (values: Record<string, string>) => string[];
  scopeTagsUploadOptions: (picker: unknown) => { tags: { enabled: boolean; dimensions: Array<{ id: string; entries: unknown[] }> }; replaces: { enabled: boolean; confirmedAtOnce: boolean } };
  scopeTagsAppendUploadFields: (form: { append: (k: string, v: string) => void }, item: Json, picker: unknown) => void;
  scopeTagsUploadErrorText: (code: string, locale: string) => string | null;
}

function loadModule(): Module {
  return require('../../scripts/config-ui/rag-panels/scope-tags.js') as Module;
}

const ORG = '80000000-0000-4000-8000-000000000001';
const WORKSPACES = [
  { value: '', text: 'Default Workspace' },
  { value: ORG, text: 'Team One' },
];

function text(el: FakeElement | null): string {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function inputLabelled(root: FakeElement, labelText: string): FakeElement {
  const label = root.querySelectorAll('label').find((l) => text(l) === labelText && l.getAttribute('for'));
  if (!label) throw new Error('no label ' + labelText);
  const input = root.doc.getElementById(label.getAttribute('for')!);
  if (!input) throw new Error('no control for ' + labelText);
  return input;
}

function type(input: FakeElement, value: string) {
  input.value = value;
  input.dispatch('input');
}

describe('view-model builders (UI-SPEC 6.7, 8.1, 11.4)', () => {
  it('groups the vocabulary by dimension in the fixed order, named fields only', () => {
    const { scopeTagsVocabularyView } = loadModule();
    const view = scopeTagsVocabularyView(
      vocabAnswer([
        entry(3, { dimension: 'department', value: 'dept-1', label: 'Dept. 1' }),
        entry(1, { tenant_key: 'o:secret-tenant' }),
        entry(4, { dimension: 'legal_entity', value: 'entity-x', label: 'Entity X', active: false }),
        { dimension: 'other', value: 'x', label: 'X', id: 'z' },
      ]),
    );
    expect(view.dimensions.map((d) => d.id)).toEqual(['region', 'legal_entity', 'department']);
    expect(view.total).toBe(3);
    expect(view.dimensions[0]!.entries[0]).toMatchObject({ label: 'Region 1', value: 'region-1', aliases: ['Area 1', 'Zone 1'], active: true });
    expect(view.dimensions[1]!.entries[0]).toMatchObject({ value: 'entity-x', active: false });
    expect(JSON.stringify(view)).not.toContain('secret-tenant');
  });

  it('suggests a value from the label and validates it like the server does', () => {
    const { scopeTagsSlugFromLabel, scopeTagsValueValid } = loadModule();
    expect(scopeTagsSlugFromLabel('Region A')).toBe('region-a');
    expect(scopeTagsSlugFromLabel('  Área   Norte!! ')).toBe('area-norte');
    expect(scopeTagsSlugFromLabel('第一组')).toBe('');
    expect(scopeTagsSlugFromLabel('x'.repeat(90)).length).toBeLessThanOrEqual(64);
    expect(scopeTagsValueValid('region-a')).toBe(true);
    expect(scopeTagsValueValid('a--b')).toBe(false);
    expect(scopeTagsValueValid('-a')).toBe(false);
    expect(scopeTagsValueValid('Region')).toBe(false);
    expect(scopeTagsValueValid('a'.repeat(65))).toBe(false);
  });

  it('splits other names on commas, trims and removes duplicates', () => {
    const { scopeTagsAliases } = loadModule();
    expect(scopeTagsAliases('Area A, Zone A，Area B, , Area A')).toEqual(['Area A', 'Zone A', 'Area B']);
    expect(scopeTagsAliases('')).toEqual([]);
  });

  it('maps documents with tag labels, suggestions with their source and an unknown value as its code', () => {
    const { scopeTagsDocumentsView, scopeTagsVocabularyView } = loadModule();
    const vocab = scopeTagsVocabularyView(vocabAnswer(DEFAULT_VOCAB));
    const view = scopeTagsDocumentsView(
      docsAnswer([doc(1, { tags: ['region:region-1', 'region:gone'], tenant_key: 't-secret' })], { total: 9, suggested_total: 4 }),
      vocab,
      'en',
    );
    expect(view.total).toBe(9);
    expect(view.suggestedTotal).toBe(4);
    const row = view.rows[0]!;
    expect(row).toMatchObject({ file: 'document-1.pdf', docType: 'general' });
    expect(row.tags).toEqual([
      expect.objectContaining({ dimension: 'region', value: 'region-1', label: 'Region 1', known: true }),
      expect.objectContaining({ dimension: 'region', value: 'gone', known: false }),
    ]);
    expect(row.suggestions).toEqual([expect.objectContaining({ dimension: 'department', value: 'dept-1', label: 'Dept. 1', source: 'rule' })]);
    expect(JSON.stringify(view)).not.toContain('t-secret');
  });

  it('computes the combination warnings from the page inputs (UI-SPEC 6.3)', () => {
    const { scopeTagsSettingsWarnings } = loadModule();
    expect(scopeTagsSettingsWarnings({ RAG_SCOPE_TAGS: 'false', RAG_SCOPE_TAG_SUGGEST: 'true', RAG_PIPELINE: 'v2', RAG_INGEST_PIPELINE: 'unified' })).toEqual(['warn.suggestNeedsTags']);
    expect(scopeTagsSettingsWarnings({ RAG_SCOPE_TAGS: 'true', RAG_SCOPE_TAG_SUGGEST: 'false', RAG_PIPELINE: 'legacy', RAG_INGEST_PIPELINE: 'legacy' })).toEqual(['warn.needsUnified', 'warn.datesNeedV2']);
    expect(scopeTagsSettingsWarnings({ RAG_SCOPE_TAGS: 'true', RAG_SCOPE_TAG_SUGGEST: 'true', RAG_PIPELINE: 'v2', RAG_INGEST_PIPELINE: 'unified' })).toEqual([]);
  });

  it('the copy never calls tags permissions or access control', () => {
    const { SCOPE_TAGS_LABELS } = loadModule();
    for (const locale of ['en', 'zh', 'it'] as const) {
      const all = Object.values(SCOPE_TAGS_LABELS[locale]).join('\n');
      expect(all.length).toBeGreaterThan(100);
      expect(all).not.toMatch(/permission|access control|权限|访问控制|permess|controllo degli accessi/i);
    }
    expect(Object.keys(SCOPE_TAGS_LABELS.zh).sort()).toEqual(Object.keys(SCOPE_TAGS_LABELS.en).sort());
    expect(Object.keys(SCOPE_TAGS_LABELS.it).sort()).toEqual(Object.keys(SCOPE_TAGS_LABELS.en).sort());
  });
});

describe('Vocabulary sub-view', () => {
  it('follows the workspace, writes each dimension in words and shows label, value, other names and state', async () => {
    const page = loadScopeTagsPage({ workspaces: WORKSPACES, workspace: ORG });
    await page.init();
    expect(page.calls('vocab')[0]!.query.get('organizationId')).toBe(ORG);
    expect(page.calls('documents')[0]!.query.get('organizationId')).toBe(ORG);
    expect(text(page.root.querySelector('[data-scope-tags-workspace]'))).toBe('Workspace: Team One');
    expect(page.tabButton('vocabulary').getAttribute('aria-selected')).toBe('true');
    expect(text(page.tabButton('documents'))).toBe('Documents with suggestions: 3');
    const vocab = page.panel('vocabulary');
    expect(vocab.querySelectorAll('h4').map(text)).toEqual(['Region', 'Legal entity', 'Department']);
    const row = vocab.querySelectorAll('tr').find((tr) => text(tr).includes('Region 1'))!;
    const code = row.querySelector('code')!;
    expect(text(code)).toBe('region-1');
    expect(code.className).toContain('font-mono');
    expect(code.getAttribute('translate')).toBe('no');
    expect(text(row)).toContain('Area 1, Zone 1');
    expect(text(row)).toContain('In use');
    expect(row.querySelector('i.bi-check-circle')).toBeTruthy();
    const retired = vocab.querySelectorAll('tr').find((tr) => text(tr).includes('Region 2'))!;
    expect(text(retired)).toContain('Retired');
    expect(retired.querySelector('i.bi-archive')).toBeTruthy();
  });

  it('the create form keeps Create tag disabled until a label is present and suggests the value', async () => {
    const page = loadScopeTagsPage();
    await page.init();
    const vocab = page.panel('vocabulary');
    buttonByText(vocab, 'New tag').click();
    const create = buttonByText(vocab, 'Create tag');
    expect(create.disabled).toBe(true);
    const findingsId = create.getAttribute('aria-describedby')!;
    expect(text(page.doc.getElementById(findingsId))).toBe('Enter a label for the tag.');
    const value = inputLabelled(vocab, 'Value');
    expect(value.getAttribute('autocomplete')).toBe('off');
    expect(value.getAttribute('spellcheck')).toBe('false');
    expect(value.getAttribute('translate')).toBe('no');
    type(inputLabelled(vocab, 'Label'), 'Region C');
    expect(value.value).toBe('region-c');
    expect(create.disabled).toBe(false);
    type(value, 'Bad Value');
    expect(create.disabled).toBe(true);
    expect(text(page.doc.getElementById(create.getAttribute('aria-describedby')!))).toContain('lower-case letters, digits and hyphens only');
    type(value, 'region-c');
    type(inputLabelled(vocab, 'Other names'), 'Zone C, Area C');
    const dimension = inputLabelled(vocab, 'Dimension');
    expect(dimension.tagName).toBe('select');
    create.click();
    await flush();
    expect(page.calls('create')[0]!.body).toEqual({ dimension: 'region', value: 'region-c', label: 'Region C', aliases: ['Zone C', 'Area C'] });
    expect(text(page.status())).toBe('Tag created: Region C.');
    expect(page.calls('vocab').length).toBeGreaterThanOrEqual(2);
  });

  it('a 409 tag_exists is shown at the Value field', async () => {
    const page = loadScopeTagsPage({ replies: { create: { status: 409, body: { success: false, error: 'tag_exists' } } } });
    await page.init();
    const vocab = page.panel('vocabulary');
    buttonByText(vocab, 'New tag').click();
    type(inputLabelled(vocab, 'Label'), 'Region 1');
    buttonByText(vocab, 'Create tag').click();
    await flush();
    const value = inputLabelled(vocab, 'Value');
    expect(value.getAttribute('aria-invalid')).toBe('true');
    const described = (value.getAttribute('aria-describedby') ?? '').split(' ').map((id) => text(page.doc.getElementById(id))).join(' ');
    expect(described).toContain('This value already exists in Region. Choose another value.');
    expect(page.doc.activeElement).toBe(value);
  });

  it('editing changes the label and other names only; the value is never an input', async () => {
    const page = loadScopeTagsPage();
    await page.init();
    const vocab = page.panel('vocabulary');
    const edit = vocab.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Edit tag: Region 1')!;
    edit.click();
    const row = vocab.querySelectorAll('tr').find((tr) => tr.querySelector('input'))!;
    const inputs = row.querySelectorAll('input');
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.value)).toEqual(['Region 1', 'Area 1, Zone 1']);
    expect(text(row.querySelector('code'))).toBe('region-1');
    type(inputs[0]!, 'Region One');
    buttonByText(row, 'Save tag').click();
    await flush();
    expect(page.calls('update')[0]!.body).toEqual({ id: (DEFAULT_VOCAB[0] as Json).id, label: 'Region One', aliases: ['Area 1', 'Zone 1'] });
    expect(text(page.status())).toBe('Tag saved: Region One.');
  });

  it('retiring asks for confirmation; Restore tag brings it back; there is no delete', async () => {
    const page = loadScopeTagsPage();
    await page.init();
    const vocab = page.panel('vocabulary');
    expect(page.root.querySelectorAll('button').filter((b) => /delete/i.test(text(b)))).toHaveLength(0);
    const retire = vocab.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Retire tag: Region 1')!;
    retire.click();
    await flush();
    let dialog = page.dialog()!;
    expect(text(dialog.querySelector('h3'))).toBe('Retire the tag Region 1?');
    expect(page.doc.activeElement && text(page.doc.activeElement)).toBe('Keep tag in use');
    buttonByText(dialog, 'Keep tag in use').click();
    await flush();
    expect(page.calls('update')).toHaveLength(0);
    vocab.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Retire tag: Region 1')!.click();
    await flush();
    dialog = page.dialog()!;
    buttonByText(dialog, 'Retire tag').click();
    await flush();
    expect(page.calls('update')[0]!.body).toEqual({ id: (DEFAULT_VOCAB[0] as Json).id, active: false });
    expect(text(page.status())).toBe('Tag retired: Region 1.');
    const retiredRow = page.panel('vocabulary').querySelectorAll('tr').find((tr) => text(tr).includes('Region 2'))!;
    expect(buttonsByText(retiredRow, 'Retire tag')).toHaveLength(0);
    buttonByText(retiredRow, 'Restore tag').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.calls('update')[1]!.body).toEqual({ id: (DEFAULT_VOCAB[1] as Json).id, active: true });
    expect(text(page.status())).toBe('Tag restored: Region 2.');
  });

  it('an empty vocabulary shows its title and body; a dimension without tags shows its own sentence', async () => {
    const empty = loadScopeTagsPage({ replies: { vocab: { status: 200, body: vocabAnswer([]) } } });
    await empty.init();
    expect(text(empty.panel('vocabulary'))).toContain('No tags yet');
    expect(text(empty.panel('vocabulary'))).toContain('Create tags for regions, legal entities and departments');
    const partial = loadScopeTagsPage({ replies: { vocab: { status: 200, body: vocabAnswer([entry(1)]) } } });
    await partial.init();
    const lines = partial.panel('vocabulary').querySelectorAll('p').filter((p) => text(p) === 'No tag in this group yet.');
    expect(lines).toHaveLength(2);
  });

  it('long labels and many other names wrap in their cells', async () => {
    const long = 'L'.repeat(30) + ' ' + 'M'.repeat(29);
    const aliases = Array.from({ length: 10 }, (_, i) => `Other name ${i + 1}`);
    const page = loadScopeTagsPage({ replies: { vocab: { status: 200, body: vocabAnswer([entry(1, { label: long, aliases })]) } } });
    await page.init();
    const row = page.panel('vocabulary').querySelectorAll('tr').find((tr) => text(tr).includes(long))!;
    const cells = [row.querySelector('th')!, ...row.querySelectorAll('td')];
    expect(cells[0]!.className).toMatch(/break-words|overflow-wrap/);
    const aliasCell = cells.find((c) => text(c).includes('Other name 10'))!;
    expect(aliasCell.className).toMatch(/break-words|overflow-wrap/);
  });
});

describe('Documents sub-view', () => {
  async function openDocuments(options: Parameters<typeof loadScopeTagsPage>[0] = {}) {
    const page = loadScopeTagsPage(options);
    await page.init();
    page.tabButton('documents').click();
    await flush();
    return page;
  }

  it('lists file, type, tags in words and stored suggestions with their source, unticked', async () => {
    const page = await openDocuments();
    expect(page.calls('documents')[0]!.query.get('filter')).toBe('suggested');
    const docs = page.panel('documents');
    const row = docs.querySelectorAll('tr').find((tr) => text(tr).includes('document-1.pdf'))!;
    expect(text(row)).toContain('Region: Region 1');
    expect(text(row)).toContain('Department: Dept. 1');
    expect(text(row)).toContain('Suggested');
    expect(text(row)).toContain('Found by a rule');
    const other = docs.querySelectorAll('tr').find((tr) => text(tr).includes('document-2.pdf'))!;
    expect(text(other)).toContain('No tags');
  });

  it('the editor has one fieldset per dimension; Add suggested tag ticks it and Save tags sends the full set', async () => {
    const page = await openDocuments();
    const docs = page.panel('documents');
    docs.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Edit tags: document-1.pdf')!.click();
    const fieldsets = docs.querySelectorAll('fieldset').filter((f) => f.querySelector('legend') && f.querySelector('input[type="checkbox"]'));
    expect(fieldsets.map((f) => text(f.querySelector('legend')))).toEqual(['Region', 'Department']);
    const boxes = docs.querySelectorAll('input[type="checkbox"]');
    const region1 = boxes.find((b) => b.getAttribute('value') === 'region:region-1')!;
    const dept1 = boxes.find((b) => b.getAttribute('value') === 'department:dept-1')!;
    expect(boxes.find((b) => b.getAttribute('value') === 'region:region-2')).toBeUndefined();
    expect(region1.checked).toBe(true);
    expect(dept1.checked).toBe(false);
    buttonByText(docs, 'Add suggested tag').click();
    expect(dept1.checked).toBe(true);
    expect(page.calls('setScopes')).toHaveLength(0);
    buttonByText(docs, 'Save tags').click();
    await flush();
    const put = page.calls('setScopes')[0]!;
    expect(put.path.split('?')[0]).toBe('/api/rag/admin/documents/' + (doc(1).id as string) + '/scopes');
    expect(put.body).toEqual({ scopes: ['department:dept-1', 'region:region-1'] });
    expect(text(page.status())).toBe('Tags saved: document-1.pdf.');
  });

  it('a suggestion is never applied without the admin adding it', async () => {
    const page = await openDocuments();
    const docs = page.panel('documents');
    docs.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Edit tags: document-1.pdf')!.click();
    buttonByText(docs, 'Save tags').click();
    await flush();
    expect(page.calls('setScopes')[0]!.body).toEqual({ scopes: ['region:region-1'] });
  });

  it('a 400 unknown_scope_value is shown at the dimension and reloads the vocabulary', async () => {
    const page = await openDocuments({ replies: { setScopes: { status: 400, body: { success: false, error: 'unknown_scope_value' } } } });
    const before = page.calls('vocab').length;
    const docs = page.panel('documents');
    docs.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Edit tags: document-1.pdf')!.click();
    buttonByText(docs, 'Save tags').click();
    await flush();
    expect(page.calls('vocab').length).toBe(before + 1);
    const fieldset = docs.querySelectorAll('fieldset').find((f) => text(f.querySelector('legend')) === 'Region')!;
    expect(text(fieldset)).toContain('A chosen tag no longer exists. The tag list was reloaded; choose again.');
  });

  it('filters by view, tag and file name; a filter with no result shows the no-documents sentence', async () => {
    const page = await openDocuments({
      replies: {
        documents: (call) =>
          call.query.get('q') === 'nothing' ? { status: 200, body: docsAnswer([]) } : { status: 200, body: docsAnswer([doc(1)]) },
      },
    });
    const docs = page.panel('documents');
    const all = docs.querySelectorAll('input[type="radio"]').find((r) => r.getAttribute('aria-label') === 'All')!;
    all.checked = true;
    all.dispatch('change');
    await flush();
    expect(page.calls('documents').at(-1)!.query.get('filter')).toBe('all');
    const tag = inputLabelled(docs, 'Tag');
    tag.value = 'region:region-1';
    tag.dispatch('change');
    await flush();
    expect(page.calls('documents').at(-1)!.query.get('scopes')).toBe('region:region-1');
    const search = inputLabelled(docs, 'Search by file name');
    search.value = 'nothing';
    search.dispatch('keydown', { key: 'Enter' });
    await flush();
    expect(page.calls('documents').at(-1)!.query.get('q')).toBe('nothing');
    expect(text(docs)).toContain('No documents match this filter.');
    expect(docs.querySelectorAll('tr').filter((tr) => text(tr).includes('document-1.pdf'))).toHaveLength(0);
  });

  it('a dimension with 200 values sits in a capped scroll region reachable by keyboard', async () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(100 + i));
    const page = await openDocuments({ replies: { vocab: { status: 200, body: vocabAnswer(many) } } });
    const docs = page.panel('documents');
    docs.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Edit tags: document-1.pdf')!.click();
    const region = docs.querySelectorAll('fieldset').find((f) => text(f.querySelector('legend')) === 'Region')!;
    const scroller = region.querySelector('[role="region"]')!;
    expect(scroller.className).toContain('max-h-72');
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.querySelectorAll('input[type="checkbox"]').length).toBe(200);
  });
});

describe('Settings, switch off and sign-in', () => {
  it('moves the scopes group into Settings and shows the combination warnings from the page inputs', async () => {
    const page = loadScopeTagsPage({ scopeTags: 'false', suggest: 'true' });
    await page.init();
    expect(page.panel('settings').querySelector('#RAG_SCOPE_TAGS')).toBeTruthy();
    expect(page.panel('settings').querySelector('#RAG_SCOPE_TAG_SUGGEST')).toBeTruthy();
    expect(text(page.alertHost())).toContain('Tag suggestions need document tags to be on.');
    const tags = page.doc.getElementById('RAG_SCOPE_TAGS')!;
    tags.value = 'true';
    tags.dispatch('change');
    page.pipeline.value = 'legacy';
    page.pipeline.dispatch('change');
    expect(text(page.alertHost())).not.toContain('Tag suggestions need document tags to be on.');
    expect(text(page.alertHost())).toContain('This filter applies in the v2 retrieval pipeline only.');
  });

  it('with the switch off both data sub-views say so and link to Settings', async () => {
    const off = { status: 404, body: { success: false, error: 'Not found' } };
    const page = loadScopeTagsPage({ replies: { vocab: off, documents: off } });
    await page.init();
    expect(text(page.panel('vocabulary'))).toContain('Document tags are off.');
    page.tabButton('documents').click();
    await flush();
    expect(text(page.panel('documents'))).toContain('Document tags are off.');
    buttonsByText(page.panel('documents'), 'Open tag settings')[0]!.click();
    expect(page.tabButton('settings').getAttribute('aria-selected')).toBe('true');
  });

  it('a 401 replaces the data views with the sign-in alert and Settings stays usable', async () => {
    const denied = { status: 401, body: { success: false, error: 'Unauthorized' } };
    const page = loadScopeTagsPage({ replies: { vocab: denied, documents: denied } });
    await page.init();
    expect(page.panel('vocabulary').querySelector('.alert')).toBeTruthy();
    expect(buttonsByText(page.panel('vocabulary'), 'Reload panel').length).toBe(1);
    expect(page.panel('settings').querySelector('#RAG_SCOPE_TAGS')).toBeTruthy();
  });
});

describe('server strings render as text (XSS, T-03.2-601)', () => {
  it('labels, other names, values and file names containing markup create no element', async () => {
    const page = loadScopeTagsPage({
      replies: {
        vocab: { status: 200, body: vocabAnswer([entry(1, { label: XSS_PAYLOAD, aliases: [XSS_PAYLOAD] })]) },
        documents: {
          status: 200,
          body: docsAnswer([doc(1, { file_name: XSS_PAYLOAD, doc_type: XSS_PAYLOAD, tags: ['region:region-1'], suggestions: [{ dimension: 'region', value: 'region-1', source: XSS_PAYLOAD }] })]),
        },
      },
    });
    await page.init();
    page.tabButton('documents').click();
    await flush();
    page.panel('documents').querySelectorAll('button').find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Edit tags'))!.click();
    expect(injectedElements(page.doc)).toHaveLength(0);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.doc.body.textContent).toContain(XSS_PAYLOAD);
  });
});

describe('index.html skeleton', () => {
  it('has the section between Upload approvals and the profiles, and the script after upload-approvals.js', () => {
    const approvals = indexHtml.indexOf('id="rag-administration-approvals"');
    const scopes = indexHtml.indexOf('id="rag-administration-scopes"');
    const profiles = indexHtml.indexOf('id="rag-administration-profiles"');
    expect(scopes).toBeGreaterThan(approvals);
    expect(profiles).toBeGreaterThan(scopes);
    const approvalsScript = indexHtml.indexOf('<script src="rag-panels/upload-approvals.js">');
    const scopesScript = indexHtml.indexOf('<script src="rag-panels/scope-tags.js">');
    expect(scopesScript).toBeGreaterThan(approvalsScript);
    expect(indexHtml).toContain('scopeTagsMountQueueControls(');
    expect(indexHtml).toContain('scopeTagsAppendUploadFields(');
  });
});

describe('Config UI upload queue: tags and "Replaces…" (UI-SPEC 6.11)', () => {
  const template = queueItemTemplate();
  const self = (picker: Json) => ({
    uploadPicker: picker,
    escapeHtml: (value: string) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    window: { buildDocTypeSelectOptions: () => [{ value: 'auto', label: 'Auto', selected: true }] },
  });
  const item = { id: 7, name: 'upload-1.pdf', size: '1 KB', status: 'queued', progress: 0, docType: 'auto' };

  it('with both controls disabled the queue item is identical to today and has no host', () => {
    const today = template(self({ enabled: true, defaultType: 'auto', loaded: true }), item);
    const off = template(self({ enabled: true, defaultType: 'auto', loaded: true, tags: { enabled: false, vocabulary: [] }, replaces: { enabled: false, confirmedAtOnce: false } }), item);
    expect(off).toBe(today);
    expect(off).not.toContain('data-queue-extras');
    const on = template(self({ enabled: true, defaultType: 'auto', loaded: true, tags: { enabled: true, vocabulary: [] }, replaces: { enabled: false } }), item);
    expect(on).toContain('data-queue-extras="7"');
  });

  function queuePage(picker: Json, replies: Parameters<typeof loadScopeTagsPage>[0]['replies'] = {}) {
    const page = loadScopeTagsPage({ queueOnly: true, replies });
    const container = page.doc.createElement('div');
    container.id = 'queue-items';
    const host = page.doc.createElement('div');
    host.setAttribute('data-queue-extras', '7');
    container.appendChild(host);
    page.doc.body.appendChild(container);
    const queueItem: Json = { ...item };
    const mount = () =>
      (page.context.scopeTagsMountQueueControls as (c: FakeElement, q: Json[], p: Json, ctx: Json) => void)(container, [queueItem], picker, { organizationId: null });
    return { page, container, host, queueItem, mount };
  }

  const vocabulary = [
    { dimension: 'region', value: 'region-1', label: 'Region 1' },
    { dimension: 'department', value: 'dept-1', label: 'Dept. 1' },
  ];

  it('both disabled: the host stays empty', () => {
    const { host, mount } = queuePage({ enabled: true, tags: { enabled: false, vocabulary }, replaces: { enabled: false } });
    mount();
    expect(host.childNodes).toHaveLength(0);
  });

  it('the tag control is a dropdown of checkboxes grouped by dimension; the trigger shows the count', () => {
    const { host, queueItem, mount } = queuePage({ enabled: true, tags: { enabled: true, vocabulary }, replaces: { enabled: false } });
    mount();
    const details = host.querySelector('details')!;
    expect(details.className).toContain('dropdown');
    const summary = details.querySelector('summary')!;
    expect(text(summary)).toContain('Tags: 0');
    expect(text(summary)).toContain('upload-1.pdf');
    const content = details.querySelector('.dropdown-content')!;
    expect(content.className).toContain('max-h-72');
    expect(content.className).toContain('overflow-y-auto');
    expect(content.querySelectorAll('legend').map(text)).toEqual(['Region', 'Department']);
    const box = content.querySelectorAll('input[type="checkbox"]').find((b) => b.getAttribute('value') === 'region:region-1')!;
    box.checked = true;
    box.dispatch('change');
    expect(queueItem.scopes).toEqual(['region:region-1']);
    expect(text(host.querySelector('summary'))).toContain('Tags: 1');
    expect(host.querySelectorAll('button').filter((b) => text(b).startsWith('Replaces'))).toHaveLength(0);
  });

  it('"Replaces…" chooses one of the workspace documents in a dialog; Close chooser changes nothing', async () => {
    const { page, host, queueItem, mount } = queuePage(
      { enabled: true, tags: { enabled: false, vocabulary: [] }, replaces: { enabled: true, confirmedAtOnce: true } },
      { documents: { status: 200, body: docsAnswer([doc(1), doc(2)]) } },
    );
    mount();
    const open = host.querySelectorAll('button').find((b) => text(b).startsWith('Replaces…'))!;
    open.click();
    await flush();
    const dialog = page.dialog()!;
    expect(page.calls('documents')[0]!.query.get('filter')).toBe('all');
    expect(text(dialog)).toContain('The chosen document stops being used for answers when this upload is ready.');
    const search = dialog.querySelector('input')!;
    expect(page.doc.activeElement).toBe(search);
    const choose = buttonByText(dialog, 'Choose document');
    expect(choose.disabled).toBe(true);
    const options = dialog.querySelectorAll('[role="radio"]');
    expect(options).toHaveLength(2);
    options[1]!.click();
    expect(options[1]!.getAttribute('aria-checked')).toBe('true');
    expect(choose.disabled).toBe(false);
    choose.click();
    await flush();
    expect(queueItem.replaces).toEqual({ id: doc(2).id, name: 'document-2.pdf' });
    expect(text(host)).toContain('Replaces: document-2.pdf');
    host.querySelectorAll('button').find((b) => text(b).startsWith('Replaces…'))!.click();
    await flush();
    buttonByText(page.dialog(), 'Close chooser').click();
    await flush();
    expect(queueItem.replaces).toEqual({ id: doc(2).id, name: 'document-2.pdf' });
    buttonByText(host, 'Clear replacement').click();
    expect(queueItem.replaces).toBeNull();
    expect(text(host)).not.toContain('Replaces: document-2.pdf');
  });

  it('sends scopes and replaces_document_id only when the controls are enabled and a value is chosen', () => {
    const { scopeTagsAppendUploadFields } = loadModule();
    const fields = (picker: Json, queued: Json) => {
      const out: Array<[string, string]> = [];
      scopeTagsAppendUploadFields({ append: (k, v) => out.push([k, v]) }, queued, picker);
      return out;
    };
    const on = { tags: { enabled: true, vocabulary }, replaces: { enabled: true } };
    const off = { tags: { enabled: false, vocabulary }, replaces: { enabled: false } };
    const queued = { scopes: ['region:region-1', 'department:dept-1', 'region:unknown'], replaces: { id: 'b0000000-0000-4000-8000-000000000002', name: 'x' } };
    expect(fields(off, queued)).toEqual([]);
    expect(fields(on, {})).toEqual([]);
    expect(fields(on, queued)).toEqual([
      ['scopes', 'department:dept-1'],
      ['scopes', 'region:region-1'],
      ['replaces_document_id', 'b0000000-0000-4000-8000-000000000002'],
    ]);
  });

  it('maps the upload refusal of an unknown tag to its sentence', () => {
    const { scopeTagsUploadErrorText } = loadModule();
    expect(scopeTagsUploadErrorText('unknown_scope_value', 'en')).toBe('A chosen tag no longer exists. The tag list was reloaded; choose again.');
    expect(scopeTagsUploadErrorText('something_else', 'en')).toBeNull();
  });

  it('queue labels and document names containing markup create no element', async () => {
    const { page, host, mount } = queuePage(
      { enabled: true, tags: { enabled: true, vocabulary: [{ dimension: 'region', value: 'region-1', label: XSS_PAYLOAD }] }, replaces: { enabled: true } },
      { documents: { status: 200, body: docsAnswer([doc(1, { file_name: XSS_PAYLOAD, doc_type: XSS_PAYLOAD })]) } },
    );
    mount();
    host.querySelectorAll('button').find((b) => text(b).startsWith('Replaces…'))!.click();
    await flush();
    expect(injectedElements(page.doc)).toHaveLength(0);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.doc.body.textContent).toContain(XSS_PAYLOAD);
  });
});
