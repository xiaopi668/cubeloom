# 更新记录

版本号在 `package.json`（`version`）和 `packaging/android/app/build.gradle`（`versionName` / `versionCode`）两处同步。
0.1.6 之前有 git tag（`v0.1.2` … `v0.1.6`）；之后按功能批次归纳，逐条提交见 GitHub 提交历史。

## 0.2.8

**面板分成两个版本，不再混在一起**

- 侧栏顶部新增「国际基岩版 / 网易版」切换（选择记在 localStorage）：
  - 国际基岩版：仪表盘、结构导入、图片导入、像素字、任务队列、快捷操作、控制台，以及 WS 状态、`/connect` 地址、服务启停按钮
  - 网易版：网易账号 / 房间 / 机器人 / 事件桥导入，顶栏只保留「网易版服务」状态
  - 日志两边都显示
- 切换时如果当前页不属于该版本，自动跳到该版本首页；网易版会立刻刷新一次服务状态
- 顶栏新增网易版状态 pill（事件桥连接时亮绿灯）

## 0.2.7

参考 GitHub `adb-lanlu/Crow-Brother-Ads`（联机大厅广告机，C# + C++）里真实调用网易接口的那部分：

- 新增 `searchLobbyRoomsByResId()`：按联机专区组件 ID 列房间（`/online-lobby-room/query/list-room-by-res-id`），面板搜索框支持 `组件:<res_id>` 写法
- PE 领取组件增加域名回退：`g79mclobt` 网络层失败时换 `g79apigatewayobt` 再试一次（`16 目标找不到` / `另一处登录` 不换，避免白发请求）
- 修正引擎 `--NeteaseServerID`：联机大厅走 PE 账号时用房间 `entityId`，走 PC 账号时用 `resId`（与 VQ `LaunchPage` 的分支一致；之前一律传 entityId）
- 测试 131 条

## 0.2.6

参考《星月导入器 1.0.5》（Go 源码）的 `chunk_fill` 规划器，补上两处正确性/效率细节：

- **6 种轴向顺序各试一遍**，取体积最大的盒子（同体积优先更「方」的），不规则形状命令数更少
- **重力/附着方块移出 fill**：沙、砂砾、混凝土粉末、火把、铁轨、门、告示牌、作物、藤蔓等逐块 `setblock`，并在实心块之后自下而上放，避免下落/脱附
- 单条 `fill` 上限从 32768 改为 **32766**（`/fill` 含端点计数，32768 会被拒）
- 测试：128 条（新增特殊方块分类、特殊块排序、覆盖一致性）

## 0.2.5

**大面积放置改用 3D `fill` 合块**

- `structureCommands()` 从「沿 z 合并成 1×1×N」升级为 3D 贪心：先沿 z 拉线、再沿 x 扩面、最后沿 y 堆体，同名字同状态的实心区域一条 `fill` 覆盖
- 实测：16³ 实心 = 1 条命令；32³ = 1 条；64³ = 8 条（旧版 262144 条 setblock），规划耗时约 0.1s
- 单条 `fill` 体积默认 32768（`/fill` 上限），超出自动按层/按列切片，覆盖范围不变
- 新环境变量：`FB_FILL_MAX`（WS 版）、`FB_NETEASE_FILL_MAX`（网易版），设成 `1` 退回逐块 `setblock`
- 测试：126 条（新增 3D 合块、切片守恒、混合方块+空腔覆盖一致性）

## 0.2.4

**修复 Windows 桌面版「后台服务 20 秒内没有就绪」**

- 端口被占用时不再直接失败：11452 上是 Cubeloom 就复用（旧实例没退干净也能开），是别的程序就自动改用 11462–11472
- 后台服务的 stdout/stderr 落到 `%APPDATA%\Cubeloom\logs\desktop.log`；启动失败对话框直接贴出最近 30 行，不用再去翻目录
- 等待时间 20s → 30s；新增 `/api/ping`（不需要登录）用于识别端口上是不是 Cubeloom
- 网易机器人（43MB、上万文件）的首次复制改成**后台进行**，不再挡在启动流程里（被杀软扫描时尤其明显）
- 回环模式下 `auth.json` 损坏/缺字段不再直接拒绝启动：改名成 `auth.json.broken-<时间戳>` 后按无口令模式启动（只绑 127.0.0.1）；非回环仍严格 fail-closed
- 版本 0.2.4（versionCode 38）

## 0.2.3

- **登录频控冷却按账号隔离**：换账号后不再被上一个账号撞出来的 20 分钟冷却锁住（之前是全局的，新账号点「领取组件」直接报频控、根本没发请求）
- **sauth 绑定账号**：`sauth.json` 记 `account`；导入登录态 / 退出登录会清掉 sauth；账号对不上时拒绝拿旧 sauth 去换 PE token（避免换到别人账号头上）
- 领取失败时显示**真实的 PE 失败原因**（网易原话），不再一律写成「登录频控」
- CI：签名凭据改成只有非空才注入环境（electron-builder 26 会把空 `CSC_LINK` 解析成项目目录，报 `build/desktop not a file`，这是 macOS 构建连续失败的真正原因）
- 版本 0.2.3（versionCode 37）

## 0.2.2

- 桌面端应用图标：Windows `.ico`（16–256 多尺寸）、macOS `.icns`（128–1024）、Linux/窗口 `icon.png`，Electron 窗口图标一并设置
- Android 启动图标：补齐 `mipmap-*` 传统图标 + `mipmap-anydpi-v26` 自适应图标（深色底 `#0B0B0B`），Manifest 挂 `android:icon` / `roundIcon`
- 修 macOS 打包：runner 的 bash 3.2 + `set -u` 下空数组 `"${FLAGS[@]}"` 会报 unbound variable（0.2.1 的 macOS 构建因此失败）
- 版本 0.2.2（versionCode 36）

## 0.2.1

- Windows 桌面构建改为**自签名**（secrets 已配 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`，自签证书 `CN=Cubeloom`，2029-11 到期）
- 公钥证书随仓库分发：`packaging/desktop/codesign/cubeloom-selfsigned.crt`，用户手动信任后 SmartScreen 不再提示「未知发布者」
- macOS 仍为未签名/未公证（缺 Developer ID 证书与 Apple 公证凭据）

## 未发布

**桌面端代码签名**

- `desktop.yml` 接入签名：Windows `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`（Authenticode），macOS `CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`（公证）
- macOS 打开 Hardened Runtime，新增 `packaging/desktop/entitlements.mac.plist`（JIT / 未签名内存 / 原生库加载）
- 有证书时带 `--config.forceCodeSigning=true`，签名失败直接构建失败；没证书仍出未签名包
- Android 签名仍走 `CUBELOOM_KEYSTORE_B64` 等 secrets（README「代码签名」有完整表）

## 0.2.0

> 版本号从 0.1.x 跳到 0.2.0：组件领取（PE 通道）这条主链路打通，按语义化版本给到 0.2。

**联机专区组件领取打通（实测 `code=0`，进房拿到地址）**

- 查清 `501 物品还未获得` 的真义：当前凭据对应的 **PE entity** 没有这间房的联机专区商品；联机专区是 PE 商城商品（`channel_id=5`），PC 商城查不到，PC 凭据进同一间房照样 501
- 「您的帐号在另一处登录」的真因不是手机抢会话，而是**每次 `/pe-authentication` 都会顶掉同账号旧的 PE token**；`session.json` 增 `peTokenAt`，超过 30 分钟先刷新
- 手动领取流程重写：先查 `/item-channel/...` 的 `buy_state`（已拥有不下单）→ PE 商城 `/pe-purchase-item/` → `code=16` 才换 PC → `502` 按成功处理 → 自动重试一次进房
- 进房通道改为 **PE 优先**（`enterLobbyRoom`），取地址/退房沿用进房成功的凭据；联机大厅/本地联机启动引擎改用 PE 的 `--UserID/--MD5Token`
- 撞「另一处登录 / 请先登录」用 sauth 重登一次，同时换新 x19 + PE；PE 登录频控落盘 `auth-cooldown.json`（20 分钟）
- 面板：登录态恢复后显示「已恢复登录态：uid … / 有效期剩 N 分钟」，不再一律显示「未登录」
- 新增 [`docs/组件领取排查.md`](docs/组件领取排查.md)：证据链、错误码表、限流坑
- 测试：123 条（新增 10 条：PE-first 领取、502 幂等、16 换通道、失效即止、通道顺序、`pe_entity_id=0`、PE/PC 501 回退、归属查询）

## 0.1.34

**组件领取改为手动**（进房流程不再发任何购买请求）

- 进房返回 `501 物品还未获得` 时，只报出组件 ID（联机大厅用列表里的 `res_id`，本地联机用服务端回传的 `res_id` 或房间号），不再自动调 `/user-item-purchase` / `/pe-purchase-item/`
- 面板新增「组件 ID」+「领取组件」：手动触发，顺序为 **PC 商城 → PE 通道**；PE 撞「您的帐号在另一处登录」后 5 分钟内不再空转
- 联机大厅选中房间时自动把 `res_id` 填进组件 ID
- 501 之后不再偷偷取地址（旧版会绕过组件直接 `/online-lobby-game-enter`）
- 测试：113 条（新增「501 不得自动购买」「501 不得偷偷取地址」「手动领取 PC→PE 顺序」）

## 0.1.33

**PE（基岩版）通道登录**

- Go 登录助手新增 `/pe-authentication`：`PeSign` 自制签名 + G79 V12 AES（密钥表、尾部标记字节、响应尾部 128 字节签名区逐字节对齐 VQ 1.6.2）
- 登录结果新增 `pe_entity_id` / `pe_token` / `pe_error`；`mode:"pe"` 可只换 PE token
- 登录时把 sauth 另存 `netease-bot/sauth.json`（0600），面板「PE 通道登录」可免密码单独换 PE token
- `session.json` 升到 v2，导出/导入/重启恢复都带 PE 登录态
- 面板新增「测试房间」（只解析地址不拉引擎）、`/api/netease-service/probe`
- 修复 `build-android.mjs` 的缓存 bug：以前只要 `build/mobile` 存在就跳过打包，导致 APK 里是旧面板/旧服务端

## 0.1.27 – 0.1.32

**多格式导入与移动端打磨**

- `.vt`（VQ/Vector 建筑）导入：`VTVB` + AES-256-CBC + HMAC + Deflate，还原方块状态与命令方块内容
- BDX、ZIP、gzip、Java NBT、`.mcstructure` 统一走文件头识别，`formats.ts` 单一入口
- 结构导入支持命令方块 `command_update`（网易桥），告示牌文字仍未还原
- Android：原生引擎补齐 Go 登录助手 `libx19login.so`、事件桥插件同步、保存对话框走 `ACTION_CREATE_DOCUMENT`
- 面板登录态导出改为弹系统文件选择器（桌面 `showSaveFilePicker`，Android 走原生桥）
- 图标更新（立体方块 + 织线）

## 0.1.16 – 0.1.26

**网易版登录与本地联机**

- 账号登录链路改为仓库内 Go 助手 `tools/x19login`（设备指纹 + mpay + 短信/上行短信），支持邮箱、手机号、短信、sauth 四种方式
- 登录态保存 `netease-bot/session.json`（0600），支持导出 / 导入 / 刷新 / 清除
- 四种进服方式：租赁服、联机大厅、山头服、本地联机
- **本地联机改为填房间号**（不是 IP）：直接 `/online-lobby-room-enter` → `/online-lobby-game-enter`，房间不会出现在大厅搜索里
- 房间解析增加冷却：进房 10 秒、组件购买 30 分钟，均持久化到 `netease-bot/*.json`
- 事件桥改 TCP NDJSON（17999），ECONNREFUSED 只提示一次「事件桥未就绪」

## 0.1.7 – 0.1.15

**账号 + 房间登录、原生引擎与三端产物**

- 面板填网易账号 + 房间号即可登录并启动机器人（不再必须先导 `mc.cfg`）
- 四种房间类型的 X19 动态签名与地址解析，固定向量单测对齐 VQ 1.6.2
- Linux / macOS 原生网易引擎（`npm run build:engine`，不再强制 Wine），Windows 仍用 `Program.exe`
- Android 原生引擎（Chaquopy Python 3.12 + `libcubeloom_engine.so`）与 APK 远程模式
- GitHub Actions 产出 Windows EXE、Linux AppImage、Android APK
- `.mcstructure` / `.bdx` / `.litematic` / `.schem` / `.schematic` / `.nbt` / `.mcworld` 导入与损坏修补
- 结构导入三步流水线：放置 → 回读校验 → 补建；游戏内 HUD 与面板同步进度

## 0.1.2 – 0.1.6

- WS 服务、管理面板、沙箱、voxel 几何、日志与口令体系的最初几版
