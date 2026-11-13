#!/usr/bin/env bash
# Runs all tests against the local chatmail relay. Needs the venv from the README.
set -euo pipefail
cd "$(dirname "$0")/.."
# Use a system Chromium if there is one, otherwise Playwright's (`playwright install chromium`).
[ -z "${CHROMIUM_PATH:-}" ] && [ -x /usr/bin/chromium ] && export CHROMIUM_PATH=/usr/bin/chromium
docker compose -f e2e/relay/compose.yaml up -d --build --wait
cargo test --quiet --release --manifest-path core/Cargo.toml
(cd invite && node --test)
(cd web && pnpm run build)
RELAY=_chatmail.test RELAY_IP=172.30.99.10 work/venv/bin/python -I e2e/test_interop.py
RELAY=_chatmail.test RELAY_IP=172.30.99.10 work/venv/bin/python -I e2e/test_import.py
work/venv/bin/python -I e2e/test_invite.py
