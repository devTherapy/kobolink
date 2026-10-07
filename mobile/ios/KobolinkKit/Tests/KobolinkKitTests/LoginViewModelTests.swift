import Foundation
import Testing

@testable import KobolinkKit

/// A `SigningIn` that records what the form handed it, and can be held in flight.
@MainActor
private final class FakeSigningIn: SigningIn {
    var result: Result<Void, SignInFailure> = .success(())
    var gate: Gate?
    private(set) var attempts: [(email: String, password: String)] = []

    func signIn(email: String, password: String) async throws(SignInFailure) {
        attempts.append((email, password))
        await gate?.wait()
        try result.get()
    }
}

@MainActor
@Suite("Login form")
struct LoginViewModelTests {
    private func filled(_ session: FakeSigningIn = FakeSigningIn()) -> (LoginViewModel, FakeSigningIn) {
        let model = LoginViewModel(session: session)
        model.email = "  \(Fixture.email) "
        model.password = Fixture.password
        return (model, session)
    }

    private func server(
        _ code: ApiErrorCode, status: Int, message: String = "From the server.",
        fields: [String: [String]] = [:], retryAfter: Int? = nil
    ) -> SignInFailure {
        .api(.server(ServerError(
            status: status, code: code, message: message, fieldErrors: fields, retryAfterSeconds: retryAfter)))
    }

    // MARK: Validation

    @Test("empty fields get an error beside each field, focus goes to the first, and nothing is sent")
    func emptyFields() async {
        let session = FakeSigningIn()
        let model = LoginViewModel(session: session)
        await model.submit()
        #expect(model.emailError == "Enter your email address.")
        #expect(model.passwordError == "Enter your password.")
        #expect(model.invalidField == .email)
        #expect(model.formError == nil)
        #expect(session.attempts.isEmpty)
    }

    @Test("a blank password alone is flagged on the password")
    func blankPassword() async {
        let session = FakeSigningIn()
        let model = LoginViewModel(session: session)
        model.email = Fixture.email
        await model.submit()
        #expect(model.emailError == nil)
        #expect(model.passwordError != nil)
        #expect(model.invalidField == .password)
        #expect(session.attempts.isEmpty)
    }

    @Test("whitespace-only email is empty; the password is never trimmed")
    func trimming() async {
        let session = FakeSigningIn()
        let model = LoginViewModel(session: session)
        model.email = "   "
        model.password = " has spaces "
        await model.submit()
        #expect(model.emailError != nil)
        model.email = " \(Fixture.email)\n"
        await model.submit()
        #expect(session.attempts.first?.email == Fixture.email)
        #expect(session.attempts.first?.password == " has spaces ")
    }

    @Test("editing a field clears its error and the form error")
    func editingClears() async {
        let model = LoginViewModel(session: FakeSigningIn())
        await model.submit()
        model.edited(.email)
        #expect(model.emailError == nil)
        #expect(model.passwordError != nil)
        model.edited(.password)
        #expect(model.passwordError == nil)
    }

    // MARK: Submitting

    @Test("a successful sign-in sends the trimmed email and the password, then empties the form")
    func success() async {
        let (model, session) = filled()
        await model.submit()
        #expect(session.attempts.count == 1)
        #expect(session.attempts.first?.email == Fixture.email)
        #expect(session.attempts.first?.password == Fixture.password)
        #expect(model.email.isEmpty)
        #expect(model.password.isEmpty)
        #expect(model.formError == nil)
        #expect(!model.isSubmitting)
    }

    @Test("while a sign-in is in flight the form is submitting and holds no password")
    func passwordLeavesStateOnSubmit() async {
        let session = FakeSigningIn()
        let gate = Gate()
        session.gate = gate
        let (model, _) = filled(session)
        let task = Task { await model.submit() }
        #expect(await waitUntil { model.isSubmitting })
        #expect(model.password.isEmpty, "no state object keeps the password after submit")
        gate.open()
        await task.value
        #expect(!model.isSubmitting)
    }

    @Test("a double tap sends one request")
    func doubleTap() async {
        let session = FakeSigningIn()
        let gate = Gate()
        session.gate = gate
        let (model, _) = filled(session)
        let first = Task { await model.submit() }
        #expect(await waitUntil { model.isSubmitting })
        model.password = Fixture.password  // typed again while the first is in flight
        await model.submit()
        gate.open()
        await first.value
        #expect(session.attempts.count == 1)
    }

    @Test("after a failure the password is gone and must be typed again; the email stays")
    func failureKeepsEmailOnly() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.unauthenticated, status: 401))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.password.isEmpty)
        #expect(model.email == "  \(Fixture.email) ")
        #expect(!model.isSubmitting)
    }

    @Test("each clear of the password rebuilds the field, and a failure sends focus back to it")
    func passwordFieldIsRebuilt() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.unauthenticated, status: 401))
        let (model, _) = filled(session)
        let before = model.passwordResetCount
        await model.submit()
        #expect(model.passwordResetCount > before)
        #expect(model.invalidField == .password)
    }

    @Test("retrying after a failure sends a new request, explicitly")
    func explicitRetry() async {
        let session = FakeSigningIn()
        session.result = .failure(.api(.unreachable(.notConnectedToInternet)))
        let (model, _) = filled(session)
        await model.submit()
        #expect(session.attempts.count == 1)
        model.password = Fixture.password
        session.result = .success(())
        await model.submit()
        #expect(session.attempts.count == 2)
        #expect(model.formError == nil)
    }

    // MARK: Error mapping

    @Test("wrong password and unknown user show the same message, which does not say which")
    func invalidCredentials() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.unauthenticated, status: 401, message: "Incorrect email or password."))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == .invalidCredentials)
        let message = LoginFormError.invalidCredentials.message
        #expect(message.contains("don't match"))
        #expect(!message.lowercased().contains("no account"))
        #expect(!message.lowercased().contains("unknown"))
    }

    @Test("rate limited names how long to wait when the server said")
    func rateLimited() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.rate_limited, status: 429, retryAfter: 840))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == .rateLimited(retryAfterSeconds: 840))
        #expect(model.formError?.message == "Too many sign-in attempts. Try again in 14 minutes.")
    }

    @Test("rate limited without a Retry-After still says to wait", arguments: [nil, 0, 1, 45, 61, 3599, 3600, 7300] as [Int?])
    func retryWording(seconds: Int?) {
        let text = RetryDelay.sentence(seconds: seconds)
        #expect(text.hasSuffix("."))
        #expect(!text.contains(" 0 "), "no zero-unit phrases: \(text)")
        if let seconds, seconds >= 60 { #expect(text.contains("minute") || text.contains("hour")) }
    }

    @Test("retry delays round up and use singular units")
    func retryUnits() throws {
        #expect(RetryDelay.sentence(seconds: 1) == "Try again in 1 second.")
        #expect(RetryDelay.sentence(seconds: 60) == "Try again in 1 minute.")
        #expect(RetryDelay.sentence(seconds: 61) == "Try again in 2 minutes.")
        #expect(RetryDelay.sentence(seconds: 3600) == "Try again in about 1 hour.")
        #expect(RetryDelay.sentence(seconds: nil) == "Wait a while, then try again.")
    }

    @Test("no connection is shown as such")
    func offline() async {
        let session = FakeSigningIn()
        session.result = .failure(.api(.unreachable(.timedOut)))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == .offline)
        #expect(model.formError?.message.contains("connection") == true)
    }

    @Test("a 5xx, an unreadable error and a 500 code are a server problem", arguments: [
        SignInFailure.api(.unexpectedResponse(status: 502)),
        .api(.server(ServerError(status: 500, code: ._internal, message: "Boom (stack trace)"))),
    ])
    func serverProblem(failure: SignInFailure) async {
        let session = FakeSigningIn()
        session.result = .failure(failure)
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == .serverProblem)
        #expect(model.formError?.message.contains("stack trace") == false)
    }

    @Test("a reply that does not match the contract asks for an update")
    func incompatible() async {
        let session = FakeSigningIn()
        session.result = .failure(.api(.undecodableResponse))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == .incompatibleServer)
    }

    @Test("validation errors from the server land beside the field they name")
    func fieldErrorsFromServer() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.validation_failed, status: 400, fields: ["email": ["Invalid email address"]]))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.emailError == "Invalid email address")
        #expect(model.passwordError == nil)
        #expect(model.formError == nil)
        #expect(model.invalidField == .email)
    }

    @Test("a validation failure that names no field of this form is still shown")
    func unknownFieldError() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.validation_failed, status: 400, message: "Check your details.", fields: ["client": ["Bad"]]))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == .other("Check your details."))
    }

    @Test("storage and missing-token failures are explained and mean the person is not signed in")
    func storageFailures() async {
        for (failure, expected) in [(SignInFailure.storage, LoginFormError.storage), (.missingToken, .missingToken)] {
            let session = FakeSigningIn()
            session.result = .failure(failure)
            let (model, _) = filled(session)
            await model.submit()
            #expect(model.formError == expected)
            #expect(model.formError?.message.isEmpty == false)
        }
    }

    @Test("a cancelled request shows nothing")
    func cancelled() async {
        let session = FakeSigningIn()
        session.result = .failure(.api(.cancelled))
        let (model, _) = filled(session)
        await model.submit()
        #expect(model.formError == nil)
        #expect(model.emailError == nil)
    }

    // MARK: Clearing

    @Test("reset empties both fields and every error")
    func reset() async {
        let session = FakeSigningIn()
        session.result = .failure(server(.unauthenticated, status: 401))
        let (model, _) = filled(session)
        await model.submit()
        model.password = "typed again"
        model.reset()
        #expect(model.email.isEmpty)
        #expect(model.password.isEmpty)
        #expect(model.formError == nil)
        #expect(model.emailError == nil)
        #expect(model.passwordError == nil)
        #expect(model.invalidField == nil)
    }

    @Test("an answer that arrives after the form was reset is dropped, not shown on the cleared form")
    func lateAnswerAfterReset() async {
        let session = FakeSigningIn()
        let gate = Gate()
        session.gate = gate
        session.result = .failure(server(.unauthenticated, status: 401))
        let (model, _) = filled(session)
        let task = Task { await model.submit() }
        #expect(await waitUntil { model.isSubmitting })
        model.reset()  // the screen disappeared mid-request
        gate.open()
        await task.value
        #expect(model.formError == nil)
        #expect(model.email.isEmpty)
    }
}
