# 手机端（Android）

结论：**能跑，但现在只有"Termux 版"是今天就能用的；独立 APK 需要把 Node 运行时塞进 APK，
要做 nodejs-mobile 移植（Node 18），仓库里已经把需要的 bundle 产好了。**

## 路线 A：Termux（现在可用，无需 APK）

```bash
# 在 Termux 里
pkg install -y nodejs git
git clone https://github.com/xiaopi668/cubeloom.git
cd cubeloom
npm install
termux-wake-lock
FB_NO_OPEN=1 npm run admin
```

- 游戏（同一台手机）里 `/connect ws://127.0.0.1:11451`，回环连接免验证；
- 手机浏览器打开 `http://127.0.0.1:11452` 看面板；
- 息屏后进程会被杀：先 `termux-wake-lock`，并在系统设置里给 Termux 关掉电池优化；
- 也可以直接用打包产物：`node tools/build.mjs` 后把 `build/portable/` 拷到手机，
  需要系统 Node（Termux 的 nodejs 包）即可跑 `./start.sh`。

## 路线 B：独立 APK（需要移植，未构建）

Android 上"本地监听一个 WebSocket 端口"必须有 Node 运行时。可行方案是
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)（内置 Node 18.20.4）：

1. 新建 Android 工程（Gradle + AGP），把 nodejs-mobile 的
   `libnode.so`（arm64-v8a / x86_64）放进 `jniLibs`，用官方 JNI 桥启动 Node；
2. 把本仓库生成的 `build/mobile/nodejs-project/` 整个放进 `assets/nodejs-project/`
   （`main.cjs` / `admin-server.cjs` / `voxel-geometry.iife.js` / `admin/`），
   入口是 `admin-server.cjs`；
3. 启动参数（环境变量）：
   ```
   FB_APP_ROOT=<app 私有目录>
   FB_WS_ENTRY=<assets>/main.cjs
   FB_FORCE_ENTRY=1 FB_NO_REPL=1 FB_NO_OPEN=1
   FB_GEOMETRY_BUNDLE=<assets>/voxel-geometry.iife.js
   FB_ADMIN_PORT=11452 FB_WS_PORT=11451 FB_CONTROL_PORT=11453
   FB_LOG_DIR=<app 私有目录>/logs
   ```
4. 用 WebView 打开 `http://127.0.0.1:11452`；申请 `INTERNET` 权限，
   Android 9+ 还要允许明文 HTTP（`usesCleartextTraffic=true`，仅回环）；
5. 前台服务 + 常驻通知，避免后台被冻结；
6. 游戏客户端与 App 在同一台手机上，`/connect ws://127.0.0.1:11451`。

**还没做的部分**（所以暂无 `.apk`）：

- JNI 桥与 Gradle 工程（需要 Android NDK；本机 SDK 已装，NDK 未装）；
- nodejs-mobile 的 Node 18 与 `node:vm` 行为差异需要真机验证；
- 应用图标、签名、上架/分发策略；
- 如果目标是"零 Node 依赖"，只能原生重写服务端（不现实，结构解析/沙箱都在 Node 侧）。

工作量估计：能跑的 debug APK 约 1~2 天（含 NDK 安装与桥接调试），可发布版本再加
图标/前台服务/签名/兼容性验证 1~2 天。需要的话可以单开一个任务做。
