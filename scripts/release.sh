#!/usr/bin/env bash
# 예전 실행 경로 호환. 실제 릴리즈는 Node CLI → GitHub Actions에서 수행한다.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/release.mjs "$@"
