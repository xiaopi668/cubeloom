# 原生网易引擎构建（Linux / macOS）

上游 [NTvector](https://github.com/lurete-cn/NTvector) 以 Windows 为主；这里用固定提交 +
补丁，把它编译成 Linux/macOS 原生 `Program`，运行时不再需要 Wine。

```bash
npm run build:engine
# 产物：netease-bot/ntvector-native/
#   Program                 原生可执行文件
#   python312/              Python 3.12 运行时（python-build-standalone）
#   scripts/cubeloom_bridge 事件桥插件
#   source/ client_cfg.json skin*.json ...
```

## 固定版本

- 源码：`lurete-cn/NTvector` @ `ce743787b83944cf39649041f9011919763b41ba`
- Python：`python-build-standalone` 3.12.16（`20261110`）
- 补丁：`patches/native-linux-macos.patch`

## 补丁做了什么

1. `application/CMakeLists.txt`：非 Windows 链接 `libpython3.12.so/.dylib`，并注入
   `$ORIGIN/python312/lib`（Linux）/ `@loader_path/python312/lib`（macOS）RPATH。
2. `PythonRuntime.cpp`：`PYTHONHOME` 指向可执行文件旁的 `python312/`；Linux 用
   `/proc/self/exe`，macOS 用 `_NSGetExecutablePath`；补 `cwchar`。
3. `VectorConsole.cpp`：非 Windows 不调用 `RedrawLogPane`。
4. `Platform.cmake`：GCC 14 的 `-Wchanges-meaning` 关闭。
5. `BuildOpenSSL.cmake`：`make -j4`，避免 CI 小内存机器 OOM。
6. 构建脚本额外创建 `Source/include/SLikeNet -> slikenet`（Linux 大小写敏感）。

## 运行时

`netease-bot/ntvector-native/python312/lib/python3.12/site-packages/` 会从官方 Windows 包
复制 `RC4.py` / `umsgpack.py`（反作弊链路需要的纯 Python 包），并删除 Tcl/Tk、测试、
`pip` 等不需要的内容（约 58 MB）。

`admin-server` 优先生成原生引擎；只有找不到 `ntvector-native/Program` 时才回退 Wine。
