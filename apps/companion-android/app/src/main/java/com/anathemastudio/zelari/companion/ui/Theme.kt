package com.anathemastudio.zelari.companion.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Gold = Color(0xFFC9A227)
private val GoldDim = Color(0xFF8A7020)
private val Bg = Color(0xFF0E0E12)
private val Surface = Color(0xFF16161C)
private val Surface2 = Color(0xFF1E1E26)
private val TextPrimary = Color(0xFFECECF1)
private val TextMuted = Color(0xFF9A9AA8)
private val Danger = Color(0xFFE85D5D)

private val scheme = darkColorScheme(
    primary = Gold,
    onPrimary = Color(0xFF1A1400),
    secondary = GoldDim,
    background = Bg,
    surface = Surface,
    surfaceVariant = Surface2,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    onSurfaceVariant = TextMuted,
    error = Danger,
    onError = Color.White,
)

@Composable
fun ZelariTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = scheme,
        content = content,
    )
}
