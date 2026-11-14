#!/usr/bin/env bash
# 安装成 systemd 用户服务（登录后自动启动，崩溃自动拉起面板，面板再拉起账号）
# 没有 systemd 的环境（容器/精简系统）会给出可操作的替代方案，而不是甩一句 bus 错误。
# 卸载：systemctl --user disable --now yogurt-shell && rm ~/.config/systemd/user/yogurt-shell.service
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js 18+" >&2
  exit 1
fi

if [ ! -d /run/systemd/system ]; then
  cat >&2 <<'EOF'
[yogurt-shell] 这台机器没有在跑 systemd（容器/精简系统常见），装不了 systemd 服务。

可选：
  1) 后台启动（推荐，退出终端也不影响）：./start-background.sh
  2) 面板里点：设置 → 后台运行 / 开机自启 →「开启开机自启」
     （没有 systemd 时面板会自动改用 crontab @reboot，前提是 cron 服务在运行）
  3) 容器部署：给容器设 restart: unless-stopped / always
EOF
  exit 1
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[yogurt-shell] 连不上 systemd 的 user bus（多见于 su / 无会话的 root）。

可选：
  1) 用普通用户登录后再执行本脚本，并先跑：loginctl enable-linger $USER
  2) 直接用 ./start-background.sh 后台启动
EOF
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/yogurt-shell.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=Yogurt Shell (Yogurt control panel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now yogurt-shell.service
systemctl --user --no-pager --lines=5 status yogurt-shell.service || true

echo
echo "已安装并启动：$UNIT"
echo "查看日志：journalctl --user -u yogurt-shell -f"
echo "想让它在没登录时也跑：sudo loginctl enable-linger $USER"
