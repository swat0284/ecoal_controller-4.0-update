#!/bin/sh

set -e

CONFIG_PATH=/data/options.json

if [ ! -f "$CONFIG_PATH" ]; then
    echo "Configuration file not found at $CONFIG_PATH"
    exit 1
fi

export NODE_ENV=production

echo "Starting ecoal 4.0 Controller..."
echo "Configuration: $CONFIG_PATH"

exec npx tsx /app/src/index.ts
