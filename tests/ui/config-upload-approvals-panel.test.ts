import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';
import {
  buttonByText,
  buttonsByText,
  exemptionItem,
  exemptionsAnswer,
  flush,
  listAnswer,
  loadApprovalsPage,
  pendingItem,
  type Json,
} from './helpers/upload-approvals-harness';

const require = createRequire(import.meta.url);

function loadModule() {
  return require('../../scripts/config-ui/rag-panels/upload-approvals.js') as {
    UPLOAD_APPROVALS_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
    uploadApprovalsPendingView: (body: Json, locale: string) => { mode: string; total: number; rows: Array<Record<string, unknown>> };
    uploadApprovalsExemptionsView: (body: Json) => { items: Array<Record<string, unknown>>; total: number; choices: Record<string, unknown> };
    uploadApprovalsLegacyWarning: (mode: string, pipeline: string) => boolean;
  };
}

const ORG = '80000000-0000-4000-8000-000000000001';
const ORG_2 = '80000000-0000-4000-8000-000000000002';
const WORKSPACES = [
  { value: '', text: '👤 Default Workspace' },
  { value: ORG, text: 'Team North' },
  { value: ORG_2, text: 'Team South' },
];

describe('view-model builders map the route answer to named fields (UI-SPEC 8.1, 11.4)', () => {
  it('maps file, uploader display or id, source, document type, upload time and the new-version marker', () => {
    const { uploadApprovalsPendingView } = loadModule();
    const view = uploadApprovalsPendingView(
      listAnswer(
        [
          pendingItem(1, { new_version: true, tenant_key: 'o:secret-tenant', extra_field: 'never-shown' }),
          pendingItem(2, { uploader: { id: 'user-2', display: 'user-2' } }),
          pendingItem(3, { uploader: null }),
          { file_name: 'no-id.pdf' },
        ],
        { total: 120 },
      ),
      'en',
    );
    expect(view.mode).toBe('members');
    expect(view.total).toBe(120);
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0]).toMatchObject({ file: 'report-1.pdf', source: 'upload', sourceKnown: true, docType: 'general', newVersion: true, uploadedAt: '2026-11-20T09:30:00.000Z' });
    expect(view.rows[0]!.uploader).toMatchObject({ display: 'member1@example.test', isId: false });
    expect(view.rows[1]!.uploader).toMatchObject({ id: 'user-2', isId: true });
    expect(view.rows[2]!.uploader).toBeNull();
    expect(JSON.stringify(view)).not.toContain('secret-tenant');
    expect(JSON.stringify(view)).not.toContain('never-shown');
  });

  it('an unknown mode is not treated as off', () => {
    const { uploadApprovalsPendingView } = loadModule();
    expect(uploadApprovalsPendingView(listAnswer([], { mode: 'later' }), 'en').mode).toBe('unknown');
    expect(uploadApprovalsPendingView(listAnswer([], { mode: 'off' }), 'en').mode).toBe('off');
  });

  it('maps exemptions and the choices for a new one', () => {
    const { uploadApprovalsExemptionsView } = loadModule();
    const view = uploadApprovalsExemptionsView(exemptionsAnswer([exemptionItem(1), exemptionItem(2, { kind: 'connector', display: '' })]));
    expect(view.items).toHaveLength(2);
    expect(view.items[0]).toMatchObject({ kind: 'uploader', display: 'member1@example.test', displayIsId: false });
    expect(view.items[1]).toMatchObject({ kind: 'connector', displayIsId: true });
    expect((view.choices.uploader as unknown[]).length).toBe(2);
  });

  it('the legacy-pipeline warning shows when approval is not off and the pipeline is not unified (D-56)', () => {
    const { uploadApprovalsLegacyWarning } = loadModule();
    expect(uploadApprovalsLegacyWarning('members', 'legacy')).toBe(true);
    expect(uploadApprovalsLegacyWarning('all', '')).toBe(true);
    expect(uploadApprovalsLegacyWarning('members', 'unified')).toBe(false);
    expect(uploadApprovalsLegacyWarning('off', 'legacy')).toBe(false);
    expect(uploadApprovalsLegacyWarning('', 'legacy')).toBe(false);
  });

  it('has the same keys in en, zh and it, with the zh status word of decision 17', () => {
    const { UPLOAD_APPROVALS_LABELS } = loadModule();
    const en = Object.keys(UPLOAD_APPROVALS_LABELS.en).sort();
    const settingsKeys = (keys: string[]) => keys.filter((k) => !k.startsWith('RAG_UPLOAD_APPROVAL.'));
    expect(settingsKeys(Object.keys(UPLOAD_APPROVALS_LABELS.zh)).sort()).toEqual(en);
    expect(settingsKeys(Object.keys(UPLOAD_APPROVALS_LABELS.it)).sort()).toEqual(en);
  });
});

describe('Pending: the table and the hold line (UI-SPEC 6.6, 9.11)', () => {
  it('renders one table with a hidden caption, column headers and the file cell as a row header holding the hold line', async () => {
    const page = loadApprovalsPage({
      replies: { list: { status: 200, body: listAnswer([pendingItem(1), pendingItem(2, { new_version: true, doc_type: 'contract_legal', source: 'nango' })]) } },
    });
    await page.init();
    const table = page.root.querySelector('table')!;
    expect(table).toBeTruthy();
    const caption = table.querySelector('caption')!;
    expect(caption.className).toContain('sr-only');
    expect(caption.textContent).toBe('Uploads awaiting approval');
    const headers = table.querySelectorAll('thead th');
    expect(headers.map((h) => h.textContent)).toEqual(['File', 'Uploaded by', 'Source', 'Document type', 'Uploaded', 'Actions']);
    expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
    const rows = page.rows();
    expect(rows).toHaveLength(2);
    const fileCell = rows[0]!.querySelector('th')!;
    expect(fileCell.getAttribute('scope')).toBe('row');
    expect(fileCell.textContent).toContain('report-1.pdf');
    const badge = fileCell.querySelector('.badge')!;
    expect(badge.className).toContain('badge-info');
    expect(badge.className).toContain('badge-outline');
    expect(badge.querySelector('i')!.className).toContain('bi-hourglass');
    expect(badge.textContent).toBe('Awaiting approval');
    expect(fileCell.textContent).toContain('Held out of answers until an admin approves it.');
    expect(rows[1]!.querySelector('th')!.textContent).toContain('New version of a document in use. The current version keeps answering until you approve.');
    expect(rows[1]!.textContent).toContain('Contract & legal');
    expect(rows[1]!.textContent).toContain('Cloud connector');
    expect(rows[0]!.textContent).toContain('member1@example.test');
    expect(rows[0]!.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-20T09:30:00.000Z');
    const approve = buttonByText(rows[0]!, 'Approve upload');
    expect(approve.className).toContain('btn-primary');
    expect(approve.getAttribute('aria-label')).toBe('Approve upload: report-1.pdf');
    const reject = buttonByText(rows[0]!, 'Reject upload');
    expect(reject.className).toContain('btn-error');
    expect(reject.getAttribute('aria-label')).toBe('Reject upload: report-1.pdf');
    expect(page.root.textContent).toContain('Uploads that are also quarantined are listed under Quarantine.');
  });

  it('shows the 12px workspace line under the description and the pending count in the sub-tab label', async () => {
    const page = loadApprovalsPage({ workspaces: WORKSPACES, workspace: ORG });
    await page.init();
    const line = page.root.querySelector('[data-upload-approvals-workspace]')!;
    expect(line.className).toContain('text-xs');
    expect(line.textContent).toBe('Workspace: Team North');
    expect(page.tabButton('pending').textContent).toBe('Pending: 2');
    expect(page.tabButton('exemptions').textContent).toBe('Exemptions');
    expect(page.tabButton('settings').textContent).toBe('Settings');
    expect(page.calls('list')[0]!.query.get('organizationId')).toBe(ORG);
    expect(page.calls('list')[0]!.query.get('limit')).toBe('50');
  });

  it('names the default workspace when none is chosen', async () => {
    const page = loadApprovalsPage();
    await page.init();
    expect(page.root.querySelector('[data-upload-approvals-workspace]')!.textContent).toBe('Workspace: Default workspace');
    expect(page.calls('list')[0]!.query.has('organizationId')).toBe(false);
  });

  it('an uploader without a display name is shown by id in monospace', async () => {
    const id = '40000000-0000-4000-8000-000000000009';
    const page = loadApprovalsPage({ replies: { list: { status: 200, body: listAnswer([pendingItem(9, { uploader: { id, display: id } })]) } } });
    await page.init();
    const mono = page.rows()[0]!.querySelectorAll('.font-mono').filter((el) => el.textContent === id);
    expect(mono.length).toBeGreaterThan(0);
    expect(mono[0]!.getAttribute('translate')).toBe('no');
  });

  it('reloads for the newly chosen workspace when #workspace-selector changes', async () => {
    const page = loadApprovalsPage({ workspaces: WORKSPACES, workspace: ORG });
    await page.init();
    page.selector.value = ORG_2;
    page.selector.dispatch('change');
    await flush();
    const lists = page.calls('list');
    expect(lists).toHaveLength(2);
    expect(lists[1]!.query.get('organizationId')).toBe(ORG_2);
    expect(page.root.querySelector('[data-upload-approvals-workspace]')!.textContent).toBe('Workspace: Team South');
  });
});

describe('Approve upload acts at once (UI-SPEC 6.6, decision 10)', () => {
  it('posts for the workspace, shows the in-flight state, removes the row and moves focus to the next row', async () => {
    const page = loadApprovalsPage({ workspaces: WORKSPACES, workspace: ORG, hold: ['approve'] });
    await page.init();
    const first = page.rows()[0]!;
    const approve = buttonByText(first, 'Approve upload');
    const reject = buttonByText(first, 'Reject upload');
    approve.click();
    await flush();
    expect(page.dialog()).toBeNull();
    const calls = page.calls('approve');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path.startsWith('/api/rag/admin/upload-approvals/20000000-0000-4000-8000-000000000001/approve')).toBe(true);
    expect(calls[0]!.query.get('organizationId')).toBe(ORG);
    expect(calls[0]!.body).toBeUndefined();
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toContain('Approving…');
    expect(reject.disabled).toBe(true);
    page.release('approve', { status: 200, body: { success: true } });
    await flush();
    expect(page.rows()).toHaveLength(1);
    expect(page.status().textContent).toBe('report-1.pdf is approved and searchable.');
    expect(page.tabButton('pending').textContent).toBe('Pending: 1');
    const next = buttonByText(page.rows()[0]!, 'Approve upload');
    expect(page.doc.activeElement).toBe(next);
  });

  it('moves focus to the status region when the last row is approved and then shows the empty state', async () => {
    const page = loadApprovalsPage({ replies: { list: { status: 200, body: listAnswer([pendingItem(1)]) } } });
    await page.init();
    buttonByText(page.rows()[0]!, 'Approve upload').click();
    await flush();
    expect(page.rows()).toHaveLength(0);
    expect(page.doc.activeElement).toBe(page.status());
    expect(page.root.textContent).toContain('No uploads awaiting approval');
  });

  it('a 409 not_pending shows the item-changed sentence and reloads the list', async () => {
    const page = loadApprovalsPage({ replies: { approve: { status: 409, body: { success: false, error: 'not_pending' } } } });
    await page.init();
    buttonByText(page.rows()[0]!, 'Approve upload').click();
    await flush();
    expect(page.calls('list')).toHaveLength(2);
    expect(page.status().textContent).toContain('This item was changed by someone else. The list has been reloaded.');
  });

  it('a 404 (another workspace or gone) is reported the same way', async () => {
    const page = loadApprovalsPage({ replies: { approve: { status: 404, body: { success: false, error: 'Document not found' } } } });
    await page.init();
    buttonByText(page.rows()[0]!, 'Approve upload').click();
    await flush();
    expect(page.calls('list')).toHaveLength(2);
    expect(page.status().textContent).toContain('This item was changed by someone else.');
  });

  it('a network failure keeps the row and re-enables its buttons', async () => {
    const page = loadApprovalsPage({ replies: { approve: { status: 0, throws: true } } });
    await page.init();
    const approve = buttonByText(page.rows()[0]!, 'Approve upload');
    approve.click();
    await flush();
    expect(page.rows()).toHaveLength(2);
    expect(approve.disabled).toBe(false);
    expect(page.status().className).toContain('text-error');
  });
});

describe('Reject upload asks first, in the error-colour dialog (UI-SPEC 12.1)', () => {
  it('opens the confirmation with the file name as text and Keep upload focused; nothing is posted until confirmed', async () => {
    const page = loadApprovalsPage({ replies: { list: { status: 200, body: listAnswer([pendingItem(1, { file_name: XSS_PAYLOAD })]) } } });
    await page.init();
    const reject = buttonByText(page.rows()[0]!, 'Reject upload');
    reject.click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain(`Reject ${XSS_PAYLOAD}?`);
    expect(dialog.textContent).toContain('The uploader is not notified.');
    expect(page.doc.activeElement).toBe(buttonByText(dialog, 'Keep upload'));
    expect(buttonByText(dialog, 'Reject upload').className).toContain('btn-error');
    expect(dialog.querySelectorAll('textarea')).toHaveLength(0);
    expect(dialog.querySelectorAll('input')).toHaveLength(0);
    expect(page.calls('reject')).toHaveLength(0);
    expect(injectedElements(page.doc)).toEqual([]);
    buttonByText(dialog, 'Keep upload').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.calls('reject')).toHaveLength(0);
    expect(page.rows()).toHaveLength(1);
    expect(page.doc.activeElement).toBe(reject);
  });

  it('posts on confirm without a reason, removes the row and announces it', async () => {
    const page = loadApprovalsPage({ workspaces: WORKSPACES, workspace: ORG });
    await page.init();
    buttonByText(page.rows()[0]!, 'Reject upload').click();
    await flush();
    buttonByText(page.dialog()!, 'Reject upload').click();
    await flush();
    const calls = page.calls('reject');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get('organizationId')).toBe(ORG);
    expect(calls[0]!.body).toBeUndefined();
    expect(page.dialog()).toBeNull();
    expect(page.rows()).toHaveLength(1);
    expect(page.status().textContent).toBe('report-1.pdf is rejected and removed.');
    expect(page.doc.activeElement).toBe(buttonByText(page.rows()[0]!, 'Approve upload'));
  });

  it('a 409 not_pending on reject reloads with the item-changed sentence', async () => {
    const page = loadApprovalsPage({ replies: { reject: { status: 409, body: { success: false, error: 'not_pending' } } } });
    await page.init();
    buttonByText(page.rows()[0]!, 'Reject upload').click();
    await flush();
    buttonByText(page.dialog()!, 'Reject upload').click();
    await flush();
    expect(page.calls('list')).toHaveLength(2);
    expect(page.status().textContent).toContain('This item was changed by someone else.');
  });
});

describe('States of the Pending view (UI-SPEC 7)', () => {
  it('with no pending upload shows the empty title and body', async () => {
    const page = loadApprovalsPage({ replies: { list: { status: 200, body: listAnswer([]) } } });
    await page.init();
    expect(page.root.querySelector('table')).toBeNull();
    expect(page.root.textContent).toContain('No uploads awaiting approval');
    expect(page.root.textContent).toContain('Uploads that need approval appear here. Until approved they are held out of answers.');
    expect(page.tabButton('pending').textContent).toBe('Pending: 0');
  });

  it('with the mode off shows the mode-is-off sentence and a link to Settings', async () => {
    const page = loadApprovalsPage({ replies: { list: { status: 200, body: listAnswer([], { mode: 'off' }) } } });
    await page.init();
    expect(page.root.querySelector('table')).toBeNull();
    expect(page.panel('pending').textContent).toContain('Upload approval is off, so uploads become searchable as soon as they are processed.');
    const link = buttonByText(page.panel('pending'), 'Open approval settings');
    expect(link.className).toContain('btn-link');
    link.click();
    await flush();
    expect(page.panel('settings').hidden).toBe(false);
    expect(page.panel('pending').hidden).toBe(true);
    expect(page.doc.activeElement).toBe(page.tabButton('settings'));
  });

  it('401 replaces the data views with the sign-in alert; Settings stays usable', async () => {
    const page = loadApprovalsPage({ replies: { list: { status: 401, body: {} }, exemptions: { status: 401, body: {} } } });
    await page.init();
    const pending = page.panel('pending');
    expect(pending.querySelector('.alert-warning')).toBeTruthy();
    expect(pending.querySelector('.bi-person-lock')).toBeTruthy();
    expect(buttonByText(pending, 'Reload panel')).toBeTruthy();
    expect(pending.querySelectorAll('input[type="password"]')).toHaveLength(0);
    page.tabButton('exemptions').click();
    await flush();
    expect(page.panel('exemptions').querySelector('.bi-person-lock')).toBeTruthy();
    page.tabButton('settings').click();
    const select = page.panel('settings').querySelector('#RAG_UPLOAD_APPROVAL');
    expect(select).toBeTruthy();
    expect(select!.disabled).toBe(false);
  });

  it('403 Forbidden (not a member of the workspace) shows the workspace sentence with Reload panel', async () => {
    const page = loadApprovalsPage({ replies: { list: { status: 403, body: { success: false, error: 'Forbidden' } } } });
    await page.init();
    expect(page.panel('pending').textContent).toContain('Your admin account is not a member of this workspace.');
    expect(buttonByText(page.panel('pending'), 'Reload panel')).toBeTruthy();
  });

  it('503 shows the unavailable sentence in the alert host with Reload panel; earlier rows stay, dimmed', async () => {
    let fail = false;
    const page = loadApprovalsPage({
      replies: { list: () => (fail ? { status: 503, body: { success: false, error: 'Upload approval administration is unavailable' } } : { status: 200, body: listAnswer([pendingItem(1)]) }) },
    });
    await page.init();
    fail = true;
    buttonByText(page.root, 'Refresh uploads').click();
    await flush();
    const alert = page.alertHost().querySelector('.alert-error')!;
    expect(alert.textContent).toContain('Upload approvals are unavailable right now. Select Reload panel in a moment.');
    expect(buttonByText(alert, 'Reload panel')).toBeTruthy();
    expect(page.rows()).toHaveLength(1);
    expect(page.rows()[0]!.closest('.opacity-60')).toBeTruthy();
    fail = false;
    buttonByText(alert, 'Reload panel').click();
    await flush();
    expect(page.alertHost().querySelector('.alert-error')).toBeNull();
  });

  it('first load shows the loading text in the content host', async () => {
    const page = loadApprovalsPage({ hold: ['list'] });
    const init = (page.context.initUploadApprovalsPanel as () => Promise<void>)();
    await flush();
    expect(page.panel('pending').textContent).toContain('Loading uploads…');
    page.release('list', { status: 200, body: listAnswer([]) });
    await init;
  });
});

describe('Paging: 50 per page with Load more (UI-SPEC 7.1, overflow)', () => {
  it('appends the next 50 and focuses the first new row; Load more disappears at the end', async () => {
    const all = Array.from({ length: 120 }, (_, i) => pendingItem(i + 1));
    const page = loadApprovalsPage({
      replies: {
        list: (call) => {
          const offset = Number(call.query.get('offset') ?? 0);
          const limit = Number(call.query.get('limit') ?? 50);
          return { status: 200, body: listAnswer(all.slice(offset, offset + limit), { total: all.length, offset }) };
        },
      },
    });
    await page.init();
    expect(page.rows()).toHaveLength(50);
    buttonByText(page.root, 'Load more uploads').click();
    await flush();
    expect(page.calls('list')[1]!.query.get('offset')).toBe('50');
    expect(page.rows()).toHaveLength(100);
    expect(page.doc.activeElement).toBe(buttonByText(page.rows()[50]!, 'Approve upload'));
    buttonByText(page.root, 'Load more uploads').click();
    await flush();
    expect(page.rows()).toHaveLength(120);
    expect(buttonsByText(page.root, 'Load more uploads')).toHaveLength(0);
  });

  it('after approving rows, Load more asks from the number of rows still listed', async () => {
    const all = Array.from({ length: 60 }, (_, i) => pendingItem(i + 1));
    const approved = new Set<string>();
    const page = loadApprovalsPage({
      replies: {
        list: (call) => {
          const rest = all.filter((item) => !approved.has(item.id as string));
          const offset = Number(call.query.get('offset') ?? 0);
          return { status: 200, body: listAnswer(rest.slice(offset, offset + 50), { total: rest.length }) };
        },
        approve: (call) => {
          approved.add(decodeURIComponent(call.path.split('/')[5]!));
          return { status: 200, body: { success: true } };
        },
      },
    });
    await page.init();
    for (let i = 0; i < 3; i += 1) {
      buttonByText(page.rows()[0]!, 'Approve upload').click();
      await flush();
      expect(page.doc.activeElement).toBe(buttonByText(page.rows()[0]!, 'Approve upload'));
    }
    expect(page.rows()).toHaveLength(47);
    buttonByText(page.root, 'Load more uploads').click();
    await flush();
    expect(page.calls('list').at(-1)!.query.get('offset')).toBe('47');
    expect(page.rows()).toHaveLength(57);
    expect(new Set(page.rows().map((r) => r.getAttribute('data-upload-approvals-row'))).size).toBe(57);
  });
});

describe('Exemptions (UI-SPEC 6.6)', () => {
  async function openExemptions(options: Parameters<typeof loadApprovalsPage>[0] = {}) {
    const page = loadApprovalsPage(options);
    await page.init();
    page.tabButton('exemptions').click();
    await flush();
    return page;
  }

  it('lists kind, name, added by and added time, loaded for the workspace', async () => {
    const page = await openExemptions({ workspaces: WORKSPACES, workspace: ORG });
    expect(page.calls('exemptions')).toHaveLength(1);
    expect(page.calls('exemptions')[0]!.query.get('organizationId')).toBe(ORG);
    const table = page.panel('exemptions').querySelector('table')!;
    expect(table.querySelector('caption')!.className).toContain('sr-only');
    expect(table.querySelectorAll('thead th').map((h) => h.textContent)).toEqual(['Kind', 'Name', 'Added by', 'Added', 'Actions']);
    const row = table.querySelector('tbody tr')!;
    expect(row.textContent).toContain('Uploader');
    expect(row.querySelector('th')!.getAttribute('scope')).toBe('row');
    expect(row.querySelector('th')!.textContent).toBe('member1@example.test');
    expect(row.textContent).toContain('admin@example.test');
    expect(row.querySelector('time')).toBeTruthy();
    expect(buttonByText(row, 'Remove exemption').getAttribute('aria-label')).toBe('Remove exemption: member1@example.test');
    expect(page.panel('exemptions').textContent).toContain('Uploads from an exempt connector or uploader skip approval');
  });

  it('Add exemption stays disabled until both selects have a value, with the reason referenced by aria-describedby', async () => {
    const page = await openExemptions();
    const panel = page.panel('exemptions');
    let add = buttonByText(panel, 'Add exemption');
    expect(add.disabled).toBe(true);
    const reasonId = add.getAttribute('aria-describedby')!;
    expect(reasonId).toBeTruthy();
    expect(page.doc.getElementById(reasonId)!.textContent).toBe('Choose a kind and a name to add an exemption.');
    const kind = page.doc.getElementById('rag-upload-approvals-exempt-kind')!;
    kind.value = 'uploader';
    kind.dispatch('change');
    add = buttonByText(page.panel('exemptions'), 'Add exemption');
    expect(add.disabled).toBe(true);
    const ref = page.doc.getElementById('rag-upload-approvals-exempt-ref')!;
    expect(ref.disabled).toBe(false);
    expect(ref.querySelectorAll('option').map((o) => o.textContent)).toEqual(['Choose a name', 'member7@example.test', '40000000-0000-4000-8000-000000000008']);
    ref.value = '40000000-0000-4000-8000-000000000007';
    ref.dispatch('change');
    add = buttonByText(page.panel('exemptions'), 'Add exemption');
    expect(add.disabled).toBe(false);
    expect(add.getAttribute('aria-describedby')).toBeNull();
    add.click();
    await flush();
    const posts = page.calls('addExemption');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ kind: 'uploader', ref: '40000000-0000-4000-8000-000000000007' });
    expect(page.calls('exemptions')).toHaveLength(2);
    expect(page.status().textContent).toBe('Exemption added: member7@example.test.');
  });

  it('Remove exemption sends DELETE with the id and the workspace, without a dialog', async () => {
    const page = await openExemptions({ workspaces: WORKSPACES, workspace: ORG });
    buttonByText(page.panel('exemptions'), 'Remove exemption').click();
    await flush();
    expect(page.dialog()).toBeNull();
    const calls = page.calls('removeExemption');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get('id')).toBe('50000000-0000-4000-8000-000000000001');
    expect(calls[0]!.query.get('organizationId')).toBe(ORG);
    expect(page.status().textContent).toBe('Exemption removed: member1@example.test. Their next uploads wait for approval.');
  });

  it('with no exemption the empty sentence shows under the form', async () => {
    const page = await openExemptions({ replies: { exemptions: { status: 200, body: exemptionsAnswer([]) } } });
    const panel = page.panel('exemptions');
    expect(panel.querySelector('table')).toBeNull();
    expect(panel.querySelector('fieldset')).toBeTruthy();
    expect(panel.textContent).toContain('No exemptions. Every gated upload waits for approval.');
  });
});

describe('Settings: RAG_UPLOAD_APPROVAL moves in from the hidden block (UI-SPEC 6.3, D-56)', () => {
  it('moves the approval group into the Settings sub-view', async () => {
    const page = loadApprovalsPage();
    await page.init();
    const group = page.doc.querySelector('[data-rag-settings-group="approval"]')!;
    expect(group.closest('#rag-phase032-settings')).toBeNull();
    expect(group.closest('#rag-upload-approvals-panel-settings')).toBeTruthy();
    expect(page.doc.querySelectorAll('#RAG_UPLOAD_APPROVAL')).toHaveLength(1);
  });

  it('warns that approval needs the unified ingest pipeline when it is not selected, and recomputes on change', async () => {
    const page = loadApprovalsPage({ pipeline: 'legacy', approvalMode: 'members' });
    await page.init();
    const warning = 'Upload approval needs the unified ingest pipeline.';
    expect(page.alertHost().textContent).toContain(warning);
    page.pipeline.value = 'unified';
    page.pipeline.dispatch('change');
    expect(page.alertHost().textContent).not.toContain(warning);
    page.pipeline.value = 'legacy';
    page.pipeline.dispatch('change');
    expect(page.alertHost().textContent).toContain(warning);
    const approval = page.doc.getElementById('RAG_UPLOAD_APPROVAL')!;
    approval.value = 'off';
    approval.dispatch('change');
    expect(page.alertHost().textContent).not.toContain(warning);
  });

  it('localizes the setting in zh and it through data-rag-i18n', async () => {
    const page = loadApprovalsPage({ locale: 'zh-CN' });
    await page.init();
    const group = page.doc.querySelector('[data-rag-settings-group="approval"]')!;
    expect(group.textContent).toContain('需要批准的上传');
    expect(page.tabButton('pending').textContent).toBe('待批准：2');
    expect(page.root.getAttribute('lang')).toBe('zh');
    const badge = page.rows()[0]!.querySelector('.badge')!;
    expect(badge.textContent).toBe('等待批准');
  });

  it('nothing notifies admins beyond the count in the sub-tab label (D-37)', async () => {
    const page = loadApprovalsPage();
    await page.init();
    expect(page.doc.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});

describe('Server strings never become markup (UI-SPEC 11.2)', () => {
  it('file names, uploader names, sources, doc types and exemption names containing markup create no element', async () => {
    const page = loadApprovalsPage({
      replies: {
        list: {
          status: 200,
          body: listAnswer([
            pendingItem(1, { file_name: XSS_PAYLOAD, uploader: { id: 'u1', display: XSS_PAYLOAD }, source: XSS_PAYLOAD, doc_type: XSS_PAYLOAD }),
            pendingItem(2, { uploader: { id: XSS_PAYLOAD, display: '' } }),
          ]),
        },
        exemptions: {
          status: 200,
          body: exemptionsAnswer([exemptionItem(1, { display: XSS_PAYLOAD, kind: XSS_PAYLOAD, added_by: { id: 'x', display: XSS_PAYLOAD } })], {
            choices: { uploader: [{ ref: XSS_PAYLOAD, display: XSS_PAYLOAD }], connector: [] },
          }),
        },
      },
    });
    await page.init();
    page.tabButton('exemptions').click();
    await flush();
    const kind = page.doc.getElementById('rag-upload-approvals-exempt-kind')!;
    kind.value = 'uploader';
    kind.dispatch('change');
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.root.textContent).toContain(XSS_PAYLOAD);
    buttonByText(page.rows()[0]!, 'Reject upload').click();
    await flush();
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.doc.querySelectorAll('a')).toHaveLength(2);
  });
});
