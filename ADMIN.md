# Cubeloom 后台管理

Minecraft 基岩版 WebSocket 结构生成器 + 黑白配色网页后台。
网页里可以直接看**日志文件**、执行沙箱代码、启停 WS 服务。

## 一键启动

双击 **`start.bat`**（停止用 `stop.bat`）。

1. 检查 `node` 和依赖（缺依赖会自动 `npm install`）
2. 启动 **WS 服务**：`ws://127.0.0.1:11451`（Minecraft 客户端连这个）
3. 启动 **网页管理端**：`http://127.0.0.1:11452`（自动打开浏览器）
4. 关闭那个控制台窗口 = 停止全部服务

> 也可以命令行单独启动：`npm run admin`（管理端，会带起 WS） / `npm run ws`（只起 WS）

## 游戏里怎么连

```国际基岩版
/connect ws://127.0.0.1:11451
```

连上后网页状态栏变成「游戏已连接」。

## 日志（自动写入文件，网页直接读取）

两个服务都会**自己写日志文件**，不需要手动记录：

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `logs/ws.log` | WS 服务（`main.ts`） | 启动信息、游戏连接/断开、控制台执行的代码与结果、原生命令、默认方块修改、错误 |
| `logs/admin.log` | 管理端（`admin-server.ts`） | 管理端启动、WS 服务启停、日志清空等管理操作 |

网页右侧「实时日志」面板做的事：

- **直接跟随 `logs/` 下的日志文件**（SSE，300ms 轮询文件增量），不是内存缓冲，重启页面/重启管理端都不会丢历史
- 下拉框切换 `全部日志 / ws.log / admin.log`，旁边显示文件大小和最近写入时间
- 暂停 / 自动滚动 / 刷新 / 清空 / 下载（下载的是真实日志文件）

## 网页管理端功能

| 功能 | 说明 |
| --- | --- |
| 状态面板 | WS 是否运行、端口、协议版本、游戏连接数、是否加密、当前原点、运行时长 |
| 运行统计 | 命令执行数、setblock 方块数、聊天消息数、错误数 |
| 实时日志 | 直接读 `logs/*.log`，支持文件切换、暂停、自动滚动、清空、下载 |
| 控制台 | 执行任意沙箱 JS（`plot(sphere(3,0))`、`pos()`、`1+1`…）；以 `/` 开头则当原生命令发送 |
| 快捷按钮 | `pos()` / 球 / 金圆盘 / 脚下放金块 / 脚下清空 |
| 默认方块 | 改 `setting.block`，之后所有 `plot()` 都用这个方块 |
| 服务启停 | 启动 / 停止 / 重启 WS 服务 |
| 连接地址 | 一键复制 `/connect ws://127.0.0.1:11451` |
| 结构导入 | 多格式：`.mcstructure` / `.bdx` / `.vt` / `.litematic` / `.schem` / `.schematic` / `.nbt`，`.mcworld` / `.zip` 自动取包内结构；可修补损坏文件 |
| 图片导入 / 像素字 | 图片或文字 → 方块画 |
| 网易版 | 账号登录（x19 + 可选 PE 通道）、四种房间（租赁服/联机大厅/山头服/本地联机）、测试房间、组件手动领取、机器人启停 |
| 任务队列 | 命令 / 等待 / 结构导入 顺序执行 |
| 快捷操作 | 球 / 圆盘 / 墙 / 清空等预设 |

## 端口

| 端口 | 用途 | 绑定 |
| --- | --- | --- |
| 11451 | WS 服务（游戏连） | 所有网卡 |
| 11452 | 网页管理端 | 仅本机 127.0.0.1（局域网访问需显式开启） |
| 11453 | 本机控制接口（管理端内部调用） | 仅本机 127.0.0.1 |
| 11454 | 网易版导入服务 `netease-service.ts` | 仅本机 127.0.0.1（`FB_NETEASE_PORT`） |
| 17999 | 机器人事件桥 TCP（`cubeloom_bridge`） | 仅本机 127.0.0.1（`FB_NETEASE_SOCKET`） |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FB_ADMIN_PORT` | 11452 | 管理页端口 |
| `FB_ADMIN_HOST` | 127.0.0.1 | 管理页绑定地址。默认只监听回环；改成 `0.0.0.0` 前**先设面板口令**（`npm run set-password`），否则等于把代码执行入口开给整个局域网 |
| `FB_ADMIN_AUTH_FILE` | `admin/auth.json` | 口令文件路径（多实例/测试用） |
| `FB_ADMIN_ALLOW_NO_AUTH` | 未设 | `1` = 显式允许"非回环 + 无口令"的面板；不设时这种配置会**拒绝启动** |
| `FB_ADMIN_COOKIE_SECURE` | 未设 | `1` = 强制 Cookie 带 `Secure`（https 反代下也会自动加） |
| `FB_WS_PORT` | 11451 | WS 服务端口 |
| `FB_CONTROL_PORT` | 11453 | 控制接口端口 |
| `FB_WS_VERSION` | 17104896 | WebSocket 协议版本（1.5.0）。换成更老的客户端（如网易版 1.21.1）握手失败时可调 |
| `FB_NO_OPEN` | 空 | 设为 `1` 则不自动打开浏览器 |
| `FB_NETEASE_PORT` | 11454 | 网易版导入服务端口 |
| `FB_NETEASE_SOCKET` | `tcp://127.0.0.1:17999` | 机器人事件桥地址 |
| `FB_NETEASE_TOKEN` | 自动生成 | 事件桥 token（`npm run setup:netease-bot` 生成） |
| `FB_NETEASE_BOT_DIR` | `<root>/netease-bot` | 引擎/配置/登录态目录 |
| `FB_NETEASE_RATE` | 5 | 向网易服下发指令的限速（条/秒） |
| `FB_NETEASE_PROTOCOL` | 898 | 覆盖协议号（默认 MCBE 1.21.130） |
| `FB_X19LOGIN` | 自动查找 | 指定 Go 登录助手路径（Android 侧是 `libx19login.so`） |
| `FB_PURCHASE_COOLDOWN_FILE` | `netease-bot/purchase-cooldown.json` | 组件购买限流冷却文件 |

## 说明

- 管理端接口默认只监听 `127.0.0.1`，不对局域网开放；要开放必须显式设置 `FB_ADMIN_HOST` 且先设口令。
- 如果 WS 服务是单独启动的（不是管理端拉起的），网页上的「停止/重启」会提示改用 `stop.bat`，只监控不误杀。

---

## 部署（Linux 服务器，systemd）

仓库内含两个单元模板，复制到 `/etc/systemd/system/` 后按需改路径：

```bash
sudo cp deploy/cubeloom.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cubeloom
```

| 项 | 默认值 |
| --- | --- |
| 工作目录 | `/opt/cubeloom` |
| 管理页 | `http://127.0.0.1:11452`（需口令） |
| WS 服务 | `:11451`（游戏内 `/connect` 这个地址） |
| 控制接口 | `127.0.0.1:11453`（仅本机） |
| 日志 | `logs/ws.log`、`logs/admin.log` |

### 面板口令

口令只保存 scrypt 哈希，存于 `admin/auth.json`（权限 600）：

```json
{ "passwordHash": "scrypt$N$r$p$saltB64$keyB64", "secret": "…", "sessionHours": 12 }
```

```bash
printf '%s' '新口令' | node tools/set-password.mjs --stdin
systemctl restart cubeloom
```

- 登录成功后发 HttpOnly + SameSite=Strict 签名 Cookie（`exp.epoch.mac`），默认 12 小时；https/反代下自动加 `Secure`
- 每次 `npm run set-password` 都会轮换 secret 并递增 `epoch`，**旧 Cookie 立即失效**
- 已登录时调用 `POST /api/auth/revoke` 可立即踢掉所有会话（含当前），无需重启面板
- 启动时的 fail-closed 规则：非回环绑定且 `admin/auth.json` 不存在 → 拒绝启动；文件损坏 → 拒绝启动；只有 `FB_ADMIN_ALLOW_NO_AUTH=1` 才显式放开
- 同一 IP 5 分钟内错 8 次锁定 5 分钟
- 本机开发想免登录：删除 `admin/auth.json` 即可

> 管理页默认是 HTTP 明文。要让外部访问，请自行在前面加一层 HTTPS 反代（nginx / Caddy），
> 并确保 `11452` 不直接暴露到公网。

### 端口

| 端口 | 用途 | 建议 |
| --- | --- | --- |
| 11452 | 管理页（需口令） | 仅本机或反代之后 |
| 11451 | WS 服务（游戏连） | 局域网/公网可达时，外部连接强制 `--login` |
| 11453 | 本机控制接口 | 仅 127.0.0.1 |

## 界面（v2）

- **品牌图形**：`admin/assets/logo.svg` / `icon.svg` / `favicon.png` / `icon-512.png` / `apple-touch-icon.png`（三颗等距体素方块向上生长 + 两颗拖尾小方块，青绿三阶配色）；生成脚本已随商业化模块一起移除，重绘时替换同名文件即可（`logo.svg`/`icon.svg` 直接改 fill 颜色）
- **主题切换**：右上角「切换到浅色 / 切换到深色」，偏好存 localStorage，登录页同样生效
- **时间统一 UTC+8**：服务端日志与页面显示全部北京时间（日志行内是 `2026-10-29T18:48:06+08:00`），页面右上角有时钟
- **全中文界面**：按钮、统计、提示、游戏内回显（`>> 已执行` / `>> 结果：2` / `>> 错误：…`）、欢迎语都是中文
- **新增功能**：
  - 玩家信息面板：玩家名 / 坐标 / 维度（向游戏发 `querytarget @p` 查询，每 10 秒自动刷新）
  - 快捷结构预设：球体 / 圆盘 / 圆柱 / 墙 / L 系统
  - 常用方块快捷选择（铁块、金块、钻石块、石英、石头、玻璃、萤石、海晶灯）
  - 最近命令（最近 8 条，点击填入控制台）
  - 日志关键字搜索

## 游戏内命令

在游戏聊天框里输入（-- 开头是会话命令，- 开头是 JavaScript 代码）：

| 命令 | 作用 |
| --- | --- |
| `--help` | 显示完整帮助（也支持 `--?`） |
| `--stop` | 断开游戏与本服务器的连接（世界不受影响，重新 `/connect ws://…` 即可恢复） |
| `-pos()` | 记录当前位置作为原点 |
| `-plot(sphere(3,0))` | 生成球体（默认铁块） |
| `-plot(sphere(3,0), undefined, "minecraft:gold_block")` | 指定方块生成 |
| `-setting.block = "minecraft:quartz_block"` | 改默认方块 |
| `-1+1` / `-Date.now()` | 执行任意 JavaScript 并回显结果 |
| `--xxx`（其它） | 提示未知命令 |

> 原理：`--stop` 是给游戏发 `closewebsocket` 命令，优雅关闭 WebSocket 连接；服务端会记录断开并清理会话。

## 导入结构（多格式）

「结构导入」页支持按**文件头自动识别**格式（不依赖扩展名），完整格式表见下文「投影文件导入」：

1. 选文件（`.mcstructure` / `.bdx` / `.vt` / `.litematic` / `.schem` / `.schematic` / `.nbt`，或含这些文件的 `.mcworld` / `.zip`）
2. 点「上传并解析」→ 显示尺寸 / 方块数 / 调色板种类 / 识别到的格式
3. 游戏里先发 `-pos()` 把放置原点设在脚下，再设 Y 偏移（默认 0）
4. 点「开始生成」→ 三步流水线（放置 → 校验 → 补建，见下文）
5. 进度同时显示在**网页进度条**和**游戏内 actionbar**（`titleraw @s actionbar`，例如 `导入「house」 [########------------] 43% 1240/2880`）
6. 过程中可点「取消」中止

实现说明：

- `.mcstructure` 按 `block_indices`（ZYX 顺序，z 变化最快）解析，忽略 `air` 与 `-1` 空位
- `.mcstructure` / `.bdx` / `.vt` 会还原方块状态；`.schem` / `.litematic` 等 Java 投影只还原方块 ID
- `.vt` 用 `VTVB` + AES-256-CBC + Deflate；命令方块内容通过网易桥 `command_update` 补写，告示牌文字暂未还原
- 沿 z 轴把连续同方块合并成 `fill` 命令，命令数大幅减少（例：156 方块 → 58 条命令）
- 每批 60 条命令、间隔 40ms；每 250ms 更新一次 actionbar 进度
- 单次上限 50 万方块（64×64×64=26 万方块约 4096 条 fill 命令）；上传文件上限约 64MB

## 游戏与玩家信息面板

后台左栏「游戏与玩家信息」会读取并显示：

| 分类 | 内容 |
| --- | --- |
| 玩家 | 名称、坐标、维度、朝向（yRot）、实体 ID、uniqueId（来自 `querytarget @p` 的 `details` 字段） |
| IP | 游戏客户端地址（会话来源 IP:端口）、服务器公网 IP、本机/内网地址 |
| 游戏版本 | 基岩版版本号（`Build`）、平台（`Plat`）、平台代号（`BuildPlat`）、版本类型（`editionType`） |
| 其他 | 语言 `locale`、游戏模式 `PlayerGameMode`、账号类型、User ID、Client ID、Server ID、设备会话、世界会话等 |
| 原始数据 | 可展开查看完整 JSON（含 game 事件上报的全部字段） |

- 版本/设备信息来自游戏事件上报（PlayerMessage / PlayerTravelled）；**在游戏里随便发一条消息**就能读到
- 查询只使用无副作用的 `querytarget` / `list`，**不会再传送玩家**（旧版曾用 `tp` 兜底，已删除）
- 玩家信息每 10 秒自动刷新一次，也可点「刷新玩家信息」

## 修补 .mcstructure 文件

后台「导入结构」面板新增 **「修补文件」** 按钮，用来修复损坏/不兼容的结构文件（很多第三方导出工具或手改的文件基岩版读不了）。

能自动修复的问题：

| 问题 | 处理 |
| --- | --- |
| 文件被 gzip 压缩（一些工具会压缩） | 解压成标准未压缩 NBT |
| 末尾缺少结束标记（截断 1~16 字节） | 自动补齐，重新解析 |
| `block_indices` 只有 1 层 / 多于 2 层 | 补第二层（全 -1）/ 只保留前两层 |
| 层内数量与尺寸乘积不一致 | 用 -1（保持原方块）补齐或截断 |
| 方块索引越界 / 非整数 | 置为 -1 |
| 缺 `format_version` / `structure_world_origin` / `entities` / `block_position_data` | 补默认值 |
| 调色板条目缺 `name` | 按 `minecraft:air` 处理 |
| 调色板是字符串数组（少见） | 转成标准结构 |
| 调色板带方块状态 | 保留方块 ID，状态不写入（导入本来也不还原状态） |

使用方式：

1. 选择文件 → 点 **「修补文件」**
2. 下方显示修复报告（例如「已修复 3 处问题：……」，或「文件本来就规范」）
3. 可点 **「下载修补后的文件」** 保存标准格式副本（名字带 `-repaired`）
4. 修补成功后该结构自动成为「待生成」，直接点「开始生成」即可

> 无法修复的情况（文件截断在数据中间、不是 NBT、缺少调色板/尺寸）会明确报错，不会生成半成品。

## 导入完整性校验与补建

结构导入不再「发完就算成功」，而是逐条等游戏回执校验：

1. 每条 `setblock`/`fill` 都带回调，读游戏返回的 `statusCode`；`0` 为成功，其它为失败
2. 失败的命令自动 **补建**，最多 3 轮（每轮只重发失败的那几条，不会重建整个结构）
3. 补建后仍失败的，会：
   - 游戏内聊天提示：`§c导入完成，但校验未通过：25 条命令 / 165 方块未能放置（已补建 3 轮）`
   - 后台页面显示：`⚠ 导入完成但校验未通过（165 方块失败，可点「补建未完成方块」）`
   - 面板新增 **「补建未完成方块」** 按钮：只重发上次失败的方块，成功后再校验（可反复点）

失败常见原因：目标区块未加载（离得太远 / 刚传送过去）、超出世界高度、方块 ID 无效。区块问题靠近结构中心后再点「补建」即可。

状态接口里也能看到：`verified`（是否校验通过）、`retried`（补建条数）、`failed`/`failedBlocks`（仍失败的命令/方块数）、`rebuild`（待补建数量）。

## 回读完整性检查（testforblock）

命令回执「成功」不代表方块真的放下了（区块未加载、跨区块边界等情况游戏可能仍返回成功）。所以导入结束后会**真的把方块读回来检查**：

1. 自动检查：导入完成后抽取结构**表面**的方块（最多 3000 个点），逐个 `testforblock` 回读
2. 发现缺失 → 用 `setblock` 补建 → 再复检这些点
3. 结果同时显示在游戏内聊天和后台面板：
   - `✓ 完整性检查通过：抽查 1899 点`
   - `完整性检查完成：抽查 1899 点，发现 12 处缺失，已全部补齐`
   - `⚠ 完整性检查：抽查 … 补建后仍有 N 处缺失（可能区块未加载）`
4. 面板新增 **「完整性检查」**（快速，抽样）和 **「深度检查」**（表面逐块，最多 3 万点）按钮，可随时手动重查
5. 状态接口字段：`structure.verify = { planned, checked, missing, fixed, remaining, deep, running }`

> 说明：受游戏命令接口限制，只能逐块 `testforblock` 回读，无法一次性全量校验；默认检查表面（看得见的地方），深度检查会检查表面全部位置。内部方块若缺失通常不可见，也无需处理。

## 导入三步流水线（强制）

结构导入现在是**必须走完的三步**，不是「发完命令就算完成」：

| 步骤 | 内容 | 游戏内显示 |
| --- | --- | --- |
| **1/3 放置方块** | 分批下发 setblock/fill，逐条等游戏回执，失败自动重新发送（最多 3 轮） | actionbar：`导入「x」 [####----] 43% 步骤 1/3 放置方块` |
| **2/3 完整性校验** | 用 `testforblock` 回读结构表面方块（默认最多 8000 点），统计缺失 | actionbar：`第 2/3 步 校验「x」 [###---] 42% 缺失 12` |
| **3/3 补建缺失** | 对缺失位置 `setblock` 补建，然后**复检**；全部存在才算通过 | actionbar：`第 3/3 步 补建「x」 [####--] 100%` |

结束语：

- 通过：`§a✔ 导入完成（三步全部通过）：castle · 3585 方块 · 命令 1044 条 · 回读抽查 1899 点 · 补齐 37 处`
- 未通过：`§c⚠ 三步未全部通过：… 回读缺失 N 处（靠近结构后再点「完整性检查」）`

后台面板同步显示当前步骤（`导入中（步骤 2/3 完整性校验）：…`）和结果；状态接口字段：`build.step / build.stepLabel`、`structure.verify`。手动「完整性检查 / 深度检查」按钮仍可随时再查。

## 网易版（租赁服 / 联机大厅 / 山头服 / 本地联机）

WebSocket 版需要客户端能 `/connect`；网易版走不了这条路，改用**机器人进服 + 事件桥**：
Cubeloom 把算好的原版指令通过 TCP 事件桥交给 NTvector 机器人，由机器人以玩家身份在服务器里执行。

### 组成

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| 机器人引擎 | `netease-bot/ntvector/`（Windows）/ `netease-bot/ntvector-native/`（Linux/macOS）/ APK 内置 `libcubeloom_engine.so` | NTvector + Cubeloom 桥插件 `cubeloom_bridge`，`npm run setup:netease-bot` 解压 |
| 事件桥 | `127.0.0.1:17999`（TCP，NDJSON） | 桥插件监听；`netease-service.ts` 连它下指令、收事件 |
| 导入服务 | `netease-service.ts`（11454） | 结构导入三步流水线、限速、重连、进度上报 |
| 网易账号登录 | `tools/x19login`（Go，零第三方依赖） | 设备指纹 + mpay 登录 → `entity_id + token`；可选 PE（基岩版）通道 |
| 后台面板 | 管理页「网易版」 | 登录 / 房间 / 测试房间 / 领取组件 / 机器人启停 / 实时日志 |

### 账号与房间

1. 账号卡片填 **网易邮箱 / 手机号 + 密码** →「登录」（风控要求时按提示填短信验证码或发上行短信）；
   登录成功后 token 存 `netease-bot/session.json`（0600），重启自动恢复。
2. 选房间类型：

| 类型 | 填什么 | 说明 |
| --- | --- | --- |
| 租赁服 | 房间号 / 房间名（可搜索）、密码 | `RentalGame` + `/rental-server-*`；账号需要是该服 OP 或服务器开作弊 |
| 联机大厅 | 房间号 / 房间名（可搜索）、密码 | `LobbyGame` + `/online-lobby-*`；搜到房间后列表里的 `res_id` 就是组件 ID |
| 山头服 | 从「刷新山头服列表」里选，或填 sid；邀请码可先加入 | `DomainGame` + `/domain-server-*` |
| 本地联机 | **4–8 位房间号**（不是 IP）、密码 | 直接 `/online-lobby-room-enter` → `/online-lobby-game-enter`，房间不会出现在大厅搜索里 |

3. 点 **「测试房间」** 只解析地址不启动引擎（排错首选）；点 **「启动机器人 + 网易服务」** 才会拉起引擎。

### 联机专区组件（`501 物品还未获得`）

带模组的房间进房会回 `501`。它的含义是**当前凭据对应的账号（PE entity）没有这间房绑定的联机专区商品**：联机专区是 **PE 商城商品**（`channel_id=5`），归属记在 PE entity 上，PC 商城查不到（回 `目标找不到`），PC 凭据进同一间房也照样 501。

Cubeloom **不会自动购买**，只把组件 ID 报出来：

```
联机大厅房间「72563」绑了联机专区组件（网易回 501：物品还未获得），组件 ID：4659475350398889607。
要进这个房间，先在面板点「领取组件」（联机专区是 PE 商城商品，必须走 PE 通道领取；领取后会自动重试一次进房）
```

点 **「领取组件」** 之后依次做三件事（一次点击最多产生一个购买请求）：

1. 查 `/item-channel/query/search-item-channel-list-by-id`（`channel_id=5`）的 `buy_state`，**已经拥有就跳过下单**；
2. 走 PE 商城 `/pe-purchase-item/`（`g79mclobt.minecraft.cn`，`item_id` 必须是 JSON 字符串）；PE 回 `code=16 目标找不到` 才换 PC 商城；`502 物品已经获得` 按成功处理；
3. 自动重试**一次**进房，成功就把 `host:port` 显示出来。

PE token 相关：

- 每次 `/pe-authentication` 成功，同账号**之前**的 PE token 立即作废，再用就回 `您的帐号在另一处登录`（不是手机抢会话）；
- `session.json` 里记 `peTokenAt`，超过 30 分钟先刷新；撞上「另一处登录」会用 sauth 重登一次（同时换新 x19 + PE）再重试一次；
- PE 登录有频控，失败后 `auth-cooldown.json` 记 20 分钟冷却，重启也不重置；引擎运行期间不主动刷新。

> 账号卡片的 `同时登录 PE 通道` 默认关闭；联机大厅/本地联机需要 PE 时会自动用 sauth 补一次。
> 手动兜底：点「PE 通道登录」。

### 使用

1. 「结构导入」页选文件（`.mcstructure` / `.bdx` / `.vt` / `.litematic` / `.schem` / `.schematic` / `.nbt`，或含这些文件的 `.mcworld` / `.zip`）→ 上传解析；
2. 「在网易服里导入」，自动跑三步：
   - **1/3 放置方块**：按 `FB_NETEASE_RATE`（默认 5 条/秒）限速下发 `setblock` / `fill`
   - **2/3 完整性校验**：对表面抽样点发**幂等 setblock**（已在 = `noChange` 通过，缺失的直接补）
   - **3/3 完成**：报告通过 / 失败数量，进度同步到面板与游戏内 actionbar
3. `.vt` 的命令方块内容会通过桥的 `command_update` 补写（更新前先 `/tp` 到附近）；告示牌文字暂未还原。
4. 联机大厅 / 本地联机启动引擎时用 PE 的 `--UserID/--MD5Token`（`--g79` 已开），租赁服 / 山头服用 PC 登录态。

### 关键限制（实测）

- 机器人账号必须是该服务器 **OP**（或服务器开启作弊），否则指令无效
- **不要用 `testforblock` 做回读**：网易服会判 `bad_packet`（reason=90）踢线，所以校验用幂等 `setblock` 的回执
- 指令必须限速：突发大量指令会被判「违规游戏行为」（reason=55）踢线；默认 5 条/秒，`FB_NETEASE_RATE` 可调
- 被踢后约 60 秒自动重连，重连后事件桥自动恢复
- 64×64×64（约 26 万方块）按 5 条/秒约 15 分钟；先用小结构确认原点和朝向
- 进房冷却 10 秒、组件购买冷却 30 分钟都持久化在 `netease-bot/*.json`，重启不重置

### 平台支持

| 平台 | 引擎 | 登录助手 | 说明 |
| --- | --- | --- | --- |
| Windows | 原生 `Program.exe` | `x19login.exe` | 安装包内置 |
| Linux | 原生 `Program`（`npm run build:engine`） | `x19login` | 未构建时回退 Wine |
| macOS | 原生 `Program` | `x19login` | 未构建时回退 Wine / CrossOver |
| Android | 原生 `libcubeloom_engine.so` + Chaquopy Python 3.12 | `libx19login.so` | APK 内置；也可用远程模式当遥控器 |

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示「缺少登录助手」 | 跑 `npm run build:x19login`；打包版应自带 `server/x19login[.exe]` |
| `登录态已失效：请先登录` | 面板重新登录，或「导入登录态」 |
| `您的帐号在另一处登录` | 同账号 PC/PE 会话互斥：取消勾选 PE 通道，或先退出手机上的游戏 |
| `操作过于频繁` | 网易登录频控：等 20 分钟（`netease-bot/auth-cooldown.json`） |
| `购买太频繁` | 组件购买冷却 30 分钟（`netease-bot/purchase-cooldown.json`） |
| `物品已经获得`（`code=502`） | 组件本来就在你名下，按成功处理 |
| 房间搜不到 / `无法找到该房间` | 房间号要完整；房间可能已关闭 |
| 引擎起不来 | 确认 `npm run setup:netease-bot` 解压过引擎；Linux/macOS 需 `npm run build:engine` 或装 Wine |

## 投影文件导入（.mcstructure / .bdx / .vt / .litematic / .schem / .schematic / .nbt）

上传后按文件头自动识别格式，不依赖扩展名：

| 格式 | 来源 | 说明 |
| --- | --- | --- |
| `.mcstructure` | 基岩版结构方块 | 未压缩 little-endian NBT，带方块状态；允许前置自定义头（自动扫起点）与 gzip 包裹 |
| `.bdx` | FastBuilder / PhoenixBuilder | `BD@` + brotli + 操作流；字符串表与旧版 data 都会还原，颜色按 1.20 的独立 identifier 折叠 |
| `.litematic` | Litematica 投影 | gzip + 大端 NBT，自动解 BlockStates 位打包（含负尺寸区域） |
| `.schem` | Sponge 原理图 v1/v2/v3 | 变长整数 `BlockData` |
| `.schematic` | MCEdit / WorldEdit 经典原理图 | `Blocks` 字节数组 + `AddBlocks` 高位；带 `Palette` 时按调色板映射 |
| `.nbt` | Java 结构方块导出 | `size` / `palette` / `blocks` |
| `.vt` | VQ / Vector 建筑 | `VTVB` 容器 + AES-256-CBC + Deflate；方块/状态/命令方块内容还原，告示牌文字暂未还原 |
| `.mcworld` / `.zip` | 世界存档 / 压缩包 | 从包里挑一个结构文件解析（优先 `.mcstructure`，其次 `.bdx` / `.litematic` / `.schem` / `.nbt`） |

- 自动识别：按文件头（BDX / ZIP / gzip / NBT 根节点）判断，不依赖扩展名
- `.mcstructure`、`.bdx`、`.vt` 会还原方块状态（楼梯朝向、半砖、颜色等）；Java 投影文件只还原方块名
- `.vt` 的命令方块内容通过引擎 `command_update` 补写（更新前会 `/tp` 到附近）；告示牌文字需要 BlockActorData，暂未还原
- 坐标会自动平移到最小角为 `(0,0,0)`，尺寸取实际包围盒
- 后台「导入结构 / 投影文件」面板直接选文件即可，解析后按三步流程导入
- `.mcworld` 是**世界存档**（`level.dat` + `db/`），本身不是结构；直接上传会提示改用结构方块导出。如果存档里带 `structures/*.mcstructure`，会自动取出来

> 注：`.schematic` 若使用旧版数字 ID 且没有 `Palette`，会按内置常见 ID 表映射；无法识别的 ID 会被跳过。
> BDX 若使用「运行时方块 ID 池」（操作 31/32…），需要按游戏版本查表才能还原，解析会直接报错；请用 FastBuilder / BDXConverter 导出「字符串方块」版本。


## 顶部 HUD（仿 PasteCraft-Builder）

导入/校验期间的 actionbar 改为多行 HUD，并且**任务结束前每 500ms 强制重发**，不会被游戏其它 actionbar 覆盖或超时消失：

```
§l§eCyanQiuper-Builder §r§7放置方块（区块 1/3）
总体进度  [██████████░░░░░░] 62%
区块进度  [███████░░░░░░░░░] 45%
文件名称  首都城
文件格式  .schem
已用时    00:02:31   剩余时间 00:01:34
```

- 阶段变化：`放置方块` → `第 2/3 步 完整性校验`（第二行变「回读进度 · 缺失 N」）→ `第 3/3 步 补建缺失`（第二行变「补建进度」）→ `✔ 三步全部通过`
- 文件格式自动识别（.mcstructure / .litematic / .schem / .schematic / .nbt）
- 「剩余时间」按当前速度估算；未开始时显示 `--:--`
- 结束后 HUD 保留 8 秒再停止刷新
- 进度条字符：`█` 已完成 / `░` 未完成；若某些设备字体缺字可改成 `#` / `-`

另：自动完整性校验上限已从 8000 点提高到 40000 点，64³ 这类结构会**全表面逐块回读**，不再只抽查 1/3。
