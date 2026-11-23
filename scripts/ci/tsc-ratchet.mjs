export function countDiagnostics() {
  return { files: {}, fileless: 0, total: 0 };
}

export function compareToBaseline() {
  return { ok: true, violations: [], improved: [] };
}
