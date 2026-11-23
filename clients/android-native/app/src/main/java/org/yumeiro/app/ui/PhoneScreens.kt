package org.yumeiro.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.yumeiro.app.AppViewModel
import org.yumeiro.app.Screen
import org.yumeiro.app.data.ApiException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

// ───────────────────────────── 扫一扫 ─────────────────────────────
@Composable
fun ScanScreen(vm: AppViewModel) {
    val ctx = LocalContext.current; val phone = vm.phone
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { phone.scanNote = ""; if (!granted) ask.launch(Manifest.permission.CAMERA) }
    Page("扫一扫", { vm.open(Screen.Chat) }) {
        Text("扫电脑网页登录页上的二维码，在手机上确认后电脑就会登录；也能扫电脑上“发到手机”的二维码，直接接着聊或传文件。", color = Muted, fontSize = 13.sp)
        if (!granted) {
            Text("需要相机权限才能扫码。", color = Ink)
            Button(onClick = { ask.launch(Manifest.permission.CAMERA) }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("授权相机") }
        } else if (phone.qr == null) {
            Box(Modifier.fillMaxWidth().height(380.dp).clip(RoundedCornerShape(18.dp)).border(1.dp, Line, RoundedCornerShape(18.dp))) {
                CameraScanner { phone.handleScan(it) }
            }
        }
        if (phone.scanNote.isNotEmpty()) Text(phone.scanNote, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
    }
    phone.qr?.let { req ->
        AlertDialog(onDismissRequest = { phone.qr = null }, title = { Text("确认登录电脑？") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("有一台设备正在请求用你的账号登录网页：")
                Text("地址：" + req.ip.ifBlank { "未知" }, fontWeight = FontWeight.SemiBold)
                if (req.ua.isNotBlank()) Text(req.ua, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text("只有这台电脑是你自己正在操作、二维码是你刚在自己的屏幕上看到的，才点“确认登录”。别人发给你的二维码不要确认。", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            }
        }, confirmButton = { TextButton(onClick = { phone.decideQr(true) }) { Text("确认登录") } }, dismissButton = { TextButton(onClick = { phone.decideQr(false) }) { Text("拒绝") } })
    }
}

@Composable
private fun CameraScanner(onResult: (String) -> Unit) {
    val lifecycle = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val lastAt = remember { AtomicLong(0) }
    val reader = remember { MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) } }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }
    AndroidView(modifier = Modifier.fillMaxSize(), factory = { c ->
        val view = PreviewView(c)
        val future = ProcessCameraProvider.getInstance(c)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(executor) { image ->
                try {
                    val plane = image.planes[0]; val buf = plane.buffer; val data = ByteArray(buf.remaining()); buf.get(data)
                    val source = PlanarYUVLuminanceSource(data, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                    val text = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
                    val now = System.currentTimeMillis()
                    if (now - lastAt.get() > 2500) { lastAt.set(now); view.post { onResult(text) } }
                } catch (_: Exception) {
                } finally { reader.reset(); image.close() }
            }
            runCatching { provider.unbindAll(); provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis) }
        }, ContextCompat.getMainExecutor(c))
        view
    })
}

// ───────────────────────────── 传文件到电脑 ─────────────────────────────
@Composable
fun TransferScreen(vm: AppViewModel) {
    val phone = vm.phone; var picker by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) phone.upload(phone.targetWorkspace, uris) }
    LaunchedEffect(Unit) { vm.loadWorkspaces() }
    val ws = vm.workspaces.firstOrNull { it.id == phone.targetWorkspace }
    Page("传文件到电脑", { vm.open(Screen.Chat) }) {
        Text("把手机里的照片、文件传到工作区，电脑上打开这个工作区的“文件”就能看到（在“手机上传”文件夹里），也可以让智能体直接读取。", color = Muted, fontSize = 13.sp)
        Card("传到哪个工作区") {
            PickRow("工作区", ws?.name ?: if (vm.workspaces.isEmpty()) "还没有工作区（先在电脑上建一个）" else "点这里选择") { if (vm.workspaces.isNotEmpty()) picker = true }
        }
        Button(onClick = { pick.launch("image/*") }, enabled = phone.targetWorkspace.isNotBlank(), modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("选择照片 / 图片") }
        OutlinedButton(onClick = { pick.launch("*/*") }, enabled = phone.targetWorkspace.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("选择文件（任意类型）") }
        for (t in phone.transfers) Item {
            Text(t.name, color = Ink, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!t.ok && !t.failed) LinearProgressIndicator(progress = { t.pct / 100f }, modifier = Modifier.fillMaxWidth())
            Text(t.message, color = if (t.failed) MaterialTheme.colorScheme.error else Muted, fontSize = 12.sp)
        }
    }
    if (picker) PickerDialog("选择工作区", vm.workspaces.map { Opt(it.id, it.name, it.owner) }, phone.targetWorkspace, { phone.targetWorkspace = it }, { picker = false })
}

// ───────────────────────────── 远程操控电脑 ─────────────────────────────
@Composable
fun RemoteListScreen(vm: AppViewModel) {
    val phone = vm.phone
    LaunchedEffect(Unit) { while (true) { phone.loadDevices(); delay(8000) } }
    Page("远程操控电脑", { vm.open(Screen.Chat) }) {
        Text("控制你自己已经配对的电脑。第一次要在电脑网页的“远程控制”里生成配对码，并在被控的电脑上运行被控端；这里只负责查看画面和操作。", color = Muted, fontSize = 13.sp)
        if (phone.devicesLoaded && phone.devices.isEmpty()) Text("还没有配对的电脑。", color = Ink)
        for (d in phone.devices) Item(Modifier.clickable { phone.device = d; vm.open(Screen.RemoteView) }) {
            Text(d.name.ifBlank { "未命名的电脑" }, color = Ink, fontWeight = FontWeight.SemiBold)
            Text(d.osLabel + " · " + (if (d.online) "在线" else "离线") + " · " + (if (d.control) "可操作" else "仅查看"), color = if (d.online) Muted else MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
    }
}

private fun android.content.Context.findActivity(): android.app.Activity? { var c = this; while (c is android.content.ContextWrapper) { if (c is android.app.Activity) return c; c = c.baseContext }; return null }

@Composable
private fun KeyChip(label: String, selected: Boolean = false, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(if (selected) Accent else Soft).border(1.dp, if (selected) Accent else Line, RoundedCornerShape(10.dp)).clickable { onClick() }.padding(horizontal = 10.dp, vertical = 8.dp), Alignment.Center) {
        Text(label, color = if (selected) Color.White else Ink, fontSize = 12.5.sp, maxLines = 1)
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun KeysPanel(phone: org.yumeiro.app.PhoneState, mac: Boolean, mods: Set<String>, onMods: (Set<String>) -> Unit, key: (String, List<String>) -> Unit, scroll: (Int) -> Unit, sendText: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val primary = if (mac) "meta" else "ctrl"
    @Composable fun group(title: String, content: @Composable () -> Unit) {
        Text(title, color = Muted, fontSize = 11.5.sp, modifier = Modifier.padding(top = 6.dp))
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        group("修饰键（先点它，再点下面的键或快捷键）") {
            for ((label, m) in listOf("Ctrl" to "ctrl", "Alt" to "alt", "Shift" to "shift", (if (mac) "Cmd" else "Win") to "meta")) KeyChip(label, m in mods) { onMods(if (m in mods) mods - m else mods + m) }
        }
        group("常用快捷键") {
            for ((label, k, m) in listOf(
                Triple("复制", "c", listOf(primary)), Triple("粘贴", "v", listOf(primary)), Triple("剪切", "x", listOf(primary)), Triple("全选", "a", listOf(primary)),
                Triple("撤销", "z", listOf(primary)), Triple("保存", "s", listOf(primary)), Triple("查找", "f", listOf(primary)), Triple("新标签", "t", listOf(primary)), Triple("关标签", "w", listOf(primary)),
                Triple("刷新", "f5", emptyList()), Triple("切换窗口", "tab", listOf(if (mac) "meta" else "alt")), Triple("关闭窗口", if (mac) "q" else "f4", listOf(if (mac) "meta" else "alt")),
            ) + (if (mac) listOf(Triple("聚焦搜索", "space", listOf("meta"))) else listOf(Triple("显示桌面", "d", listOf("meta")), Triple("任务视图", "tab", listOf("meta")), Triple("截图", "s", listOf("meta", "shift")), Triple("锁屏", "l", listOf("meta")), Triple("开始菜单", "meta", emptyList()))))
                KeyChip(label) { key(k, m) }
        }
        group("按键") {
            for ((label, k) in listOf("Enter" to "enter", "Esc" to "escape", "Tab" to "tab", "退格" to "backspace", "删除" to "delete", "空格" to "space", "←" to "left", "↑" to "up", "↓" to "down", "→" to "right", "Home" to "home", "End" to "end", "PgUp" to "pageup", "PgDn" to "pagedown"))
                KeyChip(label) { key(k, emptyList()) }
            for (n in 1..12) KeyChip("F$n") { key("f$n", emptyList()) }
        }
        group("滚动") { KeyChip("↑ 上滚") { scroll(-5) }; KeyChip("↓ 下滚") { scroll(5) } }
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(text, { text = it.take(200) }, label = { Text("要输入到电脑的文字") }, singleLine = true, modifier = Modifier.weight(1f))
            Button(enabled = text.isNotEmpty(), onClick = { sendText(text); text = "" }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("发送") }
        }
    }
}

@Composable
fun RemoteViewScreen(vm: AppViewModel) {
    val phone = vm.phone; val dev = phone.device
    if (dev == null) { vm.open(Screen.Remote); return }
    val ctx = LocalContext.current; val activity = remember { ctx.findActivity() }
    val land = androidx.compose.ui.platform.LocalConfiguration.current.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }; var status by remember { mutableStateOf("正在连接…") }; var canControl by remember { mutableStateOf(dev.control) }
    var mods by remember { mutableStateOf(setOf<String>()) }
    var quality by remember { mutableStateOf("auto") }; var profile by remember { mutableStateOf("") }
    val mac = dev.osLabel.contains("mac", ignoreCase = true)
    fun back() { phone.stopRemote(); phone.device = null; vm.open(Screen.Remote) }
    BackHandler { back() }
    // 离开这个页面时恢复成跟随系统的方向
    DisposableEffect(Unit) { onDispose { activity?.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED } }
    LaunchedEffect(dev.id) {
        var seq = 0L; var lastDl = 0L
        while (isActive) {
            try {
                val f = withContext(Dispatchers.IO) { vm.api.remoteFrame(dev.id, seq, lastDl) }
                canControl = f.control; quality = f.mode; profile = f.profile
                if (f.dlMs > 0) lastDl = f.dlMs
                if (f.bytes != null) {
                    seq = f.seq; val bmp = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(f.bytes, 0, f.bytes.size) }
                    if (bmp != null) { frame = bmp.asImageBitmap(); status = "" }
                } else status = if (!f.online) "这台电脑现在离线" else if (frame == null) "等待画面…" else status
            } catch (e: ApiException) {
                if (e.status == 401) { vm.expiredPublic(); return@LaunchedEffect }
                status = e.message ?: "读取失败"; delay(2500)
            } catch (e: Exception) { status = e.message ?: "读取失败"; delay(2500) }
        }
    }
    fun click(x: Float, y: Float, button: String, count: Int) = phone.sendInput(listOf(JSONObject().put("type", "click").put("x", x.toDouble()).put("y", y.toDouble()).put("button", button).put("count", count)))
    val sendKey: (String, List<String>) -> Unit = { k, extra ->
        val all = (mods + extra).distinct()
        phone.sendInput(listOf(JSONObject().put("type", "key").put("key", k).put("action", "press").put("mods", org.json.JSONArray(all)))); mods = emptySet()
    }
    val scroll: (Int) -> Unit = { dy -> phone.sendInput(listOf(JSONObject().put("type", "wheel").put("dy", dy))) }
    val sendText: (String) -> Unit = { t -> phone.sendInput(listOf(JSONObject().put("type", "text").put("text", t))) }
    val rotate = { activity?.requestedOrientation = if (land) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE; Unit }

    @Composable fun screenImage(maxW: androidx.compose.ui.unit.Dp, maxH: androidx.compose.ui.unit.Dp) {
        val img = frame
        if (img == null) { Box(Modifier.fillMaxWidth().height(160.dp), Alignment.Center) { Text(status, color = Muted) }; return }
        val ratio = img.width.toFloat() / img.height.toFloat()
        val w = minOf(maxW, maxH * ratio); val h = w / ratio
        Image(img, "电脑画面", Modifier.width(w).height(h).clip(RoundedCornerShape(8.dp)).border(1.dp, Line, RoundedCornerShape(8.dp))
            .pointerInput(canControl) {
                if (canControl) detectTapGestures(
                    onTap = { o -> click(o.x / size.width, o.y / size.height, "left", 1) },
                    onDoubleTap = { o -> click(o.x / size.width, o.y / size.height, "left", 2) },
                    onLongPress = { o -> click(o.x / size.width, o.y / size.height, "right", 1) })
            }, contentScale = ContentScale.FillBounds)
    }
    @Composable fun header() {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { back() }) { Text("← 返回", color = Ink) }
            Text(dev.name.ifBlank { "电脑" }, color = Ink, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            TextButton(onClick = { rotate() }) { Text(if (land) "竖屏" else "横屏", color = Accent) }
            Text(if (canControl) "可操作" else "仅查看", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(end = 8.dp))
        }
    }
    @Composable fun qualityBar() {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("画质", color = Muted, fontSize = 12.sp)
            for ((label, m) in listOf("自动" to "auto", "清晰优先" to "high", "流畅优先" to "smooth")) KeyChip(label, quality == m) { quality = m; phone.setQuality(m) }
        }
        val p = profile.split('|')
        if (p.size == 3) Text("当前：" + p[0] + " 像素宽 · 压缩 " + p[1] + " · 最高 " + p[2] + " 帧/秒" + (if (quality == "auto") "（卡了会自动降，稳定后自动升）" else ""), color = Muted, fontSize = 11.sp)
    }
    val hint = if (canControl) "点一下 = 单击；快速点两下 = 双击；长按 = 右键。" else "这台电脑是“仅查看”：想操作，请在电脑网页的“远程控制”里开启控制，并用 --allow-control 启动被控端。"
    if (land) {
        Row(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 8.dp)) {
            androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f).fillMaxSize(), Alignment.Center) { screenImage(maxWidth, maxHeight) }
            Column(Modifier.width(250.dp).fillMaxSize().padding(start = 8.dp).verticalScroll(rememberScrollState())) {
                header(); qualityBar(); Text(hint, color = Muted, fontSize = 11.5.sp)
                if (canControl) KeysPanel(phone, mac, mods, { mods = it }, sendKey, scroll, sendText)
            }
        }
    } else {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 10.dp)) {
            header()
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                qualityBar()
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth(), Alignment.TopCenter) { screenImage(maxWidth, 2000.dp) }
                if (frame != null && status.isNotEmpty()) Text(status, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                Text(hint, color = Muted, fontSize = 12.sp)
                if (canControl) KeysPanel(phone, mac, mods, { mods = it }, sendKey, scroll, sendText)
            }
        }
    }
}

// ───────────────────────────── 设置页里的“手机联动” ─────────────────────────────
@Composable
fun PhoneLinkCard(vm: AppViewModel) {
    val ctx = LocalContext.current; val phone = vm.phone
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> if (ok) phone.setNotify(true) else vm.say("没有通知权限，收不到提醒。可以在系统设置里给 Yumeiro 打开通知。") }
    Card("手机联动", "和电脑上的 Yumeiro 配合用。") {
        for ((label, hint, target) in listOf(Triple("扫一扫", "扫电脑上的登录二维码、“发到手机”的二维码", Screen.Scan), Triple("传文件到电脑", "照片、文件传到工作区", Screen.Transfer), Triple("远程操控电脑", "在手机上看电脑画面并操作", Screen.Remote)))
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { vm.open(target) }.padding(vertical = 10.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(label, color = Ink, fontSize = 15.sp); Text(hint, color = Muted, fontSize = 12.sp) }; Text("›", color = Muted, fontSize = 20.sp)
            }
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text("任务完成时通知我", color = Ink, fontSize = 14.sp); Text("协作任务完成或失败时，手机通知栏提醒。会在后台保持连接，通知栏有一条常驻提示。", color = Muted, fontSize = 12.sp) }
            Switch(phone.notifyOn, { on ->
                if (!on) phone.setNotify(false)
                else if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
                else phone.setNotify(true)
            })
        }
    }
}
