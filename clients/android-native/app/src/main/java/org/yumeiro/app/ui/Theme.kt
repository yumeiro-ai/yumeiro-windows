package org.yumeiro.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.unit.dp

val Accent = Color(0xFFE95164)

/** 当前是否深色（由主题设置决定），下面这些颜色都跟着它变；wallpaper 是选中的壁纸。 */
object Pal { var dark by mutableStateOf(true); var wallpaper by mutableStateOf<ImageBitmap?>(null); var gradient by mutableStateOf<List<Color>?>(null); var dim by mutableStateOf(35) }
class WallPreset(val id: String, val label: String, val colors: List<Color>)
/** 和网页版同一份预设渐变 */
val WALL_PRESETS = listOf(
    WallPreset("aurora", "极光", listOf(Color(0xFF1D2B64), Color(0xFFF8CDDA))), WallPreset("dusk", "黄昏", listOf(Color(0xFF355C7D), Color(0xFF6C5B7B), Color(0xFFC06C84))),
    WallPreset("mint", "薄荷", listOf(Color(0xFFA8EDEA), Color(0xFFFED6E3))), WallPreset("ocean", "海湾", listOf(Color(0xFF2193B0), Color(0xFF6DD5ED))),
    WallPreset("sunrise", "日出", listOf(Color(0xFFFF9A9E), Color(0xFFFECFEF))), WallPreset("forest", "森林", listOf(Color(0xFF134E5E), Color(0xFF71B280))),
    WallPreset("night", "夜空", listOf(Color(0xFF0F2027), Color(0xFF203A43), Color(0xFF2C5364))), WallPreset("sand", "沙丘", listOf(Color(0xFFF6D365), Color(0xFFFDA085)))
)
val Ink: Color get() = if (Pal.dark) Color(0xFFE8E9EE) else Color(0xFF22252E)
val Muted: Color get() = if (Pal.dark) Color(0xFF9DA3B5) else Color(0xFF6B7080)
val Glass: Color get() = if (Pal.dark) Color(0xA3141824) else Color(0xB8FFFFFF)
val Line: Color get() = if (Pal.dark) Color(0x1AFFFFFF) else Color(0x1F000000)
val Soft: Color get() = if (Pal.dark) Color(0x1FFFFFFF) else Color(0x14000000)
val Soft2: Color get() = if (Pal.dark) Color(0x33FFFFFF) else Color(0x26000000)
val DrawerBg: Color get() = if (Pal.dark) Color(0xF20E1017) else Color(0xF5F4F5F8)
val ToastBg: Color get() = if (Pal.dark) Color(0xEE222633) else Color(0xEEFFFFFF)
val Bubble: Color get() = if (Pal.dark) Color(0xB8464A62) else Color(0xFFE3E6F3)
val Bg1: Color get() = if (Pal.dark) Color(0xFF151827) else Color(0xFFF4F5FA)
val Bg2: Color get() = if (Pal.dark) Color(0xFF0F1117) else Color(0xFFEDEEF4)
val Bg3: Color get() = if (Pal.dark) Color(0xFF12131A) else Color(0xFFF7F7FA)
val Surface0 = Color(0xFF0F1117)

private val dark = darkColorScheme(
    primary = Accent, onPrimary = Color.White, background = Surface0, onBackground = Ink,
    surface = Color(0xFF171A23), onSurface = Ink, surfaceVariant = Color(0xFF212531), onSurfaceVariant = Muted,
    outline = Color(0x33FFFFFF), error = Color(0xFFFF8A98)
)
private val light = lightColorScheme(
    primary = Accent, onPrimary = Color.White, background = Color(0xFFF7F7F9), onBackground = Color(0xFF252832),
    surface = Color.White, onSurface = Color(0xFF252832), surfaceVariant = Color(0xFFEDEEF2), onSurfaceVariant = Color(0xFF777B86),
    outline = Color(0x33000000), error = Color(0xFFC0392B)
)

@Composable
fun YumeiroTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (Pal.dark) dark else light, content = content)
}

/** 回形针图标（Feather 图标集的路径）。material-icons-core 里没有，所以自己画。 */
val PaperclipIcon: ImageVector by lazy {
    ImageVector.Builder("paperclip", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = PathParser().parsePathString("m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48").toNodes(),
        fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round
    ).build()
}
