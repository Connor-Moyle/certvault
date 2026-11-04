package au.cme.certvault;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Twice a day: asks CertVault what's expired / due within 30 days and shows one tidy notification
 * (only when something changed, at most once a day). Works on the home network or over Tailscale.
 * The server's own ntfy / email reminders still work as well — this is a backup that needs no setup.
 */
public class ReminderWorker extends Worker {
    static final String CHANNEL = "reminders";

    public ReminderWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        String server = prefs.getString(MainActivity.KEY_SERVER, null);
        if (server == null) return Result.success();
        try {
            String cookie = CookieManager.getInstance().getCookie(server);
            if (cookie == null) return Result.success();
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/documents").openConnection();
            c.setRequestProperty("Cookie", cookie);
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() != 200) return Result.success();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONArray docs = new JSONArray(sb.toString());
            List<String> expired = new ArrayList<>(), soon = new ArrayList<>();
            for (int i = 0; i < docs.length(); i++) {
                JSONObject d = docs.getJSONObject(i);
                if (d.optBoolean("superseded")) continue;
                String st = d.optString("state");
                String t = d.optString("title", "A document");
                if ("expired".equals(st)) expired.add(t);
                else if ("soon".equals(st)) soon.add(t + " (" + d.optInt("days_left") + "d)");
            }
            if (expired.isEmpty() && soon.isEmpty()) return Result.success();
            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            String sig = today + "|" + expired + "|" + soon;
            String lastDay = prefs.getString("notified_day", "");
            if (sig.equals(prefs.getString("notified_sig", "")) || today.equals(lastDay)) return Result.success();
            prefs.edit().putString("notified_sig", sig).putString("notified_day", today).apply();
            notify(ctx, expired, soon);
        } catch (Exception ignored) {
            // NAS not reachable right now (away from home, asleep…) — try again next time
        }
        return Result.success();
    }

    static void notify(Context ctx, List<String> expired, List<String> soon) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Expiry reminders", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Tickets, licences and documents that are expired or due soon");
            nm.createNotificationChannel(ch);
        }
        if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        String title = !expired.isEmpty()
                ? expired.size() + " expired" + (soon.isEmpty() ? "" : " · " + soon.size() + " due soon")
                : soon.size() + " due in the next 30 days";
        StringBuilder body = new StringBuilder();
        for (String e : expired) body.append("Expired: ").append(e).append('\n');
        for (String s : soon) body.append(s).append('\n');
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("CertVault: " + title)
                .setContentText(body.toString().split("\n")[0])
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body.toString().trim()))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(expired.isEmpty() ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_HIGH);
        NotificationManagerCompat.from(ctx).notify(42, b.build());
    }
}
