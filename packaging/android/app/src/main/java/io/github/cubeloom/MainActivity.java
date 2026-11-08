package io.github.cubeloom;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * 一个最小壳：启动 Node 服务 → 等 127.0.0.1:11452 → WebView 打开面板。
 * 游戏与 App 在同一台手机上，游戏里 /connect ws://127.0.0.1:11451。
 */
public class MainActivity extends Activity {
    private static final String TAG = "Cubeloom";
    private static final String PANEL_URL = "http://127.0.0.1:11452/";
    private WebView webView;
    private TextView status;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        status = new TextView(this);
        status.setText("Cubeloom 启动中…\n正在拉起本地服务（首次启动需要几秒）");
        status.setGravity(Gravity.CENTER);
        status.setTextSize(16);
        root.addView(status, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient());
        webView.setVisibility(View.GONE);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        NodeRuntime.start(this);
        waitForPanel(0);
    }

    private void waitForPanel(int attempt) {
        if (attempt > 120) {
            status.setText("服务启动超时。\n请截图这个界面反馈：adblogcat -s CubeloomNode");
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
