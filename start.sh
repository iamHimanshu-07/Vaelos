#!/bin/sh
# Hardened entrypoint for Railway. If node exits for ANY reason, log it
# loudly and restart after a brief delay. This keeps the container alive
# even through transient failures during boot (DB lock, volume mount
# race, native binary warmup, etc.).

set +e

cd /app

echo "[entrypoint] starting Vaelos at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[entrypoint] PORT=${PORT:-8080} | NODE_ENV=${NODE_ENV:-unset} | VAELOS_DB=${VAELOS_DB:-unset}"

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT+1))
  echo "[entrypoint] launch attempt $ATTEMPT"
  node server.js
  EXIT_CODE=$?
  echo "[entrypoint] node exited with code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ) — restarting in 2s"
  sleep 2
done
