package org.yumeiro.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.yumeiro.app.AppViewModel

class Opt(val id: String, val label: String, val sub: String = "")

/** 选项弹窗：点一项就选中并关闭。长列表（模型、智能体、壁纸…）都用它，不再把一长串直接铺在页面上。 */
@Composable
fun PickerDialog(title: String, options: List<Opt>, selected: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            for (o in options) Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onPick(o.id); onDismiss() }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(o.id == selected, { onPick(o.id); onDismiss() })
                Column { Text(o.label, color = Ink, fontSize = 14.sp); if (o.sub.isNotBlank()) Text(o.sub, color = Muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

/** 设置页里的一行：左边名称，右边当前值，点击弹出选择。 */
@Composable
fun PickRow(label: String, value: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onClick() }.padding(vertical = 10.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Ink, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Text(value, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1.2f, fill = false).padding(start = 8.dp))
        Text("  ›", color = Muted, fontSize = 18.sp)
    }
}

private fun mostlyChinese(text: String): Boolean {
    val letters = text.count { it.isLetter() }
    if (letters == 0) return true
    return text.count { it in '\u4e00'..'\u9fff' }.toDouble() / letters >= 0.3
}

/** 说明弹窗：名称、简介、内容；英文内容可以一键翻译成中文（用服务器上的模型翻译）。 */
@Composable
fun InfoDialog(vm: AppViewModel, title: String, description: String, content: String, sub: String = "", onEdit: (() -> Unit)? = null, onDismiss: () -> Unit) {
    var zh by remember { mutableStateOf<Pair<String, String>?>(null) }; var showZh by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }; var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val needs = !mostlyChinese(description) || !mostlyChinese(content)
    val shownDesc = if (showZh) zh?.first ?: description else description
    val shownContent = if (showZh) zh?.second ?: content else content
    AlertDialog(onDismissRequest = onDismiss, title = { Column { Text(title, fontSize = 18.sp); if (sub.isNotBlank()) Text(sub, color = Muted, fontSize = 12.sp) } }, text = {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (shownDesc.isNotBlank()) Text(shownDesc, color = Ink, fontSize = 14.sp, lineHeight = 21.sp)
                if (shownContent.isNotBlank()) Text(shownContent, color = Ink, fontSize = 13.sp, lineHeight = 20.sp) else if (shownDesc.isBlank()) Text("（没有内容）", color = Muted)
            } }
            if (showZh) Text("由 AI 翻译，仅供参考。", color = Muted, fontSize = 11.sp)
            if (err.isNotEmpty()) Text(err, color = androidx.compose.material3.MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } }, dismissButton = {
        Row {
            if (needs) TextButton(enabled = !busy, onClick = {
                if (showZh) { showZh = false; return@TextButton }
                if (zh != null) { showZh = true; return@TextButton }
                busy = true; err = ""
                scope.launch {
                    try {
                        val d = if (description.isNotBlank() && !mostlyChinese(description)) vm.translate(description) else description
                        val c = if (content.isNotBlank() && !mostlyChinese(content)) vm.translate(content) else content
                        zh = d to c; showZh = true
                    } catch (e: Exception) { err = "翻译失败：" + (e.message ?: "") }
                    busy = false
                }
            }) { Text(if (busy) "翻译中…" else if (showZh) "显示原文" else "翻译成中文") }
            if (onEdit != null) TextButton(onClick = { onDismiss(); onEdit() }) { Text("编辑") }
        }
    })
}
