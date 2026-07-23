#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

npx tsx scripts/local-qwen36/build-diagnostics-unit.ts
npx tsx scripts/local-qwen36/self-correction-unit.ts
npx tsx scripts/local-qwen36/self-correction-smoke.ts
npx tsx scripts/local-qwen36/profile-unit.ts
