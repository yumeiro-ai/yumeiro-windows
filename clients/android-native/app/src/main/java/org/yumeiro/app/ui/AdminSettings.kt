package org.yumeiro.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject
import org.yumeiro.app.AppViewModel
import org.yumeiro.app.data.objects
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private fun fmtTime(ms: Long): String = if (ms <= 0) "" else SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(ms))
private fun strings(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
private fun numText(v: Double): String = if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else v.toString()

@Composable
private fun SwitchLine(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!value) }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Ink, fontSize = 14.sp, modifier = Modifier.weight(1f)); Switch(value, onChange)
    }
}

@Composable
private fun NumField(value: String, onChange: (String) -> Unit, label: String, decimal: Boolean = false) {
    OutlinedTextField(value, { onChange(it.filter { c -> c.isDigit() || (decimal && c == '.') }.take(12)) }, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number))
}

@Composable
private fun Drop(value: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }) { Text(options.firstOrNull { it.first == value }?.second ?: value.ifBlank { "选择" }) }
        DropdownMenu(open, { open = false }) { for ((v, t) in options) DropdownMenuItem({ Text(t) }, { onPick(v); open = false }) }
    }
}

@Composable
private fun Feedback(err: String) { if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }

@Composable
private fun Loading(vm: AppViewModel) {
    Text(vm.adminError.ifEmpty { "正在读取…" }, color = if (vm.adminError.isEmpty()) Muted else MaterialTheme.colorScheme.error, fontSize = 13.sp)
}

@Composable
private fun SaveButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, colors = ButtonDefaults.buttonColors(containerColor = Accent), modifier = Modifier.fillMaxWidth()) { Text(text) }
}

// ───────────────────────────── 安全与熔断 ─────────────────────────────
private val KIND = mapOf("dlp" to "敏感内容", "confidential" to "机密工作区", "breaker" to "模型熔断", "abuse" to "请求过快", "cost" to "费用上限")
private val BUILTIN = listOf("idcard" to "身份证号（带校验）", "bank" to "银行卡号（带校验）", "secret" to "密钥 / 令牌", "phone" to "手机号", "email" to "邮箱地址")

@Composable
internal fun SecurityTab(vm: AppViewModel) {
    val data = vm.adminSecurity
    if (data == null) { Loading(vm); return }
    val dlp = data.optJSONObject("dlp") ?: JSONObject(); val br = data.optJSONObject("breaker") ?: JSONObject(); val em = data.optJSONObject("emailDomains") ?: JSONObject()
    val currency = data.optString("currency", "¥")
    var dlpOn by remember(data) { mutableStateOf(dlp.optBoolean("enabled")) }
    var block by remember(data) { mutableStateOf(dlp.optString("mode") != "warn") }
    val builtin = remember(data) { mutableStateOf((dlp.optJSONObject("builtin") ?: JSONObject()).let { b -> BUILTIN.associate { (id, _) -> id to b.optBoolean(id) } }) }
    var keywords by remember(data) { mutableStateOf(strings(dlp.optJSONArray("keywords")).joinToString("\n")) }
    val allow = remember(data) { mutableStateOf(strings(dlp.optJSONArray("confidentialAllow")).toSet()) }
    var emailOn by remember(data) { mutableStateOf(em.optBoolean("enabled")) }
    var domains by remember(data) { mutableStateOf(strings(em.optJSONArray("domains")).joinToString("\n")) }
    var brOn by remember(data) { mutableStateOf(br.optBoolean("enabled", true)) }
    var thr by remember(data) { mutableStateOf(br.optInt("failureThreshold", 5).toString()) }
    var open by remember(data) { mutableStateOf(br.optInt("openSeconds", 60).toString()) }
    var rate by remember(data) { mutableStateOf(br.optInt("userRatePerMinute", 30).toString()) }
    var day by remember(data) { mutableStateOf(numText(br.optDouble("dailyCostLimit", 0.0))) }
    var month by remember(data) { mutableStateOf(numText(br.optDouble("monthlyCostLimit", 0.0))) }
    var err by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val providers = (data.optJSONArray("providers") ?: JSONArray()).objects() + (data.optJSONArray("engines") ?: JSONArray()).objects()
    val labeled = (data.optJSONArray("labeled") ?: JSONArray()).objects().map { it.optString("name") }

    Text("这里只记录“谁、什么时候、命中了什么规则”，不会记录被检测的内容本身。保存后立即对所有成员生效。", color = Muted, fontSize = 12.sp)
    Item {
        Text("注册邮箱限制", color = Ink, fontWeight = FontWeight.SemiBold)
        Text("开启后，邀请、新建成员只接受下面这些域名的邮箱（完整匹配，子域名要单独写）。已有成员不受影响。", color = Muted, fontSize = 12.sp)
        SwitchLine("只允许公司邮箱注册", emailOn) { emailOn = it }
        Field(domains, { domains = it }, "公司邮箱域名，每行一个，例如 example.com", 3)
    }
    Item {
        Text("敏感内容拦截", color = Ink, fontWeight = FontWeight.SemiBold)
        Text("成员发给模型的内容会在发出前检查，命中后按下面的方式处理并记入告警。", color = Muted, fontSize = 12.sp)
        SwitchLine("启用", dlpOn) { dlpOn = it }
        Row(verticalAlignment = Alignment.CenterVertically) { Text("命中后", color = Ink, fontSize = 14.sp); Drop(if (block) "block" else "warn", listOf("block" to "拦截并告警", "warn" to "只警告（放行并记录）")) { block = it == "block" } }
        for ((id, label) in BUILTIN) SwitchLine(label, builtin.value[id] == true) { builtin.value = builtin.value + (id to it) }
        Field(keywords, { keywords = it }, "自定义关键词，每行一个，不分大小写", 4)
        val rx = dlp.optJSONArray("regexes")?.length() ?: 0
        if (rx > 0) Text("另有 $rx 条自定义正则，保存时原样保留（添加、修改请在网页版）。", color = Muted, fontSize = 12.sp)
    }
    Item {
        Text("机密工作区", color = Ink, fontWeight = FontWeight.SemiBold)
        Text("标成“机密”的工作区默认不能发给任何模型或引擎，只有勾选的才允许（比如公司自己部署的模型）。当前机密工作区：" + (labeled.joinToString("、").ifEmpty { "无" }), color = Muted, fontSize = 12.sp)
        for (p in providers) SwitchLine(p.optString("name"), p.optString("id") in allow.value) { on -> allow.value = if (on) allow.value + p.optString("id") else allow.value - p.optString("id") }
    }
    Item {
        Text("熔断与费用上限", color = Ink, fontWeight = FontWeight.SemiBold)
        SwitchLine("启用熔断", brOn) { brOn = it }
        NumField(thr, { thr = it }, "模型连续失败多少次就熔断")
        NumField(open, { open = it }, "熔断后先断开多少秒再试探（5–3600）")
        NumField(rate, { rate = it }, "单人每分钟最多请求数（0 不限）")
        NumField(day, { day = it }, "每日费用上限 $currency（0 不限）", true)
        NumField(month, { month = it }, "每月费用上限 $currency（0 不限）", true)
        val costs = data.optJSONObject("costs")
        if (costs != null) Text("当前已用：今日 $currency${"%.2f".format(costs.optDouble("day"))}，本月 $currency${"%.2f".format(costs.optDouble("month"))}。", color = Muted, fontSize = 12.sp)
    }
    Feedback(err)
    SaveButton(if (busy) "保存中…" else "保存安全设置", !busy) {
        err = ""
        val t = thr.toIntOrNull(); val o = open.toIntOrNull(); val r = rate.toIntOrNull(); val d = day.toDoubleOrNull() ?: 0.0; val m = month.toDoubleOrNull() ?: 0.0
        if (t == null || t < 1 || o == null || o < 5 || r == null) { err = "熔断数字不正确：失败次数至少 1，断开秒数至少 5"; return@SaveButton }
        val dlpBody = JSONObject(dlp.toString()).put("enabled", dlpOn).put("mode", if (block) "block" else "warn")
            .put("builtin", JSONObject().apply { for ((id, v) in builtin.value) put(id, v) })
            .put("keywords", JSONArray(keywords.split('\n').map { it.trim() }.filter { it.isNotEmpty() }))
            .put("confidentialAllow", JSONArray(allow.value.toList()))
        val brBody = JSONObject(br.toString()).put("enabled", brOn).put("failureThreshold", t).put("openSeconds", o).put("userRatePerMinute", r).put("dailyCostLimit", d).put("monthlyCostLimit", m)
        val emBody = JSONObject().put("enabled", emailOn).put("domains", JSONArray(domains.split(Regex("[\\s,;，；]+")).map { it.trim() }.filter { it.isNotEmpty() }))
        busy = true
        vm.saveAdminSecurity(JSONObject().put("dlp", dlpBody).put("breaker", brBody).put("emailDomains", emBody)) { e -> busy = false; if (e != null) err = e }
    }

    Text("实时状态", color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
    val states = data.optJSONObject("states")
    val models = (states?.optJSONArray("models") ?: JSONArray()).objects()
    if (models.isEmpty()) Text("还没有模型被调用过，这里会显示每个模型的熔断状态。", color = Muted, fontSize = 12.sp)
    for (s in models) Item {
        val st = s.optString("state")
        val label = if (st == "open") (if (s.optBoolean("manual")) "已手动暂停" else "已熔断") else if (st == "half") "试探中" else "正常"
        Text(label, color = if (st == "open") MaterialTheme.colorScheme.error else if (st == "half") Accent else Ink, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
        Text(s.optString("key") + s.optString("reason").let { if (it.isBlank()) "" else "　$it" } + s.optLong("retryAfterMs").let { if (it > 0) "　约 ${(it + 999) / 1000} 秒后试探" else "" }, color = Muted, fontSize = 12.sp, overflow = TextOverflow.Ellipsis, maxLines = 3)
        TextButton(onClick = { vm.breakerAction(JSONObject().put("action", if (st == "closed") "trip" else "reset").put("key", s.optString("key"))) }) { Text(if (st == "closed") "手动暂停" else "立即恢复") }
    }
    for (u in (states?.optJSONArray("users") ?: JSONArray()).objects()) Item {
        Text("${u.optString("email").ifBlank { u.optString("userId") }}　请求太快，暂停中（约 ${(u.optLong("retryAfterMs") + 999) / 1000} 秒）", color = Ink, fontSize = 13.sp)
        TextButton(onClick = { vm.breakerAction(JSONObject().put("action", "reset-user").put("userId", u.optString("userId"))) }) { Text("立即恢复") }
    }
    TextButton(onClick = { vm.loadAdminSecurity() }) { Text("刷新状态") }

    Text("告警记录（最近 50 条）", color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
    val events = (data.optJSONArray("events") ?: JSONArray()).objects().take(50)
    if (events.isEmpty()) Text("暂时没有告警。", color = Muted, fontSize = 12.sp)
    for (e in events) Item {
        Text("[" + (KIND[e.optString("kind")] ?: e.optString("kind")) + "] " + e.optString("summary"), color = if (e.optBoolean("blocked", true)) MaterialTheme.colorScheme.error else Accent, fontSize = 13.sp)
        Text(fmtTime(e.optLong("at")) + e.optString("email").let { if (it.isBlank()) "" else "　$it" } + e.optString("model").let { if (it.isBlank()) "" else "　$it" }, color = Muted, fontSize = 11.sp)
    }
}

// ───────────────────────────── 套餐与授权（只读）─────────────────────────────
@Composable
internal fun PlanTab(vm: AppViewModel) {
    val d = vm.adminPlan
    if (d == null) { Loading(vm); return }
    Item {
        Text("现在：全部功能向所有人开放", color = Ink, fontWeight = FontWeight.SemiBold)
        Text("目前处于试用期，下面所有版本的功能都可以直接使用，不需要购买，也不需要授权密钥（当前 ${d.optInt("members")} 位成员）。", color = Muted, fontSize = 12.sp)
        Text("正式版本发布后会开放购买：到时候按下面的版本分档，可以在线购买，或用授权密钥解锁完整功能。", color = Muted, fontSize = 12.sp)
    }
    val features = (d.optJSONArray("features") ?: JSONArray()).objects()
    for (t in (d.optJSONArray("tiers") ?: JSONArray()).objects()) Item {
        Text(t.optString("name"), color = Ink, fontWeight = FontWeight.SemiBold)
        Text(t.optString("blurb"), color = Muted, fontSize = 12.sp)
        Text("成员 ${t.optInt("seats").let { if (it == 0) "不限" else it.toString() }}　独立桌面 ${t.optInt("desktops").let { if (it == 0) "无" else it.toString() }}", color = Muted, fontSize = 12.sp)
        for (f in features.filter { it.optString("tier") == t.optString("id") }) Text("• " + f.optString("name") + if (f.optString("status") == "planned") "（规划中）" else "", color = Ink, fontSize = 13.sp)
        Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth()) { Text("即将开放购买") }
    }
}

// ───────────────────────────── 模型价格 ─────────────────────────────
private val SYMBOLS = listOf("¥" to "¥ 人民币", "$" to "$ 美元", "€" to "€ 欧元", "£" to "£ 英镑", "₩" to "₩ 韩元", "₽" to "₽ 卢布", "₹" to "₹ 卢比")

private class PriceRow(val ref: String, val label: String, val provider: String, cur: String, input: String, output: String) {
    var cur by mutableStateOf(cur); var input by mutableStateOf(input); var output by mutableStateOf(output); var auto by mutableStateOf(false)
}

@Composable
internal fun PricingTab(vm: AppViewModel) {
    val data = vm.adminPricing
    if (data == null) { Loading(vm); return }
    var base by remember(data) { mutableStateOf(data.optString("currency", "¥").ifBlank { "¥" }) }
    val rows = remember(data) {
        (data.optJSONArray("models") ?: JSONArray()).objects().map { m ->
            val p = m.optJSONObject("price")
            PriceRow(m.optString("ref"), m.optString("label"), m.optString("providerName"), p?.optString("currency").orEmpty().ifBlank { data.optString("currency", "¥") },
                p?.optDouble("input", 0.0)?.takeIf { it > 0 }?.let { numText(it) } ?: "", p?.optDouble("output", 0.0)?.takeIf { it > 0 }?.let { numText(it) } ?: "")
        }
    }
    val rates = remember(data) { mutableStateOf((data.optJSONObject("rates") ?: JSONObject()).let { r -> r.keys().asSequence().associateWith { k -> numText(r.optDouble(k, 0.0)) } }) }
    var status by remember { mutableStateOf("") }; var err by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val symbols = (rows.map { it.cur } + base).distinct().filter { s -> SYMBOLS.none { it.first == s } }.map { it to it } + SYMBOLS
    Text("模型价格（每百万 Token）", color = Ink, fontWeight = FontWeight.SemiBold)
    Text("没填价格的模型只统计 Token，不算费用。服务商在模型列表里提供价格的可以自动读取，其余请按实际账单单价填写，并给每个模型选货币符号。改价只影响之后的调用，历史费用不变。", color = Muted, fontSize = 12.sp)
    Row(verticalAlignment = Alignment.CenterVertically) { Text("统计货币（合计用）", color = Ink, fontSize = 14.sp); Drop(base, symbols) { base = it } }
    Button(enabled = !busy, onClick = {
        busy = true; err = ""; status = "正在读取…"
        vm.syncAdminPricing { out, e ->
            busy = false
            if (e != null || out == null) { err = e ?: "读取失败"; status = ""; return@syncAdminPricing }
            val prices = out.optJSONObject("prices") ?: JSONObject(); var n = 0
            for (r in rows) {
                val p = prices.optJSONObject(r.ref) ?: continue
                r.input = numText(p.optDouble("input")); r.output = numText(p.optDouble("output"))
                p.optString("currency").takeIf { it.isNotBlank() }?.let { c -> r.cur = c }
                r.auto = true; n++
            }
            status = "读到 $n 个模型的价格（还没保存，请检查后点“保存价格”）。" + (out.optJSONArray("report") ?: JSONArray()).objects().joinToString("；") { it.optString("name") + "：" + it.optString("detail") }
        }
    }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("从服务商读取价格") }
    if (rows.isEmpty()) Text("还没有可用的模型，请先在网页版“AI 接入”里添加。", color = Muted, fontSize = 13.sp)
    for (r in rows) Item {
        Text(r.label, color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        Text(r.provider + if (r.label != r.ref) "　" + r.ref else "", color = Muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Drop(r.cur, symbols) { r.cur = it }
            Box(Modifier.weight(1f)) { NumField(r.input, { r.input = it; r.auto = false }, "输入", true) }
            Box(Modifier.weight(1f)) { NumField(r.output, { r.output = it; r.auto = false }, "输出", true) }
        }
        if (r.auto) Text("自动读取", color = Muted, fontSize = 11.sp)
    }
    val used = rows.filter { it.input.isNotBlank() || it.output.isNotBlank() }.map { it.cur }.filter { it.isNotBlank() && it != base }.distinct()
    if (used.isNotEmpty()) Item {
        Text("有模型的货币和统计货币不同，费用合计时需要折算：", color = Muted, fontSize = 12.sp)
        for (c in used) NumField(rates.value[c] ?: "", { rates.value = rates.value + (c to it) }, "1 $c = ? $base", true)
    }
    if (status.isNotEmpty()) Text(status, color = Muted, fontSize = 12.sp)
    Feedback(err)
    SaveButton(if (busy) "请稍候…" else "保存价格", !busy) {
        err = ""
        val models = JSONObject()
        for (r in rows) {
            if (r.input.isBlank() && r.output.isBlank()) continue
            val i = r.input.toDoubleOrNull() ?: 0.0; val o = r.output.toDoubleOrNull() ?: 0.0
            if (i > 1e6 || o > 1e6) { err = "价格必须是 0–1000000 的数字：" + r.label; return@SaveButton }
            models.put(r.ref, JSONObject().put("input", i).put("output", o).put("currency", r.cur))
        }
        val rateBody = JSONObject(); for (c in used) rates.value[c]?.toDoubleOrNull()?.takeIf { it > 0 }?.let { rateBody.put(c, it) }
        val missing = used.filter { !rateBody.has(it) }
        if (missing.isNotEmpty()) { err = "请先填写汇率：" + missing.joinToString("、"); return@SaveButton }
        busy = true
        vm.saveAdminPricing(JSONObject().put("currency", base).put("models", models).put("rates", rateBody)) { e -> busy = false; if (e != null) err = e else status = "已保存" }
    }
}

// ───────────────────────────── 站点设置 ─────────────────────────────
@Composable
internal fun SiteTab(vm: AppViewModel) {
    val site = vm.adminSite
    if (site == null) { Loading(vm); return }
    var name by remember(site) { mutableStateOf(site.optString("name")) }; var notice by remember(site) { mutableStateOf(site.optString("notice")) }
    var mode by remember(site) { mutableStateOf(site.optString("mode", "team").ifBlank { "team" }) }
    var err by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    Text("这里设置的名称和公告会显示在登录页上，未登录也能看到，请不要写敏感信息。设置会影响所有成员。", color = Muted, fontSize = 12.sp)
    Item {
        Field(name, { name = it.take(30) }, "团队/站点名称（留空显示 Yumeiro，最多 30 字）")
        Field(notice, { notice = it.take(200) }, "登录页公告（可选，最多 200 字）", 3)
        Row(verticalAlignment = Alignment.CenterVertically) { Text("使用模式", color = Ink, fontSize = 14.sp); Drop(mode, listOf("team" to "团队使用", "personal" to "个人使用（隐藏团队功能）")) { mode = it } }
    }
    Feedback(err)
    SaveButton(if (busy) "保存中…" else "保存站点设置", !busy) { busy = true; err = ""; vm.saveAdminSite(name.trim(), notice.trim(), mode) { e -> busy = false; if (e != null) err = e } }
}
