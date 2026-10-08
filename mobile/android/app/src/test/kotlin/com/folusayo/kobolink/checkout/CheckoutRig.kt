package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.ui.screen.CheckoutFormState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent

// Every name, e-mail and reference below is invented for these tests.

/** The instance fields of [type], by name: what a value of it can possibly hold (the compiler's static and synthetic extras left out). */
fun fieldNames(type: Class<*>): Set<String> = type.declaredFields
    .filterNot { it.isSynthetic || java.lang.reflect.Modifier.isStatic(it.modifiers) }
    .map { it.name }
    .toSet()

/** Shared fixtures for the session and ownership tests, the Kotlin twin of iOS's `CK`. */
object CK {
    const val codeA = "7hK2mQ9x"
    const val codeB = "Zz3Yy4Xx"
    const val reference = "kbl_abcdefghjk"

    const val payerName = "Ngozi Okafor"
    const val payerEmail = "ngozi@example.test"

    val userOne = AuthenticatedUser(id = "usr_one", email = "one@example.test", displayName = "One")
    val userTwo = AuthenticatedUser(id = "usr_two", email = "two@example.test", displayName = "Two")

    fun request(code: String = codeA, amountKobo: Int = 1_500_000, name: String = payerName, email: String = payerEmail) =
        InitializeRequest(code, amountKobo, name, email)

    /** A checkout already persisted by an earlier run: what a cold start finds. */
    fun pending(
        code: String = codeA,
        key: String = "persisted-key-$code-0123456789",
        owner: AttemptOwner = AttemptOwner.Payer,
        reference: String? = null,
        amountKobo: Int = 1_500_000,
    ) = PendingCheckout(request(code, amountKobo), key, reference, if (reference == null) null else amountKobo, owner)

    fun session(user: AuthenticatedUser) = AttemptOwner.Session(user.id)

    val unconfirmed = AttemptOwner.Session(null)
}

/**
 * One run of the app: a controller over [store], a gateway whose calls the test completes, and a form the controller
 * empties. [owner] is what the session would answer for "who is an attempt started now?", and a test changes it to
 * model the session moving on. [relaunched] is a new process over the same storage: what a cold start sees.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutRig(
    private val testScope: TestScope,
    val store: InMemoryPendingCheckoutStore = InMemoryPendingCheckoutStore(),
    var owner: AttemptOwner = AttemptOwner.Payer,
    private val run: Int = 1,
    ignoreCancellation: Boolean = false,
) {
    val gateway = FakeCheckoutGateway(ignoreCancellation)
    val form = CheckoutFormState()

    private val background = testScope.backgroundScope.coroutineContext
    private val scope = CoroutineScope(background + Job(background[Job]))
    private var made = 0

    /** How many idempotency keys this run has made. */
    val keysMade: Int get() = made

    val controller = CheckoutController(
        gateway,
        scope,
        store,
        newIdempotencyKey = { "run$run-key-${made++}-0123456789" },
        ownerNow = { owner },
        clearForm = form::reset,
    )

    /** Process death: the scope is cancelled, as clearing a ViewModel does. */
    fun finish() = scope.cancel()

    fun relaunched(owner: AttemptOwner = AttemptOwner.Payer) = CheckoutRig(testScope, store, owner, run + 1)

    fun settle() = testScope.runCurrent()

    val state: CheckoutState get() = controller.state.value
    val loaded: CheckoutState.Loaded? get() = state as? CheckoutState.Loaded
    val pay: PayPhase? get() = loaded?.pay

    /** Every request that was sent, as (request, key). */
    val sends: List<Pair<InitializeRequest, String>> get() = gateway.initializes.map { it.request }

    fun fillForm(name: String = payer.name, email: String = payer.email, amount: String = "") {
        form.name = name
        form.email = email
        form.amountText = amount
    }

    /** Open [code] and answer its lookup with a payable link. */
    fun openPayable(code: String = CK.codeA, amountKobo: Int? = 1_500_000) {
        controller.open(code)
        settle()
        gateway.lookups.last().complete(found(link(code = code, amountKobo = amountKobo)))
        settle()
    }

    /** Answer the lookup that the last `open` or session event started. */
    fun answerLookup(code: String = CK.codeA, amountKobo: Int? = 1_500_000, availability: LinkAvailability = LinkAvailability.Payable) {
        settle()
        gateway.lookups.last().complete(found(link(code = code, amountKobo = amountKobo), availability))
        settle()
    }

    fun pay(input: PayerInput = payer) {
        controller.pay(input)
        settle()
    }

    fun answerSend(outcome: InitializeOutcome) {
        settle()
        gateway.initializes.last().complete(outcome)
        settle()
    }

    /** Open the link, fill the form, pay, and have the outcome stay unknown (the connection dropped). */
    fun makeAttempt(code: String = CK.codeA, outcome: InitializeOutcome = InitializeOutcome.Failed(FailureKind.Network)) {
        openPayable(code)
        fillForm()
        pay()
        answerSend(outcome)
    }
}
