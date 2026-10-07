package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.apis.AuthApi
import com.folusayo.kobolink.generated.api.models.AuthResponse
import com.folusayo.kobolink.generated.api.models.AuthResponseSession
import com.folusayo.kobolink.generated.api.models.AuthResponseUser
import com.folusayo.kobolink.generated.api.models.LoginRequest
import com.folusayo.kobolink.generated.api.models.MeResponse
import com.folusayo.kobolink.generated.api.models.RegisterRequest
import java.time.OffsetDateTime
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.Response

/**
 * Shared fakes for the JVM auth tests: a scriptable [AuthApi] and a
 * [TokenStore] that records what was written, so nothing here needs the
 * Android Keystore or a network.
 */
internal class RecordingTokenStore(
    private val saveFailure: Exception? = null,
    private val clearFailure: Exception? = null,
    private val readFailure: Exception? = null,
) : TokenStore {
    var saved: String? = null
        private set
    var clearCalls = 0
        private set

    override fun saveToken(token: String) {
        saveFailure?.let { throw it }
        saved = token
    }

    override fun token(): String? {
        readFailure?.let { throw it }
        return saved
    }

    override fun clear() {
        clearCalls += 1
        clearFailure?.let { throw it }
        saved = null
    }
}

internal class FakeAuthApi(
    private val loginResponse: Response<AuthResponse>? = null,
    var meResponse: Response<MeResponse>? = null,
    var meThrows: Exception? = null,
    private val logoutThrows: Exception? = null,
) : AuthApi {
    var logoutCalled = false
    /** Runs when `getMe()` is called, e.g. to play the part of [AuthInterceptor] clearing the token on the 401. */
    var onGetMe: () -> Unit = {}
    var getMeCalls = 0
        private set

    override suspend fun getMe(): Response<MeResponse> {
        getMeCalls += 1
        onGetMe()
        meThrows?.let { throw it }
        return meResponse ?: error("no getMe() stub configured")
    }

    override suspend fun login(loginRequest: LoginRequest): Response<AuthResponse> =
        loginResponse ?: error("no login() stub configured")

    override suspend fun logout(): Response<Unit> {
        logoutCalled = true
        logoutThrows?.let { throw it }
        return Response.success(204, Unit)
    }

    override suspend fun registerUser(registerRequest: RegisterRequest): Response<AuthResponse> =
        error("not used by these tests")
}

internal fun jsonErrorBody(code: String, message: String) = """{"code":"$code","message":"$message"}"""
    .toResponseBody("application/json".toMediaType())

internal val authResponseUser = AuthResponseUser(
    id = "user_123",
    role = AuthResponseUser.Role.merchant,
    email = "ngozi@example.com",
    phone = null,
    displayName = "Ngozi",
    createdAt = OffsetDateTime.now(),
)

internal val meResponseUser = AuthResponseUser(
    id = "user_123",
    role = AuthResponseUser.Role.merchant,
    email = "ngozi@example.com",
    phone = null,
    displayName = "Ngozi",
    createdAt = OffsetDateTime.now(),
)

internal val ngozi = AuthenticatedUser(id = "user_123", email = "ngozi@example.com", displayName = "Ngozi")

internal fun loginSuccess(token: String = "a-real-looking-session-token-value") = Response.success(
    AuthResponse(
        user = authResponseUser,
        session = AuthResponseSession(id = "sess_1", expiresAt = OffsetDateTime.now().plusDays(30)),
        token = token,
    ),
)

internal fun meSuccess() = Response.success(MeResponse(user = meResponseUser))
