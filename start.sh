#!/usr/bin/env bash
# Cubeloom 一键启动（Linux / macOS）
# Windows 用 start.bat
set -euo pipefail
cd "$(dirname "$0")"

echo
echo " =========================================================="
echo "   Cubeloom 后台管理（一键启动）"
echo " ----------------------------------------------------------"
echo "   网页管理页 : http://127.0.0.1:11452"
echo "   WS 服务    : ws://<本机IP>:11451"
echo "   游戏内连接 : /connect ws://<本机IP>:11451"
echo "   日志目录   : logs/  （网页里直接查看）"
echo " =========================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo " [错误] 没有找到 node，请先安装 Node.js"
  exit 1
fi

if [ ! -f node_modules/tsx/dist/cli.mjs ]; then
  echo " [提示] 缺少运行依赖，正在安装（只需一次）..."
  npm install --no-fund --no-audit
fi

# 面板默认只监听回环：它自带"执行沙箱代码"入口，绑到 0.0.0.0 就等于把
# 宿主代码执行权交给整个局域网。要让别的设备访问，先设置面板口令再显式放开：
#   npm run set-password          # 写入 admin/auth.json（scrypt 哈希）
#   FB_ADMIN_HOST=0.0.0.0 ./start.sh
export FB_ADMIN_HOST="${FB_ADMIN_HOST:-127.0.0.1}"
export FB_NO_OPEN=1
exec node node_modules/tsx/dist/cli.mjs admin-server.ts
