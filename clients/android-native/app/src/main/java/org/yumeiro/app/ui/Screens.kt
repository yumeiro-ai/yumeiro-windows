package org.yumeiro.app.ui

import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DismissibleDrawerSheet
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.yumeiro.app.AppViewModel
import org.yumeiro.app.AttRef
import org.yumeiro.app.Conv
import org.yumeiro.app.Msg
import org.yumeiro.app.Pending
import org.yumeiro.app.Screen

@Composable
fun AppRoot(vm: AppViewModel) {
    val base = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(base.density, vm.fontScale)) {
    YumeiroTheme {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Bg1, Bg2, Bg3)))) {
            val wp = Pal.wallpaper; val grad = Pal.gradient
            if (wp != null) Image(wp, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            else if (grad != null) Box(Modifier.fillMaxSize().background(Brush.linearGradient(grad)))
            if (wp != null || grad != null) { val alpha = (0.15f + Pal.dim.coerceIn(0, 80) / 100f * 0.75f).coerceIn(0f, 0.9f); Box(Modifier.fillMaxSize().background((if (Pal.dark) Color.Black else Color.White).copy(alpha = alpha))) }
            when (vm.screen) {
                Screen.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { Text("正在连接…", color = Muted) }
                Screen.Login -> LoginScreen(vm)
                Screen.Chat -> ChatScreen(vm)
                Screen.Settings -> SettingsScreen(vm)
                Screen.Agents -> AgentsScreen(vm)
                Screen.Skills -> SkillsScreen(vm)
                Screen.Market -> MarketScreen(vm)
                Screen.Admin -> AdminScreen(vm)
                Screen.Security -> SecurityScreen(vm)
                Screen.Groups -> GroupsScreen(vm)
                Screen.GroupChat -> GroupChatScreen(vm)
                Screen.GroupEdit -> GroupEditScreen(vm)
                Screen.Scan -> ScanScreen(vm)
                Screen.Transfer -> TransferScreen(vm)
                Screen.Remote -> RemoteListScreen(vm)
                Screen.RemoteView -> RemoteViewScreen(vm)
            }
            if (vm.toast.isNotEmpty()) {
                LaunchedEffect(vm.toast) { kotlinx.coroutines.delay(3200); vm.toast = "" }
                Box(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 96.dp, start = 24.dp, end = 24.dp)
                    .background(ToastBg, RoundedCornerShape(14.dp)).border(1.dp, Line, RoundedCornerShape(14.dp)).padding(horizontal = 16.dp, vertical = 10.dp)) { Text(vm.toast, color = Ink, fontSize = 14.sp) }
            }
        }
    }
    }
}

// ───────────────────────────── 登录 ─────────────────────────────
@Composable
fun LoginScreen(vm: AppViewModel) {
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(20.dp)).background(Brush.linearGradient(listOf(Accent, Color(0xFFB63A8C)))), Alignment.Center) { Text("Y", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold) }
        Spacer(Modifier.height(14.dp))
        Text("Yumeiro", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Ink)
        Text("登录你的私有工作空间", color = Muted, fontSize = 14.sp)
        Spacer(Modifier.height(24.dp))
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().background(Glass, RoundedCornerShape(20.dp)).border(1.dp, Line, RoundedCornerShape(20.dp)).padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(vm.serverInput, { vm.serverInput = it }, label = { Text("服务器地址") }, placeholder = { Text("https://你的域名") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(vm.emailInput, { vm.emailInput = it }, label = { Text("邮箱") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            OutlinedTextField(vm.passwordInput, { vm.passwordInput = it }, label = { Text("密码") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            Row(Modifier.fillMaxWidth().clickable { vm.ignoreCertInput = !vm.ignoreCertInput }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(vm.ignoreCertInput, { vm.ignoreCertInput = it }); Column { Text("忽略证书错误", color = Ink, fontSize = 14.sp); Text("服务器用自签名证书时才勾选", color = Muted, fontSize = 12.sp) }
            }
            if (vm.loginError.isNotEmpty()) Text(vm.loginError, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            Button(onClick = { vm.login() }, enabled = !vm.loginBusy, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(14.dp), colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text(if (vm.loginBusy) "登录中…" else "登录", fontSize = 16.sp) }
        }
        Spacer(Modifier.height(14.dp))
        Text("账号由团队管理员创建。管理员请用网页版的 /admin 入口登录管理后台。", color = Muted, fontSize = 12.sp, modifier = Modifier.widthIn(max = 440.dp))
    }
}

// ───────────────────────────── 主界面 ─────────────────────────────
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: AppViewModel) {
    val drawer = rememberDrawerState(DrawerValue.Closed); val scope = rememberCoroutineScope()
    var deleting by remember { mutableStateOf<Conv?>(null) }
    ModalNavigationDrawer(drawerState = drawer, drawerContent = {
        ModalDrawerSheet(drawerContainerColor = DrawerBg, modifier = Modifier.widthIn(max = 320.dp)) {
            Sidebar(vm, onPick = { id -> scope.launch { drawer.close() }; vm.openConv(id) }, onNew = { scope.launch { drawer.close() }; vm.newChat() }, onDelete = { deleting = it },
                onSettings = { scope.launch { drawer.close() }; vm.openSettings() }, onNavigate = { t -> scope.launch { drawer.close() }; vm.open(t) })
        }
    }) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            TopBar(vm, onMenu = { scope.launch { drawer.open() } })
            Box(Modifier.weight(1f).fillMaxWidth()) { MessageList(vm) }
            Composer(vm)
        }
    }
    deleting?.let { conv ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除对话") }, text = { Text("确定删除「${conv.title}」吗？删不回来。") },
            confirmButton = { TextButton(onClick = { vm.deleteConv(conv.id); deleting = null }) { Text("删除", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } })
    }
}

@Composable
private fun Sidebar(vm: AppViewModel, onPick: (String) -> Unit, onNew: () -> Unit, onDelete: (Conv) -> Unit, onSettings: () -> Unit, onNavigate: (Screen) -> Unit) {
    Column(Modifier.fillMaxHeight().statusBarsPadding().padding(12.dp)) {
        Button(onClick = onNew, modifier = Modifier.fillMaxWidth().height(46.dp), shape = RoundedCornerShape(14.dp), colors = ButtonDefaults.buttonColors(containerColor = Soft, contentColor = Ink)) { Icon(Icons.Default.Add, null); Spacer(Modifier.size(8.dp)); Text("新建对话") }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((label, target) in listOf("扫一扫" to Screen.Scan, "传文件" to Screen.Transfer, "远程" to Screen.Remote))
                Box(Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(Soft).clickable { onNavigate(target) }.padding(vertical = 9.dp), Alignment.Center) { Text(label, color = Ink, fontSize = 13.sp) }
        }
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.weight(1f)) {
            for ((label, list) in vm.grouped()) {
                item(key = "g$label") { Text(label, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp, top = 12.dp, bottom = 4.dp)) }
                items(list, key = { it.id }) { conv ->
                    val active = conv.id == vm.currentId
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (active) Soft else Color.Transparent).clickable { onPick(conv.id) }.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(conv.title, color = Ink, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        IconButton(onClick = { onDelete(conv) }, modifier = Modifier.size(36.dp)) { Icon(Icons.Default.Delete, "删除", tint = Muted, modifier = Modifier.size(18.dp)) }
                    }
                }
            }
            if (vm.convs.isEmpty()) item { Text("还没有对话", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(12.dp)) }
        }
        HorizontalDivider(color = Line)
        Row(Modifier.fillMaxWidth().clickable { onSettings() }.padding(vertical = 10.dp, horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(CircleShape).background(Accent), Alignment.Center) { Text((vm.me.optString("email").ifEmpty { "U" }).take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold) }
            Column(Modifier.weight(1f).padding(start = 10.dp)) { Text(vm.me.optString("displayName").ifBlank { vm.me.optString("email") }, color = Ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(vm.usage.ifEmpty { vm.session.server.removePrefix("https://").removePrefix("http://") }, color = Muted, fontSize = 12.sp, maxLines = 1) }
            Icon(Icons.Default.Settings, "设置", tint = Muted)
        }
    }
}

@Composable
private fun TopBar(vm: AppViewModel, onMenu: () -> Unit) {
    var menu by remember { mutableStateOf(false) }; var renaming by remember { mutableStateOf(false) }; var draft by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onMenu) { Icon(Icons.Default.Menu, "对话列表", tint = Ink) }
        Text(vm.title, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (vm.currentId != null) Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "更多", tint = Ink) }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem({ Text("重命名") }, { menu = false; draft = vm.title; renaming = true })
                DropdownMenuItem({ Text("复制整段对话") }, { menu = false; clipboard.setText(AnnotatedString(vm.transcript())); vm.say("已复制整段对话") })
                DropdownMenuItem({ Text("删除对话", color = MaterialTheme.colorScheme.error) }, { menu = false; vm.currentId?.let { vm.deleteConv(it) } })
            }
        }
        IconButton(onClick = { vm.newChat() }) { Icon(Icons.Default.Add, "新对话", tint = Ink) }
    }
    if (renaming) AlertDialog(onDismissRequest = { renaming = false }, title = { Text("重命名对话") },
        text = { OutlinedTextField(draft, { draft = it }, singleLine = true) },
        confirmButton = { TextButton(onClick = { vm.renameConv(draft); renaming = false }) { Text("确定") } },
        dismissButton = { TextButton(onClick = { renaming = false }) { Text("取消") } })
}

@Composable
private fun MessageList(vm: AppViewModel) {
    val state = rememberLazyListState()
    val last = vm.messages.lastOrNull()
    LaunchedEffect(vm.messages.size, last?.content?.length) { if (vm.messages.isNotEmpty()) state.animateScrollToItem(vm.messages.lastIndex) }
    if (vm.messages.isEmpty()) {
        Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text("今天想聊点什么？", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("可以直接提问，也可以点下面的回形针发图片或文件让我读。", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
        }
        return
    }
    LazyColumn(state = state, modifier = Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(vm.messages, key = { it.key }) { m -> MessageItem(vm, m, streaming = vm.busy && m === last) }
    }
}

@Composable
private fun MessageItem(vm: AppViewModel, m: Msg, streaming: Boolean) {
    if (m.role == "user") {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            Column(Modifier.widthIn(max = 320.dp).background(Bubble, RoundedCornerShape(18.dp)).border(1.dp, Line, RoundedCornerShape(18.dp)).padding(horizontal = 14.dp, vertical = 10.dp)) {
                Text(m.content, color = Ink, fontSize = 15.5.sp, lineHeight = 22.sp)
                if (m.atts.isNotEmpty()) Attachments(vm, m.atts)
            }
        }
    } else {
        Column(Modifier.fillMaxWidth()) {
            if (m.error) Text(m.content, color = MaterialTheme.colorScheme.error, fontSize = 15.sp)
            else if (m.content.isEmpty() && streaming) Text("正在思考…", color = Muted, fontSize = 14.sp)
            else MarkdownText(m.content)
        }
    }
}

@Composable
private fun Attachments(vm: AppViewModel, list: List<AttRef>) {
    var viewing by remember { mutableStateOf<AttRef?>(null) }
    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (att in list) {
            if (att.image) {
                val bitmap by produceState<Bitmap?>(att.thumb, att.id) { if (value == null && att.id != null) value = vm.loadAttachmentImage(att.id) }
                bitmap?.let { Image(it.asImageBitmap(), att.name, Modifier.size(84.dp).clip(RoundedCornerShape(10.dp)).clickable { viewing = att }, contentScale = ContentScale.Crop) }
                    ?: Box(Modifier.size(84.dp).clip(RoundedCornerShape(10.dp)).background(Soft))
            } else FileTag(att.name, Modifier.clickable { viewing = att })
        }
    }
    viewing?.let { att -> AttachmentViewer(vm, att) { viewing = null } }
}

@Composable
private fun FileTag(name: String, modifier: Modifier = Modifier) {
    val ext = name.substringAfterLast('.', "file").take(5).uppercase()
    Row(modifier.widthIn(max = 220.dp).border(1.dp, Line, RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(ext, fontSize = 10.sp, fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.background(Soft2, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
        Text(name, color = Ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun AttachmentViewer(vm: AppViewModel, att: AttRef, onClose: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    if (att.image) {
        val bitmap by produceState<Bitmap?>(att.thumb, att.id) { if (value == null && att.id != null) value = vm.loadAttachmentImage(att.id) }
        AlertDialog(onDismissRequest = onClose, confirmButton = { TextButton(onClick = onClose) { Text("关闭") } }, text = { bitmap?.let { Image(it.asImageBitmap(), att.name, Modifier.fillMaxWidth(), contentScale = ContentScale.Fit) } ?: Text("读取中…") })
    } else {
        val text by produceState("正在读取…", att.id) { value = att.id?.let { vm.loadAttachmentText(it) } ?: "没有内容" }
        AlertDialog(onDismissRequest = onClose, title = { Text(att.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 16.sp) },
            text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) { androidx.compose.foundation.text.selection.SelectionContainer { Text(text, fontSize = 13.sp, lineHeight = 19.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace) } } },
            confirmButton = { TextButton(onClick = onClose) { Text("关闭") } }, dismissButton = { TextButton(onClick = { clipboard.setText(AnnotatedString(text)); vm.say("已复制") }) { Text("复制") } })
    }
}


@Composable
private fun Composer(vm: AppViewModel) {
    var text by remember { mutableStateOf("") }; var modelMenu by remember { mutableStateOf(false) }; var attachMenu by remember { mutableStateOf(false) }
    val pickImages = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> vm.addUris(uris) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> vm.addUris(uris) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp).background(Glass, RoundedCornerShape(24.dp)).border(1.dp, Soft2, RoundedCornerShape(24.dp)).padding(10.dp)) {
        if (vm.pending.isNotEmpty()) LazyRow(Modifier.padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(vm.pending.toList()) { PendingChip(vm, it) } }
        OutlinedTextField(text, { text = it }, placeholder = { Text("给 Yumeiro 发消息…", color = Muted) }, modifier = Modifier.fillMaxWidth(), maxLines = 6,
            colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box {
                IconButton(onClick = { attachMenu = true }) { Icon(PaperclipIcon, "添加图片或文件", tint = Ink, modifier = Modifier.size(22.dp)) }
                DropdownMenu(attachMenu, { attachMenu = false }) {
                    DropdownMenuItem({ Text("图片（相册 / 拍照）") }, { attachMenu = false; pickImages.launch("image/*") })
                    DropdownMenuItem({ Text("文件（PDF、Word、Excel、文本…）") }, { attachMenu = false; pickFiles.launch("*/*") })
                }
            }
            Box(Modifier.weight(1f)) {
                val label = vm.models.firstOrNull { it.ref == vm.selectedModel }?.label ?: "选择模型"
                Row(Modifier.clip(RoundedCornerShape(14.dp)).clickable { modelMenu = true }.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)); Icon(Icons.Default.KeyboardArrowDown, null, tint = Muted, modifier = Modifier.size(18.dp))
                }
                if (modelMenu) PickerDialog("选择模型", vm.models.map { Opt(it.ref, it.label, it.provider) }, vm.selectedModel, { vm.chooseModel(it) }, { modelMenu = false })
            }
            if (vm.busy) IconButton(onClick = { vm.stop() }, modifier = Modifier.size(42.dp).background(Soft2, CircleShape)) { Box(Modifier.size(14.dp).background(Ink, RoundedCornerShape(3.dp))) }
            else IconButton(onClick = { vm.send(text); if (text.isNotBlank() || vm.pending.any { it.done }) text = "" }, modifier = Modifier.size(42.dp).background(Accent, CircleShape)) { Icon(Icons.Default.Send, "发送", tint = Color.White, modifier = Modifier.size(20.dp)) }
        }
    }
}

@Composable
private fun PendingChip(vm: AppViewModel, item: Pending) {
    Box(Modifier.height(60.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, Soft2, RoundedCornerShape(12.dp)).background(Soft)) {
        Row(Modifier.padding(end = 26.dp), verticalAlignment = Alignment.CenterVertically) {
            if (item.image && item.thumb != null) Image(item.thumb.asImageBitmap(), item.name, Modifier.size(60.dp), contentScale = ContentScale.Crop, alpha = if (item.done) 1f else 0.6f)
            else Row(Modifier.padding(start = 8.dp).widthIn(max = 170.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(item.name.substringAfterLast('.', "file").take(5).uppercase(), fontSize = 10.sp, fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.background(Soft2, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
                Text(item.name, color = Ink, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp))
            }
            if (item.image) Spacer(Modifier.size(2.dp))
        }
        if (!item.done) {
            Text(if (item.processing) "解析中…" else "${item.pct}%", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.Center))
            if (item.processing) LinearProgressIndicator(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp), color = Accent)
            else LinearProgressIndicator(progress = { item.pct / 100f }, modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp), color = Accent)
        }
        IconButton(onClick = { vm.removePending(item) }, modifier = Modifier.align(Alignment.TopEnd).size(26.dp)) { Icon(Icons.Default.Close, if (item.done) "移除" else "取消上传", tint = Color.White, modifier = Modifier.size(15.dp).background(Color(0x99000000), CircleShape).padding(2.dp)) }
    }
}

