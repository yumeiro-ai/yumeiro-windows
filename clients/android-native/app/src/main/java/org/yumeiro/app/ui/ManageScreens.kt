package org.yumeiro.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.yumeiro.app.AgentOpt
import org.yumeiro.app.AppViewModel
import org.yumeiro.app.Member
import org.yumeiro.app.SkillItem
import org.yumeiro.app.Screen

@Composable
internal fun Page(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}, content: @Composable () -> Unit) {
    BackHandler { onBack() }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回", tint = Ink) }
            Text(title, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            actions()
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
    }
}

@Composable
internal fun Item(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().background(Glass, RoundedCornerShape(16.dp)).border(1.dp, Line, RoundedCornerShape(16.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
}

@Composable
internal fun Field(value: String, onChange: (String) -> Unit, label: String, lines: Int = 1, password: Boolean = false) {
    OutlinedTextField(value, onChange, label = { Text(label) }, modifier = Modifier.fillMaxWidth(), singleLine = lines == 1, minLines = lines, maxLines = if (lines == 1) 1 else 8,
        visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else KeyboardType.Text))
}

// ───────────────────────────── 智能体 ─────────────────────────────
@Composable
fun AgentsScreen(vm: AppViewModel) {
    var editing by remember { mutableStateOf<AgentOpt?>(null) }; var creating by remember { mutableStateOf(false) }; var viewing by remember { mutableStateOf<AgentOpt?>(null) }
    LaunchedEffect(Unit) { vm.loadSkills(); vm.loadAgents() }
    Page("智能体", { vm.openSettings() }, actions = { TextButton(onClick = { creating = true }) { Text("新建") } }) {
        Text("智能体 = 自己的提示词 + 技能 + 指定模型。在“设置”里选好后，新对话就会使用它。", color = Muted, fontSize = 12.sp)
        if (vm.agents.isEmpty()) Text("还没有智能体。点右上角“新建”，或去“技能市场”安装。", color = Muted, fontSize = 13.sp)
        for (a in vm.agents) Item(Modifier.clickable { viewing = a }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(a.name, color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (vm.selectedAgent == a.id) Text("使用中", color = Accent, fontSize = 12.sp)
                else if (a.shared) Text("共享", color = Muted, fontSize = 12.sp)
            }
            if (a.description.isNotBlank()) Text(a.description, color = Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row { TextButton(onClick = { vm.chooseAgent(if (vm.selectedAgent == a.id) "" else a.id) }) { Text(if (vm.selectedAgent == a.id) "取消使用" else "用于新对话") }
                if (a.mine || vm.isAdmin) TextButton(onClick = { editing = a }) { Text("编辑") } }
        }
    }
    if (creating) AgentDialog(vm, null) { creating = false }
    editing?.let { AgentDialog(vm, it) { editing = null } }
    viewing?.let { a -> InfoDialog(vm, a.name, a.description, a.systemPrompt.ifBlank { if (a.mine || vm.isAdmin) "（还没有写提示词）" else "（提示词仅创建者和管理员可见）" }, if (a.shared) "共享智能体" else "", if (a.mine || vm.isAdmin) ({ editing = a }) else null) { viewing = null } }
}

@Composable
private fun AgentDialog(vm: AppViewModel, agent: AgentOpt?, onClose: () -> Unit) {
    var name by remember { mutableStateOf(agent?.name ?: "") }; var desc by remember { mutableStateOf(agent?.description ?: "") }
    var prompt by remember { mutableStateOf(agent?.systemPrompt ?: "") }; var model by remember { mutableStateOf(agent?.model ?: "") }
    var shared by remember { mutableStateOf(agent?.shared ?: false) }; var err by remember { mutableStateOf("") }; var modelMenu by remember { mutableStateOf(false) }
    val picked = remember { mutableStateListOf<String>().also { it.addAll(agent?.skillIds ?: emptyList()) } }
    AlertDialog(onDismissRequest = onClose, title = { Text(if (agent == null) "新建智能体" else "编辑智能体") }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(name, { name = it }, "名称"); Field(desc, { desc = it }, "一句话说明（可选）"); Field(prompt, { prompt = it }, "系统提示词（它的身份、说话方式、规则）", 4)
            Box {
                TextButton(onClick = { modelMenu = true }) { Text("模型：" + (vm.models.firstOrNull { it.ref == model }?.label ?: "跟随默认")) }
                androidx.compose.material3.DropdownMenu(modelMenu, { modelMenu = false }) {
                    androidx.compose.material3.DropdownMenuItem({ Text("跟随默认") }, { model = ""; modelMenu = false })
                    for (m in vm.models) androidx.compose.material3.DropdownMenuItem({ Text(m.label) }, { model = m.ref; modelMenu = false })
                }
            }
            if (vm.skills.isNotEmpty()) Text("绑定技能（最多 8 个）", color = Muted, fontSize = 12.sp)
            for (s in vm.skills) Row(Modifier.fillMaxWidth().clickable { if (s.id in picked) picked.remove(s.id) else picked.add(s.id) }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(s.id in picked, { if (it) picked.add(s.id) else picked.remove(s.id) }); Text(s.title, color = Ink, fontSize = 14.sp)
            }
            if (vm.isAdmin) Row(Modifier.fillMaxWidth().clickable { shared = !shared }, verticalAlignment = Alignment.CenterVertically) { Switch(shared, { shared = it }); Text("  共享给所有成员", color = Ink, fontSize = 14.sp) }
            if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
    }, confirmButton = { TextButton(onClick = { vm.saveAgent(agent?.id, name.trim(), desc, prompt, model, picked.toList(), shared) { e -> if (e == null) onClose() else err = e } }) { Text("保存") } },
        dismissButton = { Row { if (agent != null) TextButton(onClick = { vm.deleteAgent(agent.id); onClose() }) { Text("删除", color = MaterialTheme.colorScheme.error) }; TextButton(onClick = onClose) { Text("取消") } } })
}

// ───────────────────────────── 技能 ─────────────────────────────
@Composable
fun SkillsScreen(vm: AppViewModel) {
    var editing by remember { mutableStateOf<SkillItem?>(null) }; var creating by remember { mutableStateOf(false) }; var viewing by remember { mutableStateOf<SkillItem?>(null) }
    LaunchedEffect(Unit) { vm.loadSkills() }
    Page("技能", { vm.openSettings() }, actions = { TextButton(onClick = { vm.open(Screen.Market) }) { Text("市场") }; TextButton(onClick = { creating = true }) { Text("新建") } }) {
        Text("技能是一段写好的说明，绑定到智能体后，它会照着做。", color = Muted, fontSize = 12.sp)
        if (vm.skills.isEmpty()) Text("还没有技能。可以新建，或去“市场”一键安装。", color = Muted, fontSize = 13.sp)
        for (s in vm.skills) Item(Modifier.clickable { viewing = s }) {
            Row { Text(s.title, color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)); if (s.shared) Text("共享", color = Muted, fontSize = 12.sp) }
            if (s.description.isNotBlank()) Text(s.description, color = Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
    if (creating) SkillDialog(vm, null) { creating = false }
    editing?.let { SkillDialog(vm, it) { editing = null } }
    viewing?.let { sk -> InfoDialog(vm, sk.title, sk.description, sk.content, if (sk.shared) "共享技能" else "", if (sk.mine || vm.isAdmin) ({ editing = sk }) else null) { viewing = null } }
}

@Composable
private fun SkillDialog(vm: AppViewModel, skill: SkillItem?, onClose: () -> Unit) {
    val canEdit = skill == null || skill.mine || vm.isAdmin
    var title by remember { mutableStateOf(skill?.title ?: "") }; var desc by remember { mutableStateOf(skill?.description ?: "") }
    var content by remember { mutableStateOf(skill?.content ?: "") }; var shared by remember { mutableStateOf(skill?.shared ?: false) }; var err by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onClose, title = { Text(if (skill == null) "新建技能" else if (canEdit) "编辑技能" else "查看技能") }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (canEdit) { Field(title, { title = it }, "名称"); Field(desc, { desc = it }, "一句话说明（可选）"); Field(content, { content = it }, "技能内容（写清楚什么时候用、怎么做）", 8)
                if (vm.isAdmin) Row(Modifier.fillMaxWidth().clickable { shared = !shared }, verticalAlignment = Alignment.CenterVertically) { Switch(shared, { shared = it }); Text("  共享给所有成员", color = Ink, fontSize = 14.sp) } }
            else { Text(skill!!.title, color = Ink, fontWeight = FontWeight.Bold); androidx.compose.foundation.text.selection.SelectionContainer { Text(skill.content, color = Ink, fontSize = 13.sp) } }
            if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
    }, confirmButton = { if (canEdit) TextButton(onClick = { vm.saveSkill(skill?.id, title.trim(), desc, content, shared) { e -> if (e == null) onClose() else err = e } }) { Text("保存") } else TextButton(onClick = onClose) { Text("关闭") } },
        dismissButton = { Row { if (skill != null && canEdit) TextButton(onClick = { vm.deleteSkill(skill.id); onClose() }) { Text("删除", color = MaterialTheme.colorScheme.error) }; if (canEdit) TextButton(onClick = onClose) { Text("取消") } } })
}

// ───────────────────────────── 市场 ─────────────────────────────
@Composable
fun MarketScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadMarket() }
    Page("技能市场", { vm.open(Screen.Skills) }) {
        Text("装好的技能会出现在“技能”里，机器人类会变成一个智能体。", color = Muted, fontSize = 12.sp)
        if (vm.market.isEmpty()) Text("市场里暂时没有内容（或正在加载）。", color = Muted, fontSize = 13.sp)
        for (m in vm.market) Item(Modifier.clickable { vm.previewMarket(m) }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(m.title, color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)); Text(if (m.type == "bot") "智能体" else "技能", color = Muted, fontSize = 11.sp)
            }
            Text(m.author, color = Muted, fontSize = 11.sp)
            if (m.description.isNotBlank()) Text(m.description, color = Muted, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Row { TextButton(onClick = { vm.previewMarket(m) }) { Text("预览") }
                if (m.installed) Text("已安装", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(12.dp)) else Button(onClick = { vm.installMarket(m) }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("安装") } }
        }
    }
    vm.previewItem?.let { it -> InfoDialog(vm, it.title, it.description, vm.previewText, it.author) { vm.previewItem = null } }
}

// ───────────────────────────── 管理（管理员）─────────────────────────────
@Composable
fun AdminScreen(vm: AppViewModel) {
    var tab by remember { mutableStateOf(0) }
    LaunchedEffect(tab) { if (vm.isAdmin) { vm.adminError = ""; when (tab) { 0 -> vm.loadMembers(); 1 -> vm.loadUsageAll(); 2 -> vm.loadMcp(); 3 -> vm.loadAdminSecurity(); 4 -> vm.loadAdminPlan(); 5 -> vm.loadAdminPricing(); else -> vm.loadAdminSite() } } }
    Page("管理", { vm.openSettings() }) {
        if (!vm.isAdmin) { Text("只有管理员能用这里。", color = Muted); return@Page }
        ScrollableTabRow(tab, containerColor = Color.Transparent, contentColor = Ink, edgePadding = 0.dp) { listOf("成员", "用量", "MCP", "安全与熔断", "套餐与授权", "模型价格", "站点设置").forEachIndexed { i, t -> Tab(tab == i, { tab = i }, text = { Text(t) }) } }
        when (tab) { 0 -> MembersTab(vm); 1 -> UsageTab(vm); 2 -> McpTab(vm); 3 -> SecurityTab(vm); 4 -> PlanTab(vm); 5 -> PricingTab(vm); else -> SiteTab(vm) }
    }
}

@Composable
private fun MembersTab(vm: AppViewModel) {
    var adding by remember { mutableStateOf(false) }; var resetting by remember { mutableStateOf<Member?>(null) }; var deleting by remember { mutableStateOf<Member?>(null) }
    TextButton(onClick = { adding = true }) { Text("＋ 添加成员") }
    for (m in vm.members) Item {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(m.name, color = if (m.disabled) Muted else Ink, fontWeight = FontWeight.SemiBold); Text(m.email + if (m.disabled) " · 已停用" else "", color = Muted, fontSize = 12.sp) }
            if (m.email != vm.me.optString("email")) Switch(!m.disabled, { vm.setMemberDisabled(m.id, !it) })
        }
        Text("今日 ${m.todayCalls} 次 · 本月 ${m.monthCalls} 次 · ${m.tokens} tokens", color = Muted, fontSize = 12.sp)
        if (m.email != vm.me.optString("email")) Row { TextButton(onClick = { resetting = m }) { Text("重置密码") }; TextButton(onClick = { deleting = m }) { Text("删除", color = MaterialTheme.colorScheme.error) } }
    }
    if (adding) {
        var email by remember { mutableStateOf("") }; var name by remember { mutableStateOf("") }; var pw by remember { mutableStateOf("") }; var err by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { adding = false }, title = { Text("添加成员") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(email, { email = it }, "邮箱"); Field(name, { name = it }, "显示名（可选）"); Field(pw, { pw = it }, "初始密码（至少 12 位）", password = true)
            if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) } },
            confirmButton = { TextButton(onClick = { vm.createMember(email.trim(), name.trim(), pw) { e -> if (e == null) adding = false else err = e } }) { Text("创建") } }, dismissButton = { TextButton(onClick = { adding = false }) { Text("取消") } })
    }
    resetting?.let { m ->
        var pw by remember { mutableStateOf("") }; var err by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { resetting = null }, title = { Text("重置 ${m.name} 的密码") }, text = { Column { Field(pw, { pw = it }, "新密码（至少 12 位）", password = true); if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) } },
            confirmButton = { TextButton(onClick = { vm.resetMemberPassword(m.id, pw) { e -> if (e == null) resetting = null else err = e } }) { Text("重置") } }, dismissButton = { TextButton(onClick = { resetting = null }) { Text("取消") } })
    }
    deleting?.let { m -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除成员") }, text = { Text("确定删除 ${m.email}？他的对话、附件等数据都会一起删除，无法恢复。") },
        confirmButton = { TextButton(onClick = { vm.deleteMember(m.id); deleting = null }) { Text("删除", color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }) }
}

@Composable
private fun UsageTab(vm: AppViewModel) {
    Text("${vm.usageMonth} 全员用量", color = Muted, fontSize = 12.sp)
    for (r in vm.usageRows) Item {
        Row { Text(r.name, color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)); Text("${r.monthCalls} 次", color = Ink) }
        Text("今日 ${r.todayCalls} 次 · ${r.tokens} tokens", color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun McpTab(vm: AppViewModel) {
    Text("这里只能开关已有的 MCP 服务；添加、编辑和市场安装请在网页版管理页操作。", color = Muted, fontSize = 12.sp)
    if (vm.mcp.isEmpty()) Text("还没有配置 MCP 服务。", color = Muted, fontSize = 13.sp)
    for (m in vm.mcp) Item {
        Row(verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text(m.name, color = Ink, fontWeight = FontWeight.SemiBold); Text(m.command.trim(), color = Muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            Switch(m.enabled, { vm.toggleMcp(m.name, it) }) }
    }
}

// ───────────────────────────── 网页找回密码的手机确认（管理员）─────────────────────────────
@Composable
fun SecurityScreen(vm: AppViewModel) {
    var code by remember { mutableStateOf("") }; var err by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    // 每 3 秒刷新一次待确认的请求，并让倒计时走起来
    LaunchedEffect(Unit) { while (true) { vm.loadApprovals(); repeat(3) { kotlinx.coroutines.delay(1000); now = System.currentTimeMillis() } } }
    Page("网页找回密码确认", { vm.openSettings() }) {
        if (!vm.isAdmin) { Text("只有管理员能用这里。", color = Muted); return@Page }
        Text("管理员在网页登录页点“忘记密码 → 手机确认”后，网页会显示一个 6 位验证码。只有确定是你自己在操作时，才在这里批准。", color = Muted, fontSize = 12.sp)
        Text("正在等待确认的请求", color = Ink, fontWeight = FontWeight.SemiBold)
        if (vm.approvals.isEmpty()) Text("现在没有待确认的请求。网页上发起后，这里会自动出现；也可以在下面手动输入验证码。", color = Muted, fontSize = 13.sp)
        for (a in vm.approvals) Item {
            val left = ((a.expiresAt - now) / 1000).coerceAtLeast(0)
            Text(a.code.take(3) + " " + a.code.drop(3), color = Accent, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Text("来自 " + a.ip.ifBlank { "未知地址" } + " · 还剩 " + left / 60 + ":" + (left % 60).toString().padStart(2, '0'), color = Muted, fontSize = 12.sp)
            if (a.ua.isNotBlank()) Text(a.ua, color = Muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row { Button(onClick = { confirm = a.code to true }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("批准") }; TextButton(onClick = { confirm = a.code to false }) { Text("拒绝") } }
        }
        Text("手动输入验证码", color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
        OutlinedTextField(code, { code = it.filter { c -> c.isDigit() || c == ' ' }.take(7) }, label = { Text("网页上显示的 6 位验证码") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        Row { Button(enabled = code.count { it.isDigit() } == 6, onClick = { confirm = code to true }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("批准") }
            TextButton(enabled = code.count { it.isDigit() } == 6, onClick = { confirm = code to false }) { Text("拒绝") } }
    }
    confirm?.let { (c, approve) ->
        AlertDialog(onDismissRequest = { confirm = null }, title = { Text(if (approve) "批准这次请求？" else "拒绝这次请求？") },
            text = { Text(if (approve) "批准后，网页上的人可以直接登录你的管理员账号并改密码。只有确定是你自己在网页上发起的，才批准。" else "拒绝后，网页那边会提示被拒绝。") },
            confirmButton = { TextButton(onClick = { vm.decideApproval(c, approve) { e -> err = e ?: ""; if (e == null) code = "" }; confirm = null }) { Text(if (approve) "批准" else "拒绝", color = if (approve) Accent else MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("取消") } })
    }
}
