#!/bin/sh
# Prints the wasm-bindgen version pinned in core/Cargo.toml; the CLI must match it exactly.
sed -n 's/^wasm-bindgen = "=\([0-9.]*\)"$/\1/p' "$(dirname "$0")/../core/Cargo.toml"
