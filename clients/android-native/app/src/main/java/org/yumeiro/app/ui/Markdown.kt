package org.yumeiro.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

sealed class Block {
    data class Para(val text: String) : Block()
    data class Heading(val level: Int, val text: String) : Block()
    data class Bullet(val marker: String, val text: String, val indent: Int) : Block()
    data class Quote(val text: String) : Block()
    data class Code(val lang: String, val code: String) : Block()
    object Rule : Block()
}

/** 很小的 Markdown 解析：标题、列表、引用、代码块、分隔线、段落。 */
fun parseBlocks(source: String): List<Block> {
    val out = mutableListOf<Block>(); val lines = source.replace("\r", "").split('\n')
    var i = 0; val para = StringBuilder()
    fun flush() { if (para.isNotEmpty()) { out.add(Block.Para(para.toString().trimEnd())); para.setLength(0) } }
    while (i < lines.size) {
        val line = lines[i]; val trimmed = line.trim()
        when {
            trimmed.startsWith("```") -> {
                flush(); val lang = trimmed.removePrefix("```").trim(); val code = StringBuilder(); i++
                while (i < lines.size && !lines[i].trim().startsWith("```")) { code.append(lines[i]).append('\n'); i++ }
                out.add(Block.Code(lang, code.toString().trimEnd('\n')))
            }
            trimmed.isEmpty() -> flush()
            Regex("^#{1,3}\\s+.*").matches(trimmed) -> { flush(); val n = trimmed.takeWhile { it == '#' }.length; out.add(Block.Heading(n, trimmed.drop(n).trim())) }
            Regex("^(-{3,}|\\*{3,}|_{3,})$").matches(trimmed) -> { flush(); out.add(Block.Rule) }
            trimmed.startsWith(">") -> { flush(); out.add(Block.Quote(trimmed.removePrefix(">").trim())) }
            Regex("^([-*+]|[0-9]+[.)])\\s+.*").matches(trimmed) -> {
                flush(); val marker = trimmed.takeWhile { !it.isWhitespace() }; val indent = (line.length - line.trimStart().length) / 2
                out.add(Block.Bullet(if (marker.first().isDigit()) marker else "•", trimmed.drop(marker.length).trim(), indent))
            }
            else -> { if (para.isNotEmpty()) para.append('\n'); para.append(line.trimEnd()) }
        }
        i++
    }
    flush(); return out
}

private val codeBg = Color(0x33000000)

/** 行内格式：**粗体**、*斜体*、`代码`、[链接](地址)。 */
fun inline(text: String, linkColor: Color, codeColor: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < text.length) {
        val c = text[i]
        fun closing(marker: String, from: Int): Int = text.indexOf(marker, from).takeIf { it > from } ?: -1
        when {
            text.startsWith("**", i) && closing("**", i + 2) > 0 -> { val e = closing("**", i + 2); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(inline(text.substring(i + 2, e), linkColor, codeColor)) }; i = e + 2 }
            c == '`' && closing("`", i + 1) > 0 -> { val e = closing("`", i + 1); withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, color = codeColor)) { append(text.substring(i + 1, e)) }; i = e + 1 }
            (c == '*' || c == '_') && i + 1 < text.length && !text[i + 1].isWhitespace() && closing(c.toString(), i + 1) > 0 && (i == 0 || !text[i - 1].isLetterOrDigit()) -> {
                val e = closing(c.toString(), i + 1); withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(text.substring(i + 1, e)) }; i = e + 1
            }
            c == '[' -> {
                val close = text.indexOf("](", i); val end = if (close > 0) text.indexOf(')', close) else -1
                if (close > 0 && end > 0) { withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(text.substring(i + 1, close)) }; i = end + 1 } else { append(c); i++ }
            }
            else -> { append(c); i++ }
        }
    }
}

@Composable
fun MarkdownText(source: String, modifier: Modifier = Modifier) {
    val blocks = remember(source) { parseBlocks(source) }
    val ink = MaterialTheme.colorScheme.onBackground; val link = Color(0xFF8AB4FF); val code = Color(0xFFFFB4BF)
    SelectionContainer {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (block in blocks) when (block) {
                is Block.Para -> Text(inline(block.text, link, code), color = ink, fontSize = 15.5.sp, lineHeight = 23.sp)
                is Block.Heading -> Text(inline(block.text, link, code), color = ink, fontSize = when (block.level) { 1 -> 21.sp; 2 -> 18.sp; else -> 16.5.sp }, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 4.dp))
                is Block.Bullet -> Row(Modifier.padding(start = (block.indent * 14).dp)) { Text(block.marker, color = Muted, fontSize = 15.5.sp, modifier = Modifier.padding(end = 8.dp)); Text(inline(block.text, link, code), color = ink, fontSize = 15.5.sp, lineHeight = 23.sp) }
                is Block.Quote -> Row(Modifier.fillMaxWidth()) { Text("▎", color = Accent, fontSize = 15.5.sp); Text(inline(block.text, link, code), color = Muted, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(start = 4.dp)) }
                is Block.Code -> CodeBlock(block)
                Block.Rule -> androidx.compose.material3.HorizontalDivider(color = Line)
            }
        }
    }
}

@Composable
private fun CodeBlock(block: Block.Code) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Color(0xCC080A10), RoundedCornerShape(12.dp)).border(1.dp, Line, RoundedCornerShape(12.dp))) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(block.lang.ifBlank { "代码" }, color = Muted, fontSize = 12.sp)
            TextButton(onClick = { clipboard.setText(AnnotatedString(block.code)); copied = true }) { Text(if (copied) "已复制" else "复制", fontSize = 12.sp, color = Muted) }
        }
        Text(block.code, color = Color(0xFFE6E8EF), fontFamily = FontFamily.Monospace, fontSize = 12.5.sp, lineHeight = 18.sp, modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp))
    }
}
