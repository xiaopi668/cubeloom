#!/usr/bin/env bash
# 在 Termux 里一键安装并启动（Android）
set -euo pipefail
pkg install -y nodejs git
if [ ! -d "$HOME/cubeloom" ]; then
  git clone https://github.com/xiaopi668/cubeloom.git "$HOME/cubeloom"
fi
cd "$HOME/cubeloom"
npm install --no-audit --no-fund
termux-wake-lock || true
echo
echo "面板：http://127.0.0.1:11452   游戏内：/connect ws://127.0.0.1:11451"
echo "按 Ctrl+C 停止（先执行 termux-wake-unlock 可恢复息屏休眠）"
FB_NO_OPEN=1 npm run admin
