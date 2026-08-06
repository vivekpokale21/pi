#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT_DIR"

npx tsx scripts/local-qwen36/tests/unit/process-backoff-unit.ts

dry_run="$(npx tsx scripts/local-qwen36/supervise-llama-server.ts --dry-run)"

require_contains() {
	local needle="$1"
	if [[ "$dry_run" != *"$needle"* ]]; then
		echo "supervisor dry-run missing expected text: $needle" >&2
		echo "$dry_run" >&2
		exit 1
	fi
}

require_contains "Qwen3.6-35B-A3B-IQ4_XS-4.15bpw.gguf"
require_contains '"maxAttempts": 3'
require_contains '"cooldownMs": 300000'

echo "backoff supervisor dry-run: ok"
