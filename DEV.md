# Cubeloom 开发文档

本文档面向二次开发/维护者，说明项目结构、运行时架构、数据模型、HTTP 接口与关键设计决策。

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js ≥ 20（ESM，`tsx` 直接跑 TS，**无构建步骤**；Android 侧是 nodejs-mobile 的 Node 18） |
| 协议 | 基岩版 WebSocket（`mcpews` 4.x）。`FB_WS_VERSION` 默认 `17104896`（= 1.5.0.0），mcpews 用它判断是否需要加密握手，**不要**照着「1.21」去改 |
| HTTP | 原生 `node:http`，无框架（`admin-server.ts`、`main.ts` 控制口） |
| 存储 | 仅本地文件（`logs/`、`admin/auth.json`），无数据库 |
| 前端 | 原生 HTML/CSS/JS，无构建（仅 `admin/`） |
| 进程 | `admin-server.ts` 单实例拉起一个 `main.ts`；也支持两个服务各自独立启动 |
| 登录助手 | Go 1.23（`tools/x19login`，零第三方依赖）：mpay/x19 登录 + G79 PE 通道认证 |
| Android 原生 | nodejs-mobile Node 18 + Chaquopy Python 3.12 + NDK 27 交叉编译的引擎 `.so` |
| 构建 | Gradle 8.13 + AGP 8.12（Gradle 9.x 与 AGP 8.12 不兼容）；esbuild 打 CJS bundle |

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
  formats.ts         多格式识别（.mcstructure/.bdx/.vt/.litematic/.schem/.schematic/.nbt，.mcworld/.zip 取包内结构）
  parsed-structure.ts 各格式解析结果 → ParsedStructure（含命令方块元数据）
  bdx.ts             BDX（PhoenixBuilder）指令流解析
  vt.ts              VQ `.vt` 建筑（AES-256-CBC + Deflate + 命令方块）
  zip.ts             极简 ZIP 读取（.mcworld/.zip）
  nbt.ts             基岩版小端 NBT 读
  java-nbt.ts        Java 版大端 NBT 读
  nbt-write.ts       基岩版 NBT 写（只支持 int/string/list/compound）
  sandbox.ts         node:vm 命令沙箱（几何进上下文 + 宿主桥；见维护手册 P0-1）
  sandbox-bundle.ts  esbuild 把 VoxelGeometry 打成 IIFE，供沙箱上下文内部求值
  sender.ts          结构导入的发送窗口 / 回执追踪（每轮独立）
  effect.ts          plot / setBlocks 落块层
  utils.ts           回显层（tell_raw / actionbar）
  netease-protocol.ts / netease-bridge.ts  网易版协议常量与事件桥（TCP NDJSON 17999）
  netease-bot.ts     托管机器人进程（FB_NETEASE_BOT_CMD：启动/就绪/重启/收尾）
  netease-account.ts 驱动 Go 登录助手（stdin/stdout NDJSON，密码不落盘）
  netease-room.ts    房间解析（租赁服/联机大厅/山头服/本地联机）、X19 动态签名、组件领取
admin/               管理面板前端（index.html / login.html / astrbot.css / *.js）
admin/assets/        品牌图形
tools/               set-password.mjs、check-sandbox.ts、build.mjs（打包预编译）、
                     build-x19login.mjs（Go 助手）、build-engine*.mjs（原生引擎）、build-android.mjs
deploy/              systemd 单元模板（cubeloom、cubeloom-netease）
packaging/           分发：portable 启动脚本、desktop（Electron）、mobile（Termux / nodejs-mobile）
vendor/ntvector/     随仓库分发的 NTvector 官方 release（MIT）+ 校验信息
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

网易版是另一条链路（和 WS 版互不影响，可同时跑）：

```
面板 ──HTTP──> admin-server.ts (11452)
                     │  spawn tools/x19login（stdin/stdout NDJSON，设备指纹 + mpay 登录）
                     │  ──X19 动态签名──> g79mclobt / g79apigatewayobt（房间 → ip:port）
                     ▼
              netease-service.ts (11454) ──TCP NDJSON 17999──> cubeloom_bridge 插件
                                                                    │ RakNet
                                                                    ▼
                                                             NTvector 引擎（原生 / Wine）
```

单实例模型：一个 `admin-server.ts` 管一个 `main.ts`，没有多用户、没有实例编排、没有服务端账户体系。

- **控制接口**：`main.ts` 在本机暴露 `/status`、`/eval`、`/send`、`/structure/*` 等，只绑 `127.0.0.1`。
  请求守卫（`main.ts` `requestGuard`）：写操作必须是 `application/json`；带 `Origin` 必须与 `Host` 同源；`Host` 必须是回环地址。
- **面板口令**：`admin/auth.json` 存在才启用登录（scrypt + `epoch` + HMAC 签名 Cookie）。不存在时按绑定地址分流：回环=本机开发模式；非回环=**拒绝启动**（`FB_ADMIN_ALLOW_NO_AUTH=1` 才显式放开）；文件损坏也拒绝启动。
- **会话认证**：本机回环连接免验证；外部连接需在聊天栏发 `--login <令牌>`（令牌打印在启动日志，可用 `FB_LOCAL_TOKEN` 固定）。
- **限流**：同一 IP 每分钟 5 次 WS 连接，超限封 10 小时。

## 4. 数据与接口

单实例本地工具，**没有服务端数据库**：

- 运行日志：`logs/ws.log`、`logs/admin.log`（管理端也强制写 `<repo>/logs`，`FB_LOG_DIR` 只对 `main.ts` 生效）
- 面板口令哈希：`admin/auth.json`（scrypt + epoch，权限 600，已 gitignore；改口令/revoke 轮换 secret 并递增 epoch）
- 结构导入的临时状态只存在进程内存里，重启即清空
- 控制接口仅监听 `127.0.0.1:${FB_CONTROL_PORT}`（默认 11453），供本地面板 / CLI 调用

## 5. 本地开发

```bash
npm install
npm run admin          # 面板 http://127.0.0.1:11452（会拉起 WS）
npm run ws             # 只跑 WS（调试协议/命令流）
npm run cli            # 终端交互版（连控制口）
npm run check:sandbox  # 39 项断言：沙箱隔离、几何 API、鉴权矩阵、落块层、回显层
npm test               # 113 条 node:test：沙箱/格式/修补器/坐标/鉴权/发送队列/网易桥/托管机器人/登录签名/房间解析
npm run typecheck      # tsc --noEmit（strictNullChecks 打开）
npm run build:x19login # Go 登录助手（本机版，tools/x19login/bin/x19login）
npm run build          # 预编译 build/{server,desktop,portable,mobile}，打包前必跑
```

调试技巧：
- 端口都可用环境变量改（`FB_WS_PORT` / `FB_CONTROL_PORT` / `FB_ADMIN_PORT` / `FB_NETEASE_PORT`），并行开多个实例时必改
- 改了 `admin/` 或 `admin-server.ts` 之后打 APK：`build-android.mjs` 现在**每次都重打 mobile bundle**（以前「文件存在就跳过」会让 APK 里是旧面板/旧服务端）
- `FB_LOG_DIR=/tmp/x` 把 WS 日志挪走，避免污染仓库
- 面板没有热更新，改 `admin/*` 后刷新页面即可；改 `*.ts` 要重启进程

## 5.1 打包

`node tools/build.mjs` 用 esbuild 把入口预编译成自包含 CJS，供没有 tsx/esbuild 的运行时使用：

| 产物 | 用途 |
|---|---|
| `build/server/` | `node build/server/admin-server.cjs`，纯服务端 |
| `build/portable/` | 便携版（系统 Node ≥ 20） |
| `build/desktop/` | Electron 工程目录（`npm run dist:*`） |
| `build/mobile/nodejs-project/` | Node 18 bundle，给 nodejs-mobile 做 APK |

打包相关的环境变量：`FB_APP_ROOT`（可写根，userData）、`FB_WS_ENTRY`（预编译 WS 入口）、
`FB_FORCE_ENTRY=1`（CJS 下判定入口）、`FB_NO_REPL=1`（无终端）、`FB_GEOMETRY_BUNDLE`
（预构建几何库）。不要把这些删掉——打包后 `import.meta.url` / `node_modules/tsx` 都不存在。

## 6. 部署

- systemd：`deploy/cubeloom.service`（面板 + WS）、`deploy/cubeloom-netease.service`（可选）
- WS 端口直连玩家（需安全组/防火墙放行）；面板只监听回环，要从外部访问请走反代并设口令
- 环境变量：`FB_WS_PORT`、`FB_CONTROL_PORT`、`FB_ADMIN_PORT`、`FB_ADMIN_HOST`、`FB_ADMIN_AUTH_FILE`、`FB_ADMIN_ALLOW_NO_AUTH`、`FB_ADMIN_COOKIE_SECURE`、`FB_LOG_DIR`、`FB_NETEASE_*`
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

- **沙箱封堵了已知逃逸链，但不是安全边界**：几何库在 vm 上下文内部求值，宿主 API 经隐藏桥接，
  `plot.constructor('return process')()` / `sphere(1).constructor...` 都拿不到宿主；但 `node:vm` 不是隔离方案，
  且 `setBlocks` / `session.sendCommand` 本身就能改世界。敌意脚本请把服务放进容器
- **脚本不能把函数传回宿主**：桥接只传纯数据，`session.subscribe("X", fn)` / `sendCommand(cmd, cb)` 会失败；
  需要回调时必须走白名单通道（见维护手册 P0-1 残余风险）
- **方块状态**：解析与命令已保留 states（楼梯朝向/含水等），回读也带状态；Java 状态属性→基岩状态的翻译仍未做
- **落块层逐块发 `setblock`**：大结构命令量 = 方块数；合并成 `fill` 会改变与服务器交互的节奏，属于待评估优化
- **类型检查已进 CI**：`tsconfig.json` + `npm run typecheck`（strictNullChecks）；但还没有 lint
- **网易 PC/PE 会话互斥**：同一账号同时拿两套 token 会被判「您的帐号在另一处登录」，所以 PE 通道默认关闭，
  只有需要 PE 商城接口（组件领取）时才手动开；`purchaseComponentManually()` 的顺序固定为 PC → PE，PE 冲突后 5 分钟内不再重试
