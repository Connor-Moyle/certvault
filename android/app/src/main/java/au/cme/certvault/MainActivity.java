package au.cme.certvault;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CertVault for Android: a thin, fast shell around your CertVault server (on the NAS) that adds the
 * things a phone browser can't do over plain HTTP — native share sheet with real files, opening PDFs,
 * saving to Downloads, "Share to CertVault" from any app, and on-device reminders.
 */
public class MainActivity extends AppCompatActivity {

    static final String PREFS = "certvault";
    static final String KEY_SERVER = "server";
    static final String KEY_INSTANCE = "instance";
    private static final int REQ_FILE = 1001;
    private static final Pattern FILE_URL = Pattern.compile(
            "^/api/(documents/[^/]+/(file|pdf)|documents/[^/]+/pages/[^/]+/file|share/(zip|pack\\.pdf)|master\\.(xlsx|csv)|calendar\\.ics)");

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private String server;
    private boolean pageReady = false;
    private final ArrayList<Uri> pendingShare = new ArrayList<>();
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler ui = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.TRANSPARENT);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " CertVaultAndroid/" + BuildConfigVersion.name(this));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "CertVaultAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
                openRemote(Uri.parse(url), true));

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        server = prefs.getString(KEY_SERVER, null);
        handleShareIntent(getIntent());
        cleanCache();
        if (server == null) {
            askServer(false);
        } else if (savedInstanceState != null && prefs.getString(KEY_INSTANCE, null) != null) {
            web.restoreState(savedInstanceState);
        } else {
            startLoad();
        }

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7);
        }
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("certvault-reminders",
                ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(ReminderWorker.class, 12, TimeUnit.HOURS).build());
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
        if (pageReady) uploadPending();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    // ---- server address ----------------------------------------------------------------------

    void askServer(boolean cancelable) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(server != null ? server : "http://192.168.0.50:30090");
        input.setSelectAllOnFocus(true);
        FrameLayout box = new FrameLayout(this);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(input);
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("CertVault server")
                .setMessage("The address of CertVault on your NAS — e.g. http://192.168.0.50:30090, or your Tailscale address when away from home.")
                .setView(box)
                .setCancelable(cancelable)
                .setPositiveButton("Connect", (d, w) -> {
                    String v = input.getText().toString().trim();
                    if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
                    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
                    server = v;
                    // new address: forget the old server's identity, pin the new one on first contact
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, v).remove(KEY_INSTANCE).apply();
                    pageReady = false;
                    startLoad();
                });
        if (cancelable) b.setNegativeButton("Cancel", null);
        b.show();
    }

    /** Fetch the server's identity WITHOUT sending our login cookie. */
    static String fetchInstance(String server) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/status").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString()).optString("instance", null);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Only load (and so only send the login cookie to) the server we paired with. On another Wi-Fi, a
     * different device answering at 192.168.0.50 gets nothing.
     */
    void startLoad() {
        if (server == null) {
            askServer(false);
            return;
        }
        final String target = server;
        io.execute(() -> {
            String inst = fetchInstance(target);
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String pinned = p.getString(KEY_INSTANCE, null);
            ui.post(() -> {
                if (inst == null) {
                    showError("Can't reach CertVault", escape(target) + " isn't answering.<br>Check you're on the home Wi-Fi (or Tailscale is on) and the NAS is running.", false);
                } else if (pinned == null || pinned.equals(inst)) {
                    if (pinned == null) p.edit().putString(KEY_INSTANCE, inst).apply();
                    web.loadUrl(target + "/");
                } else {
                    showError("This isn't your CertVault", "Something else is answering at " + escape(target)
                            + " — maybe you're on a different Wi-Fi. Your login wasn't sent to it.", true);
                }
            });
        });
    }

    void showError(String title, String bodyHtml, boolean offerTrust) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>"
                + "body{font-family:sans-serif;padding:32px 24px;color:#191c20;background:#f9f9ff}"
                + "@media(prefers-color-scheme:dark){body{color:#e2e2e9;background:#111318}}"
                + "button{display:block;width:100%;margin-top:14px;height:48px;border:0;border-radius:24px;font-size:15px;background:#415f91;color:#fff}"
                + "button.t{background:transparent;color:#415f91;border:1px solid #74777f}</style></head><body>"
                + "<h2>" + title + "</h2><p>" + bodyHtml + "</p>"
                + "<button onclick='CertVaultAndroid.retry()'>Try again</button>"
                + "<button class='t' onclick='CertVaultAndroid.changeServer()'>Change server address</button>"
                + (offerTrust ? "<button class='t' onclick='CertVaultAndroid.trustServer()'>I reinstalled CertVault — trust this server</button>" : "")
                + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    void cleanCache() {
        long cutoff = System.currentTimeMillis() - 24L * 3600 * 1000;
        for (String d : new String[]{"open", "share", "camera"}) {
            deleteOld(new File(getCacheDir(), d), cutoff);
        }
    }

    static void deleteOld(File f, long cutoff) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteOld(k, cutoff);
        if (f.isFile() && f.lastModified() < cutoff) f.delete();
        else if (f.isDirectory() && (kids == null || kids.length == 0) && f.lastModified() < cutoff) f.delete();
    }

    boolean sameOrigin(Uri u) {
        if (server == null) return false;
        Uri s = Uri.parse(server);
        return s.getHost() != null && s.getHost().equalsIgnoreCase(u.getHost()) && s.getPort() == u.getPort()
                && (s.getScheme() == null || s.getScheme().equalsIgnoreCase(u.getScheme()));
    }

    // ---- web view ---------------------------------------------------------------------------------

    class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!sameOrigin(u)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
            String path = u.getPath() == null ? "" : u.getPath();
            if (FILE_URL.matcher(path).find()) {
                openRemote(u, "1".equals(u.getQueryParameter("download")) || !path.endsWith("/pdf") && !path.endsWith("/file"));
                return true;
            }
            return false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            CookieManager.getInstance().flush();
            if (!pendingShare.isEmpty()) uploadPending();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            showError("Can't reach CertVault", escape(server) + " isn't answering.<br>Check you're on the home Wi-Fi (or Tailscale is on) and the NAS is running.", false);
        }
    }

    class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            cameraUri = null;
            boolean wantsImages = false;
            for (String t : params.getAcceptTypes()) {
                if (t == null || t.isEmpty() || t.startsWith("image")) wantsImages = true;
            }
            Intent camera = null;
            if (wantsImages) {
                try {
                    File dir = new File(getCacheDir(), "camera");
                    dir.mkdirs();
                    File photo = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                    cameraUri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", photo);
                    camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                            .putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception e) {
                    camera = null;
                }
            }
            Intent intent;
            if (params.isCaptureEnabled() && camera != null) {
                intent = camera;
            } else {
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] accept = params.getAcceptTypes();
                if (accept.length == 1 && accept[0] != null && accept[0].contains("/")) pick.setType(accept[0]);
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                intent = Intent.createChooser(pick, "Add to CertVault");
                if (camera != null) intent.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
            }
            try {
                startActivityForResult(intent, REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast("No app available to pick files");
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            List<Uri> uris = new ArrayList<>();
            if (data != null && data.getClipData() != null) {
                ClipData cd = data.getClipData();
                for (int i = 0; i < cd.getItemCount(); i++) uris.add(cd.getItemAt(i).getUri());
            } else if (data != null && data.getData() != null) {
                uris.add(data.getData());
            } else if (cameraUri != null) {
                uris.add(cameraUri);
            }
            if (!uris.isEmpty()) result = uris.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ---- files: open / save / share --------------------------------------------------------------

    static final class Fetched {
        File file;
        String name;
        String mime;
    }

    Fetched fetch(String url, File dir) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) c.setRequestProperty("Cookie", cookie);
        c.setConnectTimeout(15000);
        c.setReadTimeout(120000);
        int code = c.getResponseCode();
        if (code >= 400) throw new Exception("Server said " + code);
        Fetched f = new Fetched();
        f.name = filenameFrom(c.getHeaderField("Content-Disposition"));
        f.mime = c.getContentType() == null ? "application/octet-stream" : c.getContentType().split(";")[0].trim();
        if (f.name == null) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(f.mime);
            f.name = "certvault-file" + (ext != null ? "." + ext : "");
        }
        dir.mkdirs();
        File sub = new File(dir, UUID.randomUUID().toString().substring(0, 8));
        sub.mkdirs();
        f.file = new File(sub, f.name.replaceAll("[\\\\/:*?\"<>|]", "_"));
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f.file)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        return f;
    }

    static String filenameFrom(String cd) {
        if (cd == null) return null;
        Matcher m = Pattern.compile("filename\\*=(?:UTF-8|utf-8)''([^;]+)").matcher(cd);
        try {
            if (m.find()) return URLDecoder.decode(m.group(1), "UTF-8");
        } catch (Exception ignored) {
        }
        m = Pattern.compile("filename=\"?([^\";]+)\"?").matcher(cd);
        return m.find() ? m.group(1) : null;
    }

    void openRemote(Uri u, boolean alsoSave) {
        toast(alsoSave ? "Downloading…" : "Opening…");
        io.execute(() -> {
            try {
                Fetched f = fetch(u.toString(), new File(getCacheDir(), "open"));
                String saved = alsoSave ? saveToDownloads(f) : null;
                ui.post(() -> {
                    if (saved != null) toast("Saved to " + saved);
                    Uri cu = FileProvider.getUriForFile(this, getPackageName() + ".files", f.file);
                    Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(cu, f.mime)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(Intent.createChooser(view, f.name));
                    } catch (ActivityNotFoundException e) {
                        if (saved == null) toast("No app can open " + f.name);
                    }
                });
            } catch (Exception e) {
                ui.post(() -> toast("Couldn't get the file: " + e.getMessage()));
            }
        });
    }

    String saveToDownloads(Fetched f) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, f.name);
                v.put(MediaStore.Downloads.MIME_TYPE, f.mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CertVault");
                Uri dest = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (dest == null) return null;
                try (OutputStream out = getContentResolver().openOutputStream(dest); InputStream in = new FileInputStream(f.file)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                return "Downloads/CertVault";
            }
            File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "CertVault");
            dir.mkdirs();
            File dest = new File(dir, f.file.getName());
            try (InputStream in = new FileInputStream(f.file); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return dest.getParent();
        } catch (Exception e) {
            return null;
        }
    }

    /** JavaScript → native. Only our own server's pages are ever loaded in this WebView. */
    class Bridge {
        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        @JavascriptInterface
        public String version() {
            return BuildConfigVersion.name(MainActivity.this);
        }

        @JavascriptInterface
        public String serverUrl() {
            return server == null ? "" : server;
        }

        @JavascriptInterface
        public void changeServer() {
            ui.post(() -> askServer(true));
        }

        @JavascriptInterface
        public void retry() {
            ui.post(MainActivity.this::startLoad);
        }

        @JavascriptInterface
        public void trustServer() {
            ui.post(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Trust this server?")
                    .setMessage("Only do this if you reinstalled or restored CertVault on your NAS. Otherwise you could be sending your login to someone else's device.")
                    .setPositiveButton("Trust it", (d, w) -> {
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_INSTANCE).apply();
                        startLoad();
                    })
                    .setNegativeButton("Cancel", null).show());
        }

        @JavascriptInterface
        public void openExternal(String url) {
            ui.post(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (ActivityNotFoundException ignored) {
                }
            });
        }

        /** files: JSON [{url, name}] (url relative to the server). Opens the Android share sheet with the real files. */
        @JavascriptInterface
        public void shareFiles(String filesJson, String text, String subject) {
            ui.post(() -> toast("Preparing to share…"));
            io.execute(() -> {
                try {
                    JSONArray arr = new JSONArray(filesJson);
                    ArrayList<Uri> uris = new ArrayList<>();
                    boolean allPdf = true;
                    File dir = new File(getCacheDir(), "share");
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject o = arr.getJSONObject(i);
                        String url = o.getString("url");
                        if (url.startsWith("/")) url = server + url;
                        if (!sameOrigin(Uri.parse(url))) continue;  // only ever fetch from our own server
                        Fetched f = fetch(url, dir);
                        String want = o.optString("name", null);
                        if (want != null && !want.isEmpty()) {
                            File renamed = new File(f.file.getParentFile(), want.replaceAll("[\\\\/:*?\"<>|]", "_"));
                            if (f.file.renameTo(renamed)) f.file = renamed;
                        }
                        if (!"application/pdf".equals(f.mime)) allPdf = false;
                        uris.add(FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f.file));
                    }
                    final boolean pdf = allPdf;
                    ui.post(() -> {
                        Intent send;
                        if (uris.size() == 1) {
                            send = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris.get(0));
                        } else {
                            send = new Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                        }
                        send.setType(uris.isEmpty() ? "text/plain" : pdf ? "application/pdf" : "*/*");
                        if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
                        if (subject != null && !subject.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, subject);
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        if (!uris.isEmpty()) send.setClipData(ClipData.newRawUri("", uris.get(0)));
                        startActivity(Intent.createChooser(send, "Send"));
                    });
                } catch (Exception e) {
                    ui.post(() -> toast("Couldn't share: " + e.getMessage()));
                }
            });
        }
    }

    // ---- "Share to CertVault" from other apps -------------------------------------------------------

    void handleShareIntent(Intent i) {
        if (i == null) return;
        String a = i.getAction();
        String own = getPackageName() + ".files";
        if (Intent.ACTION_SEND.equals(a)) {
            Uri u = i.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null && !own.equals(u.getAuthority())) pendingShare.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) {
            ArrayList<Uri> list = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Uri u : list) if (u != null && !own.equals(u.getAuthority())) pendingShare.add(u);
        }
        i.setAction(Intent.ACTION_MAIN);
    }

    void uploadPending() {
        if (pendingShare.isEmpty() || server == null) return;
        final ArrayList<Uri> items = new ArrayList<>(pendingShare);
        pendingShare.clear();
        toast("Saving " + items.size() + " file" + (items.size() == 1 ? "" : "s") + " to CertVault…");
        io.execute(() -> {
            try {
                String pinned = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_INSTANCE, null);
                if (pinned == null || !pinned.equals(fetchInstance(server))) {
                    ui.post(() -> toast("Not connected to your CertVault — upload cancelled"));
                    return;
                }
                String csrf = csrfToken();
                if (csrf == null) {
                    ui.post(() -> {
                        pendingShare.addAll(items);
                        toast("Log in, and the shared file will upload straight after");
                    });
                    return;
                }
                String boundary = "----cv" + UUID.randomUUID();
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/documents").openConnection();
                c.setDoOutput(true);
                c.setRequestMethod("POST");
                c.setChunkedStreamingMode(1 << 20);
                c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                c.setRequestProperty("X-CSRF-Token", csrf);
                String cookie = CookieManager.getInstance().getCookie(server);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                c.setReadTimeout(600000);
                try (OutputStream out = c.getOutputStream()) {
                    for (Uri u : items) {
                        String name = displayName(u);
                        String mime = getContentResolver().getType(u);
                        out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\""
                                + name.replace("\"", "") + "\"\r\nContent-Type: " + (mime == null ? "application/octet-stream" : mime)
                                + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                        try (InputStream in = getContentResolver().openInputStream(u)) {
                            byte[] buf = new byte[65536];
                            int n;
                            while (in != null && (n = in.read(buf)) > 0) out.write(buf, 0, n);
                        }
                        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                    }
                    out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                ui.post(() -> {
                    if (code < 300) {
                        toast("Saved to CertVault — reading it now");
                        web.evaluateJavascript("if(window.loadDocs){location.hash='#/';loadDocs().then(function(){route()})}", null);
                    } else {
                        toast("Upload failed (" + code + ")");
                    }
                });
            } catch (Exception e) {
                ui.post(() -> toast("Upload failed: " + e.getMessage()));
            }
        });
    }

    String csrfToken() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/me").openConnection();
            String cookie = CookieManager.getInstance().getCookie(server);
            if (cookie == null) return null;
            c.setRequestProperty("Cookie", cookie);
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString()).optString("csrf", null);
        } catch (Exception e) {
            return null;
        }
    }

    String displayName(Uri u) {
        try (Cursor cur = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cur != null && cur.moveToFirst()) {
                String n = cur.getString(0);
                if (n != null) return n;
            }
        } catch (Exception ignored) {
        }
        String last = u.getLastPathSegment();
        return last != null ? last : "shared-file";
    }

    void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace("\"", "&quot;").replace("'", "&#39;");
    }
}
