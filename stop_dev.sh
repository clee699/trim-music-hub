#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"

run_maybe_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo "$@"
  else
    "$@"
  fi
}

echo "=== Stopping TRIM Music Hub Dev Environment ==="

# 停止开发后端 (3175)
BACKEND_PID_FILE="$LOG_DIR/backend_dev.pid"
if [ -f "$BACKEND_PID_FILE" ]; then
  PID=$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    run_maybe_sudo kill "$PID" 2>/dev/null || true
  fi
  rm -f "$BACKEND_PID_FILE"
fi
run_maybe_sudo pkill -f "node.*--watch.*$PROJECT_DIR/server.mjs" 2>/dev/null || true

# 停止开发前端 (5175)
FRONTEND_PID_FILE="$LOG_DIR/frontend_dev.pid"
if [ -f "$FRONTEND_PID_FILE" ]; then
  PID=$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$FRONTEND_PID_FILE"
fi
pkill -f "vite.*--port 5175" 2>/dev/null || true

echo "✅ 开发环境服务已全部停止。"
