#!/usr/bin/env bash
# 前台启动面板（Ctrl+C 会先停掉所有账号再退出）
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[yogurt-shell] 未找到 node，请先安装 Node.js 18+：https://nodejs.org/" >&2
  exit 1
fi
exec node server.js "$@"
