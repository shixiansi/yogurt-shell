#!/usr/bin/env bash
# 一键后台启动（不需要懂 nohup）：日志写到 data/panel.out.log，pid 记到 data/runtime/panel.pid
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[yogurt-shell] 未找到 node，请先安装 Node.js 18+：https://nodejs.org/" >&2
  exit 1
fi

mkdir -p data data/runtime

if [ -f data/runtime/panel.pid ]; then
  old_pid="$(cat data/runtime/panel.pid 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[yogurt-shell] 面板已经在运行（pid $old_pid）"
    echo "  地址：http://127.0.0.1:${YOGURT_SHELL_PORT:-3090}/"
    exit 0
  fi
fi

nohup node server.js "$@" >> data/panel.out.log 2>&1 &
new_pid=$!
echo "$new_pid" > data/runtime/panel.pid
sleep 2

if kill -0 "$new_pid" 2>/dev/null; then
  echo "[yogurt-shell] 已在后台启动（pid $new_pid）"
  echo "  地址：http://127.0.0.1:${YOGURT_SHELL_PORT:-3090}/"
  echo "  日志：data/panel.out.log（tail -f 可跟）"
  echo "  停止：./stop.sh"
else
  echo "[yogurt-shell] 启动失败，看看日志：" >&2
  tail -n 20 data/panel.out.log >&2 || true
  exit 1
fi
