/**
 * SharePoint and OneDrive scope picker (Phase 6.3, D-22, UI-SPEC 6.7). Stub.
 */

class SharePointScopePickerModal extends (typeof Modal !== 'undefined' ? Modal : class {}) {
    openPicker() {
        return new Promise(() => {});
    }
}

function buildSharePointScopeSummary() {
    return { hasSelection: false, label: '' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SharePointScopePickerModal, buildSharePointScopeSummary };
}
