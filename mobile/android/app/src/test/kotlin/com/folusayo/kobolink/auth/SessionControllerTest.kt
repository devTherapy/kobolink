package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * The session decisions that used to live inline in `MainActivity`'s
 * `LaunchedEffect` — extracted so they can run on the JVM. The rule under
 * test: only a definitive 401 may destroy a stored token; everything else
 * keeps it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionControllerTest {

    private val json = Serializer.kotlinxSerializationJson

    private fun controllerWith(api: FakeAuthApi, store: RecordingTokenStore = RecordingTokenStore()) =
        SessionController(AuthRepository(api, store, json)) to store

    private fun signedInStore() = RecordingTokenStore().also { it.saveToken("valid-token") }

    @Test
    fun `no stored token resolves straight to signed out without calling the API`() = runTest {
        val api = FakeAuthApi()
        val (controller, _) = controllerWith(api)

        controller.resolve()

        assertEquals(SessionState.SignedOut(), controller.state.value)
        assertEquals(0, api.getMeCalls)
    }

    @Test
    fun `a valid token resolves to signed in`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())

        controller.resolve()

        assertEquals(SessionState.SignedIn(ngozi), controller.state.value)
    }

    @Test
    fun `a network failure on cold start keeps the token and goes offline, not signed out`() = runTest {
        val (controller, store) = controllerWith(FakeAuthApi(meThrows = IOException("airplane mode")), signedInStore())

        controller.resolve()

        assertTrue("expected Offline but was ${controller.state.value}", controller.state.value is SessionState.Offline)
        assertEquals("the token must survive a transient failure", "valid-token", store.token())
        assertEquals(0, store.clearCalls)
    }

    @Test
    fun `a 5xx on cold start keeps the token and goes offline`() = runTest {
        val api = FakeAuthApi(meResponse = Response.error(503, jsonErrorBody("unavailable", "Try again soon.")))
        val (controller, store) = controllerWith(api, signedInStore())

        controller.resolve()

        assertTrue("expected Offline but was ${controller.state.value}", controller.state.value is SessionState.Offline)
        assertEquals("valid-token", store.token())
        assertEquals(0, store.clearCalls)
    }

    @Test
    fun `a 401 on cold start clears the token and says why`() = runTest {
        val api = FakeAuthApi(meResponse = Response.error(401, jsonErrorBody("unauthenticated", "Session expired.")))
        val (controller, store) = controllerWith(api, signedInStore())

        controller.resolve()

        val state = controller.state.value
        assertTrue("expected SignedOut but was $state", state is SessionState.SignedOut)
        assertTrue("a revoked session should come with a notice", (state as SessionState.SignedOut).notice != null)
        assertNull(store.token())
    }

    @Test
    fun `a 401 on cold start whose local clear fails still signs out instead of crashing`() = runTest {
        // clear() throws IOException when the commit fails; if that escaped resolve() the app would
        // crash on every launch while storage can't write, stuck on Resolving.
        val store = RecordingTokenStore(clearFailure = IOException("disk error")).also { it.saveToken("dead-token") }
        val api = FakeAuthApi(meResponse = Response.error(401, jsonErrorBody("unauthenticated", "Session expired.")))
        val (controller, _) = controllerWith(api, store)

        controller.resolve()

        val state = controller.state.value
        assertTrue("expected SignedOut but was $state", state is SessionState.SignedOut)
        assertTrue((state as SessionState.SignedOut).notice != null)
    }

    @Test
    fun `a 401 on cold start does not clear again when the interceptor already did`() = runTest {
        val store = signedInStore()
        val api = FakeAuthApi(meResponse = Response.error(401, jsonErrorBody("unauthenticated", "Session expired.")))
        api.onGetMe = { store.clear() } // AuthInterceptor clears the token on the 401, before the repository sees it
        val (controller, _) = controllerWith(api, store)

        controller.resolve()

        assertEquals("the token was already gone; no second clear", 1, store.clearCalls)
        assertTrue(controller.state.value is SessionState.SignedOut)
    }

    @Test
    fun `an unreadable token store resolves to signed out naming secure storage, not a crash`() = runTest {
        val store = RecordingTokenStore(readFailure = SecurityException("Keystore unavailable"))
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, _) = controllerWith(api, store)

        controller.resolve()

        val state = controller.state.value
        assertTrue("expected SignedOut but was $state", state is SessionState.SignedOut)
        assertTrue(
            "notice should name secure storage: ${(state as SessionState.SignedOut).notice}",
            state.notice.orEmpty().contains("secure storage"),
        )
        assertEquals("no network call without a readable token", 0, api.getMeCalls)
    }

    @Test
    fun `retry from offline succeeds once the network is back`() = runTest {
        val api = FakeAuthApi(meThrows = IOException("down"))
        val (controller, store) = controllerWith(api, signedInStore())
        controller.resolve()
        assertTrue(controller.state.value is SessionState.Offline)

        api.meThrows = null
        api.meResponse = meSuccess()
        controller.retry()

        assertEquals(SessionState.SignedIn(ngozi), controller.state.value)
        assertEquals("valid-token", store.token())
    }

    @Test
    fun `resolve is a one-shot - a second call, as on Activity recreation, does not hit the network again`() = runTest {
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, _) = controllerWith(api, signedInStore())

        controller.resolve()
        controller.resolve()

        assertEquals(1, api.getMeCalls)
        assertEquals(SessionState.SignedIn(ngozi), controller.state.value)
    }

    @Test
    fun `retry re-checks only when offline`() = runTest {
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, _) = controllerWith(api, signedInStore())
        controller.resolve()

        controller.retry()

        assertEquals("retry while signed in must not re-run the check", 1, api.getMeCalls)
    }

    @Test
    fun `a session-expired signal while signed in moves to signed out with a notice`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        controller.resolve()

        controller.onSessionExpired()

        val state = controller.state.value
        assertTrue("expected SignedOut but was $state", state is SessionState.SignedOut)
        assertTrue((state as SessionState.SignedOut).notice != null)
    }

    @Test
    fun `a session-expired signal while signed out changes nothing`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi())
        controller.resolve()

        controller.onSessionExpired()

        assertEquals(SessionState.SignedOut(), controller.state.value)
    }

    @Test
    fun `end to end - a 401 on an authenticated request signs the app out`() = runTest {
        // The real wiring: OkHttp + AuthInterceptor -> SessionExpiryBus -> SessionController.
        val server = MockWebServer().apply { start() }
        try {
            val store = signedInStore()
            val bus = SessionExpiryBus()
            val controller = SessionController(AuthRepository(FakeAuthApi(meResponse = meSuccess()), store, json))
            controller.resolve()
            assertEquals(SessionState.SignedIn(ngozi), controller.state.value)
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { controller.observeExpiry(bus.events) }

            server.enqueue(MockResponse().setResponseCode(401))
            val client = OkHttpClient.Builder()
                .addInterceptor(AuthInterceptor(store, server.url("/"), bus::notifyExpired))
                .build()
            client.newCall(Request.Builder().url(server.url("/api/wallet")).build()).execute().close()

            assertNull("dead token must be removed", store.token())
            val state = controller.state.value
            assertTrue("expected SignedOut but was $state", state is SessionState.SignedOut)
            assertTrue((state as SessionState.SignedOut).notice != null)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `logout whose local clear fails does not crash and says the session may still be on the device`() = runTest {
        val store = RecordingTokenStore(clearFailure = IOException("disk error")).also { it.saveToken("t") }
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), store)
        controller.resolve()

        controller.logout()

        val state = controller.state.value
        assertTrue("expected SignedOut but was $state", state is SessionState.SignedOut)
        assertTrue((state as SessionState.SignedOut).notice != null)
    }

    @Test
    fun `login moves to signed in and logout back to signed out`() = runTest {
        val store = RecordingTokenStore()
        val (controller, _) = controllerWith(FakeAuthApi(loginResponse = loginSuccess()), store)
        controller.resolve()

        controller.login("ngozi@example.com", "pw")
        assertEquals(SessionState.SignedIn(ngozi), controller.state.value)

        controller.logout()
        assertEquals(SessionState.SignedOut(), controller.state.value)
        assertNull(store.token())
    }
}
