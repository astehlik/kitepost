FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATIC_DIR="" TRUST_PROXY=1
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json server.mjs ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
