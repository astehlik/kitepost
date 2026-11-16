#!/usr/bin/env bash
# Runs all tests against the local chatmail relay. Needs the venv from the README.
set -euo pipefail
cd "$(dirname "$0")/.."
# Use a system Chromium if there is one, otherwise Playwright's (`playwright install chromium`).
[ -z "${CHROMIUM_PATH:-}" ] && [ -x /usr/bin/chromium ] && export CHROMIUM_PATH=/usr/bin/chromium
docker compose -f e2e/relay/compose.yaml up -d --build --wait
(cd core && cargo test --quiet --release --workspace)
(cd invite && node --test)
./build-wasm.sh
(cd web && node --test test/ && pnpm run build)
# Arguments go to pytest, e.g. -k reactions. Tests that change the whole relay run alone afterwards;
# pytest exits with 5 when the arguments select none of them.
work/venv/bin/pytest e2e -n "${E2E_WORKERS:-4}" "$@"
work/venv/bin/pytest e2e -m exclusive "$@" || [ $? -eq 5 ]
