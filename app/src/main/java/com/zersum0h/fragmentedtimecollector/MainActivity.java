package com.zersum0h.fragmentedtimecollector;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import androidx.core.content.FileProvider;

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final String SERVER = "http://129.211.30.32:8080";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        webView = findViewById(R.id.webview);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        checkUpdate();

        webView.loadUrl(SERVER);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) results = new Uri[]{Uri.parse(dataString)};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void checkUpdate() {
        new Thread(() -> {
            try {
                URL url = new URL(SERVER + "/api/version");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                InputStream is = conn.getInputStream();
                byte[] buf = new byte[1024];
                StringBuilder sb = new StringBuilder();
                int len;
                while ((len = is.read(buf)) != -1) sb.append(new String(buf, 0, len));
                is.close();
                conn.disconnect();

                JSONObject json = new JSONObject(sb.toString());
                int latestCode = json.getInt("versionCode");
                String latestName = json.getString("versionName");
                String downloadUrl = SERVER + json.getString("downloadUrl");
                String changelog = json.optString("changelog", "");

                int currentCode = getPackageManager()
                        .getPackageInfo(getPackageName(), 0).versionCode;

                if (latestCode > currentCode) {
                    runOnUiThread(() -> showUpdateDialog(latestName, changelog, downloadUrl));
                }
            } catch (Exception e) {
                // silent fail
            }
        }).start();
    }

    private void showUpdateDialog(String version, String changelog, String downloadUrl) {
        new AlertDialog.Builder(this)
                .setTitle("发现新版本 v" + version)
                .setMessage(changelog.isEmpty() ? "是否立即更新？" : changelog + "\n\n是否立即更新？")
                .setCancelable(false)
                .setPositiveButton("立即更新", (d, w) -> downloadAndInstall(downloadUrl))
                .setNegativeButton("稍后再说", (d, w) -> d.dismiss())
                .show();
    }

    private void downloadAndInstall(String downloadUrl) {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("正在下载更新...")
                .setCancelable(false)
                .create();
        dialog.show();

        new Thread(() -> {
            try {
                URL url = new URL(downloadUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(30000);
                int total = conn.getContentLength();
                InputStream is = conn.getInputStream();

                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                File apkFile = new File(dir, "update.apk");
                FileOutputStream fos = new FileOutputStream(apkFile);

                byte[] buf = new byte[8192];
                int len, downloaded = 0;
                while ((len = is.read(buf)) != -1) {
                    fos.write(buf, 0, len);
                    downloaded += len;
                    int progress = total > 0 ? downloaded * 100 / total : 0;
                    runOnUiThread(() -> dialog.setMessage("正在下载更新... " + progress + "%"));
                }
                fos.close();
                is.close();
                conn.disconnect();

                runOnUiThread(() -> {
                    dialog.dismiss();
                    installApk(apkFile);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    dialog.dismiss();
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("下载失败")
                            .setMessage(e.getMessage())
                            .setPositiveButton("确定", null)
                            .show();
                });
            }
        }).start();
    }

    private void installApk(File file) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
