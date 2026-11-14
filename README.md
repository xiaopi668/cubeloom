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
结构文件 ──HTTP──> netease-service.ts (11454) ──TCP 17999──> 机器人事件桥 ──RakNet──> 网易租赁服
                          ▲
                   admin-server 反代 /api/netease/*
```

### 前提

| 项 | 要求 |
|---|---|
| 机器人本体 | **仓库自带** NTvector 官方 Windows 包（[vendor/ntvector](vendor/ntvector/)，MIT）+ Cubeloom 桥插件，`npm run setup:netease-bot` 一键解压 |
| 机器人账号 | 面板里直接填**网易账号 + 密码**（或短信验证码）和**房间号**；账号必须是目标服的 **OP**，或服务器开启作弊 |
| 运行平台 | 引擎是 Windows x64（Program.exe）：Windows 原生跑；Linux/macOS 装 Wine 也能跑（本机已验证引擎启动 → Python 3.12 → RakNet 初始化，真实进服待实测） |
| 协议基线 | MCBE 1.21.130 / 协议 898，可用 `FB_NETEASE_PROTOCOL` 覆盖（基线常量见 `src/netease-protocol.ts`） |

### 各平台怎么跑引擎

| 平台 | 网易引擎 | 登录助手 | 说明 |
|---|---|---|---|
| Windows | 原生 Program.exe | `x19login.exe` | 安装包内置，直接进服 |
| Linux | **原生 `Program`（不用 Wine）** | `x19login`（linux） | `npm run build:engine` 本地编译；CI 打 AppImage 时会自动构建。没构建原生引擎时才回退 Wine |
| macOS | **原生 `Program`（不用 Wine）** | `x19login`（darwin） | `npm run build:engine` 用随包 Python 3.12 构建；CI 的 dmg 会自动带上。未构建时才回退 Wine/CrossOver |
| Android | **原生 `libcubeloom_engine.so`**（arm64/x86_64） | `libx19login.so`（Go/NDK） | APK 内置 Chaquopy Python 3.12 + 引擎；`npm run build:engine:android` 构建。仍保留远程模式 |

Linux/macOS 的引擎检测结果会显示在面板「网易账号 / 房间」下面；有原生 `Program` 时显示 `native`，没有时才回退 Wine。APK 的远程模式不受宿主平台限制，宿主可以是 Windows、Linux 或 macOS。

Wine 相关环境变量：

```bash
FB_WINE=/path/to/wine          # 指定 wine 可执行文件（默认自动找 wine / wine64 / macOS 常见路径）
WINEPREFIX=~/.wine-cubeloom    # 隔离的 Wine 前缀（首次会初始化，约 300–400 MB）
FB_NETEASE_NO_WINE=1           # 禁用 Wine（例如你想手动用 CrossOver 启动）
```

首次运行 Wine 会初始化前缀；引擎不需要 .NET/Gecko，已经用 `WINEDLLOVERRIDES=mscoree,mshtml=` 抑制安装弹窗。

### 账号 + 房间（推荐，不用再导 mc.cfg）

```bash
npm run setup:netease-bot     # 1. 解压引擎、安装桥插件、生成桥 token
npm run admin                 # 2. 打开面板 →「网易版」页
```

面板里：

1. 填 **网易邮箱 / 手机号 + 密码** →「登录」（风控要求时按提示填短信验证码 / 发上行短信）；
2. 选 **房间类型**，再填对应信息：

| 类型 | 填什么 | 引擎参数 |
|---|---|---|
| 租赁服 | 房间号 / 房间名（可搜索），有密码填密码 | `RentalGame` + `/rental-server-*` |
| 联机大厅 | 房间号 / 房间名（可搜索），有密码填密码 | `LobbyGame` + `/online-lobby-*` |
| 山头服 | 点「刷新山头服列表」选一个，或填 sid；邀请码可先加入 | `DomainGame` + `/domain-server-*` |
| 本地联机 | 主机 IP + 端口（默认 19132），**不需要登录** | `LocalGame`，引擎走本地会话直连 |

3. 点 **「启动机器人 + 网易服务」**。

背后的链路是固定的：

```
账号/密码 ──stdin──> tools/x19login（Go：设备指纹 + mpay 登录，零第三方依赖）
                             │ entity_id + token
                             ▼
admin-server ──X19 动态签名──> g79mclobt.minecraft.cn
                             │ /rental-server/query/search-by-name
                             │ /rental-server-world-enter/get
                             ▼
              Program.exe --ServerIP … --UserID … --MD5Token …（argv，不经 shell）
```

- 密码只用于换 token，**不落盘、不进日志**；账号/房间/房间密码存在 `netease-bot/account.json`（0600）。
- 账号登录只支持**网易官服**（网易邮箱 / 手机号）；手机号填 **11 位大陆号码，不带 +86/区号**（带 `+86`、空格、横线会自动清理）。4399 等渠道服请用「高级 → mc.cfg」方式。
- token 只在 `admin-server` 内存里，默认 6 小时过期，过期后重新登录即可。
- 登录助手是 Go 写的（`tools/x19login`）：`npm run build:x19login` 构建本机版；
  `npm run build` 会自动产出 host + Windows 两个版本，打包时一起带进 `server/`。
- 房间地址、MD5Token 的生成逻辑在 `src/netease-room.ts`，有固定向量单测（与 VQ 1.6.2 / NeteaseLogin 逐字节对齐）。

### 免重复登录（保存 / 导出登录态）

登录成功后会把 `entity_id + token` 存到 `netease-bot/session.json`（权限 0600），
`admin-server` 启动时会自动读出来并调用登录助手刷新 token，所以重启面板/重开程序一般不用再登录。

面板「网易账号 / 房间」下面有四个按钮：

| 按钮 | 作用 |
|---|---|
| 导出登录态 | 下载 `cubeloom-netease-session-<uid>.json`，可带到别的机器导入 |
| 导入登录态 | 选一个导出的 JSON，验证并刷新后直接登录 |
| 刷新登录态 | 手动用当前 token 换新 token |
| 清除保存 | 删除本地 `session.json`（当前会话仍可用，退出/重启后才需要重登） |

> 登录态文件里的 token **等同于账号凭据**，不要发给别人；导入/导出走的是本机面板接口，面板本身仍需口令保护。

### 手动方式（mc.cfg / 环境变量）

引擎也认启动器导出的 `mc.cfg`，或者手写环境变量：

```bash
cp netease/netease.env.example netease/netease.env
chmod 600 netease/netease.env
#   FB_NETEASE_SOCKET=tcp://127.0.0.1:17999
#   FB_NETEASE_TOKEN=xxxx
```

```bash
export FB_NETEASE_BOT_CMD="$PWD/netease-bot/start-bot.bat"
export FB_NETEASE_SOCKET="tcp://127.0.0.1:17999"
export FB_NETEASE_TOKEN="$(node -p "require('./netease-bot/ntvector/scripts/cubeloom_bridge/cubeloom_bridge.json').token")"
npm run netease
```

`netease-service` 会在退出时把机器人一起收掉；`/status` 的 `managedBot` 字段能看到
pid / 重启次数 / 最后错误。细节见 [packaging/netease-bot/README.md](packaging/netease-bot/README.md)。

### 面板

`npm run admin` 打开面板（11452），「网易版」页负责登录/房间/启停；「网易版（机器人 · 事件桥）」卡片会显示：

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

### 账号登录常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 提示「缺少登录助手」 | 跑过一次 `npm run build:x19login`；打包版应自带 `server/x19login[.exe]` |
| 密码登录提示失败/风控 | 改用「短信验证码登录」；按提示填验证码，或按提示发上行短信后点「我发好了」 |
| 提示「请先登录网易账号」 | token 只在内存里，重启面板/超过 6 小时后需要重新登录 |
| 房间搜不到 | 房间号要填**完整数字 ID**（或房间名）；账号必须已购买/加入该租赁服 |
| 引擎起不来 | 确认 `netease-bot/ntvector/Program.exe` 已解压（`npm run setup:netease-bot`），且系统是 Windows x64 |
| 进服被踢、版本不符 | 用「高级 → 协议版本」覆盖，或换更新版本的 NTvector |

## 下载与使用（APK / EXE / AppImage）

推送到 `main` 或打 `v*` tag 时，GitHub Actions 会自动编译三端产物：
Actions 页面里对应 workflow 的 **Artifacts**（tag 构建还会附带 Release）。

| 平台 | 文件 | 怎么用 |
|---|---|---|
| Windows | `Cubeloom Setup <版本>.exe` / `Cubeloom-<版本>-win.zip` | 运行安装包；或解压后双击 `Cubeloom.exe` |
| Linux | `Cubeloom-<版本>.AppImage` | `chmod +x` 后直接运行 |
| Android | `Cubeloom-Android-<版本>-release.apk` | 传到手机安装（允许未知来源），打开 App；`npm run build:android -- --debug` 可出调试包 |

> 产物**未签名**：Windows 首次运行会弹 SmartScreen（更多信息 → 仍要运行）；macOS 需要
> `xattr -dr com.apple.quarantine /Applications/Cubeloom.app`；Android 是 debug 签名，仅自用/测试。

### Windows（EXE，自带网易机器人）

1. 下载 `Setup` 安装包或 zip，安装/解压后启动 Cubeloom，面板在应用窗口里打开；
2. 同一台电脑上进游戏：`/connect ws://127.0.0.1:11451`；
3. 安装包内置 NTvector（43 MB）、登录助手 `x19login.exe` 与网易版服务：面板「网易版」页
   填网易账号 + 密码（或短信）登录，再填房间号，点「启动机器人 + 网易服务」即可；
   老的 `mc.cfg` 导入收在「高级」里；
4. 日志、面板口令、机器人配置在 `%APPDATA%\Cubeloom`（`netease-bot/account.json`、
   `netease-bot/ntvector/mc.cfg`）。

### Linux（AppImage）

```bash
chmod +x Cubeloom-*.AppImage
./Cubeloom-*.AppImage
# 没有 FUSE 的发行版：
./Cubeloom-*.AppImage --appimage-extract-and-run
```

数据在 `~/.config/Cubeloom`。游戏内 `/connect ws://127.0.0.1:11451`。

### Android（APK）

APK 有**两种运行方式**（右下角 ⚙ 随时切换）：

1. **本机模式**：App 内启动 Node 18 服务 + **Android 原生网易引擎**（Chaquopy Python 3.12），
   账号登录（Go 助手 `libx19login.so`）、房间解析、机器人进服都在手机内完成；
   同一台手机进游戏 `/connect ws://127.0.0.1:11451`。
2. **远程模式**：直接填电脑/服务器的面板地址（如 `http://192.168.1.10:11452/`），
   网易账号登录、房间解析、机器人进服都在那台机器上完成，手机只当遥控器。

> Android 原生引擎为实验特性：已在 Waydroid x86_64（Android 13）验证引擎启动、Python 3.12、登录链路和 RakNet 连接；arm64 真机与“进服后事件桥导入”还需要用真实租赁服账号验证。APK 约 70 MB（含 Node 运行时、Python 3.12、两种 ABI 的引擎）。

远程模式对方要允许局域网访问（面板里点一下就行）：

1. 电脑/服务器打开 Cubeloom 面板 →「网易版」→ **手机 / 局域网访问**；
2. 设一个面板口令（至少 6 位）→ **开启局域网访问**；
3. 重启 Cubeloom，面板会显示 `http://192.168.x.x:11452/`；
4. 手机 APK 右下角 ⚙ → **连接电脑 / 服务器** → 填这个地址。

也可以在启动时用环境变量（等价）：

```bash
FB_ADMIN_HOST=0.0.0.0 npm run admin   # 必须先有 admin/auth.json 口令，否则 fail-closed 拒绝启动
```

日志在应用私有目录 `files/cubeloom/nodejs-project/logs`（仅本机模式）。

### 从源码构建

```bash
npm run build          # server / desktop / portable / mobile bundle
npm run build:engine   # Linux/macOS 原生网易引擎（不用 Wine；CI 会自动跑）
npm run build:engine:android  # Android arm64/x86_64 原生引擎（Chaquopy Python 3.12）
npm run dist:linux     # AppImage；Windows/macOS 用 dist:win / dist:mac
npm run build:android  # release APK（自动生成本地 keystore；可用 CUBELOOM_KEYSTORE 指定）
npm run build:android -- --debug  # debug APK（开发用）
```

## 安全说明

聊天栏 `-` 命令会在服务端执行 JavaScript，这是本项目的核心玩法，也因此必须说清边界：

- 沙箱基于 `node:vm` 独立上下文：脚本里 `process` / `require` / `Buffer` 不可达，字符串构造（`Function` / `eval`）被禁用，单条命令默认 5 秒超时（`FB_SANDBOX_TIMEOUT`）
- **已知逃逸链已封堵**：几何库（VoxelGeometry）打包后在上下文**内部**求值，`plot` / `setBlocks` / `session` 等宿主 API 通过隐藏桥接暴露——脚本拿到的是上下文函数，宿主对象/函数不会外泄。
  以前的 `plot.constructor('return process')().getBuiltinModule('child_process')...` 和 `sphere(1).constructor.constructor('return process')()` 现在都拿不到宿主（`test/sandbox.test.ts` 17 条用例锁死）
- **它仍然不是"无能力"沙箱**：`node:vm` 本身不是安全边界；并且 `setBlocks` / `session.sendCommand` 按设计就能改世界、发任意原版命令。要跑完全不可信的脚本，请把整个服务放进容器/虚拟机
- 认证默认值：本机（`127.0.0.1` / `::1`）连接免验证；**局域网或公网设备连进来必须先发 `--login <令牌>`**，令牌在启动日志里打印，可用 `FB_LOCAL_TOKEN` 固定
- 反向代理/隧道（cloudflared、nginx、frp）转发进来的连接即使远端显示为 `127.0.0.1`，只要带 `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` 就按外部连接处理，必须 `--login`
- 要让所有来源都免验证（不推荐）：`FB_ALLOW_ANON=1`

自测：`npm run check:sandbox`（39 项断言）+ `npm test`（87 条：沙箱逃逸/修补器/坐标契约/格式解析/鉴权/发送队列/网易桥/托管机器人/网易登录签名与房间解析）。


## 目录

```
main.ts              WS 服务
admin-server.ts      本地管理面板
cli.mjs              终端交互版
netease-service.ts   网易版事件桥
src/                 结构解析 / NBT / 格式 / 沙箱 / 会话 / 发送队列 / 网易桥 / 网易登录与房间解析
admin/               面板前端（原生 HTML/CSS/JS，无构建）
packaging/           desktop（Electron）/ android（APK）/ mobile / portable / netease-bot
vendor/ntvector/     随仓库分发的网易机器人（MIT，含校验值）
tools/x19login/      网易账号登录助手（Go，含 NeteaseLogin 的 MIT 副本）
test/                回归测试（node --test，74 条）
tools/               构建、打包、自测脚本
deploy/              systemd 单元模板
tsconfig.json        类型检查配置（npm run typecheck）
```

## 已知限制

- `@pureeval/voxel-geometry` 锁在 `1.2.10`：该版本 npm 元数据里没有 `license` 字段，许可依据只能看源码仓库的 LICENSE
- 落块层每块发一条 `setblock`，十万级结构会产生同等数量的命令；要提速可以合并成 `fill`，但那会改变与服务器交互的节奏，暂未做
- 网易登录助手内的 mpay 实现来自 [NeteaseLogin](https://github.com/DHY0627/NeteaseLogin)（MIT），已随仓库 vendor
- 管理面板为单实例本地工具，没有账户体系；若要多人使用请自行加反代与访问控制

## 贡献

提交前请跑：

```bash
npm run check:sandbox
```

Issue / PR 都欢迎。涉及许可证或上游署名变更的改动，请在 PR 描述里说明理由。

## 免责

本项目与 Mojang、Microsoft、网易均无关联。使用相关服务时请遵守对应服务条款。
