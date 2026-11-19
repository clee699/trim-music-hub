#!/bin/bash
set -e

if [ -d "/vol1/@appcenter/nodejs_v24/bin" ]; then
  export PATH="/vol1/@appcenter/nodejs_v24/bin:$PATH"
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"

NODE_BIN="$(command -v node)"
NPX_BIN="$(command -v npx)"

run_maybe_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo "$@"
  else
    "$@"
  fi
}

echo "=== Starting TRIM Music Hub Full-Stack Dev Environment ==="

# 1. 清理旧的开发后端进程 (仅匹配当前开发目录的 --watch server.mjs，绝不误伤生产容器)
BACKEND_PID_FILE="$LOG_DIR/backend_dev.pid"
if [ -f "$BACKEND_PID_FILE" ]; then
  OLD_BACKEND_PID=$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_BACKEND_PID" ] && run_maybe_sudo kill -0 "$OLD_BACKEND_PID" 2>/dev/null; then
    echo "Stopping existing dev backend (PID: $OLD_BACKEND_PID)..."
    run_maybe_sudo kill "$OLD_BACKEND_PID" 2>/dev/null || true
  fi
  rm -f "$BACKEND_PID_FILE"
fi
run_maybe_sudo pkill -f "node.*--watch.*$PROJECT_DIR/server.mjs" 2>/dev/null || true
sleep 1

# 2. 启动独立开发后端 (端口 3175, 开启 --watch 热监听与 .env 环境变量注入)
echo "🚀 启动独立开发后端 (端口: 3175, 开启 --watch 热重载)..."
cd "$PROJECT_DIR"
ENV_FILE_ARG=()
if [ -f "$PROJECT_DIR/.env" ]; then
  ENV_FILE_ARG=(--env-file="$PROJECT_DIR/.env")
fi

run_maybe_sudo bash -c "
  export PORT=3175
  export DATA_DIR=\"$PROJECT_DIR/data\"
  nohup \"$NODE_BIN\" --watch \"\${@}\" \"$PROJECT_DIR/server.mjs\" > \"$LOG_DIR/backend_dev.log\" 2>&1 &
  echo \$! > \"$BACKEND_PID_FILE\"
" _ "${ENV_FILE_ARG[@]}"

# 等待后端就绪
for i in {1..12}; do
  if (command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ':3175 ') || curl -fsS http://127.0.0.1:3175/api/health >/dev/null 2>&1; then
    echo "✅ 独立开发后端启动成功 (端口: 3175)"
    break
  fi
  sleep 0.5
done

# 3. 清理旧的 Vite 前端进程
FRONTEND_PID_FILE="$LOG_DIR/frontend_dev.pid"
if [ -f "$FRONTEND_PID_FILE" ]; then
  OLD_FRONTEND_PID=$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_FRONTEND_PID" ] && kill -0 "$OLD_FRONTEND_PID" 2>/dev/null; then
    kill "$OLD_FRONTEND_PID" 2>/dev/null || true
  fi
  rm -f "$FRONTEND_PID_FILE"
fi
pkill -f "vite.*--port 5175" 2>/dev/null || true
sleep 1

# 4. 启动 Vite 前端开发服务器 (端口 5175, 强制代理至本地开发后端 3175，严禁连接生产环境)
echo "🚀 启动前端 Vite 开发服务器 (端口: 5175, 代理至 http://127.0.0.1:3175)..."
cd "$PROJECT_DIR/frontend"
VITE_BACKEND_TARGET="http://127.0.0.1:3175" nohup "$NPX_BIN" vite --host 0.0.0.0 --port 5175 > "$LOG_DIR/frontend_dev.log" 2>&1 &
echo $! > "$FRONTEND_PID_FILE"
sleep 1

echo "=========================================================="
echo "🎉 全栈开发环境启动完成！"
echo "📡 前端开发入口: http://127.0.0.1:5175"
echo "🔗 独立后端接口: http://127.0.0.1:3175"
echo "🛡️ 生产环境端口 4175 完全隔离不受影响"
echo "=========================================================="
