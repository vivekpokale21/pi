#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

npx tsx scripts/local-qwen36/semantic-search-unit.ts
npx tsx scripts/local-qwen36/read-file-unit.ts
npx tsx scripts/local-qwen36/profile-unit.ts
