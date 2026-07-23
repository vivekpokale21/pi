#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

npx tsx scripts/local-qwen36/apply-diff-unit.ts
npx tsx scripts/local-qwen36/profile-unit.ts

base_url="${QWEN36_BASE_URL:-http://127.0.0.1:8080/v1}"
if ! curl -fsS --max-time 2 "$base_url/models" >/tmp/pi-qwen36-apply-diff-models.json; then
	if [[ "${REQUIRE_LIVE_QWEN36:-0}" == "1" ]]; then
		echo "local Qwen3.6 llama.cpp server is required but not reachable at $base_url" >&2
		exit 1
	fi
	echo "apply-diff-unit and profile-unit passed; live apply_diff smoke skipped because $base_url/models is not reachable"
	exit 0
fi

npx tsx scripts/local-qwen36/profile-smoke.ts
