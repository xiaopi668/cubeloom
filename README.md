# Cubeloom

[![CI](https://github.com/xiaopi668/cubeloom/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaopi668/cubeloom/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-informational.svg)](.github/workflows/ci.yml)

> WebSocket based Minecraft Bedrock structure generator —— 把方块织成建筑。

在电脑或手机上跑一个本地服务，游戏里 `/connect ws://127.0.0.1:11451` 连上去，
然后由它**替你一块一块地放方块**：既可以导入现成建筑文件，也可以用代码现场"算"出形状。

```
git clone https://github.com/xiaopi668/cubeloom.git && cd cubeloom
npm install
npm run admin              # 网页控制台 http://127.0.0.1:11452
npm run ws                 # 只跑 WS 服务（11451）
npm run cli                # 终端交互版
```

> 尚未发布到 npm（`package.json` 里没有 `bin` 入口），请用仓库内脚本启动。

许可证：**AGPL-3.0-or-later**。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **结构导入** | `.mcstructure` / `.litematic` / `.schem` / `.schematic` / `.nbt` → 方块；带回读校验与自动补建 |
| **体素几何** | 聊天栏发 `-<代码>` 执行 JavaScript，用 `sphere` / `circle` / `torus` / `lsystem` / 参数方程 / 海龟绘图直接生成建筑 |
| **音乐盒** | MIDI 文件 → 游戏内 `note.*` 音符盒音色播放，支持鼓通道与变速 |
| **像素画 / 像素字** | 上传图片或输入文本 → 方块画 |
| **网易版接入** | 通过外部机器人事件桥（协议基线 MCBE 1.21.130 / 898）驱动原版指令 |
| **损坏修补** | 结构文件损坏时自动修补，导入失败可重试补建 |

## 快速开始

需要 Node.js ≥ 20。

```bash
git clone https://github.com/xiaopi668/cubeloom.git
cd cubeloom
npm install
npm run admin          # 打开 http://127.0.0.1:11452
```

游戏内：

```
/connect ws://127.0.0.1:11451
--help                  # 查看命令
-pos()                  # 记录当前位置作为原点
-plot(sphere(3,0))      # 生成半径 3 的球（默认铁块）
```

Windows 用户可以直接双击 `start.bat`，macOS/Linux 用 `./start.sh`。

## 游戏内命令

| 命令 | 作用 |
|---|---|
| `-<代码>` | 执行 JavaScript，`plot(...)` 落方块 |
| `--help` | 帮助 |
| `--login <令牌>` | 外部连接验证（令牌见启动日志） |
| `--stop` | 断开连接（世界不受影响） |

体素几何 API（来自 [VoxelGeometry](https://github.com/CAIMEOX/VoxelGeometry)）：

```js
plot(sphere(5, 4))                                  // 球壳
plot(circle(5, 4))                                  // 圆环
plot(simple_equation("x*x+y*y+z*z<=5", -5, 5, 1))   // 不等式 → 实体
plot(simple_parametric("5*Math.cos(t)", "0", "10*Math.sin(t)", ["t", 0, Math.PI*2, 0.1]))
const t = new Turtle2D(); t.forward(10); plot(t.getTrack())
lsystem("X", { X: "XFYFX+F+YFXFY-F-XFXFY", Y: "YFXFY-F-XFXFY+F+YFXFY" }, 5)
```

变换器：`scale` / `move` / `swap` / `pipe` / `embed` / `diffusion` / `array_gen`。

## 手机上用

`/connect`（别名 `/wsserver`）是基岩版客户端自带的命令，手机版一样能用，但有两条硬要求：
**世界要开作弊**（单机），或者**你在服务器里是管理员**（权限等级 2）；另外它不能写进命令方块。

### 方式一：电脑跑服务，手机连（最常用）

1. 电脑上启动服务：

   ```bash
   npm run admin        # 面板 + WS 一起（WS 在 11451）
   # 或者只起 WS
   npm run ws
   ```

   启动日志里记下两行：

   ```
   WS 服务已启动：ws://[::]:11451
   外部连接令牌：xxxxxxxxxxxx
   ```

2. 查电脑的局域网 IP：

   | 系统 | 命令 |
   |---|---|
   | Windows | `ipconfig` → 看「IPv4 地址」 |
   | macOS | `ipconfig getifaddr en0` |
   | Linux | `ip addr show` → 找 `192.168.x.x` 或 `10.x.x.x` |

3. 手机和电脑连**同一个 Wi-Fi**。访客网络、AP 隔离、公司网络常常互相 ping 不通，先排除这些。

4. 手机进游戏，在聊天栏：

   ```
   /connect ws://192.168.1.23:11451
   --login xxxxxxxxxxxx          # 非本机连接必须先验证
   -pos()                        # 把当前位置记为原点
   -plot(sphere(3,0))            # 放一个半径 3 的球
   ```

   令牌就是启动日志里那串；想固定下来：`FB_LOCAL_TOKEN=mysecret npm run ws`。

5. 连不上先看防火墙：

   - Windows 首次启动会弹「是否允许 Node.js 访问网络」，必须勾**专用网络**；没弹出来就手动放行：
     ```powershell
     netsh advfirewall firewall add rule name="Cubeloom WS" dir=in action=allow protocol=TCP localport=11451
     ```
   - Linux：`sudo ufw allow 11451/tcp`（firewalld 用 `firewall-cmd --add-port=11451/tcp`）

6. 手机浏览器也想看管理面板？面板默认只听 `127.0.0.1`，手机打不开，要显式放开：

   ```bash
   npm run set-password                     # 先设口令（写 admin/auth.json，scrypt 哈希）
   FB_ADMIN_HOST=0.0.0.0 npm run admin      # Linux / macOS
   # Windows cmd:        set FB_ADMIN_HOST=0.0.0.0 && npm run admin
   # Windows PowerShell: $env:FB_ADMIN_HOST="0.0.0.0"; npm run admin
   ```

   然后手机浏览器开 `http://192.168.1.23:11452`，用刚设的口令登录（防火墙同样要放行 11452）。

   > 面板里有「执行沙箱代码」入口，绑到 `0.0.0.0` 又不设口令，等于把电脑的代码执行权交给整个局域网。
   > 启动时如果检测到这种情况，控制台会打警告。

### 方式二：手机自己跑服务（Termux / Android）

```bash
pkg install nodejs git
git clone https://github.com/xiaopi668/cubeloom.git
cd cubeloom
npm install
FB_NO_OPEN=1 npm run admin     # 面板 + WS 一起起；只要 WS 就换成 npm run ws（面板不会起）
```

同一台手机上进游戏：`/connect ws://127.0.0.1:11451`（回环连接免验证），浏览器开 `http://127.0.0.1:11452` 看面板。

- 先执行 `termux-wake-lock`，否则息屏后进程会被系统杀掉
- 十万级方块的导入在手机上会明显发热、变慢，建议先用小结构试水
- Termux 里的 `npm install` 需要 Node ≥ 20，`pkg install nodejs` 通常就够

### 手机连不上的排查顺序

| 现象 | 先查 | 处理 |
|---|---|---|
| 一直「正在连接」 | 手机能否 ping 通电脑 IP；端口是否被防火墙拦 | 放行 11451；关掉访客网络/AP 隔离 |
| 连上后 `-` 命令没反应 | 有没有先发 `--login <令牌>` | 发令牌；**注意令牌区分大小写** |
| 聊天栏没有 `/connect` | 世界没开作弊 / 不是管理员 | 世界设置里开「作弊」，或让服主给你 OP |
| 面板打不开 | 面板默认只绑 `127.0.0.1` | 按上面方式一第 6 步放开并设口令 |
| 连接后被踢、提示版本不符 | 客户端版本太新/太旧 | 用 `FB_WS_VERSION` 调整协议版本后重启 |

## 网易版（租赁服 / 互通服）

网易版客户端用不了 `/connect`，所以走另一条路：**机器人以玩家身份进服**，Cubeloom 把算好的指令经事件桥交给机器人执行。

```
结构文件 ──HTTP──> netease-service.ts (11454) ──UNIX socket──> 机器人事件桥 ──RakNet──> 网易租赁服
                          ▲
                   admin-server 反代 /api/netease/*
```

### 前提

| 项 | 要求 |
|---|---|
| 机器人本体 | **仓库自带** NTvector 官方 Windows 包（[vendor/ntvector](vendor/ntvector/)，MIT）+ Cubeloom 桥插件，`npm run setup:netease-bot` 一键解压；仍需自己的账号 `mc.cfg` 与 OP 权限 |
| 机器人账号 | 必须是目标服的 **OP**，或服务器开启了作弊，否则指令无效 |
| 运行平台 | Linux / macOS（事件桥走 UNIX socket；Windows 请用 WSL） |
| 协议基线 | MCBE 1.21.130 / 协议 898，可用 `FB_NETEASE_PROTOCOL` 覆盖，详见 [docs/NETEASE_PROTOCOL.md](docs/NETEASE_PROTOCOL.md) |

### 配置

```bash
cp netease/netease.env.example netease/netease.env
chmod 600 netease/netease.env
# 填两项：
#   FB_NETEASE_SOCKET=/opt/netease-bot/bot.sock   # 机器人事件桥的 socket 路径
#   FB_NETEASE_TOKEN=xxxx                          # 事件桥 token
```

机器人侧按 `netease/config.json.example`（房间号/密码）和 `netease/mc.cfg.example`（`sauth` 登录凭证）填写，
这两份是**账号凭据**，权限设 600，别提交到仓库（`.gitignore` 已忽略 `netease/*.env`、`netease/config.json`、`netease/mc.cfg`）。

### 机器人（仓库自带，一键解压）

```bash
npm run setup:netease-bot     # 解压 vendor/ntvector 到 netease-bot/，装桥插件、生成 token
export FB_NETEASE_BOT_CMD="$PWD/netease-bot/start-bot.bat"
export FB_NETEASE_SOCKET="tcp://127.0.0.1:17999"
export FB_NETEASE_TOKEN="$(node -p "require('./netease-bot/ntvector/scripts/cubeloom_bridge/cubeloom_bridge.json').token")"
npm run netease               # 自动拉起机器人、等桥就绪、崩了 5 秒后重启
```

`netease-service` 会在退出时把机器人一起收掉；`/status` 的 `managedBot` 字段能看到
pid / 重启次数 / 最后错误。细节与"为什么绕不开账号和 OP"见
[packaging/netease-bot/README.md](packaging/netease-bot/README.md)。

### 启动

```bash
set -a; . ./netease/netease.env; set +a   # 载入环境变量（Windows 用 set 或写进 systemd）
npm run netease
```

另外起一个 `npm run admin` 打开面板（11452），「网易版（机器人 · 事件桥）」区会显示：

```
事件桥已连接 · 机器人 xxx · 服务器 x.x.x.x:xxxx · 协议 898（1.21.130）
```

### 使用

选 `.mcstructure` → 上传解析 → 「在网易服里导入」，自动跑三步：

1. **放置**：按 `FB_NETEASE_RATE`（默认 5 条/秒）限速下发 `setblock` / `fill`
2. **校验**：对表面抽样点发**幂等 setblock**（已经是目标方块算通过，缺的直接补上）
3. **完成**：报告通过 / 失败数量，进度同时推到面板和游戏内 actionbar

### 关键限制（实测）

- **不能用 `testforblock` 回读**：网易服会判 `bad_packet`（reason=90）踢线，所以校验用幂等 `setblock` 的回执代替
- **指令必须限速**：突发大量指令会被判「违规游戏行为」（reason=55）踢线；默认 5 条/秒，可用 `FB_NETEASE_RATE` 调，越低越稳
- 被踢后约 60 秒自动重连，重连后事件桥自动恢复
- 64×64×64（约 26 万方块）按 5 条/秒要跑约 15 分钟；**先用小结构确认原点和朝向**
- 和 WS 版一样只还原方块 ID，不还原方块状态（朝向/半砖/告示牌文字）
- 网易版服务和 WS 版互不影响，可以同时跑（11454 / 11451 两个端口）

## 打包与分发

### 桌面端（Electron，已可出包）

```bash
npm run build          # 预编译 server / desktop / mobile 三套产物
npm run dist:linux     # dist-app/Cubeloom-<版本>.AppImage
npm run dist:win       # Windows 安装包（在 Windows 或 CI 上跑）
npm run dist:mac       # macOS dmg（在 macOS 或 CI 上跑）
```

- 打包后的 App 自带 Node 运行时，用户不需要另装 Node；
- 面板在应用窗口里打开，游戏仍然 `/connect ws://127.0.0.1:11451`；
- 日志/口令/临时文件写到系统 userData 目录，安装目录保持只读也能跑；
- CI 的 `Desktop build` workflow 在 tag `v*` 或手动触发时构建三平台**未签名**产物。
- 细节与已知限制：[packaging/desktop/README.md](packaging/desktop/README.md)

### 手机端

- **Termux（今天就能用）**：`packaging/mobile/termux-install.sh`，手机同机
  `/connect ws://127.0.0.1:11451`，面板在浏览器打开；
- **独立 APK**：需要把 Node 运行时塞进 APK（nodejs-mobile，Node 18），
  仓库已经产出 `build/mobile/nodejs-project/`（`main.cjs` / `admin-server.cjs` /
  预构建几何库 / 面板资源），但 JNI 桥与 Gradle 工程尚未构建，因此暂无 `.apk`；
- 路线、步骤与工作量估计：[packaging/mobile/README.md](packaging/mobile/README.md)

## 安全说明

聊天栏 `-` 命令会在服务端执行 JavaScript，这是本项目的核心玩法，也因此必须说清边界：

- 沙箱基于 `node:vm` 独立上下文：脚本里 `process` / `require` / `Buffer` 不可达，字符串构造（`Function` / `eval`）被禁用，单条命令默认 5 秒超时（`FB_SANDBOX_TIMEOUT`）
- **已知逃逸链已封堵**：几何库（VoxelGeometry）打包后在上下文**内部**求值，`plot` / `setBlocks` / `session` 等宿主 API 通过隐藏桥接暴露——脚本拿到的是上下文函数，宿主对象/函数不会外泄。
  以前的 `plot.constructor('return process')().getBuiltinModule('child_process')...` 和 `sphere(1).constructor.constructor('return process')()` 现在都拿不到宿主（`test/sandbox.test.ts` 17 条用例锁死）
- **它仍然不是"无能力"沙箱**：`node:vm` 本身不是安全边界；并且 `setBlocks` / `session.sendCommand` 按设计就能改世界、发任意原版命令。要跑完全不可信的脚本，请把整个服务放进容器/虚拟机
- 认证默认值：本机（`127.0.0.1` / `::1`）连接免验证；**局域网或公网设备连进来必须先发 `--login <令牌>`**，令牌在启动日志里打印，可用 `FB_LOCAL_TOKEN` 固定
- 反向代理/隧道（cloudflared、nginx、frp）转发进来的连接即使远端显示为 `127.0.0.1`，只要带 `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` 就按外部连接处理，必须 `--login`
- 要让所有来源都免验证（不推荐）：`FB_ALLOW_ANON=1`

自测：`npm run check:sandbox`（39 项断言）+ `npm test`（74 条：沙箱逃逸/修补器/坐标契约/格式解析/鉴权/发送队列/网易桥/托管机器人）。

> 维护与风险清单：见 [docs/维护手册.md](docs/维护手册.md)。

## 目录

```
main.ts              WS 服务
admin-server.ts      本地管理面板
cli.mjs              终端交互版
netease-service.ts   网易版事件桥
src/                 结构解析 / NBT / 格式 / 沙箱 / 会话
admin/               面板前端（原生 HTML/CSS/JS，无构建）
deploy/              systemd 单元模板
docs/                协议基线、CLI 说明、移植笔记、维护手册与风险清单
tools/               set-password.mjs、check-sandbox.ts
test/                数据层回归测试（node --test：修补器 / 坐标契约 / 解析）
tsconfig.json        类型检查配置（npm run typecheck）
```

## 与上游的关系

Cubeloom 是 [CyanQiuper-Builder](https://github.com/Diamond-Minec/CyanQiuper-Builder) 的社区分支，
**移除了全部商业化模块**（用户中心、订阅计费、支付回调、插件市场、多实例编排），只保留工具本体。

谱系：

```
Diamond-Minec/CyanQiuper-Builder (MIT)
        │  本项目 fork 并剥离商业模块，改为 AGPL-3.0
        ▼
xiaopi668/cubeloom (AGPL-3.0)
```

上游署名与保留的 MIT 声明都写在 [NOTICE](NOTICE) 里。落块层、回显层、命令沙箱
与会话的注入逻辑均为独立实现，只保留导出名、类型字段名这类接口形状。

运行时依赖：`@pureeval/voxel-geometry`（VoxelGeometry，AGPL-3.0）、`mcpews`（MIT）、`ws`（MIT）。

## 已知限制

- `@pureeval/voxel-geometry` 锁在 `1.2.10`：该版本 npm 元数据里没有 `license` 字段，许可依据只能看源码仓库的 LICENSE
- 落块层每块发一条 `setblock`，十万级结构会产生同等数量的命令；要提速可以合并成 `fill`，但那会改变与服务器交互的节奏，暂未做
- 网易版需要自备机器人本体（参考 NTvector），本仓库不含
- 管理面板为单实例本地工具，没有账户体系；若要多人使用请自行加反代与访问控制

## 贡献

提交前请跑：

```bash
npm run check:sandbox
```

Issue / PR 都欢迎。涉及许可证或上游署名变更的改动，请在 PR 描述里说明理由。

## 免责

本项目与 Mojang、Microsoft、网易均无关联。使用相关服务时请遵守对应服务条款。
