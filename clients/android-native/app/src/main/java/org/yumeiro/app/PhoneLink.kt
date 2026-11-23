package org.yumeiro.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.yumeiro.app.data.ApiException
import org.yumeiro.app.data.objects

/** 手机联动：扫码、传文件到电脑、远程操控电脑、任务完成通知的开关。 */
data class QrRequest(val code: String, val ip: String, val ua: String, val expiresAt: Long)
data class RemoteDevice(val id: String, val name: String, val osLabel: String, val online: Boolean, val control: Boolean)
class TransferItem(val name: String, val size: Long) {
    var pct by mutableStateOf(0)
    var message by mutableStateOf("等待上传")
    var ok by mutableStateOf(false)
    var failed by mutableStateOf(false)
}

/** 通知开关等少量设置，单独存一份（后台服务也要读）。 */
object PhonePrefs {
    private fun prefs(c: Context) = c.getSharedPreferences("yumeiro_phone", Context.MODE_PRIVATE)
    fun notifyOn(c: Context) = prefs(c).getBoolean("notifyOn", false)
    fun setNotify(c: Context, on: Boolean) { prefs(c).edit().putBoolean("notifyOn", on).apply() }
    fun eventSeq(c: Context) = prefs(c).getLong("eventSeq", -1L)
    fun setEventSeq(c: Context, seq: Long) { prefs(c).edit().putLong("eventSeq", seq).apply() }
}

class PhoneState(private val vm: AppViewModel) {
    var qr by mutableStateOf<QrRequest?>(null)
    var scanNote by mutableStateOf("")
    val devices = mutableStateListOf<RemoteDevice>()
    var device by mutableStateOf<RemoteDevice?>(null)
    var devicesLoaded by mutableStateOf(false)
    val transfers = mutableStateListOf<TransferItem>()
    var targetWorkspace by mutableStateOf("")
    var notifyOn by mutableStateOf(false)

    private val app get() = vm.getApplication<android.app.Application>()

    fun init() { notifyOn = PhonePrefs.notifyOn(app); if (notifyOn) NotifyService.start(app) }

    // ---- 扫码 ----
    /** 扫到的内容：只认自己登录的这台服务器发出的二维码，别的一律忽略（防止被人用别处的二维码骗去确认）。 */
    fun handleScan(text: String) {
        val mine = runCatching { java.net.URI(vm.session.server).host }.getOrNull()
        when (val t = parseScan(text, mine)) {
            is ScanTarget.Rejected -> scanNote = t.reason
            is ScanTarget.Login -> loadQr(t.code)
            is ScanTarget.Chat -> { vm.open(Screen.Chat); vm.openConv(t.id) }
            is ScanTarget.Workspace -> { targetWorkspace = t.id; vm.open(Screen.Transfer) }
        }
    }

    private fun loadQr(code: String) = vm.io({ vm.api.call("GET", "/api/security/qr-info?code=" + java.net.URLEncoder.encode(code, "UTF-8")) }, onError = { scanNote = it.message ?: "二维码已过期或无效，请在电脑上重新生成" }) { d ->
        qr = QrRequest(code, d.optString("ip"), d.optString("ua"), d.optLong("expiresAt"))
    }

    fun decideQr(approve: Boolean) {
        val req = qr ?: return; qr = null
        vm.io({ vm.api.call("POST", "/api/security/qr-approve", JSONObject().put("code", req.code).put("approve", approve)) }) {
            vm.say(if (approve) "已确认，电脑上会自动登录" else "已拒绝")
            scanNote = ""; if (approve) vm.open(Screen.Chat)
        }
    }

    // ---- 传文件到电脑（工作区）----
    fun upload(workspaceId: String, uris: List<Uri>) {
        if (workspaceId.isBlank()) { vm.say("先选择要传到哪个工作区"); return }
        val resolver = app.contentResolver
        for (uri in uris) {
            val name = safeName(runCatching { resolver.query(uri, null, null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(c.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) else null } }.getOrNull() ?: "手机文件")
            val item = TransferItem(name, 0); transfers.add(0, item)
            vm.viewModelScope.launch {
                val data = withContext(Dispatchers.IO) { runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() }
                if (data == null || data.isEmpty()) { item.failed = true; item.message = "读取失败或文件是空的"; return@launch }
                if (data.size > 200 * 1024 * 1024) { item.failed = true; item.message = "太大了（上限 200 MB）"; return@launch }
                item.message = "上传中…"
                try {
                    withContext(Dispatchers.IO) { vm.api.uploadToWorkspace(workspaceId, "手机上传/$name", data) { sent, total -> item.pct = (sent * 100 / total).toInt() } }
                    item.ok = true; item.pct = 100; item.message = "已传到工作区的“手机上传”文件夹（" + sizeText(data.size.toLong()) + "）"
                } catch (e: ApiException) {
                    if (e.status == 401) vm.expiredPublic() else { item.failed = true; item.message = e.message ?: "上传失败" }
                }
            }
        }
    }

    private fun safeName(name: String) = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().take(120).ifBlank { "手机文件" }
    private fun sizeText(n: Long) = if (n >= 1048576) "%.1f MB".format(n / 1048576.0) else (n / 1024 + 1).toString() + " KB"

    // ---- 远程操控电脑 ----
    fun loadDevices() = vm.io({ vm.api.call("GET", "/api/remote/devices") }) { d ->
        devices.clear()
        devices.addAll((d.optJSONArray("devices") ?: JSONArray()).objects().map { RemoteDevice(it.optString("id"), it.optString("name"), it.optString("osLabel"), it.optBoolean("online"), it.optBoolean("allowControl")) })
        devicesLoaded = true
    }

    fun sendInput(events: List<JSONObject>, onError: (String) -> Unit = { vm.say(it) }) {
        val id = device?.id ?: return
        vm.io({ vm.api.call("POST", "/api/remote/devices/$id/input", JSONObject().put("events", JSONArray(events))) }, onError = { onError(it.message ?: "操作失败") })
    }

    fun setQuality(mode: String) { val id = device?.id ?: return; vm.io({ vm.api.call("POST", "/api/remote/devices/$id/quality", JSONObject().put("mode", mode)) }, onError = { vm.say(it.message ?: "切换失败") }) }

    fun stopRemote() { val id = device?.id ?: return; vm.io({ vm.api.call("POST", "/api/remote/devices/$id/stop", JSONObject()) }, onError = {}) }

    // ---- 通知 ----
    fun setNotify(on: Boolean) {
        notifyOn = on; PhonePrefs.setNotify(app, on)
        if (on) { PhonePrefs.setEventSeq(app, -1L); NotifyService.start(app) } else NotifyService.stop(app)
    }
}
