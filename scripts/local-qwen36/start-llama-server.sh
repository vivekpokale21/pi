#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

LLAMA_CPP_SERVER_BIN="${LLAMA_CPP_SERVER_BIN:-/mnt/d/Projects/llama.cpp/build/bin/llama-server}"
QWEN36_MODEL_PATH="${QWEN36_MODEL_PATH:-/home/vivek/models/Qwen3.6-35B-A3B-IQ4_XS-4.15bpw.gguf}"
QWEN36_HOST="${QWEN36_HOST:-127.0.0.1}"
QWEN36_PORT="${QWEN36_PORT:-8080}"
QWEN36_CTX="${QWEN36_CTX:-131072}"
QWEN36_BATCH="${QWEN36_BATCH:-2048}"
QWEN36_UBATCH="${QWEN36_UBATCH:-2048}"
QWEN36_NGL="${QWEN36_NGL:-999}"
QWEN36_N_CPU_MOE="${QWEN36_N_CPU_MOE:-34}"
QWEN36_CACHE_TYPE_K="${QWEN36_CACHE_TYPE_K:-q8_0}"
QWEN36_CACHE_TYPE_V="${QWEN36_CACHE_TYPE_V:-q8_0}"
QWEN36_FIT="${QWEN36_FIT:-on}"
QWEN36_DRY_RUN=0

usage() {
	cat <<'USAGE'
Usage: scripts/local-qwen36/start-llama-server.sh [--dry-run]

Starts the fixed local Qwen3.6-35B-A3B ByteShape llama.cpp server profile.

Environment overrides:
  LLAMA_CPP_SERVER_BIN  Path to llama-server
  QWEN36_MODEL_PATH     Path to Qwen3.6-35B-A3B-IQ4_XS GGUF
  QWEN36_HOST           Bind host, default 127.0.0.1
  QWEN36_PORT           Bind port, default 8080
USAGE
}

while (($# > 0)); do
	case "$1" in
		--dry-run)
			QWEN36_DRY_RUN=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "unknown argument: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

require_file() {
	local path="$1"
	local label="$2"
	if [[ ! -f "$path" ]]; then
		echo "$label does not exist: $path" >&2
		exit 1
	fi
}

require_executable() {
	local path="$1"
	local label="$2"
	if [[ ! -x "$path" ]]; then
		echo "$label is not executable: $path" >&2
		exit 1
	fi
}

require_executable "$LLAMA_CPP_SERVER_BIN" "llama-server"
require_file "$QWEN36_MODEL_PATH" "Qwen3.6 model"

cmd=(
	"$LLAMA_CPP_SERVER_BIN"
	--host "$QWEN36_HOST"
	--port "$QWEN36_PORT"
	-m "$QWEN36_MODEL_PATH"
	-c "$QWEN36_CTX"
	-b "$QWEN36_BATCH"
	-ub "$QWEN36_UBATCH"
	-ngl "$QWEN36_NGL"
	--n-cpu-moe "$QWEN36_N_CPU_MOE"
	--cache-type-k "$QWEN36_CACHE_TYPE_K"
	--cache-type-v "$QWEN36_CACHE_TYPE_V"
	--fit "$QWEN36_FIT"
	--mmap
	--jinja
	--no-mmproj
)

if [[ "$QWEN36_DRY_RUN" == "1" ]]; then
	printf '%q ' "${cmd[@]}"
	printf '\n'
	exit 0
fi

cd "$ROOT_DIR"
exec "${cmd[@]}"
