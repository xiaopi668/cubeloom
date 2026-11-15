package io.github.cubeloom;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.net.Socket;

/**
 * 一个最小壳，两种模式：
 *
 *   local  —— 启动 App 内置 Node 服务，WebView 打开 127.0.0.1:11452。
 *             手机上能做结构编辑/预览；网易进服仍然需要 Windows 引擎，手机内跑不了。
 *   remote —— 直接打开电脑/服务器上的 Cubeloom 面板（例如 http://192.168.1.10:11452/），
 *             网易账号登录、房间解析、机器人进服都在那台机器上完成，手机只当遥控器。
 *
 * 右下角的 ⚙ 可以随时切换模式；选择会记在 SharedPreferences 里。
 */
public class MainActivity extends Activity {
    private static final String TAG = "Cubeloom";
    private static final String PANEL_URL = "http://127.0.0.1:11452/";
    private static final String PREFS = "cubeloom";
    private static final String KEY_MODE = "mode";
    private static final String KEY_REMOTE = "remote_url";

    private WebView webView;
    private TextView status;
    private TextView gear;
    private static final int REQ_FILE = 1001;
    private static final int REQ_SAVE = 1002;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveName = "";
    private String pendingSaveContent = "";
    private SharedPreferences prefs;
    private String mode = "";
    private String remoteUrl = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        mode = prefs.getString(KEY_MODE, "");
        remoteUrl = prefs.getString(KEY_REMOTE, "");

        FrameLayout root = new FrameLayout(this);
        status = new TextView(this);
        status.setText("Cubeloom 启动中…");
        status.setGravity(Gravity.CENTER);
        status.setTextSize(16);
        status.setPadding(dp(24), dp(24), dp(24), dp(24));
        root.addView(status, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (!isRemote()) return;
                status.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!isRemote() || request == null || !request.isForMainFrame()) return;
                status.setText("连接失败：" + error.getDescription() + "\n" + remoteUrl
                        + "\n\n点右下角 ⚙ 换地址，或确认对方已设 FB_ADMIN_HOST=0.0.0.0");
                status.setVisibility(View.VISIBLE);
                webView.setVisibility(View.GONE);
            }
        });
        webView.addJavascriptInterface(new SaveBridge(), "CubeloomNative");
        webView.setVisibility(View.GONE);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 右下角悬浮设置按钮：切换本机/远程
        gear = new TextView(this);
        gear.setText("⚙");
        gear.setTextSize(22);
        gear.setTextColor(Color.WHITE);
        gear.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x99000000);
        bg.setCornerRadius(dp(22));
        gear.setBackground(bg);
        gear.setAlpha(0.75f);
        gear.setOnClickListener(v -> showModeDialog());
        FrameLayout.LayoutParams gearLp = new FrameLayout.LayoutParams(
                dp(44), dp(44), Gravity.BOTTOM | Gravity.RIGHT);
        gearLp.setMargins(0, 0, dp(14), dp(14));
        root.addView(gear, gearLp);

        setContentView(root);

        if (mode.isEmpty()) {
            showModeDialog();
        } else {
            startMode();
        }
    }

    private boolean isRemote() {
        return "remote".equals(mode);
    }

    private void startMode() {
        if (isRemote()) startRemote();
        else startLocal();
    }

    private void startLocal() {
        mode = "local";
        status.setText("Cubeloom 启动中…\n正在拉起本地服务（首次启动需要几秒）");
        status.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        NodeRuntime.start(this);
        waitForPanel(0);
    }

    private void startRemote() {
        mode = "remote";
        status.setText("正在连接 " + remoteUrl + " …");
        status.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        webView.loadUrl(remoteUrl);
    }

    private void waitForPanel(int attempt) {
        if (isRemote()) return;
        if (attempt > 120) {
            status.setText("服务启动超时。\n请截图这个界面反馈：adb logcat -s CubeloomNode");
            return;
        }
        new Thread(() -> {
            boolean ok = false;
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", 11452), 500);
                ok = true;
            } catch (Exception ignored) {
            }
            if (ok) {
                handler.post(() -> {
                    status.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                    webView.loadUrl(PANEL_URL);
                });
            } else {
                handler.postDelayed(() -> waitForPanel(attempt + 1), 500);
            }
        }, "panel-wait").start();
    }

    private void showModeDialog() {
        String[] items = {
                "本机模式：手机内运行面板 + 网易引擎",
                "连接电脑 / 服务器：网易进服在那边跑",
        };
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("运行方式")
                .setItems(items, (d, which) -> {
                    if (which == 0) {
                        prefs.edit().putString(KEY_MODE, "local").apply();
                        startLocal();
                    } else {
                        askRemoteUrl();
                    }
                });
        if (mode.isEmpty()) b.setCancelable(false);
        b.show();
    }

    private void askRemoteUrl() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(remoteUrl.isEmpty() ? "http://192.168.1.2:11452/" : remoteUrl);
        input.setSelection(input.getText().length());

        new AlertDialog.Builder(this)
                .setTitle("Cubeloom 节点地址")
                .setMessage("电脑/服务器上启动 Cubeloom 面板，并允许局域网访问：\n"
                        + "FB_ADMIN_HOST=0.0.0.0 npm run admin\n"
                        + "（公网使用请加反向代理和口令）")
                .setView(input)
                .setPositiveButton("连接", (d, w) -> {
                    String url = normalizeUrl(input.getText().toString());
                    if (url.isEmpty()) {
                        toastStatus("地址要以 http:// 或 https:// 开头");
                        return;
                    }
                    remoteUrl = url;
                    prefs.edit().putString(KEY_REMOTE, url).putString(KEY_MODE, "remote").apply();
                    startRemote();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private static String normalizeUrl(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        if (!u.endsWith("/")) u += "/";
        return u;
    }

    private void toastStatus(String text) {
        status.setText(text);
        status.setVisibility(View.VISIBLE);
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    /** 暴露给网页的保存入口：只做“弹系统另存为”，不直接读文件系统 */
    public class SaveBridge {
        @JavascriptInterface
        public void saveText(String filename, String content) {
            runOnUiThread(() -> startSaveFile(filename, content));
        }
    }

    /** 用系统“另存为”窗口保存文本（登录态导出等），不直接写死目录 */
    private void startSaveFile(String filename, String content) {
        pendingSaveName = (filename == null ? "" : filename).replaceAll("[\\\\/:*?\"<>|\\n\\r]", "_").trim();
        if (pendingSaveName.isEmpty()) pendingSaveName = "cubeloom-session.json";
        pendingSaveContent = content == null ? "" : content;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, pendingSaveName);
        try {
            startActivityForResult(intent, REQ_SAVE);
        } catch (Exception e) {
            toastStatus("打开保存窗口失败：" + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        if (requestCode == REQ_SAVE) {
            Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
            if (uri == null) {
                Toast.makeText(this, "已取消保存", Toast.LENGTH_SHORT).show();
                pendingSaveContent = "";
                return;
            }
            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new IllegalStateException("无法打开输出流");
                os.write(pendingSaveContent.getBytes(StandardCharsets.UTF_8));
                os.flush();
                Toast.makeText(this, "已保存：" + uri, Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                Toast.makeText(this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            } finally {
                pendingSaveContent = "";
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
