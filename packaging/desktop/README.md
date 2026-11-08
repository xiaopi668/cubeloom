# 桌面端（Electron）

## 产物

| 平台 | 命令 | 文件 |
|---|---|---|
| Linux | `npm run dist:linux` | `dist-app/Cubeloom-<版本>.AppImage`、`.tar.gz` |
| Windows | `npm run dist:win` | `dist-app/Cubeloom Setup <版本>.exe`、`.zip` |
| macOS | `npm run dist:mac` | `dist-app/Cubeloom-<版本>.dmg`、`.zip` |

构建前会先跑 `node tools/build.mjs`，把 `main.ts` / `admin-server.ts` 预编译成
`build/desktop/server/*.cjs`，并附带预构建的几何库与面板静态资源。

> 本机没有签名证书，产物是未签名的；Windows 首次运行会弹 SmartScreen，macOS 需要
> `xattr -dr com.apple.quarantine /Applications/Cubeloom.app`。正式发布请配置
> `CSC_LINK` / `CSC_KEY_PASSWORD`（Windows 还需 `WIN_CSC_LINK`）。

## 运行方式

- 主进程只做窗口与进程管理；`admin-server.cjs` 仍作为子进程运行（和 CLI 版一致）；
- 子进程用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，复用 Electron 自带 Node，
  用户不需要另外装 Node；
- 可写数据（`logs/`、`auth.json`、结构临时文件）放 `app.getPath("userData")`：
  - Windows：`%APPDATA%\Cubeloom`
  - macOS：`~/Library/Application Support/Cubeloom`
  - Linux：`~/.config/Cubeloom`
- 面板固定 `http://127.0.0.1:11452`，WS 服务 `11451`，控制口 `11453`；
- 安装包内置 NTvector（`netease-bot/`）与 `netease-service.cjs`：
  面板「网易版 → 机器人账号 / 房间」填 `mc.cfg` 字段（或粘贴完整 JSON），
  点「启动机器人 + 网易服务」；机器人文件首次启动复制到 userData；
- 游戏仍然是 `/connect ws://127.0.0.1:11451`（同机）或局域网 IP（需 `--login`）。

## 目录结构

```
packaging/desktop/
  electron-main.cjs     启动服务、等端口、开窗口、退出时收尾
  README.md
build/desktop/          node tools/build.mjs 生成（electron-builder 的 project 目录）
  electron-main.cjs
  server/{main.cjs,admin-server.cjs,voxel-geometry.iife.js}
  admin/
  package.json          build 配置（appId / 图标 / target）
```

## 已知限制

- 没有应用图标（electron-builder 用默认 Electron 图标）；放 `build/desktop/build/icon.png`
  （512×512）后重新打包即可；
- 没有自动更新（`electron-updater` 未接入）；
- 单实例锁基于 userData，同机多开会被第二个实例拦截并聚焦已有窗口。
