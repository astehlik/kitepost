FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine
# Must match the vmail user of the chatmail container, which owns the mailboxes.
ARG VMAIL_UID=996
ARG VMAIL_GID=996
ENV NODE_ENV=production PORT=8080 MAILBOXES_DIR=/mailboxes DATA_FILE=/data/invites.json
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json server.mjs handoff.mjs setup-links.mjs sha512crypt.mjs i18n.mjs ./
COPY public public
RUN mkdir /data && chown ${VMAIL_UID}:${VMAIL_GID} /data
USER ${VMAIL_UID}:${VMAIL_GID}
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
