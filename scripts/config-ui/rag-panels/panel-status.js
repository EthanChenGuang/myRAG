function ragPanelSetStatus(host, render) {
  render();
}

if (typeof window !== 'undefined') window.ragPanelSetStatus = ragPanelSetStatus;
if (typeof module !== 'undefined' && module.exports) module.exports = { ragPanelSetStatus };
