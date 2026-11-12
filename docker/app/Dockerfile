# syntax=docker/dockerfile:1

FROM rust:1.99-slim AS wasm
WORKDIR /src
COPY core/rust-toolchain.toml core/Cargo.toml core/
COPY scripts/wasm-bindgen-version.sh scripts/
RUN cd core && rustup show active-toolchain \
 && cargo install wasm-bindgen-cli --version "$(../scripts/wasm-bindgen-version.sh)" --locked
COPY core/ core/
RUN cargo build --manifest-path core/Cargo.toml --target wasm32-unknown-unknown --release \
 && wasm-bindgen --target web --out-dir /out core/target/wasm32-unknown-unknown/release/kitepost_core.wasm

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
