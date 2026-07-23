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

    val baseUrl: Flow<String> = context.dataStore.data.map { it[keyBase] ?: "" }
    val token: Flow<String> = context.dataStore.data.map { it[keyToken] ?: "" }
    val projectId: Flow<String> = context.dataStore.data.map { it[keyProject] ?: "" }
    val mode: Flow<String> = context.dataStore.data.map { it[keyMode] ?: "agent" }
    val phase: Flow<String> = context.dataStore.data.map { it[keyPhase] ?: "build" }

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
}
