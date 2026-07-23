package com.anathemastudio.zelari.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.anathemastudio.zelari.companion.ui.CompanionApp
import com.anathemastudio.zelari.companion.ui.CompanionViewModel
import com.anathemastudio.zelari.companion.ui.ZelariTheme

class MainActivity : ComponentActivity() {
    private val vm: CompanionViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ZelariTheme {
                Surface(Modifier.fillMaxSize()) {
                    CompanionApp(vm)
                }
            }
        }
    }
}
