package io.github.cubeloom;

import android.content.Context;
import android.content.res.AssetManager;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 在 App 进程内启动 Node（nodejs-mobile 的 libnode.so）+ Cubeloom 服务。
 *
 * assets/nodejs-project 是整个服务端 bundle（由 tools/build-android.mjs 生成）：
 *   admin-server.cjs / main.cjs / voxel-geometry.iife.js / admin/
 */
public final class NodeRuntime {
    private static final String TAG = "CubeloomNode";
    private static final String ASSET_ROOT = "nodejs-project";
    private static volatile boolean started = false;

    static {
        // libnode 必须先加载，JNI 库依赖它
        System.loadLibrary("node");
        System.loadLibrary("cubeloom-node");
    }

    private static native int startNode(String[] args, String workDir);

    public static synchronized void start(Context context) {
        if (started) return;
        started = true;
        File filesDir = context.getFilesDir();
        File root = new File(filesDir, "cubeloom");
        File project = new File(root, "nodejs-project");
        copyAssets(context.getAssets(), ASSET_ROOT, project);
        File engine = new File(root, "netease-bot/ntvector-native");
        copyAssets(context.getAssets(), "engine", engine);
        String abi = android.os.Build.SUPPORTED_ABIS.length > 0 ? android.os.Build.SUPPORTED_ABIS[0] : "arm64-v8a";
        copyAssets(context.getAssets(), "engine-lib-dynload/" + abi,
                new File(engine, "python312/lib/python3.12/lib-dynload"));

        String rootPath = project.getAbsolutePath();
        setenv("FB_APP_ROOT", rootPath);
        setenv("FB_WS_ENTRY", rootPath + "/main.cjs");
        setenv("FB_FORCE_ENTRY", "1");
        setenv("FB_WS_INPROCESS", "1");
        setenv("FB_NO_REPL", "1");
        setenv("FB_NO_OPEN", "1");
        setenv("FB_GEOMETRY_BUNDLE", rootPath + "/voxel-geometry.iife.js");
        setenv("FB_NETEASE_ENTRY", rootPath + "/netease-service.cjs");
        setenv("FB_NETEASE_INPROCESS", "1");
        setenv("FB_NETEASE_BOT_DIR", root.getAbsolutePath() + "/netease-bot");
        setenv("FB_NETEASE_ENGINE", context.getApplicationInfo().nativeLibraryDir + "/libcubeloom_engine.so");
        setenv("FB_X19LOGIN", context.getApplicationInfo().nativeLibraryDir + "/libx19login.so");
        setenv("VECTOR_PYTHON_HOME", engine.getAbsolutePath() + "/python312");
        setenv("VECTOR_SOURCE_DIR", engine.getAbsolutePath() + "/source");
        setenv("VECTOR_PLUGIN_DIR", engine.getAbsolutePath() + "/scripts");
        String libPath = context.getApplicationInfo().nativeLibraryDir + ":" + engine.getAbsolutePath() + "/python312/lib";
        setenv("LD_LIBRARY_PATH", libPath + ":" + (System.getenv("LD_LIBRARY_PATH") != null ? System.getenv("LD_LIBRARY_PATH") : ""));
        setenv("FB_LOG_DIR", rootPath + "/logs");
        setenv("FB_ADMIN_HOST", "127.0.0.1");
        setenv("FB_ADMIN_PORT", "11452");
        setenv("FB_WS_PORT", "11451");
        setenv("FB_CONTROL_PORT", "11453");
        setenv("HOME", root.getAbsolutePath());
        setenv("TMPDIR", context.getCacheDir().getAbsolutePath());

        String[] args = {"node", rootPath + "/admin-server.cjs"};
        new Thread(() -> {
            Log.i(TAG, "starting node: " + rootPath);
            int code = startNode(args, rootPath);
            Log.w(TAG, "node exited with code " + code);
        }, "cubeloom-node").start();
    }

    private static void setenv(String key, String value) {
        try {
            Os.setenv(key, value, true);
        } catch (ErrnoException e) {
            Log.w(TAG, "setenv " + key + " failed: " + e.getMessage());
        }
    }

    private static void copyAssets(AssetManager assets, String assetPath, File dest) {
        try {
            String[] children = assets.list(assetPath);
            if (children == null || children.length == 0) {
                copyFile(assets, assetPath, dest);
                return;
            }
            if (!dest.exists() && !dest.mkdirs()) {
                Log.w(TAG, "mkdirs failed: " + dest);
            }
            for (String child : children) {
                copyAssets(assets, assetPath + "/" + child, new File(dest, child));
            }
        } catch (IOException e) {
            Log.e(TAG, "copy asset failed: " + assetPath, e);
        }
    }

    private static void copyFile(AssetManager assets, String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        try (InputStream in = assets.open(assetPath); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }
}
