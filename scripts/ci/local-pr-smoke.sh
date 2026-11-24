#!/usr/bin/env bash
# Mirror .github/workflows/pr-smoke.yml locally; prints pass/fail per job.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
GATE_LOG_DIR="${GATE_LOG_DIR:-/tmp}"
SUMMARY_LOG="${GATE_SUMMARY_LOG:-}"
export DEEPEVAL_TELEMETRY_OPT_OUT=1
export DEEPEVAL_UPDATE_WARNING_OPT_IN=0
export RAGAS_DO_NOT_TRACK=true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

declare -A STATUS
declare -A DETAIL

run_job() {
  local name="$1"
  shift
  set +e
  local log="${GATE_LOG_DIR}/local-gate-${name}.log"
  if "$@" >"$log" 2>&1; then
    STATUS[$name]=PASS
    DETAIL[$name]="ok"
  else
    STATUS[$name]=FAIL
    DETAIL[$name]="see $log (tail: $(tail -3 "$log" | tr '\n' ' '))"
  fi
  set -e
}

echo "=== local pr-smoke (repo: $ROOT) ==="

run_job ts-vitest npx vitest run
run_job ts-root-mts node --import tsx --test tests/*.test.mts
run_job ts-rag-db node --import tsx --test tests/rag-db/*.test.mts
run_job ts-config node scripts/check-config.mjs
run_job ts-boundary bash -c 'node scripts/ci/check-rag-boundary.mjs && node --test scripts/tests/check-rag-boundary.node-test.mjs'
run_job ts-config-selftest node --test scripts/check-config.test.mjs scripts/typecheck-new.test.mjs scripts/tests/tsc-ratchet.node-test.mjs scripts/tests/check-node-runtime.node-test.mjs
run_job ts-gen-zod node --test scripts/tests/gen-zod.node-test.mjs
run_job ts-typecheck-new npm run typecheck:new
run_job ts-next-typegen npx next typegen
run_job ts-tsc npx tsc --noEmit -p tsconfig.json
run_job ts-workflows bash -c 'uv sync --directory eval --locked --all-extras && uv run --directory eval python ../scripts/ci/check-workflows.py && uv run --directory eval python -m unittest discover -s ../scripts/tests -p test_check_workflows.py'

run_job sibling-types bash -c 'npm ci --ignore-scripts --prefix voice-agent && cd baileys-whatsapp && corepack enable && yarn install --immutable --mode=skip-build && cd .. && node scripts/ci/tsc-ratchet.mjs --cwd voice-agent --baseline scripts/ci/sibling-tsc-baseline.json --key voice-agent && node scripts/ci/tsc-ratchet.mjs --cwd baileys-whatsapp --baseline scripts/ci/sibling-tsc-baseline.json --key baileys-whatsapp'

run_job voice-agent bash -c 'npm ci --ignore-scripts --prefix voice-agent && npm test --prefix voice-agent && node scripts/ci/tsc-ratchet.mjs --cwd voice-agent --baseline scripts/ci/sibling-tsc-baseline.json --key voice-agent'

run_job schema-parity bash -c 'npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json'

run_job python bash -c 'uv sync --directory rag-sidecar --locked --extra chunking && uv sync --directory rag-sidecar --locked --extra preflight && uv sync --directory eval --locked --all-extras && uv run --directory rag-sidecar --extra chunking pytest -q && uv run --directory eval pytest -q'

run_job eval-smoke bash -c 'npm run test-rag -- --out eval/out/smoke && npm run test-rag -- --fixture-mode ingest --out eval/out/smoke-ingest'

run_job gate-negative-control bash -c 'set +e; npm run test-rag -- --degrade drop_top_candidate --out eval/out/negative-degrade; code=$?; set -e; test "$code" -eq 10; jq -e ".passed == false and (.mismatches | length == 0)" eval/out/negative-degrade/gate.json; jq -e "[.offenders[] | select(.slice == \"overall\" and .metric == \"mrr\") | (.threshold - .observed)] | (length == 1 and .[0] >= 0.05)" eval/out/negative-degrade/gate.json; set +e; npm run test-rag -- --max-results 1 --out eval/out/negative; code=$?; set -e; test "$code" -eq 10; jq -e ".passed == false and (.offenders | length > 0) and (.mismatches | length == 0)" eval/out/negative/gate.json'

if command -v docker >/dev/null 2>&1; then
  run_job docker-build bash -c 'docker build -t rag-sidecar:ci rag-sidecar'
else
  STATUS[docker-build]=SKIP
  DETAIL[docker-build]="docker not available"
fi

echo ""
echo "=== LOCAL GATE SUMMARY ==="
printf "%-24s %s  %s\n" "JOB" "STATUS" "DETAIL"
fail=0
for name in ts-vitest ts-root-mts ts-rag-db ts-config ts-boundary ts-config-selftest ts-gen-zod ts-typecheck-new ts-next-typegen ts-tsc ts-workflows sibling-types voice-agent schema-parity python eval-smoke gate-negative-control docker-build; do
  st="${STATUS[$name]:-SKIP}"
  printf "%-24s %s  %s\n" "$name" "$st" "${DETAIL[$name]:-}"
  if [[ "$st" == FAIL ]]; then fail=$((fail + 1)); fi
done
echo "FAIL count: $fail"
if [[ -n "$SUMMARY_LOG" ]]; then
  {
    echo "=== LOCAL GATE SUMMARY ==="
    printf "%-24s %s  %s\n" "JOB" "STATUS" "DETAIL"
    for name in ts-vitest ts-root-mts ts-rag-db ts-config ts-boundary ts-config-selftest ts-gen-zod ts-typecheck-new ts-next-typegen ts-tsc ts-workflows sibling-types voice-agent schema-parity python eval-smoke gate-negative-control docker-build; do
      st="${STATUS[$name]:-SKIP}"
      printf "%-24s %s  %s\n" "$name" "$st" "${DETAIL[$name]:-}"
    done
    echo "FAIL count: $fail"
  } >"$SUMMARY_LOG"
fi
exit "$fail"