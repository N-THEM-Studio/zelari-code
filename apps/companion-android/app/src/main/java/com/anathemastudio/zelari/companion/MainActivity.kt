package com.anathemastudio.zelari.companion

import android.content.Intent
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
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        vm.applyPairingPayload(data)
    }
}
