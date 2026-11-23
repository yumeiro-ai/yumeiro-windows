package org.yumeiro.app

import java.net.URI
import java.net.URLDecoder

/** 扫到的二维码是什么。纯函数（不依赖 Android），方便单元测试。 */
sealed class ScanTarget {
    data class Login(val code: String) : ScanTarget()
    data class Chat(val id: String) : ScanTarget()
    data class Workspace(val id: String) : ScanTarget()
    data class Rejected(val reason: String) : ScanTarget()
}

/**
 * 只认自己登录的这台服务器发出的二维码：主机名不一样就拒绝，
 * 防止别人拿别处的二维码骗你点“确认登录”。
 */
fun parseScan(text: String, serverHost: String?): ScanTarget {
    val raw = text.trim()
    val uri = runCatching { URI(raw) }.getOrNull()
    val scheme = uri?.scheme?.lowercase()
    val host = uri?.host
    if (uri == null || host == null || (scheme != "http" && scheme != "https")) return ScanTarget.Rejected("这不是 Yumeiro 的二维码：" + raw.take(40))
    if (serverHost == null || !host.equals(serverHost, ignoreCase = true)) return ScanTarget.Rejected("这个二维码来自别的服务器（$host），和你登录的不是同一个，已忽略。")
    val query = (uri.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate { part ->
        val k = part.substringBefore('='); val v = part.substringAfter('=', "")
        URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
    }
    val qr = query["qr"].orEmpty(); val open = query["open"].orEmpty()
    return when {
        qr.isNotBlank() -> ScanTarget.Login(qr)
        open.startsWith("chat:") && open.length > 5 -> ScanTarget.Chat(open.removePrefix("chat:"))
        open.startsWith("workspace:") && open.length > 10 -> ScanTarget.Workspace(open.removePrefix("workspace:"))
        else -> ScanTarget.Rejected("这个二维码不是登录或转接用的")
    }
}
