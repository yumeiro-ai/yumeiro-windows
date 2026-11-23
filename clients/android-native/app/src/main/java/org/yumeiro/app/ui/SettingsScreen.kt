package org.yumeiro.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.yumeiro.app.AppViewModel
import org.yumeiro.app.Screen

@Composable
internal fun Card(title: String, hint: String = "", content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Glass, RoundedCornerShape(18.dp)).border(1.dp, Line, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        if (hint.isNotEmpty()) Text(hint, color = Muted, fontSize = 12.sp)
        content()
    }
}

@Composable
private fun SwitchRow(label: String, hint: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!value) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(label, color = Ink, fontSize = 14.sp); Text(hint, color = Muted, fontSize = 12.sp) }
        Switch(value, onChange)
    }
}

@Composable
internal fun Choice(selected: Boolean, title: String, sub: String = "", onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onClick() }.padding(vertical = 6.dp, horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, onClick)
        Column { Text(title, color = Ink, fontSize = 14.sp); if (sub.isNotBlank()) Text(sub, color = Muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
fun SettingsScreen(vm: AppViewModel) {
    BackHandler { vm.closeSettings() }
    LaunchedEffect(Unit) { vm.loadWorkspaces(); if (vm.isAdmin) { vm.loadMembers(); vm.loadServiceUpdate() } }
    var addMemory by remember { mutableStateOf(false) }; var clearAsk by remember { mutableStateOf(false) }; var pwd by remember { mutableStateOf(false) }; var picker by remember { mutableStateOf("") }
    val pickImage = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { uri -> if (uri != null) vm.importWallpaper(uri) }
    var workspaceEmail by remember { mutableStateOf("") }; var workspaceUserId by remember { mutableStateOf("") }; var workspaceSearch by remember { mutableStateOf("") }; var workspaceError by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.closeSettings() }) { Icon(Icons.Default.ArrowBack, "返回", tint = Ink) }
            Text("设置", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Card(vm.me.optString("displayName").ifBlank { vm.me.optString("email") }) {
                Text(vm.me.optString("email") + if (vm.me.optString("role") == "admin") " · 管理员" else "", color = Muted, fontSize = 13.sp)
                Text(vm.session.server, color = Muted, fontSize = 13.sp)
                if (vm.usage.isNotEmpty()) Text("用量：" + vm.usage, color = Muted, fontSize = 13.sp)
                if (vm.me.optBoolean("hasLocalPassword", true)) TextButton(onClick = { pwd = true }) { Text("修改密码") }
            }
            Card("工作区", "同步工作区成员与项目状态；不会在客户端保存或收集 API Key。") {
                if (vm.workspaces.isEmpty()) Text("还没有可用工作区。", color = Muted, fontSize = 13.sp)
                for (workspace in vm.workspaces) {
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { vm.selectedWorkspaceId = workspace.id }.padding(vertical = 7.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(workspace.name, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            Text("创建者：${workspace.owner.ifBlank { "当前账号" }} · ${workspace.members.size} 位成员", color = Muted, fontSize = 12.sp)
                        }
                        if (vm.selectedWorkspaceId == workspace.id) Text("已选", color = Accent, fontSize = 12.sp)
                    }
                }
                val workspace = vm.workspaces.firstOrNull { it.id == vm.selectedWorkspaceId }
                if (workspace != null) {
                    Text("成员", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                    if (workspace.members.isEmpty()) Text("暂无其他成员", color = Muted, fontSize = 13.sp)
                    for (member in workspace.members) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(member.name.ifBlank { member.email }, color = Ink, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    }
                    if (workspace.mine || vm.isAdmin) {
                        OutlinedTextField(workspaceEmail, { workspaceEmail = it; workspaceUserId = ""; workspaceError = "" }, label = { Text("邀请成员") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { if (workspaceUserId.isNotBlank()) vm.inviteWorkspaceMember(workspace.id, workspaceUserId) { e -> workspaceError = e ?: ""; if (e == null) { workspaceEmail = ""; workspaceUserId = "" } } else workspaceError = "请先从搜索结果选择成员" }, enabled = workspaceUserId.isNotBlank()) { Text("邀请") }
                            if (workspace.mine || vm.isAdmin) TextButton(onClick = { vm.searchWorkspaceMembers(workspace.id, workspaceSearch) }) { Text("搜索账号") }
                        }
                        if (workspace.mine || vm.isAdmin) {
                            OutlinedTextField(workspaceSearch, { workspaceSearch = it }, label = { Text("搜索成员账号（至少 2 个字符）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                            for (candidate in vm.workspaceMemberCandidates.take(5)) Text((candidate.name.ifBlank { candidate.email }), color = Muted, fontSize = 12.sp, modifier = Modifier.clickable { workspaceEmail = candidate.email; workspaceUserId = candidate.id })
                        }
                    }
                    if (workspaceError.isNotBlank()) Text(workspaceError, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                }
            }
            if (vm.isAdmin) vm.serviceUpdate?.let { update ->
                val reminder = update.reachable && update.latest.isNotBlank() && update.installed.isNotBlank() && update.latest != update.installed
                Card("服务更新", if (reminder) "有新的桌面端服务版本可用" else "管理员可在网页版执行更新") {
                    Text(
                        if (!update.enabled) "桌面端更新服务未启用" else if (!update.reachable) "暂时无法连接更新服务" else if (reminder) "当前 ${update.installed}，最新 ${update.latest}" else "当前版本 ${update.installed.ifBlank { "未知" }}",
                        color = if (reminder) Accent else Muted,
                        fontSize = 13.sp
                    )
                    if (update.message.isNotBlank()) Text(update.message, color = Muted, fontSize = 12.sp)
                    TextButton(onClick = { vm.loadServiceUpdate() }) { Text("刷新状态") }
                }
            }
            Card("对话", "点一行选择；输入框里也能临时换模型。") {
                PickRow("默认模型", vm.models.firstOrNull { it.ref == vm.selectedModel }?.label ?: "未选择") { picker = "model" }
                PickRow("新对话用的智能体", vm.agents.firstOrNull { it.id == vm.selectedAgent }?.name ?: "不使用") { picker = "agent" }
            }
            PhoneLinkCard(vm)
            Card("更多") {
                for ((label, hint, target) in listOf(Triple("智能体", "新建、编辑、选择", Screen.Agents), Triple("技能", "自己写，或从市场安装", Screen.Skills), Triple("技能市场", "浏览并一键安装", Screen.Market)) + (if (vm.isAdmin) listOf(Triple("网页找回密码确认", "输入网页上的验证码，批准或拒绝", Screen.Security), Triple("管理", "成员、安全与熔断、套餐、模型价格、站点设置", Screen.Admin)) else emptyList()))
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { vm.open(target) }.padding(vertical = 10.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text(label, color = Ink, fontSize = 15.sp); Text(hint, color = Muted, fontSize = 12.sp) }; Text("›", color = Muted, fontSize = 20.sp)
                    }
            }
            Card("记忆", "它会记住你的偏好和重要信息，让回答更贴合你。不会保存密码和密钥。") {
                SwitchRow("启用记忆", "关闭后不读取也不保存", vm.memEnabled) { vm.setMemPref("enabled", it) }
                SwitchRow("自动记住", "聊天里出现的长期偏好自动记下", vm.memAuto) { vm.setMemPref("auto", it) }
                SwitchRow("跨对话使用", "在其它对话里也参考这些记忆", vm.memCross) { vm.setMemPref("crossChat", it) }
                Text("已记住 ${vm.memories.size} 条", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                for (m in vm.memories) Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text((if (m.pinned) "📌 " else "") + m.text, color = Ink, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = { vm.deleteMemory(m.id) }, modifier = Modifier.size(32.dp)) { Icon(Icons.Default.Close, "删除", tint = Muted, modifier = Modifier.size(16.dp)) }
                }
                Row { TextButton(onClick = { addMemory = true }) { Text("添加一条") }; if (vm.memories.isNotEmpty()) TextButton(onClick = { clearAsk = true }) { Text("清空", color = MaterialTheme.colorScheme.error) } }
            }
            Card("外观", "只影响这台手机") {
                PickRow("主题", mapOf("system" to "跟随系统", "dark" to "深色", "light" to "浅色")[vm.themeMode] ?: "深色") { picker = "theme" }
                PickRow("壁纸", (wallOptions(vm).firstOrNull { it.id == vm.wallpaper }?.label ?: if (vm.wallpaper.startsWith("server:")) vm.wallpaper.removePrefix("server:").substringBeforeLast('.') else "无") + if (vm.wallBusy) "（处理中…）" else "") { vm.loadWallItems(); picker = "wp" }
                PickRow("壁纸遮罩", dims.firstOrNull { it.id == vm.wallDim.toString() }?.label ?: (vm.wallDim.toString() + "%")) { picker = "dim" }
                PickRow("字体大小", fonts.firstOrNull { it.id == vm.fontScale.toString() }?.label ?: "标准") { picker = "font" }
            }
            Card("关于") {
                Text("Yumeiro 安卓原生客户端 0.46.1", color = Muted, fontSize = 13.sp)
                Text("Powered by Yumeiro", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text("使用 Cindy、Dash黄一孟 的项目进行制作 · 制作者：BYL", color = Muted, fontSize = 11.sp)
                Text("以 Apache License 2.0 开源；使用、修改、分发请保留署名与许可证", color = Muted, fontSize = 11.sp)
                Text("管理后台（成员、模型、MCP、市场等）请在浏览器里打开 服务器地址/admin。", color = Muted, fontSize = 12.sp)
            }
            OutlinedButton(onClick = { vm.logout() }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(14.dp)) { Icon(Icons.Default.ExitToApp, null); Spacer(Modifier.size(8.dp)); Text("退出登录 / 切换账号", color = MaterialTheme.colorScheme.error) }
        }
    }
    when (picker) {
        "model" -> PickerDialog("默认对话模型", vm.models.map { Opt(it.ref, it.label, it.provider) }, vm.selectedModel, { vm.chooseModel(it) }, { picker = "" })
        "agent" -> PickerDialog("新对话使用的智能体", listOf(Opt("", "不使用智能体", "普通对话")) + vm.agents.map { Opt(it.id, it.name, it.description) }, vm.selectedAgent, { vm.chooseAgent(it) }, { picker = "" })
        "theme" -> PickerDialog("主题", listOf(Opt("system", "跟随系统"), Opt("dark", "深色"), Opt("light", "浅色")), vm.themeMode, { vm.setTheme(it) }, { picker = "" })
        "wp" -> PickerDialog("壁纸（只在这台手机上生效）", wallOptions(vm), vm.wallpaper, { if (it == "__pick") pickImage.launch("image/*") else vm.chooseWallpaper(it) }, { picker = "" })
        "dim" -> PickerDialog("壁纸遮罩（越大越暗）", dims, vm.wallDim.toString(), { vm.chooseWallDim(it.toInt()) }, { picker = "" })
        "font" -> PickerDialog("字体大小", fonts, vm.fontScale.toString(), { vm.setFont(it.toFloat()) }, { picker = "" })
    }
    if (addMemory) {
        var text by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { addMemory = false }, title = { Text("添加记忆") }, text = { OutlinedTextField(text, { text = it }, placeholder = { Text("例如：我是前端工程师，偏好简洁回答") }, minLines = 2) },
            confirmButton = { TextButton(onClick = { vm.addMemory(text); addMemory = false }) { Text("保存") } }, dismissButton = { TextButton(onClick = { addMemory = false }) { Text("取消") } })
    }
    if (clearAsk) AlertDialog(onDismissRequest = { clearAsk = false }, title = { Text("清空所有记忆") }, text = { Text("确定清空吗？清空后无法恢复。") },
        confirmButton = { TextButton(onClick = { vm.clearMemories(); clearAsk = false }) { Text("清空", color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = { clearAsk = false }) { Text("取消") } })
    if (pwd) {
        var old by remember { mutableStateOf("") }; var new by remember { mutableStateOf("") }; var err by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { pwd = false }, title = { Text("修改密码") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(old, { old = it }, label = { Text("当前密码") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                OutlinedTextField(new, { new = it }, label = { Text("新密码（至少 16 位）") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                if (err.isNotEmpty()) Text(err, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            }
        }, confirmButton = { TextButton(onClick = { vm.changePassword(old, new) { e -> if (e == null) pwd = false else err = e } }) { Text("修改") } }, dismissButton = { TextButton(onClick = { pwd = false }) { Text("取消") } })
    }
}

private val fonts = listOf(Opt("0.9", "小"), Opt("1.0", "标准"), Opt("1.15", "大"), Opt("1.3", "特大"))

private val dims = listOf(Opt("0", "最亮 0%"), Opt("20", "20%"), Opt("35", "标准 35%"), Opt("50", "50%"), Opt("65", "65%"), Opt("80", "最暗 80%"))
private fun wallOptions(vm: AppViewModel): List<Opt> =
    listOf(Opt("", "无壁纸"), Opt("__pick", "从手机相册选择图片…", "会缩小后保存在本应用里，不需要存储权限")) +
    (if (vm.hasLocalWallpaper) listOf(Opt("local", "我选的图片", "本机")) else emptyList()) +
    WALL_PRESETS.map { Opt("preset:" + it.id, it.label, "渐变") } +
    vm.wallItems.filter { it.kind == "image" }.map { Opt("server:" + it.name, it.name.substringBeforeLast('.'), "服务器壁纸库（只记住名字，不改服务器设置）") }
