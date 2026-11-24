#!/usr/bin/env bash
# Standalone Worker Node Deployment Script
# Execute this on a remote SSH host to start a backend worker replica.
set -euo pipefail

PORT="${PORT:-4000}"
CENTRAL_DB_HOST="${CENTRAL_DB_HOST:-127.0.0.1}"
CENTRAL_DB_PORT="${CENTRAL_DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-password123}"
DB_NAME="${DB_NAME:-concert_booking}"
NODE_ID="worker_$(hostname)_${PORT}"

export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${CENTRAL_DB_HOST}:${CENTRAL_DB_PORT}/${DB_NAME}"
export PORT="${PORT}"
export NODE_ID="${NODE_ID}"

echo "=========================================================="
echo " Starting Concert Booking Worker: ${NODE_ID}"
echo " Binding to port: ${PORT}"
echo " Connecting to central database at: ${CENTRAL_DB_HOST}:${CENTRAL_DB_PORT}"
echo "=========================================================="

# Check node
if ! command -v node &> /dev/null; then
    echo "[-] Node.js is not installed. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Build and start
npm install --production=false
npm run build
exec node dist/index.js
