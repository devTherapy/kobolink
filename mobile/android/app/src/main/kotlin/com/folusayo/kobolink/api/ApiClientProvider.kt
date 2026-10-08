package com.folusayo.kobolink.api

import android.content.Context
import com.folusayo.kobolink.BuildConfig
import com.folusayo.kobolink.auth.AuthInterceptor
import com.folusayo.kobolink.auth.EncryptedTokenStore
import com.folusayo.kobolink.auth.SessionExpiryBus
import com.folusayo.kobolink.auth.SessionRevoker
import com.folusayo.kobolink.auth.TokenStore
import com.folusayo.kobolink.auth.openEncryptedPrefs
import com.folusayo.kobolink.checkout.EncryptedPendingCheckoutStore
import com.folusayo.kobolink.checkout.PendingCheckoutStore
import com.folusayo.kobolink.checkout.ReopeningPendingCheckoutStore
import com.folusayo.kobolink.generated.api.apis.AuthApi
import com.folusayo.kobolink.generated.api.apis.CheckoutApi
import com.folusayo.kobolink.generated.api.apis.LinksApi
import com.folusayo.kobolink.generated.api.apis.WalletApi
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.TimeUnit

/**
 * Builds the Retrofit client against every request/response model
 * `openApiGenerate` produced from `apps/api/openapi.json` (see
 * app/build.gradle.kts). Nothing here hand-writes a DTO: the interfaces
 * ([LinksApi], [AuthApi], [WalletApi], ...) and the models they carry come
 * entirely from the OpenAPI document, so this file is the "one working call"
 * proof the M0 acceptance bar asks for, not a place that reintroduces
 * hand-written shapes.
 *
 * `BuildConfig.API_BASE_URL` comes from `local.properties` /
 * `KOBOLINK_API_BASE_URL` (see local.properties.example) — never hardcoded.
 *
 * [init] must run once, before any of the lazily-built properties below are
 * first touched — [com.folusayo.kobolink.KobolinkApplication.onCreate] is
 * the one call site, guaranteed to run before any `Activity`. It exists
 * because [tokenStore] needs a `Context` to reach the Android Keystore
 * ([EncryptedTokenStore]), and this object otherwise has none of its own.
 */
object ApiClientProvider {

    /** The same lenient/ignore-unknown-keys Json the generated client uses. */
    val json: Json = Serializer.kotlinxSerializationJson

    /**
     * The single source of truth for "are we signed in" and the only path
     * that ever reads or writes the session token — see [TokenStore]'s doc
     * comment for why nothing else is allowed to.
     */
    lateinit var tokenStore: TokenStore
        private set

    /** Signalled by [AuthInterceptor] when the server rejects the stored token mid-session. */
    val sessionExpiry = SessionExpiryBus()

    private var initialized = false

    private lateinit var appContext: Context

    fun init(context: Context) {
        if (initialized) return
        appContext = context.applicationContext
        tokenStore = EncryptedTokenStore(context.applicationContext)
        initialized = true
    }

    /**
     * Where an unsettled payment is remembered (encrypted, one slot per link). If secure storage cannot be opened
     * every call fails as "unavailable", so no payment is sent without a record and the checkout says so, and the
     * open is tried again on the next call: a transient fault is not cached for the life of the process.
     */
    val pendingCheckouts: PendingCheckoutStore by lazy {
        ReopeningPendingCheckoutStore {
            EncryptedPendingCheckoutStore(openEncryptedPrefs(appContext, EncryptedPendingCheckoutStore.PREFS_FILE_NAME))
        }
    }

    private val okHttpClient: OkHttpClient by lazy {
        check(::tokenStore.isInitialized) {
            "ApiClientProvider.init(context) must run before the API client is used — call it from Application.onCreate."
        }
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            // Attaches `Authorization: Bearer <token>` when signed in. Must
            // run before the logging interceptor below so the request it
            // logs reflects what's actually sent — irrelevant at Level.BASIC
            // (no headers logged either way) but keeps the two interceptors
            // in the order a reader would expect.
            .addInterceptor(AuthInterceptor(tokenStore, BuildConfig.API_BASE_URL.toHttpUrl(), sessionExpiry::notifyExpired))
            .apply {
                if (BuildConfig.DEBUG) {
                    addInterceptor(HttpLoggingInterceptor().apply {
                        level = HttpLoggingInterceptor.Level.BASIC
                        // BASIC only ever logs the request/response line and
                        // body size, never headers — so this never actually
                        // sees the Authorization header. Redacted anyway as
                        // defense in depth: the day someone bumps this to
                        // HEADERS or BODY level to debug something, the
                        // session token still doesn't end up in Logcat.
                        // Also gated behind BuildConfig.DEBUG, so none of
                        // this interceptor ships in a release build at all.
                        redactHeader("Authorization")
                    })
                }
            }
            .build()
    }

    /**
     * The client the money-moving `POST /api/checkout/initialize` goes through: [base] (same pool, same
     * interceptors) with OkHttp's silent connection-failure retry turned off. That retry can write a POST a second
     * time on a fresh connection after the first copy already reached the server and created the checkout; when the
     * second attempt then fails, the app would report a failure for a payment that exists. A payment is sent at most
     * once per call; any retry is the app's own, under the same idempotency key. (Same rule as the wallet client.)
     */
    fun checkoutClient(base: OkHttpClient): OkHttpClient =
        base.newBuilder().retryOnConnectionFailure(false).build()

    private val retrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(okHttpClient)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    private val checkoutRetrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(checkoutClient(okHttpClient))
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    /** Ends a session on the server with a token the app has already removed locally (best effort). */
    val sessionRevoker: SessionRevoker by lazy { SessionRevoker(okHttpClient, BuildConfig.API_BASE_URL.toHttpUrl()) }

    val links: LinksApi by lazy { retrofit.create(LinksApi::class.java) }
    val checkout: CheckoutApi by lazy { checkoutRetrofit.create(CheckoutApi::class.java) }
    val auth: AuthApi by lazy { retrofit.create(AuthApi::class.java) }
    val wallet: WalletApi by lazy { retrofit.create(WalletApi::class.java) }
}
