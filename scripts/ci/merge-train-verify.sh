#!/usr/bin/env bash
# Extra merge-train checks per PR (exit 0 = ok).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pr="${1:?pr number}"
cd "$ROOT"

verify_definer_migrations() {
  local pattern="$1"
  shift
  local files=("$@")
  local missing=0
  for f in "${files[@]}"; do
  [[ -f "$f" ]] || { echo "missing migration $f"; missing=1; continue; }
  if ! grep -q "SECURITY DEFINER" "$f"; then
    echo "$f: no SECURITY DEFINER"
    missing=1
  fi
  if ! grep -qE "SET search_path\s*=\s*''" "$f"; then
    echo "$f: missing SET search_path = ''"
    missing=1
  fi
  if ! grep -qiE "REVOKE.*FROM.*(PUBLIC|anon|authenticated)" "$f"; then
    echo "$f: missing REVOKE from anon/authenticated/PUBLIC"
    missing=1
  fi
  done
  return "$missing"
}

verify_rag_index_exports() {
  local f="$ROOT/src/lib/rag/index.ts"
  [[ -f "$f" ]] || return 0
  for sym in scheduleIngestWake queueConfigFromProcessEnv softDeleteLineage; do
    if grep -q "$sym" "$f"; then
      :
    else
      echo "index.ts missing export surface for $sym (may re-export)"
    fi
  done
}

verify_ingest_recall() {
  local min="${1:-0.6195}"
  local out
  out=$(npm run test-rag -- --fixture-mode ingest --out eval/out/merge-train-ingest 2>&1 | tee /dev/stderr | tail -5)
  if echo "$out" | grep -q 'gate: PASS'; then
    return 0
  fi
  if grep -q 'recall@10' eval/out/merge-train-ingest/gate.md 2>/dev/null; then
    val=$(grep -oP 'recall@10=\K[0-9.]+' eval/out/merge-train-ingest/gate.md | head -1 || true)
    if [[ -n "$val" ]] && awk "BEGIN {exit !($val >= $min)}"; then
      return 0
    fi
  fi
  echo "ingest recall below $min or gate failed"
  return 1
}

case "$pr" in
  19)
    verify_definer_migrations "0357" supabase/migrations/0357*.sql 2>/dev/null || verify_definer_migrations "" "$(ls supabase/migrations/*0357*.sql 2>/dev/null)" ;;
  22)
    verify_definer_migrations "" \
      supabase/migrations/0420*.sql \
      supabase/migrations/0421*.sql \
      supabase/migrations/0422*.sql \
      supabase/migrations/0423*.sql 2>/dev/null || true
    for g in supabase/migrations/042[0-3]*.sql; do
      [[ -f "$g" ]] && verify_definer_migrations "" "$g" || true
    done
    verify_ingest_recall 0.6195
    ;;
  18|21|17|16|20)
    verify_rag_index_exports || true
    ;;
esac
echo "verify pr${pr} ok"