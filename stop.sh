#!/usr/bin/env bash
# 优雅停止：先停掉所有账号，再退出面板
# 端口/监听地址/访问令牌都从 data/config.json 读（所以设了 token 也能停）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[yogurt-shell] 未找到 node，请先安装 Node.js 18+" >&2
  exit 1
fi

node scripts/stop-panel.js
status=$?

if [ "$status" -eq 3 ]; then
  if [ -f "$HOME/.config/systemd/user/yogurt-shell.service" ]; then
    echo "[yogurt-shell] 它在 systemd 手里，可以试试：systemctl --user stop yogurt-shell"
  elif [ -f data/runtime/panel.pid ]; then
    echo "[yogurt-shell] 最后手段：kill \$(cat data/runtime/panel.pid)"
  else
    echo "[yogurt-shell] 面板没在运行；要启动就 ./start-background.sh"
  fi
fi
exit 0
