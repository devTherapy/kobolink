package com.folusayo.kobolink

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import com.folusayo.kobolink.ui.screen.LinkLookupScreen
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import java.io.IOException
import kotlinx.serialization.SerializationException

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge, insets applied by Scaffold inside the Compose tree —
        // this app never draws its own status bar or gesture pill.
        enableEdgeToEdge()

        setContent {
            KobolinkTheme {
                LinkLookupScreen(resolveLink = ::resolvePublicLink)
            }
        }
    }

    private suspend fun resolvePublicLink(code: String): Result<PublicLinkResponse> = try {
        val response = ApiClientProvider.links.resolvePublicLink(code)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            Result.success(body)
        } else {
            val apiError = response.errorBody()?.string()?.let { raw ->
                runCatching { ApiClientProvider.json.decodeFromString(ApiError.serializer(), raw) }.getOrNull()
            }
            Result.failure(RuntimeException(apiError?.message ?: "Link lookup failed (HTTP ${response.code()})."))
        }
    } catch (e: IOException) {
        Result.failure(RuntimeException("Couldn't reach the API. Check the connection and API_BASE_URL.", e))
    } catch (e: SerializationException) {
        Result.failure(RuntimeException("The API returned something this app couldn't parse.", e))
    }
}
