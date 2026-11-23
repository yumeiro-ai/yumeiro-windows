package org.yumeiro.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.yumeiro.app.data.ApiClient
import org.yumeiro.app.data.Session
import org.yumeiro.app.data.objects

/**
 * 任务完成通知：前台服务里向服务器“长轮询”新事件（不依赖 Google 推送，国内手机也能用）。
 * 开启后会在通知栏常驻一条“正在接收任务通知”；在设置里关掉就停止。
 */
class NotifyService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannels(this)
        val ongoing = NotificationCompat.Builder(this, CH_KEEP).setSmallIcon(android.R.drawable.stat_notify_sync_noanim).setContentTitle("Yumeiro")
            .setContentText("正在接收任务完成通知").setOngoing(true).setSilent(true).setContentIntent(openApp(this)).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ONGOING_ID, ongoing)
        if (job == null) job = scope.launch { loop() }
        return START_STICKY
    }

    private suspend fun loop() {
        val session = Session(applicationContext); val api = ApiClient(session)
        var seq = PhonePrefs.eventSeq(this)
        var failures = 0
        while (scope.isActive) {
            if (session.server.isEmpty() || session.cookies.isEmpty()) { stopSelf(); return }
            try {
                val r = api.request("GET", "/api/events?since=$seq&wait=25", null, 40000)
                if (r.status == 401) { stopSelf(); return }
                val json = r.json
                if (!r.ok || json == null) { failures++; delay(minOf(60000L, 5000L * failures)); continue }
                failures = 0
                val newSeq = json.optLong("seq", seq)
                // since=0 的第一次只是对齐序号，不会有历史通知
                for (e in (json.optJSONArray("events") ?: org.json.JSONArray()).objects()) notifyEvent(e.optString("title"), e.optString("body"), e.optBoolean("ok", true), e.optLong("seq").toInt())
                if (newSeq != seq) { seq = newSeq; PhonePrefs.setEventSeq(this, seq) }
            } catch (e: Exception) { failures++; delay(minOf(60000L, 5000L * failures)) }
        }
    }

    private fun notifyEvent(title: String, body: String, ok: Boolean, id: Int) {
        val n = NotificationCompat.Builder(this, CH_TASK).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title.ifBlank { "Yumeiro" })
            .setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(openApp(this))
            .setPriority(if (ok) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH).build()
        runCatching { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(1000 + id, n) }
    }

    override fun onDestroy() { job?.cancel(); scope.cancel(); super.onDestroy() }

    companion object {
        private const val CH_TASK = "tasks"; private const val CH_KEEP = "keep"; private const val ONGOING_ID = 7
        fun ensureChannels(c: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val m = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            m.createNotificationChannel(NotificationChannel(CH_TASK, "任务完成", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "协作任务完成或失败时提醒" })
            m.createNotificationChannel(NotificationChannel(CH_KEEP, "后台接收", NotificationManager.IMPORTANCE_MIN).apply { description = "保持连接，用来接收任务通知" })
        }
        private fun openApp(c: Context): PendingIntent = PendingIntent.getActivity(c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun start(c: Context) { runCatching { ContextCompat.startForegroundService(c, Intent(c, NotifyService::class.java)) } }
        fun stop(c: Context) { c.stopService(Intent(c, NotifyService::class.java)) }
    }
}
