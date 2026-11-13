# syntax=docker/dockerfile:1

FROM rust:1.99-slim AS wasm
# ring (iroh, in kitepost-transfer) is compiled to wasm32 with clang.
RUN apt-get update && apt-get install -y --no-install-recommends clang llvm && rm -rf /var/lib/apt/lists/*
ENV CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar
WORKDIR /src
COPY core/rust-toolchain.toml core/Cargo.toml core/
COPY scripts/wasm-bindgen-version.sh scripts/
RUN cd core && rustup show active-toolchain \
 && cargo install wasm-bindgen-cli --version "$(../scripts/wasm-bindgen-version.sh)" --locked
COPY core/ core/
RUN cargo build --manifest-path core/Cargo.toml --target wasm32-unknown-unknown --release -p kitepost-core -p kitepost-transfer \
 && for crate in kitepost_core kitepost_transfer; do \
      wasm-bindgen --target web --out-dir /out "core/target/wasm32-unknown-unknown/release/$crate.wasm"; \
    done

FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
COPY --from=wasm /out src/wasm
RUN pnpm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
ENV BRIDGE_URL=../bridge \
    DEFAULT_RELAY=nine.testrun.org \
    CONNECT_SRC=""
COPY docker/app/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web /src/web/dist /usr/share/nginx/html
EXPOSE 8080
