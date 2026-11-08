# 手机端（Android APK / Termux）

安卓版把 Node 运行时（nodejs-mobile，Node 18.20.4）和 Cubeloom 服务一起打进 APK：
打开 App → 本地起服务 → WebView 打开面板 → 游戏里 `/connect ws://127.0.0.1:11451`。
不需要 Termux，也不需要另装 Node。

## 下载

GitHub Actions 的 **Android build** workflow（push main / tag `v*`）会产出：

```
Cubeloom-Android-<版本>-debug.apk
```

安装时允许「未知来源」。APK 是 **debug 签名、未上架**，仅自用/测试。

## 本地构建

前置：Android SDK（platform 36）、NDK `27.0.12077973`、Gradle 8.13、Node 20。

```bash
npm ci
npm run build          # 生成 build/mobile/nodejs-project
npm run build:android  # 产物 dist-app/Cubeloom-Android-<版本>-debug.apk
```

`tools/build-android.mjs` 会：

1. 取 `nodejs-mobile-react-native@18.20.4` 的 `libnode.so`（arm64-v8a / x86_64）与 Node 头文件（首次约 100MB，缓存在 `build/cache/`）；
2. 把 `build/mobile/nodejs-project` 复制进 `app/src/main/assets/`；
3. 生成 `local.properties`，调用 Gradle `assembleDebug`；
4. 把 APK 复制到 `dist-app/`。

想用系统自带的 Gradle：`GRADLE_BIN=$(which gradle) npm run build:android`。

## 结构

```
packaging/android/
  app/src/main/java/io/github/cubeloom/MainActivity.java   等 11452 → WebView 打开面板
  app/src/main/java/io/github/cubeloom/NodeRuntime.java    解压 assets、setenv、启动 Node
  app/src/main/cpp/native-lib.cpp                          JNI → node::Start()
  app/src/main/cpp/CMakeLists.txt                         链接预编译 libnode.so
  app/src/main/assets/nodejs-project/                     构建时生成（gitignore）
  app/src/main/jniLibs/<abi>/libnode.so                   构建时生成（gitignore）
```

运行时环境变量（NodeRuntime 里设置）：

```
FB_APP_ROOT / FB_WS_ENTRY / FB_FORCE_ENTRY / FB_NO_REPL / FB_NO_OPEN
FB_GEOMETRY_BUNDLE / FB_LOG_DIR / FB_ADMIN_HOST / FB_ADMIN_PORT / FB_WS_PORT / FB_CONTROL_PORT
```

日志：应用私有目录 `files/cubeloom/nodejs-project/logs/`（`adb logcat -s CubeloomNode` 也能看）。

## 限制

- **minSdk 24（Android 7.0）**，arm64-v8a + x86_64 两个 ABI；
- Node 18（nodejs-mobile 最后版本），不是 Node 20；
- 面板在 WebView 里，没有原生后台常驻：切后台可能被系统冻结，正在导入时建议保持前台；
- 网易版机器人（NTvector）是 Windows 程序，Android 上仍需 Termux + 外部机器人，APK 只带 WS 版；
- 16KB 页大小的新机型如果装不上，需要换 16KB 对齐的 libnode 构建（上游 nodejs-mobile 未更新）。

## Termux（备用）

不想装 APK 或要自己换 Node 版本：

```bash
pkg install -y nodejs git
git clone https://github.com/xiaopi668/cubeloom.git
cd cubeloom && npm install
termux-wake-lock
FB_NO_OPEN=1 npm run admin
```

同一台手机进游戏 `/connect ws://127.0.0.1:11451`，浏览器开面板 `http://127.0.0.1:11452`。
