# Cubeloom 开发文档

本文档面向二次开发/维护者，说明项目结构、运行时架构、数据模型、HTTP 接口与关键设计决策。

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js ≥ 20（ESM，`tsx` 直接跑 TS，无构建步骤） |
| 协议 | 基岩版 WebSocket（`mcpews` 4.x，协议版本 `FB_WS_VERSION`，默认 17104896 = 1.21.x） |
| HTTP | 原生 `node:http`，无框架（`admin-server.ts`） |
| 存储 | 仅本地文件（`logs/`、`admin/auth.json`），无数据库 |
| 前端 | 原生 HTML/CSS/JS，无构建（`site/`、`admin/`） |
| 进程 | 每用户独立 `main.ts` 实例（`systemd-run --scope`，Windows/无 systemd 时直接 spawn） |

## 2. 目录结构

```
main.ts              WS 服务：连接、结构导入、校验补建、HUD
admin-server.ts      本地管理面板（单实例模式）
netease-service.ts   网易版导入服务（可选，依赖外部机器人事件桥）
src/
  session.ts         会话、--login 认证、连接限流
  structure.ts       结构解析/命令生成
  structure-repair.ts 损坏 .mcstructure 修补
  formats.ts         多格式识别
  nbt.ts / nbt-write.ts / java-nbt.ts  NBT 读写
  sandbox.ts         node:vm 命令沙箱（隔离 + 超时）
  effect.ts / utils.ts
admin/               管理面板前端（原生 HTML/CSS/JS，无构建）
tools/               开发脚本：set-password.mjs、check-sandbox.ts
deploy/              systemd 单元模板
docs/                协议基线、CLI 说明、移植笔记
logs/                运行日志
```

## 3. 运行时架构

```
浏览器 ──HTTP──> admin-server.ts (11452)
                        │  spawn main.ts（单实例）
                        ▼
                  main.ts  WS 服务（11451）
                        │
玩家 ──/connect ws──> main.ts ──原版命令流──> 游戏服务器
                        ▲
                        └── 控制接口 127.0.0.1:11453（本地面板调用）
```

单实例模型：一个 `admin-server.ts` 管一个 `main.ts`，没有多用户、没有实例编排、没有服务端账户体系。

- **控制接口**：`main.ts` 在本机暴露 `/status`、`/structure/prepare|build|cancel|verify|clear` 等，仅 `127.0.0.1`。
- **会话认证**：本机回环连接免验证；外部连接需在聊天栏发 `--login <令牌>`（令牌打印在启动日志，可用 `FB_LOCAL_TOKEN` 固定）。
- **限流**：同一 IP 每分钟 5 次 WS 连接，超限封 10 小时。

## 4. 数据与接口

社区版为单实例本地工具，**没有服务端数据库**：

- 运行日志：`logs/ws.log`、`logs/admin.log`
- 面板口令哈希：`admin/auth.json`（scrypt，文件不存在则不启用登录）
- 结构导入的临时状态只存在进程内存里，重启即清空
- 控制接口仅监听 `127.0.0.1:${FB_CONTROL_PORT}`（默认 11453），供本地面板调用

> 原项目里的 `site-server.ts`（注册/登录/订阅/支付/插件市场/多用户实例编排）
> 已从社区版移除，不随本仓库分发。

## 5. 本地开发

```bash
npm install
npm run site       # 站点（默认 127.0.0.1:11455）
npm run ws         # 单独跑一个 WS 实例（调试）
npm run admin      # 本地管理面板
FB_EMAIL_VERIFY=0 npm run site   # 免邮箱验证注册（本地调试）
```

调试技巧：
- `tools/cdp-*.mjs`：headless Chrome 截图/点检页面
- `tools/patch-*.mjs`：幂等补丁脚本（改代码/页面）
- 日志：`logs/ws.log`、`logs/admin.log`

## 6. 部署

- systemd：`cubeloom-site.service`（站点）、`cubeloom.service`（WS 单实例）、`cubeloom-netease.service`（可选）
- nginx：443 → `127.0.0.1:11455`；WS 端口直连玩家（需安全组/防火墙放行）
- 环境变量：`FB_WS_PORT`、`FB_CONTROL_PORT`、`FB_LOG_DIR`、`FB_NETEASE_*`
- 安全相关：`FB_LOCAL_TOKEN`（未配用户库时的外部连接令牌，默认启动时随机生成并打印）、`FB_ALLOW_ANON=1`（放开匿名，等同旧行为）、`FB_REQUIRE_AUTH=1`（本机也强制验证）、`FB_SANDBOX_TIMEOUT`（单条命令执行上限，默认 5000ms）

## 7. 代码约定

- 所有改动优先“打补丁脚本 + 语法检查”（`esbuild transformSync`）后再部署
- 页面统一 `style-v2.css` + `align.css`（主题/间距 token），新增页面必须包含主题初始化脚本与主题切换按钮
- 图标一律内联 SVG（不用 emoji），颜色使用 CSS 变量
- 任何新增接口先鉴权（`currentUser`）再处理；管理接口单独 token
- 数据写入统一 `writeJson`（原子写 + 0600）

## 8. 扩展建议

- ~~插件执行沙箱~~：已在 `src/sandbox.ts` 用 `node:vm` 隔离（拿不到 `process`/`require`，禁用字符串构造，5s 执行超时）。**仍未做的是完整隔离**：注入的 `plot`/`setBlocks`/`session` 是宿主对象，理论上可顺原型链摸到宿主 `Function`；要彻底解决需把执行搬进 `worker_threads` 或子进程
- 网易多账号：每账号独立机器人目录 + 独立 `netease-service` 端口（124xx）
