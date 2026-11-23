package org.yumeiro.app.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class ApiException(message: String, val status: Int = 0) : Exception(message)

const val HTTPS_UNSUPPORTED = "这个地址不支持 HTTPS"

/** 服务器地址、账号、会话 Cookie 和 CSRF 令牌（只保存在本应用的私有存储里）。 */
class Session(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("yumeiro", Context.MODE_PRIVATE)
    var server: String = prefs.getString("server", "") ?: ""
    var email: String = prefs.getString("email", "") ?: ""
    var ignoreCert: Boolean = prefs.getBoolean("ignoreCert", false)
    var csrf: String = prefs.getString("csrf", "") ?: ""
    val cookies: MutableMap<String, String> = HashMap<String, String>().also { map ->
        val raw = prefs.getString("cookies", "") ?: ""
        if (raw.isNotEmpty()) runCatching { JSONObject(raw).let { o -> o.keys().forEach { k -> map[k] = o.getString(k) } } }
    }
    var defaultModel: String = prefs.getString("defaultModel", "") ?: ""
    var fontScale: Float = prefs.getFloat("fontScale", 1f)
    var themeMode: String = prefs.getString("themeMode", "dark") ?: "dark"
    var wallpaper: String = prefs.getString("wallpaper", "") ?: ""

    fun save() {
        prefs.edit().putString("server", server).putString("email", email).putBoolean("ignoreCert", ignoreCert)
            .putString("csrf", csrf).putString("cookies", JSONObject(cookies as Map<*, *>).toString()).putString("defaultModel", defaultModel).putFloat("fontScale", fontScale).putString("themeMode", themeMode).putString("wallpaper", wallpaper).apply()
    }

    fun clearLogin() { cookies.clear(); csrf = ""; save() }
}

class Reply(val status: Int, val text: String) {
    val json: JSONObject? by lazy { runCatching { JSONObject(text) }.getOrNull() }
    val ok get() = status in 200..299
    fun error(default: String): String = json?.optString("error")?.takeIf { it.isNotBlank() } ?: default
}

/** 规范化用户输入的服务器地址：补上 https://，去掉结尾斜杠。 */
fun normalizeServer(input: String): String {
    var s = input.trim().trimEnd('/')
    if (s.isEmpty()) return ""
    if (!s.startsWith("http://", true) && !s.startsWith("https://", true)) s = "https://$s"
    return s
}

class ApiClient(private val session: Session) {
    @Volatile private var activeStream: HttpURLConnection? = null

    private fun open(path: String, method: String, timeoutMs: Int): HttpURLConnection {
        val url = URL(session.server + path)
        val conn = url.openConnection() as HttpURLConnection
        if (conn is HttpsURLConnection && session.ignoreCert) trustAll(conn)
        conn.requestMethod = method
        conn.connectTimeout = 15000
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("Accept", "application/json")
        conn.setRequestProperty("Origin", session.server)
        conn.setRequestProperty("User-Agent", "Yumeiro-Android/1.0")
        if (session.cookies.isNotEmpty()) conn.setRequestProperty("Cookie", session.cookies.entries.joinToString("; ") { "${it.key}=${it.value}" })
        if (method != "GET" && session.csrf.isNotEmpty()) conn.setRequestProperty("X-CSRF-Token", session.csrf)
        return conn
    }

    private fun trustAll(conn: HttpsURLConnection) {
        // 只在用户明确勾选“忽略证书错误”（自签名证书）并且只针对这个已保存的服务器时使用
        val trust = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        })
        val ctx = SSLContext.getInstance("TLS"); ctx.init(null, trust, SecureRandom())
        conn.sslSocketFactory = ctx.socketFactory
        val host = URL(session.server).host
        conn.hostnameVerifier = HostnameVerifier { name, _ -> name == host }
    }

    private fun remember(conn: HttpURLConnection) {
        val headers = conn.headerFields["Set-Cookie"] ?: return
        for (header in headers) {
            val first = header.substringBefore(';')
            val name = first.substringBefore('=').trim(); val value = first.substringAfter('=', "").trim()
            if (name.isEmpty()) continue
            val maxAge = Regex("max-age=(-?[0-9]+)", RegexOption.IGNORE_CASE).find(header)?.groupValues?.get(1)?.toLongOrNull()
            if (value.isEmpty() || (maxAge != null && maxAge <= 0)) session.cookies.remove(name) else session.cookies[name] = value
        }
        session.save()
    }

    private fun readAll(stream: InputStream?): String {
        if (stream == null) return ""
        val out = ByteArrayOutputStream(); val buf = ByteArray(8192)
        while (true) { val n = stream.read(buf); if (n < 0) break; out.write(buf, 0, n) }
        return out.toString("UTF-8")
    }

    fun request(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 30000): Reply {
        val conn = try { open(path, method, timeoutMs) } catch (e: Exception) { throw ApiException("服务器地址不对：${e.message}") }
        try {
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            remember(conn)
            val text = readAll(if (status >= 400) conn.errorStream else conn.inputStream)
            return Reply(status, text)
        } catch (e: ApiException) { throw e } catch (e: Exception) { throw ApiException(explain(e)) } finally { conn.disconnect() }
    }

    /** 需要登录的接口：401 就抛出带 status 的异常，让界面回到登录页。 */
    fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val r = request(method, path, body)
        if (r.status == 401) throw ApiException("登录已过期，请重新登录", 401)
        if (!r.ok) throw ApiException(r.error("请求失败（HTTP ${r.status}）"), r.status)
        return r.json ?: JSONObject()
    }

    fun login(email: String, password: String): JSONObject {
        val r = request("POST", "/api/auth/login", JSONObject().put("email", email).put("password", password))
        val json = r.json
        if (r.ok && json != null && json.optBoolean("authenticated")) { session.csrf = json.optString("csrfToken"); session.save(); return json }
        throw ApiException(r.error("登录失败（HTTP ${r.status}）"), r.status)
    }

    /** 当前会话还有效吗？有效的话顺便刷新 CSRF 令牌。 */
    fun checkSession(): JSONObject? {
        val r = request("GET", "/api/auth/session", null, 15000)
        val json = r.json
        if (r.ok && json != null && json.optBoolean("authenticated")) { session.csrf = json.optString("csrfToken", session.csrf); session.save(); return json }
        return null
    }

    fun logout() { runCatching { request("POST", "/api/auth/logout", JSONObject()) }; session.clearLogin() }

    fun bytes(path: String, maxBytes: Int = 12 * 1024 * 1024): Pair<String, ByteArray> {
        val conn = open(path, "GET", 60000)
        try {
            val status = conn.responseCode
            if (status !in 200..299) throw ApiException("读取失败（HTTP $status）", status)
            val type = conn.contentType ?: ""
            val out = ByteArrayOutputStream(); val buf = ByteArray(16384)
            conn.inputStream.use { s -> while (true) { val n = s.read(buf); if (n < 0) break; out.write(buf, 0, n); if (out.size() > maxBytes) throw ApiException("文件太大") } }
            return type to out.toByteArray()
        } catch (e: ApiException) { throw e } catch (e: Exception) { throw ApiException(explain(e)) } finally { conn.disconnect() }
    }

    /** 流式聊天（SSE）：每个事件回调一次；返回后表示这一轮结束。取消用 [cancelStream]。 */
    fun stream(path: String, body: JSONObject, onEvent: (String, JSONObject) -> Unit) {
        val conn = open(path, "POST", 10 * 60 * 1000)
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        activeStream = conn
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            remember(conn)
            if (status !in 200..299) {
                val text = readAll(conn.errorStream)
                val msg = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
                if (status == 401) throw ApiException("登录已过期，请重新登录", 401)
                throw ApiException(msg.ifBlank { "请求失败（HTTP $status）" }, status)
            }
            val reader = conn.inputStream.bufferedReader(Charsets.UTF_8)
            var event = "message"; val data = StringBuilder()
            while (true) {
                val line = reader.readLine() ?: break
                when {
                    line.startsWith("event:") -> event = line.substring(6).trim()
                    line.startsWith("data:") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.substring(5).trimStart()) }
                    line.isEmpty() -> {
                        if (data.isNotEmpty()) onEvent(event, runCatching { JSONObject(data.toString()) }.getOrElse { JSONObject() })
                        event = "message"; data.setLength(0)
                    }
                }
            }
        } catch (e: ApiException) { throw e } catch (e: Exception) { if (activeStream != null) throw ApiException(explain(e)) } finally { activeStream = null; conn.disconnect() }
    }

    fun cancelStream() { activeStream?.let { activeStream = null; runCatching { it.disconnect() } } }

    /** 上传附件（带进度，可取消）。 */
    class Upload(val conn: HttpURLConnection) { @Volatile var cancelled = false; fun cancel() { cancelled = true; runCatching { conn.disconnect() } } }

    fun upload(name: String, data: ByteArray, onStart: (Upload) -> Unit, onProgress: (Long, Long) -> Unit): JSONObject {
        val conn = open("/api/attachments?name=" + java.net.URLEncoder.encode(name, "UTF-8"), "PUT", 10 * 60 * 1000)
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.setFixedLengthStreamingMode(data.size)
        val handle = Upload(conn); onStart(handle)
        try {
            conn.outputStream.use { out ->
                var sent = 0; val chunk = 16 * 1024
                while (sent < data.size) {
                    if (handle.cancelled) throw ApiException("已取消")
                    val n = minOf(chunk, data.size - sent); out.write(data, sent, n); sent += n; onProgress(sent.toLong(), data.size.toLong())
                }
                out.flush()
            }
            val status = conn.responseCode
            remember(conn)
            val reply = Reply(status, readAll(if (status >= 400) conn.errorStream else conn.inputStream))
            if (status == 401) throw ApiException("登录已过期，请重新登录", 401)
            if (!reply.ok) throw ApiException(reply.error("上传失败（HTTP $status）"), status)
            return reply.json?.optJSONObject("attachment") ?: throw ApiException("服务器没有返回附件信息")
        } catch (e: ApiException) { throw e } catch (e: Exception) { throw ApiException(if (handle.cancelled) "已取消" else explain(e)) } finally { conn.disconnect() }
    }

    /** 远程控制的一帧画面：204 表示暂时没有新画面。 */
    class Frame(val status: Int, val seq: Long, val bytes: ByteArray?, val online: Boolean, val control: Boolean, val dlMs: Long = 0, val mode: String = "auto", val profile: String = "")

    fun remoteFrame(id: String, since: Long, lastDlMs: Long = 0): Frame {
        val conn = open("/api/remote/devices/$id/frame?since=$since&dl=$lastDlMs", "GET", 25000)
        try {
            val status = conn.responseCode
            remember(conn)
            if (status == 401) throw ApiException("登录已过期，请重新登录", 401)
            val online = conn.getHeaderField("X-Online") == "1"; val control = conn.getHeaderField("X-Control") == "1"
            if (status == 204) return Frame(204, since, null, online, control, 0, conn.getHeaderField("X-Mode") ?: "auto", conn.getHeaderField("X-Profile") ?: "")
            if (status !in 200..299) { val msg = runCatching { JSONObject(readAll(conn.errorStream)).optString("error") }.getOrNull().orEmpty(); throw ApiException(msg.ifBlank { "读取画面失败（HTTP $status）" }, status) }
            val t0 = System.currentTimeMillis()
            val data = conn.inputStream.use { it.readBytes() }
            return Frame(200, conn.getHeaderField("X-Seq")?.toLongOrNull() ?: since, data, online, control, System.currentTimeMillis() - t0, conn.getHeaderField("X-Mode") ?: "auto", conn.getHeaderField("X-Profile") ?: "")
        } catch (e: ApiException) { throw e } catch (e: Exception) { throw ApiException(explain(e)) } finally { conn.disconnect() }
    }

    /** 把手机里的文件传到工作区（覆盖同名文件前，服务器会自动备份旧的）。 */
    fun uploadToWorkspace(workspaceId: String, path: String, data: ByteArray, onProgress: (Long, Long) -> Unit) {
        val conn = open("/api/workspaces/$workspaceId/upload?path=" + java.net.URLEncoder.encode(path, "UTF-8"), "PUT", 10 * 60 * 1000)
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.setFixedLengthStreamingMode(data.size)
        try {
            conn.outputStream.use { out ->
                var sent = 0; val chunk = 16 * 1024
                while (sent < data.size) { val n = minOf(chunk, data.size - sent); out.write(data, sent, n); sent += n; onProgress(sent.toLong(), data.size.toLong()) }
                out.flush()
            }
            val status = conn.responseCode
            remember(conn)
            val reply = Reply(status, readAll(if (status >= 400) conn.errorStream else conn.inputStream))
            if (status == 401) throw ApiException("登录已过期，请重新登录", 401)
            if (!reply.ok) throw ApiException(reply.error("上传失败（HTTP $status）"), status)
        } catch (e: ApiException) { throw e } catch (e: Exception) { throw ApiException(explain(e)) } finally { conn.disconnect() }
    }

    private fun explain(e: Exception): String = when {
        e is javax.net.ssl.SSLHandshakeException || e.cause is java.security.cert.CertificateException -> "服务器的证书不被信任（自签名证书常见）。确认是自己的服务器后，在登录页勾选“忽略证书错误”。"
        e is javax.net.ssl.SSLException -> "这个地址不支持 HTTPS。如果服务器是 http 的，请在地址前面写上 http://"
        e is java.net.UnknownHostException -> "找不到这个服务器地址，请检查网址和网络。"
        e is java.net.SocketTimeoutException -> "连接超时，请检查网络或稍后再试。"
        e is java.net.ConnectException -> "连不上服务器，请检查地址、端口和网络。"
        else -> e.message ?: e.javaClass.simpleName
    }
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
