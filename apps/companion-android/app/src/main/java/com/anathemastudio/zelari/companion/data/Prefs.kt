package com.anathemastudio.zelari.companion.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("zelari_companion")

class Prefs(private val context: Context) {
    private val keyBase = stringPreferencesKey("base_url")
    private val keyToken = stringPreferencesKey("token")
    private val keyProject = stringPreferencesKey("project_id")
    private val keyMode = stringPreferencesKey("mode")
    private val keyPhase = stringPreferencesKey("phase")
    private val keyProvider = stringPreferencesKey("provider")
    private val keyModel = stringPreferencesKey("model")
    // t63: agent controls (Desktop parity).
    private val keyPreset = stringPreferencesKey("permission_preset")
    private val keyStrictDone = stringPreferencesKey("strict_done")
    private val keyFolder = stringPreferencesKey("folder_path")

    val baseUrl: Flow<String> = context.dataStore.data.map { it[keyBase] ?: "" }
    val token: Flow<String> = context.dataStore.data.map { it[keyToken] ?: "" }
    val projectId: Flow<String> = context.dataStore.data.map { it[keyProject] ?: "" }
    val mode: Flow<String> = context.dataStore.data.map { it[keyMode] ?: "kraken" }
    val phase: Flow<String> = context.dataStore.data.map { it[keyPhase] ?: "build" }
    val provider: Flow<String> = context.dataStore.data.map { it[keyProvider] ?: "" }
    val model: Flow<String> = context.dataStore.data.map { it[keyModel] ?: "" }
    val permissionPreset: Flow<String> = context.dataStore.data.map { it[keyPreset] ?: "standard" }
    val strictDone: Flow<Boolean> = context.dataStore.data.map { (it[keyStrictDone] ?: "0") == "1" }
    val folderPath: Flow<String> = context.dataStore.data.map { it[keyFolder] ?: "" }

    suspend fun saveConnection(baseUrl: String, token: String) {
        context.dataStore.edit {
            it[keyBase] = baseUrl.trim().trimEnd('/')
            it[keyToken] = token.trim()
        }
    }

    suspend fun saveProject(id: String) {
        context.dataStore.edit { it[keyProject] = id }
    }

    suspend fun saveModePhase(mode: String, phase: String) {
        context.dataStore.edit {
            it[keyMode] = mode
            it[keyPhase] = phase
        }
    }

    suspend fun saveProviderModel(provider: String, model: String) {
        context.dataStore.edit {
            it[keyProvider] = provider
            it[keyModel] = model
        }
    }

    suspend fun saveAgent(preset: String, strictDone: Boolean) {
        context.dataStore.edit {
            it[keyPreset] = preset
            it[keyStrictDone] = if (strictDone) "1" else "0"
        }
    }

    suspend fun saveFolder(path: String) {
        context.dataStore.edit { it[keyFolder] = path }
    }
}
