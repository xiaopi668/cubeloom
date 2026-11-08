# NTvector（随仓库分发的网易版机器人本体）

| 项 | 值 |
|---|---|
| 上游 | [lurete-cn/NTvector](https://github.com/lurete-cn/NTvector) |
| 版本 | 官方 release `NTVector.Official.version.V1.1.1.zip` |
| 发布日期 | 2026-08-24 |
| 许可 | **MIT**（见同目录 `LICENSE`，版权归上游作者） |
| 文件 | `NTVector.Official.version.V1.1.1.zip`（15,996,359 字节） |
| SHA-256 | `920bbc532991d40b877bb89e05928b6c98a0d2350262cfc07b38829711883083` |
| 平台 | **Windows x64**（Program.exe + 内嵌 Python 3.12；Linux/Android 需按上游源码自行构建） |

## 为什么放在仓库里

网易租赁服没有 `/connect`，必须有机器人以玩家身份进服。把官方包直接放进仓库，
用户执行一次 `npm run setup:netease-bot` 就能得到可运行的机器人，不需要再去 GitHub
找 release、对版本、解压。Cubeloom 侧只依赖机器人暴露的事件桥（NDJSON），
不修改 NTvector 本体。

## 用法

```bash
npm run setup:netease-bot
# 解压到 netease-bot/ntvector/，并安装 packaging/netease-bot/bridge 下的事件桥插件
```

然后按 [packaging/netease-bot/README.md](../../packaging/netease-bot/README.md) 填
`mc.cfg`（房间号 / 账号），设置：

```bash
FB_NETEASE_BOT_CMD="$PWD/netease-bot/start-bot.bat"
FB_NETEASE_SOCKET="tcp://127.0.0.1:17999"
FB_NETEASE_TOKEN="<setup 时写进 cubeloom_bridge.json 的 token>"
npm run netease
```

## 注意

- 账号必须是目标服的 **OP**，或服务器开启作弊；
- 机器人账号的登录凭据（`mc.cfg` 等）**不进仓库**，`netease-bot/` 已在 `.gitignore`；
- 本仓库只做分发与桥接，不修改 NTvector；上游更新时替换 zip、更新本文件的 SHA-256 与版本即可；
- 二进制来源可验证：下载地址与上述 SHA-256 均来自上游官方 release。
