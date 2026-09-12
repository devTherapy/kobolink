package com.folusayo.kobolink.auth

import okhttp3.Interceptor
import okhttp3.Response

/**
 * The mobile half of `SessionGuard`'s accepted credentials
 * (`apps/api/src/auth/extract-token.ts`: "the explicit bearer header wins —
 * it can only have been sent deliberately by a mobile client"). Attaches
 * `Authorization: Bearer <token>` to every outgoing request whenever
 * [tokenStore] currently holds one; adds nothing when signed out, so
 * unauthenticated endpoints (link lookup, register, login itself) are
 * unaffected either way.
 *
 * Deliberately does not distinguish which endpoint is being called — the
 * server-side guard is what decides whether a given route needs the header,
 * this interceptor's only job is "attach the credential if we have one."
 */
class AuthInterceptor(private val tokenStore: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val token = tokenStore.token()
        val authenticated = if (token != null) {
            request.newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        } else {
            request
        }
        return chain.proceed(authenticated)
    }
}
