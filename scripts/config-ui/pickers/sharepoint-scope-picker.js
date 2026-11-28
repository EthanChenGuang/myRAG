/**
 * SharePoint Online and OneDrive for Business scope picker (Phase 6.3, D-22, UI-SPEC 6.7).
 *
 * A drill-down list, one level per request: Sites, libraries, folders (OneDrive starts at Libraries). Site, library
 * and folder names are third-party text: every element is built with createElement and textContent, the Modal base
 * gets a fixed title and an empty host (UI-SPEC finding 14). Only id, name and has_children of a listed item are read.
 */

const SHAREPOINT_SCOPE_PROVIDER_NAMES = {
    'sharepoint-online': 'SharePoint Online',
    'one-drive': 'OneDrive for Business',
};

const SHAREPOINT_SCOPE_KIND_TEXT = {
    sites: { loading: 'Loading sites…', more: 'Load more sites', open: 'Open site', icon: 'bi-globe2' },
    drives: { loading: 'Loading libraries…', more: 'Load more libraries', open: 'Open library', icon: 'bi-collection' },
    folders: { loading: 'Loading folders…', more: 'Load more folders', open: 'Open folder', icon: 'bi-folder' },
};

const SHAREPOINT_SCOPE_TEXT = {
    title: 'Choose what to sync',
    rootSites: 'Sites',
    rootLibraries: 'Libraries',
    searchLabel: 'Search sites',
    searchPlaceholder: 'Search sites by name…',
    searchPrompt: 'Type at least 2 characters to find a site.',
    emptySites: 'No site was found for this account. The connected account needs access to at least one site.',
    emptyLibraries: 'This site has no document library the connected account can read.',
    emptyFolders: 'This folder has no sub-folders. Select it to sync the files in it.',
    loadFailed: 'This list could not be loaded.',
    throttled: 'The source is limiting requests. Wait a moment, then select Reload list.',
    signIn: 'Your session has ended. Sign in again, then reopen the picker.',
    reload: 'Reload list',
    nothing: 'Nothing selected',
    showSelection: 'Show selection',
    remove: 'Remove',
    close: 'Close picker',
    discard: 'Discard changes',
    save: 'Save selection',
    saving: 'Saving…',
    saveFailed: 'The selection was not saved. Try again.',
};

const SHAREPOINT_SCOPE_SEARCH_DELAY_MS = 300;

function sharePointScopeEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
}

function sharePointScopeIcon(name) {
    const icon = sharePointScopeEl('i', `bi ${name}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function sharePointScopeSpinner() {
    const spinner = sharePointScopeEl('span', 'loading loading-spinner loading-sm motion-reduce:hidden');
    spinner.setAttribute('aria-hidden', 'true');
    return spinner;
}

function sharePointScopeCounts(selection) {
    const value = selection && typeof selection === 'object' ? selection : {};
    const count = (list) => (Array.isArray(list) ? list.length : 0);
    return { sites: count(value.sites), drives: count(value.drives), folders: count(value.folders) };
}

/** The selection button text of a provider card: the empty prompt, or the saved counts (UI-SPEC 12.6). */
function buildSharePointScopeSummary(selection, provider) {
    const counts = sharePointScopeCounts(selection);
    const oneDrive = provider === 'one-drive';
    const hasSelection = counts.sites + counts.drives + counts.folders > 0;
    let label;
    if (!hasSelection) {
        label = oneDrive ? 'Choose libraries and folders' : 'Choose sites, libraries and folders';
    } else if (oneDrive) {
        label = `Libraries: ${counts.drives}, folders: ${counts.folders}`;
    } else {
        label = `Sites: ${counts.sites}, libraries: ${counts.drives}, folders: ${counts.folders}`;
    }
    return { hasSelection, label, counts };
}

function sharePointScopeKey(kind, id, driveId) {
    if (kind === 'sites') return `site:${id}`;
    if (kind === 'drives') return `drive:${id}`;
    return `folder:${driveId}:${id}`;
}

class SharePointScopePickerModal extends (typeof Modal !== 'undefined' ? Modal : class {}) {
    /**
     * @param {'sharepoint-online'|'one-drive'} provider
     * @param {{ savedScope?: object, modeLabel?: string, fetch?: Function, save?: Function, onSaved?: Function }} options
     */
    constructor(provider, options = {}) {
        super({
            id: `sharepoint-scope-picker-${provider === 'one-drive' ? 'one-drive' : 'sharepoint-online'}`,
            title: SHAREPOINT_SCOPE_TEXT.title,
            size: 'lg',
            closeOnEscape: true,
            closeOnBackdrop: true,
        });
        this.provider = provider === 'one-drive' ? 'one-drive' : 'sharepoint-online';
        this.oneDrive = this.provider === 'one-drive';
        this.fetchImpl = options.fetch || ((...args) => fetch(...args));
        this.saveImpl = options.save || null;
        this.onSaved = options.onSaved || null;
        this.modeLabel = options.modeLabel || 'Default (current behaviour)';

        this.ancestry = new Map();
        this.driveSites = new Map();
        this.saved = this.selectionFromScope(options.savedScope);
        this.selection = new Map(this.saved);

        this.levels = [this.oneDrive ? { kind: 'drives', name: SHAREPOINT_SCOPE_TEXT.rootLibraries } : { kind: 'sites', name: SHAREPOINT_SCOPE_TEXT.rootSites }];
        this.view = { items: [], cursor: null, status: 'loading', more: false };
        this.query = '';
        this.requestSeq = 0;
        this.searchTimer = null;
        this.saving = false;
        this.saveError = false;
        this.selectionOpen = false;
        this.resolvePromise = null;
        this.didSave = false;
    }

    selectionFromScope(scope) {
        const map = new Map();
        if (!scope || typeof scope !== 'object') return map;
        for (const site of Array.isArray(scope.sites) ? scope.sites : []) {
            if (!site || !site.id) continue;
            map.set(sharePointScopeKey('sites', site.id), { kind: 'sites', id: String(site.id), name: String(site.name || site.id), path: [String(site.name || site.id)] });
        }
        for (const drive of Array.isArray(scope.drives) ? scope.drives : []) {
            if (!drive || !drive.id) continue;
            const entry = { kind: 'drives', id: String(drive.id), name: String(drive.name || drive.id), path: [String(drive.name || drive.id)] };
            if (drive.parentId) {
                entry.parentId = String(drive.parentId);
                this.driveSites.set(entry.id, entry.parentId);
            }
            map.set(sharePointScopeKey('drives', entry.id), entry);
        }
        for (const folder of Array.isArray(scope.folders) ? scope.folders : []) {
            if (!folder || !folder.id || !folder.driveId) continue;
            const entry = { kind: 'folders', id: String(folder.id), name: String(folder.name || folder.id), driveId: String(folder.driveId), path: [String(folder.name || folder.id)] };
            if (folder.parentId) entry.parentId = String(folder.parentId);
            map.set(sharePointScopeKey('folders', entry.id, entry.driveId), entry);
        }
        return map;
    }

    /** Opens the picker; resolves with { saved } when it closes. */
    openPicker() {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            this.open('<div data-sharepoint-scope-host></div>');
            this.host = this.modalElement.querySelector('[data-sharepoint-scope-host]');
            this.buildFrame();
            this.loadLevel(false);
        });
    }

    close() {
        if (this.saving) return;
        if (!this.isOpen) return;
        if (this.searchTimer) clearTimeout(this.searchTimer);
        super.close();
        if (this.handleEscape) document.removeEventListener('keydown', this.handleEscape);
        if (this.handleTabKey) document.removeEventListener('keydown', this.handleTabKey);
        if (this.resolvePromise) {
            const resolve = this.resolvePromise;
            this.resolvePromise = null;
            resolve({ saved: this.didSave });
        }
    }

    buildFrame() {
        const root = sharePointScopeEl('div', 'space-y-4');
        this.crumbHost = sharePointScopeEl('nav');
        this.crumbHost.setAttribute('aria-label', 'Location');
        this.searchHost = sharePointScopeEl('div');
        this.listRegion = sharePointScopeEl('div', 'border border-base-300 rounded-lg max-h-96 overflow-y-auto overscroll-contain p-2');
        this.listRegion.setAttribute('data-sharepoint-scope-list', '');
        this.listRegion.setAttribute('aria-busy', 'true');
        this.summaryHost = sharePointScopeEl('div', 'p-2 bg-base-200 rounded-lg space-y-2');
        this.warningHost = sharePointScopeEl('div');
        this.errorHost = sharePointScopeEl('div');
        this.buttonHost = sharePointScopeEl('div', 'sticky bottom-0 bg-base-100 flex flex-wrap justify-end gap-2 pt-4 border-t border-base-300');
        root.append(this.crumbHost, this.searchHost, this.listRegion, this.summaryHost, this.warningHost, this.errorHost, this.buttonHost);
        this.host.appendChild(root);
        this.renderAll();
    }

    get level() {
        return this.levels[this.levels.length - 1];
    }

    /** Keys of the items above the current level, outermost first. */
    levelAncestors() {
        const keys = [];
        for (let index = 1; index < this.levels.length; index += 1) {
            const entry = this.levels[index];
            keys.push({ key: sharePointScopeKey(entry.itemKind, entry.id, entry.driveId), name: entry.name });
        }
        return keys;
    }

    levelUrl(cursor) {
        const level = this.level;
        const params = [];
        let base;
        if (level.kind === 'sites') {
            base = '/api/nango/sharepoint/sites';
            if (this.query.trim().length >= 2) params.push(`query=${encodeURIComponent(this.query.trim())}`);
        } else if (level.kind === 'drives') {
            base = '/api/nango/sharepoint/drives';
            if (!this.oneDrive) params.push(`site_id=${encodeURIComponent(level.siteId)}`);
        } else {
            base = '/api/nango/sharepoint/folders';
            params.push(`drive_id=${encodeURIComponent(level.driveId)}`);
            if (level.folderId) params.push(`item_id=${encodeURIComponent(level.folderId)}`);
        }
        if (this.oneDrive) params.push('provider=one-drive');
        if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
        return params.length ? `${base}?${params.join('&')}` : base;
    }

    async loadLevel(more) {
        const seq = ++this.requestSeq;
        const url = this.levelUrl(more ? this.view.cursor : null);
        if (more) {
            this.view.more = true;
        } else {
            this.view = { items: [], cursor: null, status: 'loading', more: false };
        }
        this.renderList();
        let outcome;
        try {
            const response = await this.fetchImpl(url, { method: 'GET', credentials: 'same-origin' });
            if (response.status === 401 || response.status === 403) outcome = { status: 'signin' };
            else if (response.status === 429) outcome = { status: 'throttled' };
            else if (!response.ok) outcome = { status: 'error' };
            else {
                const body = await response.json();
                const items = (Array.isArray(body && body.items) ? body.items : [])
                    .filter((item) => item && typeof item.id === 'string' && item.id)
                    .map((item) => ({ id: item.id, name: typeof item.name === 'string' && item.name ? item.name : item.id, hasChildren: item.has_children !== false }));
                outcome = { status: 'ready', items, cursor: typeof body.cursor === 'string' && body.cursor ? body.cursor : null };
            }
        } catch {
            outcome = { status: 'error' };
        }
        if (seq !== this.requestSeq || !this.isOpen) return;
        const firstNew = this.view.items.length;
        if (outcome.status === 'ready') {
            this.view = { items: more ? this.view.items.concat(outcome.items) : outcome.items, cursor: outcome.cursor, status: 'ready', more: false };
        } else {
            this.view = { items: more ? this.view.items : [], cursor: more ? this.view.cursor : null, status: outcome.status, more: false };
        }
        this.renderList();
        if (outcome.status !== 'ready') return;
        if (more) {
            const boxes = this.listRegion.querySelectorAll('input[type="checkbox"]');
            if (boxes[firstNew]) boxes[firstNew].focus();
        } else if (this.headingEl) {
            this.headingEl.focus();
        }
    }

    goTo(index) {
        if (index < 0 || index >= this.levels.length - 1) return;
        this.levels = this.levels.slice(0, index + 1);
        if (this.level.kind !== 'sites') this.query = '';
        this.renderCrumbs();
        this.renderSearch();
        this.loadLevel(false);
    }

    openItem(item) {
        const level = this.level;
        let next;
        if (level.kind === 'sites') {
            next = { kind: 'drives', itemKind: 'sites', id: item.id, name: item.name, siteId: item.id };
        } else if (level.kind === 'drives') {
            if (!this.oneDrive && level.siteId) this.driveSites.set(item.id, level.siteId);
            next = { kind: 'folders', itemKind: 'drives', id: item.id, name: item.name, siteId: level.siteId, driveId: item.id, folderId: null };
        } else {
            next = { kind: 'folders', itemKind: 'folders', id: item.id, name: item.name, siteId: level.siteId, driveId: level.driveId, folderId: item.id };
        }
        this.levels.push(next);
        this.renderCrumbs();
        this.renderSearch();
        this.loadLevel(false);
    }

    itemKey(item) {
        return sharePointScopeKey(this.level.kind, item.id, this.level.driveId);
    }

    /** Known ancestor keys of a selected entry, from this session's levels or from the saved parent ids. */
    ancestorsOf(key, entry) {
        const known = this.ancestry.get(key);
        if (known) return known;
        const keys = [];
        if (!entry) return keys;
        if (entry.kind === 'drives' && entry.parentId) keys.push(sharePointScopeKey('sites', entry.parentId));
        if (entry.kind === 'folders') {
            const site = this.driveSites.get(entry.driveId);
            if (site) keys.push(sharePointScopeKey('sites', site));
            keys.push(sharePointScopeKey('drives', entry.driveId));
            if (entry.parentId) keys.push(sharePointScopeKey('folders', entry.parentId, entry.driveId));
        }
        return keys;
    }

    coveringAncestor() {
        for (const ancestor of this.levelAncestors()) {
            if (this.selection.has(ancestor.key)) return ancestor;
        }
        return null;
    }

    toggleItem(item, checked) {
        const key = this.itemKey(item);
        const ancestors = this.levelAncestors();
        if (checked) {
            const level = this.level;
            const path = ancestors.map((ancestor) => ancestor.name).concat(item.name);
            const entry = { kind: level.kind, id: item.id, name: item.name, path };
            if (level.kind === 'drives' && !this.oneDrive && level.siteId) entry.parentId = level.siteId;
            if (level.kind === 'folders') {
                entry.driveId = level.driveId;
                if (level.folderId) entry.parentId = level.folderId;
            }
            this.ancestry.set(key, ancestors.map((ancestor) => ancestor.key));
            for (const [otherKey, other] of [...this.selection]) {
                if (otherKey !== key && this.ancestorsOf(otherKey, other).includes(key)) this.selection.delete(otherKey);
            }
            this.selection.set(key, entry);
        } else {
            this.selection.delete(key);
        }
        this.saveError = false;
        this.renderSelectionState();
    }

    removeEntry(key) {
        this.selection.delete(key);
        this.saveError = false;
        this.renderList();
        this.renderSelectionState();
    }

    hasChanges() {
        if (this.saved.size !== this.selection.size) return true;
        for (const key of this.saved.keys()) if (!this.selection.has(key)) return true;
        return false;
    }

    removedCount() {
        let count = 0;
        for (const [key, entry] of this.saved) {
            if (this.selection.has(key)) continue;
            if (this.ancestorsOf(key, entry).some((ancestor) => this.selection.has(ancestor))) continue;
            count += 1;
        }
        return count;
    }

    scopeFromSelection() {
        const scope = { sites: [], drives: [], folders: [] };
        for (const entry of this.selection.values()) {
            if (entry.kind === 'sites') {
                scope.sites.push({ id: entry.id, name: entry.name });
            } else if (entry.kind === 'drives') {
                const drive = { id: entry.id, name: entry.name };
                if (entry.parentId) drive.parentId = entry.parentId;
                scope.drives.push(drive);
            } else {
                const folder = { id: entry.id, name: entry.name, driveId: entry.driveId };
                if (entry.parentId) folder.parentId = entry.parentId;
                scope.folders.push(folder);
            }
        }
        return scope;
    }

    async defaultSave(scope) {
        const response = await this.fetchImpl('/api/nango/connections', {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: this.provider, sourceScope: scope }),
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
    }

    async save() {
        if (this.saving || !this.hasChanges()) return;
        const scope = this.scopeFromSelection();
        this.saving = true;
        this.saveError = false;
        this.renderSelectionState();
        let ok = true;
        try {
            if (this.saveImpl) await this.saveImpl(scope);
            else await this.defaultSave(scope);
        } catch {
            ok = false;
        }
        this.saving = false;
        if (!ok) {
            this.saveError = true;
            this.renderSelectionState();
            const saveButton = this.buttonHost.querySelector('.btn-primary');
            if (saveButton) saveButton.focus();
            return;
        }
        this.didSave = true;
        this.close();
        if (this.onSaved) this.onSaved(`Selection saved for ${SHAREPOINT_SCOPE_PROVIDER_NAMES[this.provider]}.`, scope);
    }

    renderAll() {
        this.renderCrumbs();
        this.renderSearch();
        this.renderList();
        this.renderSelectionState();
    }

    renderCrumbs() {
        const trail = sharePointScopeEl('div', 'breadcrumbs text-sm whitespace-normal');
        const list = sharePointScopeEl('ol', 'flex-wrap');
        this.levels.forEach((level, index) => {
            const li = sharePointScopeEl('li', 'min-w-0');
            const name = sharePointScopeEl('span', 'truncate max-w-40 inline-block align-bottom', level.name);
            name.title = level.name;
            if (index > 0) name.setAttribute('translate', 'no');
            if (index === this.levels.length - 1) {
                name.setAttribute('aria-current', 'page');
                li.appendChild(name);
            } else {
                const button = sharePointScopeEl('button', 'btn btn-link btn-sm px-0');
                button.type = 'button';
                button.appendChild(name);
                button.addEventListener('click', () => this.goTo(index));
                li.appendChild(button);
            }
            list.appendChild(li);
        });
        trail.appendChild(list);
        this.crumbHost.replaceChildren(trail);
    }

    renderSearch() {
        if (this.level.kind !== 'sites') {
            this.searchHost.replaceChildren();
            this.searchInput = null;
            return;
        }
        if (this.searchInput && this.searchHost.contains(this.searchInput)) return;
        const control = sharePointScopeEl('div', 'form-control');
        const inputId = `${this.id}-search`;
        const label = sharePointScopeEl('label', 'label');
        label.setAttribute('for', inputId);
        label.appendChild(sharePointScopeEl('span', 'label-text', SHAREPOINT_SCOPE_TEXT.searchLabel));
        const input = sharePointScopeEl('input', 'input input-bordered input-sm w-full');
        input.type = 'search';
        input.id = inputId;
        input.name = 'sharepoint-scope-search';
        input.placeholder = SHAREPOINT_SCOPE_TEXT.searchPlaceholder;
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.value = this.query;
        input.addEventListener('input', () => {
            if (this.searchTimer) clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.searchTimer = null;
                const next = String(input.value || '');
                const effective = (value) => (value.trim().length >= 2 ? value.trim() : '');
                const changed = effective(next) !== effective(this.query);
                this.query = next;
                if (changed) this.loadLevel(false);
                else this.renderList();
            }, SHAREPOINT_SCOPE_SEARCH_DELAY_MS);
        });
        control.append(label, input);
        this.searchInput = input;
        this.searchHost.replaceChildren(control);
    }

    headingText(count) {
        const level = this.level;
        if (level.kind === 'sites') return `Sites: ${count}`;
        if (level.kind === 'drives') return this.oneDrive ? `Libraries: ${count}` : `Libraries of ${level.name}: ${count}`;
        return `Folders in ${level.name}: ${count}`;
    }

    emptyLines() {
        const kind = this.level.kind;
        if (kind === 'sites') {
            const query = this.query.trim();
            if (query.length >= 2) return [`No site matches “${query}”.`];
            return [SHAREPOINT_SCOPE_TEXT.emptySites, SHAREPOINT_SCOPE_TEXT.searchPrompt];
        }
        if (kind === 'drives') return [SHAREPOINT_SCOPE_TEXT.emptyLibraries];
        return [SHAREPOINT_SCOPE_TEXT.emptyFolders];
    }

    renderList() {
        const view = this.view;
        const kindText = SHAREPOINT_SCOPE_KIND_TEXT[this.level.kind];
        const busy = view.status === 'loading' || view.more;
        this.listRegion.setAttribute('aria-busy', busy ? 'true' : 'false');
        this.headingEl = null;
        const nodes = [];

        if (view.status === 'loading') {
            const line = sharePointScopeEl('p', 'flex items-center gap-2 p-2 text-sm text-base-content/70');
            line.append(sharePointScopeSpinner(), sharePointScopeEl('span', '', kindText.loading));
            nodes.push(line);
        } else if (view.status === 'signin') {
            const alert = sharePointScopeEl('div', 'alert alert-warning');
            alert.append(sharePointScopeIcon('bi-exclamation-triangle'), sharePointScopeEl('span', '', SHAREPOINT_SCOPE_TEXT.signIn));
            const closeButton = sharePointScopeEl('button', 'btn btn-ghost btn-sm', SHAREPOINT_SCOPE_TEXT.close);
            closeButton.type = 'button';
            closeButton.addEventListener('click', () => this.close());
            alert.appendChild(closeButton);
            nodes.push(alert);
        } else if (view.status === 'throttled' || view.status === 'error') {
            const throttled = view.status === 'throttled';
            const alert = sharePointScopeEl('div', `alert ${throttled ? 'alert-warning' : 'alert-error'}`);
            alert.append(
                sharePointScopeIcon(throttled ? 'bi-hourglass-split' : 'bi-x-circle'),
                sharePointScopeEl('span', '', throttled ? SHAREPOINT_SCOPE_TEXT.throttled : SHAREPOINT_SCOPE_TEXT.loadFailed),
            );
            const reload = sharePointScopeEl('button', 'btn btn-outline btn-sm', SHAREPOINT_SCOPE_TEXT.reload);
            reload.type = 'button';
            reload.addEventListener('click', () => this.loadLevel(false));
            alert.appendChild(reload);
            nodes.push(alert);
        } else {
            const heading = sharePointScopeEl('h4', 'sr-only', this.headingText(view.items.length));
            heading.setAttribute('tabindex', '-1');
            this.headingEl = heading;
            nodes.push(heading);
            if (view.items.length === 0) {
                for (const line of this.emptyLines()) nodes.push(sharePointScopeEl('p', 'p-2 text-sm text-base-content/70 break-words', line));
            } else {
                const list = sharePointScopeEl('ul', `divide-y divide-base-300${view.more ? ' opacity-60' : ''}`);
                const covering = this.coveringAncestor();
                for (const item of view.items) list.appendChild(this.renderRow(item, covering, kindText));
                nodes.push(list);
            }
            if (view.cursor) {
                const more = sharePointScopeEl('button', 'btn btn-outline btn-sm mt-2');
                more.type = 'button';
                if (view.more) {
                    more.disabled = true;
                    more.append(sharePointScopeSpinner(), sharePointScopeEl('span', '', kindText.loading));
                } else {
                    more.textContent = kindText.more;
                }
                more.addEventListener('click', () => this.loadLevel(true));
                nodes.push(more);
            }
        }
        this.listRegion.replaceChildren(...nodes);
    }

    renderRow(item, covering, kindText) {
        const li = sharePointScopeEl('li', 'flex items-center gap-2 p-2 rounded-md hover:bg-base-200');
        const label = sharePointScopeEl('label', `flex items-center gap-2 min-w-0 flex-1 ${covering ? 'cursor-default' : 'cursor-pointer'}`);
        const box = sharePointScopeEl('input', 'checkbox checkbox-sm');
        box.type = 'checkbox';
        const key = this.itemKey(item);
        if (covering) {
            box.checked = true;
            box.disabled = true;
        } else {
            box.checked = this.selection.has(key);
            box.addEventListener('change', () => this.toggleItem(item, !!box.checked));
        }
        const text = sharePointScopeEl('span', 'min-w-0 flex flex-col');
        const name = sharePointScopeEl('span', 'truncate', item.name);
        name.title = item.name;
        name.setAttribute('translate', 'no');
        text.appendChild(name);
        if (covering) text.appendChild(sharePointScopeEl('span', 'text-xs text-base-content/60 truncate', `Included by ${covering.name}`));
        label.append(box, sharePointScopeIcon(kindText.icon), text);
        li.appendChild(label);
        if (item.hasChildren) {
            const open = sharePointScopeEl('button', 'btn btn-ghost btn-sm shrink-0');
            open.type = 'button';
            open.setAttribute('aria-label', `${kindText.open} ${item.name}`);
            open.append(sharePointScopeEl('span', '', kindText.open), sharePointScopeIcon('bi-chevron-right'));
            open.addEventListener('click', () => this.openItem(item));
            li.appendChild(open);
        }
        return li;
    }

    summaryText() {
        if (this.selection.size === 0) return SHAREPOINT_SCOPE_TEXT.nothing;
        const counts = sharePointScopeCounts(this.scopeFromSelection());
        if (this.oneDrive) return `Selected: libraries ${counts.drives}, folders ${counts.folders}`;
        return `Selected: sites ${counts.sites}, libraries ${counts.drives}, folders ${counts.folders}`;
    }

    renderSelectionState() {
        const bar = sharePointScopeEl('p', 'text-sm text-base-content/70', this.summaryText());
        const nodes = [bar];
        if (this.selection.size > 0) {
            const details = sharePointScopeEl('details');
            details.open = this.selectionOpen;
            if (this.selectionOpen) details.setAttribute('open', '');
            details.addEventListener('toggle', () => {
                this.selectionOpen = !!details.open;
            });
            const summary = sharePointScopeEl('summary', 'cursor-pointer text-sm', SHAREPOINT_SCOPE_TEXT.showSelection);
            const list = sharePointScopeEl('ul', 'mt-2 space-y-1');
            for (const [key, entry] of this.selection) {
                const li = sharePointScopeEl('li', 'flex items-start justify-between gap-2');
                const pathText = sharePointScopeEl('span', 'text-sm break-words min-w-0', entry.path.join(' / '));
                pathText.setAttribute('translate', 'no');
                li.appendChild(pathText);
                const remove = sharePointScopeEl('button', 'btn btn-ghost btn-xs shrink-0', SHAREPOINT_SCOPE_TEXT.remove);
                remove.type = 'button';
                remove.disabled = this.saving;
                remove.setAttribute('aria-label', `Remove ${entry.name} from the selection`);
                remove.addEventListener('click', () => {
                    this.selectionOpen = true;
                    this.removeEntry(key);
                    const nextSummary = this.summaryHost.querySelector('summary');
                    if (nextSummary) nextSummary.focus();
                });
                li.appendChild(remove);
                list.appendChild(li);
            }
            details.append(summary, list);
            nodes.push(details);
        }
        this.summaryHost.replaceChildren(...nodes);

        const removed = this.removedCount();
        if (removed > 0) {
            const warning = sharePointScopeEl('div', 'alert alert-warning');
            warning.append(
                sharePointScopeIcon('bi-exclamation-triangle'),
                sharePointScopeEl(
                    'span',
                    '',
                    `Removed from the selection: ${removed}. Files outside the new selection are removed from the knowledge base at the next full sync, following this connection's deletion mode (${this.modeLabel}).`,
                ),
            );
            this.warningHost.replaceChildren(warning);
        } else {
            this.warningHost.replaceChildren();
        }

        if (this.saveError) {
            const line = sharePointScopeEl('p', 'text-sm text-error', SHAREPOINT_SCOPE_TEXT.saveFailed);
            line.setAttribute('role', 'alert');
            this.errorHost.replaceChildren(line);
        } else {
            this.errorHost.replaceChildren();
        }

        const changed = this.hasChanges();
        const dismiss = sharePointScopeEl('button', 'btn btn-ghost', changed ? SHAREPOINT_SCOPE_TEXT.discard : SHAREPOINT_SCOPE_TEXT.close);
        dismiss.type = 'button';
        dismiss.disabled = this.saving;
        dismiss.addEventListener('click', () => this.close());
        const save = sharePointScopeEl('button', 'btn btn-primary');
        save.type = 'button';
        save.disabled = this.saving || !changed;
        if (this.saving) save.append(sharePointScopeSpinner(), sharePointScopeEl('span', '', SHAREPOINT_SCOPE_TEXT.saving));
        else save.textContent = SHAREPOINT_SCOPE_TEXT.save;
        save.addEventListener('click', () => this.save());
        this.buttonHost.replaceChildren(dismiss, save);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SharePointScopePickerModal, buildSharePointScopeSummary };
}
