#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

dry_run="$(scripts/local-qwen36/start-llama-server.sh --dry-run)"

require_contains() {
	local needle="$1"
	if [[ "$dry_run" != *"$needle"* ]]; then
		echo "dry-run command missing expected text: $needle" >&2
		echo "$dry_run" >&2
		exit 1
	fi
}

require_contains "Qwen3.6-35B-A3B-IQ4_XS-4.15bpw.gguf"
require_contains "--mmap"
require_contains "--n-cpu-moe 34"
require_contains "-c 131072"
require_contains "-b 2048"
require_contains "-ub 2048"
require_contains "--jinja"

base_url="${QWEN36_BASE_URL:-http://127.0.0.1:8080/v1}"
if ! curl -fsS --max-time 2 "$base_url/models" >/tmp/pi-qwen36-models.json; then
	if [[ "${REQUIRE_LIVE_QWEN36:-0}" == "1" ]]; then
		echo "local Qwen3.6 llama.cpp server is required but not reachable at $base_url" >&2
		exit 1
	fi
	echo "dry-run checks passed; live smoke skipped because $base_url/models is not reachable"
	exit 0
fi

npx tsx scripts/local-qwen36/tool-smoke.ts
