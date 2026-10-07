package com.folusayo.kobolink.auth

import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Response

/**
 * The mobile half of `SessionGuard`'s accepted credentials
 * (`apps/api/src/auth/extract-token.ts`: "the explicit bearer header wins —
 * it can only have been sent deliberately by a mobile client").
 *
 * - Attaches `Authorization: Bearer <token>` whenever [tokenStore] holds one,
 *   but ONLY to requests whose origin (scheme, host and port) matches
 *   [apiBaseUrl]. The OkHttp client is shared, so without this check any
 *   future call to another host would leak the session token to it.
 * - Adds nothing when signed out, so unauthenticated endpoints (link lookup,
 *   register, login itself) are unaffected either way.
 * - When the server answers 401 to a request that carried a token, that token
 *   is dead (revoked or expired): it is cleared from [tokenStore] and
 *   [onSessionExpired] is called so the UI can move to signed-out. The token
 *   is only cleared if it is still the one this request sent — a late 401 for
 *   an old token must not wipe a session the user has since signed into.
 *
 * Deliberately does not distinguish which endpoint is being called — the
 * server-side guard decides whether a route needs the header.
 */
class AuthInterceptor(
    private val tokenStore: TokenStore,
    private val apiBaseUrl: HttpUrl,
    private val onSessionExpired: () -> Unit = {},
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!request.url.hasSameOriginAs(apiBaseUrl)) return chain.proceed(request)

        // A Keystore/decryption failure here would otherwise throw a non-IOException on
        // OkHttp's dispatcher thread and crash the process. Send the request without a
        // bearer instead; the server's 401 is handled like any other signed-out call.
        val token = readToken() ?: return chain.proceed(request)
        val response = chain.proceed(
            request.newBuilder()
                .header("Authorization", "Bearer $token")
                .build(),
        )

        if (response.code == 401 && readToken() == token) {
            // The caller still gets the 401 response regardless of whether the clear succeeds.
            runCatching { tokenStore.clear() }
            onSessionExpired()
        }
        return response
    }

    private fun readToken(): String? = try {
        tokenStore.token()
    } catch (e: Exception) {
        null
    }

    private fun HttpUrl.hasSameOriginAs(other: HttpUrl) =
        scheme == other.scheme && host == other.host && port == other.port
}
