# Upstream proposals for chatmail/relay

Both patches are against the chatmail/relay repository (the Docker image ships it in `/opt/chatmail`)
and were tested with the local relay in `e2e/relay`.

## 0001: include hook for operator-defined nginx locations

**Title:** nginx: include operator locations from /etc/nginx/custom.d

Port 443 on a relay is taken by nginx's ALPN stream router, so operators who want to serve anything
else on the relay's hostname (a landing page, a web client, an invite page) have to patch
`nginx.conf.j2` or put a second TLS proxy in front, which breaks IMAP/SMTP over 443 unless it routes
by ALPN as well.

This adds `include /etc/nginx/custom.d/*.conf;` to the main HTTPS server and creates the directory
during deploy. It is empty by default, so nothing changes for existing relays. Operators can mount or
drop in files with additional `location` blocks. Exact and longer prefix matches take precedence
over the relay's own `location /`, while `/new`, `/mxdeliv`, `/relay`, autoconfig and MTA-STS keep
working.

## 0002: keep the deploy fingerprint in the container filesystem

**Title:** docker: recreated containers skip the deploy and run default configs

`chatmail-init.sh` stores the deploy fingerprint in `/etc/chatmail/.deploy-fingerprint`. With the
documented setup `/etc/chatmail` is a persistent volume, but the rendered configs (`/etc/postfix`,
`/etc/dovecot`, `/etc/nginx`, …) live in the container filesystem.

Steps to reproduce:

1. Start the relay with `./config:/etc/chatmail` mounted and let it deploy.
2. `docker compose up -d --force-recreate` (or `down` + `up`, or any change to the compose file).
3. The log shows `No changes detected (…), skipping deploy.`; Postfix, Dovecot and nginx run with
   Debian's default configuration (no TLS on 993/465, nothing on 443). The healthcheck still reports
   *healthy* because the services are active.

The patch moves the fingerprint to `/etc/chatmail-deploy-fingerprint`, next to the configs it
describes: a recreated container always deploys, while a plain restart still skips it. Until this is
merged, `CMDEPLOY_STAGES=configure,activate` works around it by deploying on every start.
