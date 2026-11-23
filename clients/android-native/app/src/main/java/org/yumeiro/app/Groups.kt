package org.yumeiro.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.yumeiro.app.data.ApiException
import org.yumeiro.app.data.objects

/** 群聊成员的可编辑草稿：名称、模型、身份、擅长。 */
class GMember(label: String = "", model: String = "", role: String = "", strengths: String = "") {
    var label by mutableStateOf(label)
    var model by mutableStateOf(model)
    var role by mutableStateOf(role)
    var strengths by mutableStateOf(strengths)
}
data class GroupItem(val id: String, val title: String, val mode: String, val rounds: Int, val pmLabel: String, val pmModel: String, val members: List<GMember>, val count: Int)
data class GMsg(val key: Long, val role: String, val label: String, val content: String, val task: String = "", val error: Boolean = false, val streaming: Boolean = false)

val GROUP_MODES = listOf(
    "pm" to "产品经理带队（推荐）", "chat" to "群聊（@ 点名）", "roundtable" to "圆桌讨论", "pipeline" to "接力", "supervisor" to "主管调度"
)
fun groupModeLabel(mode: String) = GROUP_MODES.firstOrNull { it.first == mode }?.second ?: mode

// 模型名 → (默认身份, 默认擅长)：只是按名字给的建议，用户可以改
private val HINTS = listOf(
    Regex("claude|opus|sonnet|haiku", RegexOption.IGNORE_CASE) to ("资深架构师与写作者" to "长文写作、代码、严谨推理"),
    Regex("gpt|o1|o3|o4", RegexOption.IGNORE_CASE) to ("全能工程师" to "通用问答、代码、工具调用"),
    Regex("deepseek", RegexOption.IGNORE_CASE) to ("算法与后端工程师" to "代码、数学与推理、性价比高"),
    Regex("qwen|通义", RegexOption.IGNORE_CASE) to ("中文内容专家" to "中文理解、多语言、代码"),
    Regex("gemini", RegexOption.IGNORE_CASE) to ("资料研究员" to "超长上下文、多模态、检索总结"),
    Regex("glm|智谱", RegexOption.IGNORE_CASE) to ("办公文案助理" to "中文对话、办公写作"),
    Regex("kimi|moonshot", RegexOption.IGNORE_CASE) to ("阅读与总结专员" to "长文阅读与总结"),
    Regex("doubao|豆包", RegexOption.IGNORE_CASE) to ("创意文案" to "中文创作、日常对话")
)
fun hintFor(name: String): Pair<String, String> = HINTS.firstOrNull { it.first.containsMatchIn(name) }?.second ?: ("全能助手" to "通用对话与分析")
fun safeName(text: String): String = text.replace(Regex("[@\\s/]+"), "").take(20).ifEmpty { "模型" }

/** 多智能体群聊的状态与网络调用（与 AppViewModel 共用登录会话）。 */
class GroupState(private val vm: AppViewModel) {
    val groups = mutableStateListOf<GroupItem>()
    var current by mutableStateOf<GroupItem?>(null)
    val messages = mutableStateListOf<GMsg>()
    var busy by mutableStateOf(false); private set
    var editing by mutableStateOf<GroupItem?>(null)   // 编辑已有群聊；新建时为 null
    private var keySeq = 0L
    private var job: Job? = null

    private fun parse(g: JSONObject): GroupItem {
        val pm = g.optJSONObject("pm")
        return GroupItem(g.optString("id"), g.optString("title").ifBlank { "新群聊" }, g.optString("mode", "chat"), g.optInt("rounds", 2),
            pm?.optString("label").orEmpty().ifBlank { "产品经理" }, pm?.optString("model").orEmpty(),
            (g.optJSONArray("members") ?: JSONArray()).objects().map { GMember(it.optString("label"), it.optString("model"), it.optString("role"), it.optString("strengths")) }, g.optInt("count"))
    }

    fun load() = vm.io({ vm.api.call("GET", "/api/groups") }, onError = {}) { d ->
        groups.clear(); groups.addAll((d.optJSONArray("groups") ?: JSONArray()).objects().map { parse(it) })
    }

    fun open(id: String) {
        vm.io({ vm.api.call("GET", "/api/groups/$id") }) { d ->
            current = d.optJSONObject("group")?.let { parse(it) }
            messages.clear()
            for (m in (d.optJSONArray("messages") ?: JSONArray()).objects())
                messages.add(GMsg(keySeq++, m.optString("role"), if (m.optString("role") == "user") "你" else m.optString("label"), m.optString("content")))
            vm.open(Screen.GroupChat)
        }
    }

    fun delete(id: String) = vm.io({ vm.api.call("DELETE", "/api/groups/$id") }) { if (current?.id == id) current = null; load() }

    /** 新建时用“所有可用模型”做初始成员（最多 12 个），身份和擅长按模型名给默认值。 */
    fun allModelMembers(existing: List<GMember> = emptyList()): List<GMember> {
        val used = existing.map { it.model }.toSet(); val names = existing.map { it.label }.toMutableSet(); val out = mutableListOf<GMember>()
        for (m in vm.models) {
            if (existing.size + out.size >= 12) break
            if (m.ref in used) continue
            var name = safeName(m.label); var n = 2; while (name in names) name = safeName(m.label) + n++
            names.add(name); val h = hintFor(m.ref + " " + m.label); out.add(GMember(name, m.ref, h.first, h.second))
        }
        return out
    }

    fun save(id: String?, title: String, mode: String, rounds: Int, pmLabel: String, pmModel: String, members: List<GMember>, done: (String?) -> Unit) {
        val body = JSONObject().put("title", title).put("mode", mode).put("rounds", rounds)
            .put("members", JSONArray(members.map { JSONObject().put("label", it.label.trim()).put("role", it.role.trim()).put("strengths", it.strengths.trim()).apply { if (it.model.isNotEmpty()) put("model", it.model) } }))
        if (mode == "pm") body.put("pm", JSONObject().put("label", pmLabel.trim().ifEmpty { "产品经理" }).apply { if (pmModel.isNotEmpty()) put("model", pmModel) })
        vm.io({ if (id == null) vm.api.call("POST", "/api/groups", body) else vm.api.call("PATCH", "/api/groups/$id", body) }, onError = { done(it.message ?: "保存失败") }) { d ->
            load(); done(null)
            val saved = d.optJSONObject("group"); if (saved != null && id == null) open(saved.optString("id")) else if (saved != null) current = parse(saved)
        }
    }

    fun stop() { vm.api.cancelStream() }

    fun send(raw: String) {
        val text = raw.trim(); val group = current ?: return
        if (text.isEmpty() || busy) return
        busy = true
        messages.add(GMsg(keySeq++, "user", "你", text))
        job = vm.viewModelScope.launch {
            val live = HashMap<String, Int>()   // 成员名 → 它正在写的那条消息的位置（成员可能并行发言）
            var failed: String? = null
            try {
                withContext(Dispatchers.IO) {
                    vm.api.stream("/api/groups/${group.id}/send", JSONObject().put("message", text)) { event, data ->
                        val label = data.optString("label")
                        vm.viewModelScope.launch {
                            when (event) {
                                "turn_start" -> { messages.add(GMsg(keySeq++, "agent", label, "", data.optString("task"), streaming = true)); live[label] = messages.lastIndex }
                                "delta" -> live[label]?.let { i -> if (i in messages.indices) messages[i] = messages[i].copy(content = messages[i].content + data.optString("text")) }
                                "turn_end" -> live.remove(label)?.let { i -> if (i in messages.indices) messages[i] = messages[i].copy(streaming = false) }
                                "note" -> messages.add(GMsg(keySeq++, "note", "", data.optString("text")))
                                "error" -> failed = data.optString("error").ifBlank { "群聊失败" }
                                else -> {}
                            }
                        }
                    }
                }
                failed?.let { messages.add(GMsg(keySeq++, "note", "", it, error = true)) }
            } catch (e: ApiException) {
                if (e.status == 401) vm.expiredPublic() else messages.add(GMsg(keySeq++, "note", "", e.message ?: "请求失败", error = true))
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) { messages.add(GMsg(keySeq++, "note", "", e.message ?: "请求失败", error = true)) }
            finally { busy = false; for (i in messages.indices) if (messages[i].streaming) messages[i] = messages[i].copy(streaming = false); load(); vm.loadUsage() }
        }
    }
}
