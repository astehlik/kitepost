#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
version=$(scripts/wasm-bindgen-version.sh)
if [ "$(tools/bin/wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $version" ]; then
  cargo install wasm-bindgen-cli --version "$version" --locked --root tools
fi
# ring (used by iroh in kitepost-transfer) needs clang and llvm-ar for wasm32.
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-clang}" AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-llvm-ar}"
command -v "$CC_wasm32_unknown_unknown" >/dev/null || { echo "clang is required, e.g. apt install clang llvm" >&2; exit 1; }
# Inside core/, so rustup and cargo pick up rust-toolchain.toml and .cargo/config.toml.
(cd core && cargo build --target wasm32-unknown-unknown --release -p kitepost-core -p kitepost-transfer)
for crate in kitepost_core kitepost_transfer; do
  tools/bin/wasm-bindgen --target web --out-dir web/src/wasm "core/target/wasm32-unknown-unknown/release/$crate.wasm"
done
