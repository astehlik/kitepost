#!/bin/bash
# Entrypoint wrapper for the chatmail container: adds `include /etc/nginx/custom.d/*.conf;` to the
# HTTPS server of the image's own nginx template, then starts the original entrypoint.
# Patching on every start always uses the current image's template, also after Watchtower updates.
template=/opt/chatmail/cmdeploy/src/cmdeploy/nginx/nginx.conf.j2
anchor='^[[:space:]]*index index\.html index\.htm;'

if ! grep -q 'custom\.d/\*\.conf' "$template"; then
  if [ "$(grep -c "$anchor" "$template")" = 1 ]; then
    sed -i "/$anchor/a\\\t\tinclude /etc/nginx/custom.d/*.conf;" "$template"
  else
    echo "nginx-hook: anchor not found in $template, extra locations stay disabled" >&2
  fi
fi

exec "$@"
