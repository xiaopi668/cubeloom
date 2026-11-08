# Cubeloom 开发文档

本文档面向二次开发/维护者，说明项目结构、运行时架构、数据模型、HTTP 接口与关键设计决策。
架构分析与风险清单见 [docs/维护手册.md](docs/维护手册.md)。

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js ≥ 20（ESM，`tsx` 直接跑 TS，**无构建步骤**） |
| 协议 | 基岩版 WebSocket（`mcpews` 4.x）。`FB_WS_VERSION` 默认 `17104896`（= 1.5.0.0），mcpews 用它判断是否需要加密握手，**不要**照着「1.21」去改 |
| HTTP | 原生 `node:http`，无框架（`admin-server.ts`、`main.ts` 控制口） |
| 存储 | 仅本地文件（`logs/`、`admin/auth.json`），无数据库 |
| 前端 | 原生 HTML/CSS/JS，无构建（仅 `admin/`） |
| 进程 | `admin-server.ts` 单实例拉起一个 `main.ts`；也支持两个服务各自独立启动 |

## 2. 目录结构

```
main.ts              WS 服务：连接、结构导入、回读校验、补建、HUD、控制接口
admin-server.ts      网页管理端：静态页 + API + 拉起/停止 WS 子进程
netease-service.ts   网易版导入服务（可选，依赖外部机器人事件桥）
cli.mjs              终端交互版（控制接口的 HTTP 客户端）
src/
  session.ts         会话、--login 认证、连接限流、消息回执
  structure.ts       ParsedStructure → setblock/fill 命令
  structure-repair.ts 损坏 .mcstructure 修补（有损，见维护手册）
  formats.ts         多格式识别（.mcstructure/.litematic/.schem/.schematic/.nbt）
  nbt.ts             基岩版小端 NBT 读
  java-nbt.ts        Java 版大端 NBT 读
  nbt-write.ts       基岩版 NBT 写（只支持 int/string/list/compound）
  sandbox.ts         node:vm 命令沙箱（不是安全边界，见维护手册 P0-1）
  effect.ts          plot / setBlocks 落块层
  utils.ts           回显层（tell_raw / actionbar）
  netease-protocol.ts / netease-bridge.ts  网易版协议常量与事件桥
admin/               管理面板前端（index.html / login.html / astrbot.css / *.js）
admin/assets/        品牌图形
tools/               set-password.mjs、check-sandbox.ts
deploy/              systemd 单元模板（cubeloom、cubeloom-netease）
docs/                协议基线、CLI 说明、移植笔记、维护手册
netease/             网易版配置样例（*.example）
logs/                运行日志（运行时生成，已 gitignore）
```

## 3. 运行时架构

```
浏览器 ──HTTP──> admin-server.ts (11452)
                        │  spawn node tsx main.ts（单实例）
                        ▼
                  main.ts  WS 服务（11451，绑通配地址）
                        │
玩家 ──/connect ws──> main.ts ──原版命令流──> 游戏服务器
                        ▲
                        └── 控制接口 127.0.0.1:11453（面板 / CLI 调用）
```

单实例模型：一个 `admin-server.ts` 管一个 `main.ts`，没有多用户、没有实例编排、没有服务端账户体系。

- **控制接口**：`main.ts` 在本机暴露 `/status`、`/eval`、`/send`、`/structure/*` 等，只绑 `127.0.0.1`。
  请求守卫（`main.ts` `requestGuard`）：写操作必须是 `application/json`；带 `Origin` 必须与 `Host` 同源；`Host` 必须是回环地址。
- **面板口令**：`admin/auth.json` 存在才启用登录（scrypt + HMAC 签名 Cookie）。**文件不存在 = 面板完全开放**，所以不要把它绑到公网。
- **会话认证**：本机回环连接免验证；外部连接需在聊天栏发 `--login <令牌>`（令牌打印在启动日志，可用 `FB_LOCAL_TOKEN` 固定）。
- **限流**：同一 IP 每分钟 5 次 WS 连接，超限封 10 小时。

## 4. 数据与接口

单实例本地工具，**没有服务端数据库**：

- 运行日志：`logs/ws.log`、`logs/admin.log`（管理端也强制写 `<repo>/logs`，`FB_LOG_DIR` 只对 `main.ts` 生效）
- 面板口令哈希：`admin/auth.json`（scrypt，权限 600，已 gitignore）
- 结构导入的临时状态只存在进程内存里，重启即清空
- 控制接口仅监听 `127.0.0.1:${FB_CONTROL_PORT}`（默认 11453），供本地面板 / CLI 调用

## 5. 本地开发

```bash
npm install
npm run admin          # 面板 http://127.0.0.1:11452（会拉起 WS）
npm run ws             # 只跑 WS（调试协议/命令流）
npm run cli            # 终端交互版（连控制口）
npm run check:sandbox  # 39 项断言：沙箱隔离、几何 API、鉴权矩阵、落块层、回显层
npm test               # 13 条 node:test：修补器、坐标契约、解析
npm run typecheck      # tsc --noEmit（strictNullChecks 打开）
```

调试技巧：
- 端口都可用环境变量改（`FB_WS_PORT` / `FB_CONTROL_PORT` / `FB_ADMIN_PORT`），并行开多个实例时必改
- `FB_LOG_DIR=/tmp/x` 把 WS 日志挪走，避免污染仓库
- 面板没有热更新，改 `admin/*` 后刷新页面即可；改 `*.ts` 要重启进程

## 6. 部署

- systemd：`deploy/cubeloom.service`（面板 + WS）、`deploy/cubeloom-netease.service`（可选）
- WS 端口直连玩家（需安全组/防火墙放行）；面板只监听回环，要从外部访问请走反代并设口令
- 环境变量：`FB_WS_PORT`、`FB_CONTROL_PORT`、`FB_ADMIN_PORT`、`FB_ADMIN_HOST`、`FB_LOG_DIR`、`FB_NETEASE_*`
- 安全相关：`FB_LOCAL_TOKEN`（外部连接令牌，默认启动时随机生成并打印）、`FB_ALLOW_ANON=1`（放开匿名）、`FB_REQUIRE_AUTH=1`（本机也强制验证）、`FB_SANDBOX_TIMEOUT`（单条命令执行上限，默认 5000ms）

> `tsx` 已从 devDependencies 移到 dependencies：所有启动路径都是 `node node_modules/tsx/dist/cli.mjs`，
> `npm ci --omit=dev` 之后必须还能跑。

## 7. 代码约定

- 无构建步骤：提交前至少 `npm run check:sandbox && npm test && npm run typecheck`；改动 `main.ts` 的导入链路再加一次启动冒烟
- 新增 HTTP 接口：先过 `requestGuard`（两个服务都有），再鉴权，再处理
- 写入磁盘的配置/口令用原子写 + 0600（`tools/set-password.mjs` 是现存写法）
- 日志统一 UTC+8，行首 ISO 时间戳
- 游戏内回显走 `src/utils.ts` 的 `tell_raw`，不要手拼 JSON

## 8. 已知限制与扩展方向

- **沙箱不是安全边界**：注入的 `plot` / `setBlocks` 是宿主对象，`plot.constructor('return process')()` 可直达宿主；
  彻底隔离需要把执行搬进 `worker_threads` 或子进程，只回传方块数据
- **结构导入只到方块名**：block states（朝向/含水/台阶类型）在解析阶段就被丢弃，回读也只比块名
- **落块层逐块发 `setblock`**：大结构命令量 = 方块数；合并成 `fill` 会改变与服务器交互的节奏，属于待评估优化
- 网易版需要自备机器人本体（参考 NTvector），本仓库不含
- **没有类型检查**：仓库无 `tsconfig.json`，`tsc` 从未在 CI 跑过；加 `typescript` + `@types/node` 是下一步
