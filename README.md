# Cubeloom

> WebSocket based Minecraft Bedrock structure generator —— 把方块织成建筑。

在电脑或手机上跑一个本地服务，游戏里 `/connect ws://127.0.0.1:11451` 连上去，
然后由它**替你一块一块地放方块**：既可以导入现成建筑文件，也可以用代码现场"算"出形状。

```
npm i -g cubeloom          # 或 npx cubeloom
cubeloom admin             # 网页控制台 http://127.0.0.1:11452
cubeloom ws                # 只跑 WS 服务（11451）
cubeloom cli               # 终端交互版
```

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

## 安全说明

聊天栏 `-` 命令会在服务端执行 JavaScript，这是本项目的核心玩法，也因此必须说清边界：

- 沙箱基于 `node:vm` 独立上下文：拿不到 `process` / `require` / `Buffer`，禁用了 `Function` 与 `eval` 的字符串构造，单条命令默认 5 秒超时（`FB_SANDBOX_TIMEOUT`）
- **这不是完整隔离**。注入给脚本的 `plot` / `setBlocks` 是宿主对象，理论上可以顺着原型链摸到宿主 `Function`。要做到彻底隔离，需要把执行搬进 `worker_threads` 或子进程
- 认证默认值：本机（`127.0.0.1` / `::1`）连接免验证；**局域网或公网设备连进来必须先发 `--login <令牌>`**，令牌在启动日志里打印，可用 `FB_LOCAL_TOKEN` 固定
- 要让所有来源都免验证（不推荐）：`FB_ALLOW_ANON=1`

自测：`npm run check:sandbox`（27 项断言，覆盖隔离、API 未回退、鉴权优先级）。

## 目录

```
main.ts              WS 服务
admin-server.ts      本地管理面板
cli.mjs              终端交互版
netease-service.ts   网易版事件桥
src/                 结构解析 / NBT / 格式 / 沙箱 / 会话
admin/               面板前端（原生 HTML/CSS/JS，无构建）
deploy/              systemd 单元模板
docs/                协议基线、CLI 说明、移植笔记
tools/               set-password.mjs、check-sandbox.ts
```

## 与上游的关系

Cubeloom 是 [CyanQiuper-Builder](https://github.com/Diamond-Minec/CyanQiuper-Builder) 的社区分支，
**移除了全部商业化模块**（用户中心、订阅计费、支付回调、插件市场、多实例编排），只保留工具本体。

谱系：

```
CAIMEOX/FastBuilder (无许可证)
        │
        ▼
Diamond-Minec/CyanQiuper-Builder (MIT)
        │  本项目 fork 并剥离商业模块，改为 AGPL-3.0
        ▼
xiaopi668/cubeloom (AGPL-3.0)
```

上游署名、保留的 MIT 声明、以及一处**尚未解决的授权缺口**都写在 [NOTICE](NOTICE) 里，发布或分发前请先读。

运行时依赖：`@pureeval/voxel-geometry`（VoxelGeometry，AGPL-3.0）、`mcpews`（MIT）、`ws`（MIT）。

## 已知限制

- `@pureeval/voxel-geometry` 锁在 `1.2.10`：该版本 npm 元数据里没有 `license` 字段，许可依据只能看源码仓库的 LICENSE
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
