#!/usr/bin/env bash
# CertVault one-shot installer for TrueNAS SCALE 24.10+ (run in System → Shell):
#   curl -fsSL https://raw.githubusercontent.com/Connor-Moyle/certvault/main/install-truenas.sh | sudo bash
# Options (env vars): POOL=CME_Nas PORT=30090
set -euo pipefail

POOL="${POOL:-CME_Nas}"
PORT="${PORT:-30090}"
DS="$POOL/certvault"
DIR="/mnt/$DS"
APP="certvault"

echo "==> Dataset $DS"
if [ "$(midclt call pool.dataset.query "[[\"id\",\"=\",\"$DS\"]]")" = "[]" ]; then
  midclt call pool.dataset.create "{\"name\":\"$DS\"}" >/dev/null
  echo "    created"
else
  echo "    already exists"
fi
midclt call --job filesystem.setperm "{\"path\":\"$DIR\",\"uid\":568,\"gid\":568,\"mode\":\"770\",\"options\":{\"stripacl\":true,\"recursive\":true}}" >/dev/null
echo "    owner set to apps (568)"

COMPOSE=$(cat <<EOF
services:
  certvault:
    image: ghcr.io/connor-moyle/certvault:latest
    pull_policy: always
    restart: unless-stopped
    ports:
      - "$PORT:8080"
    environment:
      TZ: Australia/Perth
    volumes:
      - $DIR:/data
    user: "568:568"
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
EOF
)
PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$COMPOSE")

echo "==> App $APP"
if [ "$(midclt call app.query "[[\"name\",\"=\",\"$APP\"]]")" = "[]" ]; then
  midclt call --job app.create "{\"app_name\":\"$APP\",\"custom_app\":true,\"custom_compose_config_string\":$PAYLOAD}" >/dev/null
  echo "    installed"
else
  midclt call --job app.update "$APP" "{\"custom_compose_config_string\":$PAYLOAD}" >/dev/null
  echo "    updated"
fi

echo "==> Waiting for CertVault to start"
for i in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 2
done

IP=$(midclt call interface.ip_in_use '{"ipv4":true,"ipv6":false,"loopback":false}' | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[0]["address"] if a else "your-nas-ip")')
echo
echo "============================================================"
echo "  CertVault is running:  http://$IP:$PORT"
if [ -f "$DIR/SETUP_CODE.txt" ]; then
  echo "  Setup code:            $(cat "$DIR/SETUP_CODE.txt")"
else
  echo "  (already set up — log in with your account)"
fi
echo "============================================================"
