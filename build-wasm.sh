#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
version=$(scripts/wasm-bindgen-version.sh)
if [ "$(tools/bin/wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $version" ]; then
  cargo install wasm-bindgen-cli --version "$version" --locked --root tools
fi
cargo build --manifest-path core/Cargo.toml --target wasm32-unknown-unknown --release
tools/bin/wasm-bindgen --target web --out-dir web/src/wasm \
  core/target/wasm32-unknown-unknown/release/kitepost_core.wasm
