package com.folusayo.kobolink.auth

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * `POST /api/auth/logout` for a token that is no longer in the [TokenStore] (see [AuthRepository.logout]): the
 * token is sent explicitly, on a client WITHOUT [AuthInterceptor], so it can neither read the store nor clear it on a
 * 401. Only ever sent to [apiBaseUrl]. Best effort: any [IOException] is the caller's to ignore, and the response
 * code is not looked at, because the device is signed out whatever the server says.
 */
class SessionRevoker(client: OkHttpClient, private val apiBaseUrl: HttpUrl) {
    private val client = client.newBuilder()
        .apply { interceptors().removeAll { it is AuthInterceptor } }
        .retryOnConnectionFailure(false)
        .build()

    suspend fun revoke(token: String) {
        val request = Request.Builder()
            .url(apiBaseUrl.resolve("api/auth/logout") ?: throw IOException("Bad API base URL."))
            .header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null))
            .build()
        withContext(Dispatchers.IO) { client.newCall(request).execute().close() }
    }
}
