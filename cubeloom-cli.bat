@echo off
chcp 65001 >nul
title Cubeloom CLI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

node cli.mjs
echo.
echo [Cubeloom CLI 已退出] 按任意键关闭...
pause >nul
