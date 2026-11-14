# 网易版机器人（仓库自带 NTvector + Cubeloom 桥插件）

网易租赁服没有 `/connect`，必须有机器人以玩家身份进服。**本仓库直接带了 NTvector 官方
Windows 包**（[vendor/ntvector/](../../vendor/ntvector/)，MIT），并提供 Cubeloom 的事件桥插件，
不用再去 GitHub 找 release：

```bash
npm run setup:netease-bot
# 解压到 netease-bot/ntvector/，装上 scripts/cubeloom_bridge/，生成随机 token
```

```
结构文件 → netease-service → tcp://127.0.0.1:17999 → cubeloom_bridge（NTvector 插件）→ 租赁服
```

## 你需要准备的

1. **账号**：在面板「网易版」里直接填网易邮箱/手机号 + 密码（或短信验证码）和房间号，
   Cubeloom 会用 `tools/x19login` 换 token、查房间地址，再以 argv 启动引擎；
   也仍然支持启动器导出的 `mc.cfg`（面板「高级」里）；
2. **权限**：这个账号必须是目标服的 **OP**，或服务器开启作弊；
3. **系统**：官方包是 **Windows x64**（Program.exe + 内嵌 Python 3.12）。
   Linux/macOS 可以直接用 **Wine** 跑（`FB_WINE` 可指定 wine 路径，`FB_NETEASE_NO_WINE=1` 关闭）；
   Android 不能直接跑 Windows 引擎，请用 APK 的「远程模式」连电脑/服务器。

## 启动

Cubeloom 可以直接托管机器人：

```bash
# Linux/macOS 跑 .bat 需要 wine 或改用 start-bot.sh（脚本已生成，指向同名 exe）
FB_NETEASE_BOT_CMD="$PWD/netease-bot/start-bot.bat" \
FB_NETEASE_SOCKET="tcp://127.0.0.1:17999" \
FB_NETEASE_TOKEN="$(node -p "require('./netease-bot/ntvector/scripts/cubeloom_bridge/cubeloom_bridge.json').token")" \
npm run netease
```

`netease-service` 会启动机器人、等桥就绪、崩溃自动重启，并在退出时把机器人一起收掉；
`/status` 的 `managedBot` 能看到 pid / 重启次数 / 最后错误。

也可以手动开机器人（`netease-bot/start-bot.bat`），只把 `FB_NETEASE_SOCKET/TOKEN` 给服务。

账号模式的命令由 `admin-server` 拼好后经 `FB_NETEASE_BOT_ARGV`（JSON 数组）传给
`netease-service`，`ManagedBot` 直接 `spawn(exe, args)`，不经过 shell，所以昵称里有空格/引号也安全：

```bash
FB_NETEASE_BOT_ARGV='["C:\\...\\Program.exe","--ServerIP","1.2.3.4","--ServerPort","19132","--UserID","…","--MD5Token","…","--NeteaseServerID","…:RentalGame","--AuthServerUrl","https://g79authobt.minecraft.cn","--DisplayName","小皮","--g79","--logger"]' \
FB_NETEASE_SOCKET="tcp://127.0.0.1:17999" \
FB_NETEASE_TOKEN="…" \
npm run netease
```

## 桥插件协议

`packaging/netease-bot/bridge/cubeloom_bridge/`：

- 插件根目录 = 内层包名 = `cubeloom_bridge`，入口 `cubeloom_bridge/__init__.py`；
- 监听 `127.0.0.1:17999`（可在 `cubeloom_bridge.json` 改），NDJSON 一行一条；
- 客户端（Cubeloom）→ 机器人：`auth` / `command`（`command`、`command_nowait`、`pos`、
  `identity`、`players`、`get_block`）；
- 机器人 → 客户端：`hello` / `auth_ok` / `result` / `event`（`on_text`、`on_player_list`、
  `on_disconnect`）；
- 指令走 `engine.command()`，坐标走 `engine.get_pot_x/y/z()`（服务器确认前为 `None`，
  此时回 `ok:false`，Cubeloom 会等下一次）。

## 已知限制

- 官方包协议默认是 **860 / 1.21.120**，与仓库基线 898 / 1.21.130 不同：面板会显示
  `⚠ 协议偏低`，功能通常可用；要严格对齐用 `FB_NETEASE_PROTOCOL` 或换更新的 NTvector。
- 插件依赖 NTvector 的 `OnTextPacket` / `on_player_list` 事件与 `engine.command` 等 API；
  上游改 API 时需要同步插件。
- 桥只监听回环、只接受带 token 的客户端；`cubeloom_bridge.json` 权限 0600，别提交。
- 机器人账号的凭据不进仓库：`netease-bot/` 已在 `.gitignore`。
