#!/bin/sh
set -eu

config_path="${MANGA_TRANSLATION_CONFIG_PATH:-/data/config/koharu.json}"

if [ ! -f "$config_path" ]; then
  mkdir -p "$(dirname "$config_path")"
  cp /app/docker/koharu.json "$config_path"
fi

exec node backend/server.js
