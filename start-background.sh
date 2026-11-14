#!/usr/bin/env bash
# 一键后台启动（不需要懂 nohup）：逻辑都在 scripts/start-background.js，这里只做转发
cd "$(dirname "$0")" || exit 1
exec node scripts/start-background.js "$@"
