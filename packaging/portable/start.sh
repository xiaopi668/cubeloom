#!/usr/bin/env bash
# Cubeloom 便携版（需要系统 Node.js ≥ 20）
set -euo pipefail
cd "$(dirname "$0")"
exec env \
  FB_APP_ROOT="$PWD" \
  FB_WS_ENTRY="$PWD/server/main.cjs" \
  FB_FORCE_ENTRY=1 \
  FB_NO_REPL=1 \
  FB_GEOMETRY_BUNDLE="$PWD/server/voxel-geometry.iife.js" \
  FB_NETEASE_ENTRY="$PWD/server/netease-service.cjs" \
  FB_NETEASE_BOT_DIR="$PWD/netease-bot" \
  FB_LOG_DIR="$PWD/logs" \
  node server/admin-server.cjs
