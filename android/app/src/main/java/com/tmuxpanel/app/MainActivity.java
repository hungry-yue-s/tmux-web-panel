package com.tmuxpanel.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.ScriptHandler;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_FILE = 41, SAVE_FILE = 42;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayDeque<WebView> children = new ArrayDeque<>();
    private SharedPreferences preferences;
    private FrameLayout root, browser, childContainer;
    private WebView main;
    private PanelEndpoint endpoint, entry;
    private EditText addressField;
    private ValueCallback<Uri[]> fileChooser;
    private ProgressBar progress;
    private View connection, errorView, customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private byte[] pendingBytes;
    private String pendingUrl, nativeScript;
    private boolean imeVisible;
    private ScriptHandler themeScript;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        preferences = getSharedPreferences("connection", MODE_PRIVATE);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(color(R.color.surface));
        setContentView(root);
        WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightNavigationBars(true);
        if (Build.VERSION.SDK_INT < 27) getWindow().setNavigationBarColor(Color.BLACK);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            // This container handles every inset. WebView receives its actual usable
            // bounds once, avoiding IME padding plus a second visual-viewport resize.
            return WindowInsetsCompat.CONSUMED;
        });
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::back);
        try (InputStream input = getAssets().open("native-client.js")) {
            ByteArrayOutputStream script = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) script.write(buffer, 0, count);
            nativeScript = new String(script.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) { nativeScript = ""; }
        String saved = preferences.getString("endpoint", "");
        if (saved.isEmpty()) showConnection();
        else {
            try {
                entry = endpoint = PanelEndpoint.parse(saved);
                openPanel(savedState == null ? endpoint.url() : savedState.getString("lastUrl", endpoint.url()));
            } catch (IllegalArgumentException e) { showConnection(); }
        }
    }

    private void showConnection() {
        hideIme();
        if (connection != null) root.removeView(connection);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(color(R.color.surface));
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setGravity(Gravity.CENTER_VERTICAL);
        body.setPadding(dp(28), dp(32), dp(28), dp(32));
        scroll.addView(body, new ScrollView.LayoutParams(-1, -1));
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.app_icon);
        icon.setContentDescription("Tmux Panel");
        LinearLayout.LayoutParams iconSize = new LinearLayout.LayoutParams(dp(76), dp(76));
        iconSize.bottomMargin = dp(28); body.addView(icon, iconSize);
        body.addView(text("Tmux Panel", 14, R.color.accent, true));
        TextView title = text("连接你的工作台", 30, R.color.ink, true);
        spaceAbove(title, 8); body.addView(title);
        TextView subtitle = text("终端、会话与文件，随时接续。", 15, R.color.muted, false);
        subtitle.setLineSpacing(dp(6), 1); spaceAbove(subtitle, 12); body.addView(subtitle);
        TextView label = text("引导链接 / 服务器地址", 13, R.color.ink, true);
        spaceAbove(label, 40); body.addView(label);
        EditText address = new EditText(this);
        addressField = address;
        address.setSingleLine(true); address.setTextSize(16);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("粘贴引导链接或扫描电脑二维码"); address.setTextColor(color(R.color.ink));
        address.setHintTextColor(color(R.color.muted));
        address.setPadding(dp(16), dp(16), dp(16), dp(16));
        address.setBackground(shape(R.color.panel, 16));
        address.setText(preferences.getString("endpoint", BuildConfig.DEFAULT_ENDPOINT));
        address.setContentDescription("服务器地址"); spaceAbove(address, 8); body.addView(address);
        TextView hint = text("首次配置后自动保存。引导链接会解析电脑的新地址，登录状态保留在客户端内。", 13, R.color.muted, false);
        hint.setLineSpacing(dp(4), 1); spaceAbove(hint, 12); body.addView(hint);
        Button connect = button("连接工作台", () -> {
            try {
                PanelEndpoint next = PanelEndpoint.parse(address.getText().toString());
                entry = endpoint = next;
                preferences.edit().putString("endpoint", next.url()).apply();
                root.removeView(connection); connection = null;
                openPanel(next.url());
            } catch (IllegalArgumentException e) { address.setError(e.getMessage()); }
        });
        connect.setTextColor(color(R.color.surface)); connect.setBackgroundTintList(android.content.res.ColorStateList.valueOf(color(R.color.accent)));
        spaceAbove(connect, 24); body.addView(connect);
        Button scan = button("扫描电脑二维码", () -> {
            hideIme();
            new IntentIntegrator(this).setDesiredBarcodeFormats(Collections.singletonList(IntentIntegrator.QR_CODE))
                .setCaptureActivity(ScanActivity.class)
                .setPrompt("扫描电脑提供的工作台引导链接二维码")
                .setBeepEnabled(false).setOrientationLocked(false).initiateScan();
        });
        spaceAbove(scan, 8); body.addView(scan);
        if (main != null) {
            Button cancel = button("返回当前工作台", () -> { root.removeView(connection); connection = null; });
            spaceAbove(cancel, 8); body.addView(cancel);
        }
        TextView footer = text("Android 客户端 · " + BuildConfig.VERSION_NAME, 12, R.color.muted, false);
        spaceAbove(footer, 32); body.addView(footer);
        connection = scroll; root.addView(scroll, fill());
    }

    private void openPanel(String url) {
        hideIme();
        closeCustomView();
        if (fileChooser != null) { fileChooser.onReceiveValue(null); fileChooser = null; }
        closeChildren();
        if (themeScript != null) { themeScript.remove(); themeScript = null; }
        if (main != null) { main.destroy(); main = null; }
        if (browser != null) root.removeView(browser);
        errorView = null;
        browser = new FrameLayout(this);
        root.addView(browser, 0, fill());
        main = createWebView(true);
        browser.addView(main, fill());
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams bar = new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP);
        browser.addView(progress, bar);
        main.loadUrl(endpoint.contains(url) ? url : endpoint.url());
    }

    private WebView createWebView(boolean primary) {
        WebView web = new WebView(this);
        web.setBackgroundColor(color(R.color.surface));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " TmuxPanelAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        if (primary) installBridge(web);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String url = request.getUrl().toString();
                if (endpoint.contains(url) || (!primary && (url.startsWith("blob:") || url.equals("about:blank")))) return false;
                if (primary && entry.contains(url)) {
                    endpoint = entry; installBridge(view); return false;
                }
                PanelEndpoint resolved = primary && endpoint.sameOrigin(entry.url())
                    ? entry.bootstrapTarget(view.getUrl(), url, request.hasGesture()) : null;
                if (resolved != null) { endpoint = resolved; installBridge(view); return false; }
                openExternal(url);
                if (!primary) closeChild(view);
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (view == main && entry.contains(url) && !endpoint.sameOrigin(entry.url())) {
                    endpoint = entry; installBridge(view);
                }
                if (view == main && errorView != null) { browser.removeView(errorView); errorView = null; }
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (view == main && endpoint.contains(url)) {
                    android.webkit.WebBackForwardList history = view.copyBackForwardList();
                    int previous = history.getCurrentIndex() - 1;
                    // Logging in uses location.href. Do not return to login and
                    // immediately redirect back forever when pressing system Back.
                    if (!Uri.parse(url).getPath().endsWith("/login.html") && previous >= 0
                            && endpoint.contains(history.getItemAtIndex(previous).getUrl())
                            && Uri.parse(history.getItemAtIndex(previous).getUrl()).getPath().endsWith("/login.html")) view.clearHistory();
                    view.evaluateJavascript("window.__tmuxAndroidTheme="
                        + JSONObject.quote(preferences.getString("theme", "oyster")) + ";" + nativeScript, null);
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == main && request.isForMainFrame()) showError("暂时无法连接工作台", "请确认地址、网络和电脑上的面板服务。", view);
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (view == main && endpoint.sameOrigin(error.getUrl())) showError("连接证书未通过验证", "请安装电脑面板的本地 CA 证书，或使用带有效证书的 HTTPS 地址。", view);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int percent) {
                if (primary && progress != null) { progress.setProgress(percent); progress.setVisibility(percent == 100 ? View.GONE : View.VISIBLE); }
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!primary || !endpoint.contains(view.getUrl())) { callback.onReceiveValue(null); return true; }
                if (fileChooser != null) fileChooser.onReceiveValue(null);
                fileChooser = callback;
                try { startActivityForResult(params.createIntent(), PICK_FILE); }
                catch (Exception e) { fileChooser.onReceiveValue(null); fileChooser = null; toast("没有可用的文件选择器"); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!gesture || children.size() >= 4 || !endpoint.contains(view.getUrl())) return false;
                WebView child = createWebView(false);
                showChild(child);
                ((WebView.WebViewTransport) result.obj).setWebView(child);
                result.sendToTarget(); return true;
            }
            @Override public void onCloseWindow(WebView view) { closeChild(view); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view; customViewCallback = callback; root.addView(view, fill());
            }
            @Override public void onHideCustomView() { closeCustomView(); }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (endpoint.contains(url)) saveDownload(null, url, URLUtil.guessFileName(url, disposition, mime), mime);
            else toast("请从文件预览的下载菜单保存文件");
        });
        return web;
    }

    private void installBridge(WebView web) {
        if (themeScript != null) { themeScript.remove(); themeScript = null; }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            String theme = JSONObject.quote(preferences.getString("theme", "oyster"));
            themeScript = WebViewCompat.addDocumentStartJavaScript(web,
                "if(window.top===window){try{localStorage.setItem('tmux_theme'," + theme + ");}catch(e){}}",
                Collections.singleton(endpoint.origin()));
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.removeWebMessageListener(web, "TmuxAndroid");
        WebViewCompat.addWebMessageListener(web, "TmuxAndroid", Collections.singleton(endpoint.origin()),
            (view, message, origin, isMainFrame, reply) -> {
                if (view != main || !isMainFrame || !endpoint.sameOrigin(origin.toString()) || !endpoint.contains(view.getUrl())) return;
                handleMessage(message.getData());
            });
    }

    private void handleMessage(String raw) {
        if (raw == null || raw.length() > 24 * 1024 * 1024) return;
        try {
            JSONObject value = new JSONObject(raw);
            switch (value.optString("type")) {
                case "settings": showClientMenu(); break;
                case "notice": toast(value.optString("text").substring(0, Math.min(200, value.optString("text").length()))); break;
                case "theme":
                    String themeId = value.optString("id");
                    if (themeId.matches("[a-z0-9-]{1,64}")) preferences.edit().putString("theme", themeId).apply();
                    updateTheme(value.optString("background"), value.optString("foreground")); break;
                case "clipboard":
                    ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (value.has("text") && value.optString("text").length() <= 1024 * 1024) clipboard.setPrimaryClip(ClipData.newPlainText("Tmux Panel", value.optString("text")));
                    else if (value.has("pngBase64")) {
                        byte[] bytes = decode(value.getString("pngBase64"));
                        File folder = new File(getCacheDir(), "exports"); folder.mkdirs();
                        File file = new File(folder, "clipboard.png");
                        try (OutputStream out = new java.io.FileOutputStream(file)) { out.write(bytes); }
                        clipboard.setPrimaryClip(ClipData.newUri(getContentResolver(), "PNG", FileProvider.getUriForFile(this, getPackageName() + ".files", file)));
                    }
                    break;
                case "download": saveDownload(decode(value.getString("data")), null, value.optString("name", "download"), value.optString("mime", "application/octet-stream")); break;
                case "downloadUrl":
                    String url = value.getString("url");
                    if (endpoint.contains(url)) saveDownload(null, url, value.optString("name", "download"), "application/octet-stream");
                    break;
                default: break;
            }
        } catch (Exception e) { toast("这次操作未完成，请重试"); }
    }

    private byte[] decode(String data) {
        if (data.length() > 23 * 1024 * 1024) throw new IllegalArgumentException("File too large");
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        if (bytes.length > 16 * 1024 * 1024) throw new IllegalArgumentException("File too large");
        return bytes;
    }

    private void saveDownload(byte[] bytes, String url, String name, String mime) {
        if (pendingBytes != null || pendingUrl != null) { toast("请先完成当前文件保存"); return; }
        pendingBytes = bytes; pendingUrl = url;
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        save.setType(mime != null && mime.contains("/") ? mime.split(";")[0] : "application/octet-stream");
        save.putExtra(Intent.EXTRA_TITLE, name.replaceAll("[\\\\/\\p{Cntrl}]", "_").substring(0, Math.min(name.length(), 160)));
        try { startActivityForResult(save, SAVE_FILE); }
        catch (Exception e) { pendingBytes = null; pendingUrl = null; toast("没有可用的文件保存位置"); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        IntentResult scan = IntentIntegrator.parseActivityResult(request, result, data);
        if (scan != null) {
            if (scan.getContents() != null && addressField != null) {
                try {
                    PanelEndpoint scanned = PanelEndpoint.parse(scan.getContents());
                    addressField.setText(scanned.url());
                    toast("已识别引导链接，点击连接工作台完成配置");
                } catch (IllegalArgumentException e) { toast("二维码不是有效的工作台链接"); }
            }
            return;
        }
        if (request == PICK_FILE && fileChooser != null) {
            fileChooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); fileChooser = null;
        }
        if (request == SAVE_FILE) {
            byte[] bytes = pendingBytes; String url = pendingUrl;
            pendingBytes = null; pendingUrl = null;
            if (result != RESULT_OK || data == null || data.getData() == null) return;
            if (bytes == null && url == null) { toast("保存已中断，请重新下载"); return; }
            Uri destination = data.getData();
            PanelEndpoint source = endpoint;
            io.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(destination)) {
                    if (out == null) throw new java.io.IOException("No output");
                    if (bytes != null) out.write(bytes);
                    else if (url != null) downloadUrl(source, url, out);
                    runOnUiThread(() -> toast("文件已保存"));
                } catch (Exception e) { runOnUiThread(() -> toast("保存失败，请重试")); }
            });
        }
    }

    private void downloadUrl(PanelEndpoint source, String url, OutputStream out) throws Exception {
        for (int redirects = 0; redirects < 5; redirects++) {
            if (!source.contains(url)) throw new java.io.IOException("Untrusted download");
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            try {
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) { url = new URL(new URL(url), connection.getHeaderField("Location")).toString(); continue; }
                if (status < 200 || status >= 300) throw new java.io.IOException("HTTP " + status);
                try (InputStream input = connection.getInputStream()) { byte[] buffer = new byte[32768]; int n; while ((n = input.read(buffer)) != -1) out.write(buffer, 0, n); }
                return;
            } finally { connection.disconnect(); }
        }
        throw new java.io.IOException("Too many redirects");
    }

    private void showChild(WebView child) {
        children.push(child);
        if (childContainer == null) { childContainer = new FrameLayout(this); root.addView(childContainer, fill()); }
        childContainer.removeAllViews();
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setBackgroundColor(color(R.color.surface));
        Button close = button("返回工作台", () -> closeChild(child)); layout.addView(close, new LinearLayout.LayoutParams(-1, dp(48)));
        layout.addView(child, new LinearLayout.LayoutParams(-1, 0, 1)); childContainer.addView(layout, fill());
    }

    private void closeChild(WebView child) {
        if (!children.remove(child)) return;
        if (child.getParent() instanceof ViewGroup) ((ViewGroup) child.getParent()).removeView(child);
        child.destroy();
        if (childContainer != null) { root.removeView(childContainer); childContainer = null; }
        if (!children.isEmpty()) { WebView previous = children.pop(); if (previous.getParent() instanceof ViewGroup) ((ViewGroup) previous.getParent()).removeView(previous); showChild(previous); }
    }
    private void closeChildren() { while (!children.isEmpty()) closeChild(children.peek()); }

    private void showError(String title, String description, WebView web) {
        if (browser == null) return;
        if (errorView != null) browser.removeView(errorView);
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(24), dp(28), dp(24)); box.setBackgroundColor(color(R.color.surface));
        box.addView(text(title, 26, R.color.ink, true));
        TextView explanation = text(description, 15, R.color.muted, false); spaceAbove(explanation, 16); box.addView(explanation);
        Button retry = button("重新连接", () -> { endpoint = entry; openPanel(entry.url()); }); spaceAbove(retry, 24); box.addView(retry);
        box.addView(button("连接设置", this::showConnection));
        errorView = box; browser.addView(box, fill());
    }

    private void showClientMenu() {
        new AlertDialog.Builder(this).setTitle("Android 客户端")
            .setItems(new String[]{"连接设置", "刷新工作台", "在浏览器打开"}, (dialog, which) -> {
                if (which == 0) showConnection(); else if (which == 1 && main != null) main.reload();
                else if (which == 2 && entry != null) openExternal(entry.url());
            }).setNegativeButton("返回", null).show();
    }

    private void back() {
        if (imeVisible) { hideIme(); return; }
        if (customView != null) { closeCustomView(); return; }
        if (connection != null) { if (main == null) finish(); else { root.removeView(connection); connection = null; } return; }
        if (!children.isEmpty()) { closeChild(children.peek()); return; }
        if (main == null) { finish(); return; }
        if (!endpoint.contains(main.getUrl())) { main.loadUrl(endpoint.url()); return; }
        main.evaluateJavascript("Boolean(window.__tmuxAndroidBack && window.__tmuxAndroidBack())", handled -> {
            if (isFinishing() || isDestroyed() || main == null) return;
            if ("true".equals(handled)) return;
            if (main.canGoBack()) main.goBack();
            else new AlertDialog.Builder(this).setTitle("工作台仍在运行")
                .setMessage("关闭客户端不会结束电脑上的 tmux 会话。")
                .setPositiveButton("留在工作台", null).setNeutralButton("连接设置", (d, w) -> showConnection())
                .setNegativeButton("关闭客户端", (d, w) -> finish()).show();
        });
    }
    // API 33+ uses the platform dispatcher registered in onCreate. This override
    // remains exclusively for older Android releases without that dispatcher.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { back(); }
    private void hideIme() { WindowInsetsControllerCompat controller = ViewCompat.getWindowInsetsController(root); if (controller != null) controller.hide(WindowInsetsCompat.Type.ime()); }
    private void closeCustomView() { if (customView != null) { root.removeView(customView); customView = null; customViewCallback.onCustomViewHidden(); customViewCallback = null; } }

    private void openExternal(String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:"))) { toast("暂不支持打开这个链接"); return; }
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { toast("没有可用的浏览器"); }
    }

    private void updateTheme(String background, String foreground) {
        if (!background.matches("#[0-9a-fA-F]{6}") || !foreground.matches("#[0-9a-fA-F]{6}")) return;
        int value = Color.parseColor(background);
        root.setBackgroundColor(value);
        if (main != null) main.setBackgroundColor(value);
        getWindow().setStatusBarColor(value);
        getWindow().setNavigationBarColor(Build.VERSION.SDK_INT < 27 ? Color.BLACK : value);
        boolean light = Color.red(value) * .2126 + Color.green(value) * .7152 + Color.blue(value) * .0722 > 145;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(light); bars.setAppearanceLightNavigationBars(light);
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (main != null && endpoint.contains(main.getUrl())) out.putString("lastUrl", main.getUrl());
    }
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onDestroy() {
        if (fileChooser != null) { fileChooser.onReceiveValue(null); fileChooser = null; }
        closeChildren(); if (main != null) main.destroy(); io.shutdown(); super.onDestroy();
    }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView text = new TextView(this); text.setText(value); text.setTextSize(size); text.setTextColor(color(color));
        if (bold) text.setTypeface(Typeface.DEFAULT, Typeface.BOLD); return text;
    }
    private Button button(String title, Runnable action) {
        Button button = new Button(this); button.setText(title); button.setAllCaps(false); button.setMinHeight(dp(52));
        button.setTextColor(color(R.color.ink)); button.setBackground(shape(R.color.panel, 16));
        button.setOnClickListener(v -> action.run()); return button;
    }
    private GradientDrawable shape(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color(color)); shape.setCornerRadius(dp(radius)); shape.setStroke(dp(1), color(R.color.line)); return shape; }
    private void spaceAbove(View view, int amount) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(amount); view.setLayoutParams(params); }
    private FrameLayout.LayoutParams fill() { return new FrameLayout.LayoutParams(-1, -1); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private int color(int id) { return getColor(id); }
    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_SHORT).show(); }
}
