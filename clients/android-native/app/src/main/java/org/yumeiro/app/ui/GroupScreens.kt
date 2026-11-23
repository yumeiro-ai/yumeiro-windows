package org.yumeiro.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.yumeiro.app.AppViewModel
import org.yumeiro.app.GMember
import org.yumeiro.app.GROUP_MODES
import org.yumeiro.app.GroupItem
import org.yumeiro.app.Screen
import org.yumeiro.app.groupModeLabel
import org.yumeiro.app.hintFor
import org.yumeiro.app.safeName

private fun nameColor(label: String): Color {
    val hue = label.fold(7) { h, c -> (h * 31 + c.code) % 360 }.toFloat()
    return Color.hsv(hue, 0.5f, 0.85f)
}

// ───────────────────────────── 群聊列表 ─────────────────────────────
@Composable
fun GroupsScreen(vm: AppViewModel) {
    val g = vm.group
    var deleting by remember { mutableStateOf<GroupItem?>(null) }
    LaunchedEffect(Unit) { g.load() }
    BackHandler { vm.closeSettings() }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.closeSettings() }) { Icon(Icons.Default.ArrowBack, "返回", tint = Ink) }
            Text("群聊（多智能体）", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = { g.editing = null; vm.open(Screen.GroupEdit) }) { Text("新建") }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("把多个模型放进一个群，每个模型有自己的身份。选“产品经理带队”时，你只和产品经理说话，它会按各模型的擅长分配任务，再汇总答复你。", color = Muted, fontSize = 12.sp)
            if (g.groups.isEmpty()) Text("还没有群聊。点右上角“新建”。", color = Muted, fontSize = 13.sp)
            for (item in g.groups) Column(Modifier.fillMaxWidth().background(Glass, RoundedCornerShape(16.dp)).border(1.dp, Line, RoundedCornerShape(16.dp)).clickable { g.open(item.id) }.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("👥 " + item.title, color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(groupModeLabel(item.mode).substringBefore('（'), color = Accent, fontSize = 12.sp)
                }
                Text(item.members.joinToString("、") { it.label }.ifEmpty { "（没有成员）" }, color = Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Row { TextButton(onClick = { deleting = item }) { Text("删除", color = androidx.compose.material3.MaterialTheme.colorScheme.error) } }
            }
        }
    }
    deleting?.let { item ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除群聊") }, text = { Text("确定删除「${item.title}」和它的全部记录吗？") },
            confirmButton = { TextButton(onClick = { g.delete(item.id); deleting = null }) { Text("删除", color = androidx.compose.material3.MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } })
    }
}

// ───────────────────────────── 新建 / 编辑 ─────────────────────────────
@Composable
fun GroupEditScreen(vm: AppViewModel) {
    val g = vm.group; val editing = g.editing
    var title by remember { mutableStateOf(editing?.title ?: "") }
    var mode by remember { mutableStateOf(editing?.mode ?: "pm") }
    var rounds by remember { mutableStateOf((editing?.rounds ?: 4).toString()) }
    var pmLabel by remember { mutableStateOf(editing?.pmLabel ?: "产品经理") }
    var pmModel by remember { mutableStateOf(editing?.pmModel ?: "") }
    val members = remember { mutableStateListOf<GMember>().also { list ->
        if (editing != null) list.addAll(editing.members.map { GMember(it.label, it.model, it.role, it.strengths) })
        else { val all = g.allModelMembers(); if (all.isNotEmpty()) list.addAll(all) else { list.add(GMember("成员甲")); list.add(GMember("成员乙")) } }
    } }
    var picker by remember { mutableStateOf<GMember?>(null) }; var pickMode by remember { mutableStateOf(false) }; var pickPm by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }; var saving by remember { mutableStateOf(false) }
    val back = { vm.open(if (editing != null && g.current != null) Screen.GroupChat else Screen.Groups) }
    BackHandler { back() }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { back() }) { Icon(Icons.Default.ArrowBack, "返回", tint = Ink) }
            Text(if (editing == null) "新建群聊" else "群聊设置", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(enabled = !saving, onClick = {
                saving = true; error = ""
                g.save(editing?.id, title, mode, rounds.toIntOrNull() ?: 2, pmLabel, pmModel, members.toList()) { err -> saving = false; if (err != null) error = err }
            }) { Text(if (saving) "保存中…" else "保存") }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(title, { title = it }, label = { Text("群聊名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            PickRow("方式", groupModeLabel(mode).substringBefore('（')) { pickMode = true }
            if (mode == "pm") {
                Column(Modifier.fillMaxWidth().background(Glass, RoundedCornerShape(14.dp)).border(1.dp, Line, RoundedCornerShape(14.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("产品经理", color = Ink, fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(pmLabel, { pmLabel = it }, label = { Text("名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    PickRow("模型", vm.models.firstOrNull { it.ref == pmModel }?.label ?: "默认模型") { pickPm = true }
                    Text("建议选最强的推理模型。", color = Muted, fontSize = 11.sp)
                }
            }
            Text("成员（最多 12 位）：每个模型一个身份。产品经理会根据“擅长”把任务分给最合适的人；身份和擅长是按模型名给的默认建议，可以随意修改。", color = Muted, fontSize = 12.sp)
            for ((index, m) in members.withIndex()) Column(Modifier.fillMaxWidth().background(Glass, RoundedCornerShape(14.dp)).border(1.dp, Line, RoundedCornerShape(14.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(m.label, { m.label = it }, label = { Text("名称（不含空格）") }, singleLine = true, modifier = Modifier.weight(1f))
                    TextButton(onClick = { members.removeAt(index) }) { Text("移除", color = androidx.compose.material3.MaterialTheme.colorScheme.error) }
                }
                PickRow("模型", vm.models.firstOrNull { it.ref == m.model }?.label ?: "默认模型") { picker = m }
                OutlinedTextField(m.role, { m.role = it }, label = { Text("身份，如“后端工程师”") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(m.strengths, { m.strengths = it }, label = { Text("擅长，如“写代码、排错”") }, minLines = 1, maxLines = 3, modifier = Modifier.fillMaxWidth())
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { if (members.size < 12) members.add(GMember("成员" + (members.size + 1))) }) { Text("＋ 添加成员") }
                OutlinedButton(onClick = { members.addAll(g.allModelMembers(members.toList())) }) { Text("＋ 加入我能用的所有模型") }
            }
            OutlinedTextField(rounds, { rounds = it.filter { c -> c.isDigit() }.take(1) }, label = { Text(if (mode == "pm") "最多分配轮数（1–6）" else "讨论轮数（圆桌，1–4）") }, singleLine = true, modifier = Modifier.widthIn(max = 220.dp))
            if (error.isNotEmpty()) Text(error, color = androidx.compose.material3.MaterialTheme.colorScheme.error, fontSize = 13.sp)
            Spacer(Modifier.height(24.dp))
        }
    }
    val modelOpts = listOf(Opt("", "默认模型")) + vm.models.map { Opt(it.ref, it.label, it.provider) }
    if (pickMode) PickerDialog("群聊方式", GROUP_MODES.map { Opt(it.first, it.second) }, mode, { mode = it; if (it == "pm" && rounds == "2") rounds = "4" }, { pickMode = false })
    if (pickPm) PickerDialog("产品经理用的模型", modelOpts, pmModel, { pmModel = it }, { pickPm = false })
    picker?.let { m -> PickerDialog("成员的模型", modelOpts, m.model, { ref ->
        m.model = ref
        val info = vm.models.firstOrNull { it.ref == ref }
        if (info != null) { val h = hintFor(info.ref + " " + info.label); if (m.role.isBlank()) m.role = h.first; if (m.strengths.isBlank()) m.strengths = h.second; if (m.label.isBlank()) m.label = safeName(info.label) }
    }, { picker = null }) }
}

// ───────────────────────────── 群聊页 ─────────────────────────────
@Composable
fun GroupChatScreen(vm: AppViewModel) {
    val g = vm.group; val group = g.current
    var text by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    BackHandler { if (!g.busy) vm.open(Screen.Groups) else g.stop() }
    LaunchedEffect(g.messages.size, g.messages.lastOrNull()?.content?.length) { if (g.messages.isNotEmpty()) listState.scrollToItem(g.messages.lastIndex) }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { if (g.busy) g.stop(); vm.open(Screen.Groups) }) { Icon(Icons.Default.ArrowBack, "返回", tint = Ink) }
            Column(Modifier.weight(1f)) {
                Text(group?.title ?: "群聊", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text((group?.members?.joinToString("、") { it.label } ?: "") , color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(enabled = !g.busy && group != null, onClick = { g.editing = group; vm.open(Screen.GroupEdit) }) { Text("设置") }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (g.messages.isEmpty()) Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
                Text(if (group?.mode == "pm") "说出你的需求，产品经理会按每位成员的擅长分工。" else "发一条消息开始。用 @名称 可以点名某位成员。", color = Muted, fontSize = 14.sp)
            }
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), state = listState, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(g.messages, key = { it.key }) { m ->
                    if (m.role == "note") { Text(m.content, color = if (m.error) androidx.compose.material3.MaterialTheme.colorScheme.error else Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)); return@items }
                    val mine = m.role == "user"
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(m.label, color = if (mine) Muted else nameColor(m.label), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            if (m.task.isNotBlank()) Text("  任务：" + m.task, color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Box(Modifier.widthIn(max = 320.dp).background(if (mine) Accent.copy(alpha = 0.85f) else Glass, RoundedCornerShape(16.dp)).border(1.dp, Line, RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 8.dp)) {
                            androidx.compose.foundation.text.selection.SelectionContainer {
                                Text(if (m.content.isEmpty() && m.streaming) "…" else m.content, color = if (mine) Color.White else Ink, fontSize = 15.sp, lineHeight = 22.sp)
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(text, { text = it }, placeholder = { Text(if (group?.mode == "pm") "说出你的需求…" else "发消息，@名称 点名") }, modifier = Modifier.weight(1f), maxLines = 5, shape = RoundedCornerShape(18.dp))
            if (g.busy) Button(onClick = { g.stop() }, modifier = Modifier.height(52.dp)) { Text("停止") }
            else IconButton(onClick = { val t = text; text = ""; g.send(t) }, enabled = text.isNotBlank(), modifier = Modifier.height(52.dp)) { Icon(Icons.Default.Send, "发送", tint = if (text.isNotBlank()) Accent else Muted) }
        }
    }
}
