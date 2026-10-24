#!/usr/bin/env bash
set -euo pipefail

# Default UID/GID for the surowan user inside the container.
# Override with PUID/PGID env vars to match the host user when using
# bind mounts — this avoids file ownership conflicts.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u surowan)" != "$PUID" ] || [ "$(id -g surowan)" != "$PGID" ]; then
  groupmod -o -g "$PGID" surowan
  usermod -o -u "$PUID" -g "$PGID" surowan
fi

# Fix ownership and permissions for mounted volumes.
# assertConfigPermissions requires: config parent dir 0700, config file 0600;
# the key jar next to it must be 0600 as well.
chown -R surowan:surowan /data /config 2>/dev/null || true
chmod 700 /config /data 2>/dev/null || true
[ -f /config/config.jsonc ] && chmod 600 /config/config.jsonc 2>/dev/null || true
[ -f /config/key.json ] && chmod 600 /config/key.json 2>/dev/null || true

# Drop to non-root user and execute
exec gosu surowan node /app/src/cli.ts "$@"
