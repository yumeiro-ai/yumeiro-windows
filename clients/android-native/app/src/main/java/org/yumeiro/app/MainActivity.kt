package org.yumeiro.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import org.yumeiro.app.ui.AppRoot

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val sys = androidx.compose.foundation.isSystemInDarkTheme()
            androidx.compose.runtime.LaunchedEffect(sys) { vm.setSystemDark(sys) }
            val dark = org.yumeiro.app.ui.Pal.dark
            androidx.compose.runtime.DisposableEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT) else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                onDispose { }
            }
            AppRoot(vm)
        }
    }
}
