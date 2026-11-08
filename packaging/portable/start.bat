@echo off
chcp 65001 >nul
title Cubeloom
cd /d "%~dp0"
set "FB_APP_ROOT=%CD%"
set "FB_WS_ENTRY=%CD%\server\main.cjs"
set "FB_FORCE_ENTRY=1"
set "FB_NO_REPL=1"
set "FB_GEOMETRY_BUNDLE=%CD%\server\voxel-geometry.iife.js"
set "FB_LOG_DIR=%CD%\logs"
node server\admin-server.cjs
pause
