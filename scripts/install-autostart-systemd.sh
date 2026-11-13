#!/usr/bin/env bash
# 安装成 systemd 用户服务：登录后自动启动，崩溃自动拉起面板（面板会自己拉起账号）
# 卸载：systemctl --user disable --now yogurt-shell && rm ~/.config/systemd/user/yogurt-shell.service
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js 18+" >&2
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
# 面板自己负责停账号，这里给足时间做优雅退出
TimeoutStopSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now yogurt-shell.service
systemctl --user --no-pager status yogurt-shell.service || true

echo
echo "已安装并启动：$UNIT"
echo "查看日志：journalctl --user -u yogurt-shell -f"
echo "想让它在没登录时也跑：sudo loginctl enable-linger $USER"
