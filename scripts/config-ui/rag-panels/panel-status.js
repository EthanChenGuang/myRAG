/**
 * Status reporting shared by the RAG administration panels (UI-SPEC amendment 261127-tfs). The panel's status region stays the only
 * live region. A completed action passes { toast: true }: its rendered sentence is also shown in the page toast, aria-hidden so screen
 * readers hear it once. Errors never toast.
 */
function ragPanelSetStatus(host, render, isError, options) {
  render();
  if (isError || !options || !options.toast || !host) return;
  const text = String(host.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const scope = typeof window !== 'undefined' ? window : globalThis;
  if (typeof scope.showToast === 'function') scope.showToast(text, 'success', { ariaHidden: true });
}

if (typeof window !== 'undefined') window.ragPanelSetStatus = ragPanelSetStatus;
if (typeof module !== 'undefined' && module.exports) module.exports = { ragPanelSetStatus };
