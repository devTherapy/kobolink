import Foundation
import Observation

/// What the login screen shows beside a field or above the form.
public enum LoginFormError: Equatable, Sendable {
    /// 401 from `login`: the email is unknown or the password is wrong. The API answers both the same
    /// way on purpose, so this screen does not say which.
    case invalidCredentials
    /// 429. `retryAfterSeconds` is the server's `Retry-After`, when it sent one.
    case rateLimited(retryAfterSeconds: Int?)
    /// No answer: offline, a timeout, a TLS failure. The request may not have arrived, and nothing was retried.
    case offline
    /// 5xx, or an answer the app cannot read as an error.
    case serverProblem
    /// A 200 whose body does not match the contract.
    case incompatibleServer
    /// The Keychain refused the token; the person was not signed in.
    case storage
    /// The server accepted the login but sent no token to keep.
    case missingToken
    /// Some other refusal, in the server's words.
    case other(String)

    public var message: String {
        switch self {
        case .invalidCredentials:
            "That email and password don't match. Check them and try again."
        case .rateLimited(let seconds):
            "Too many sign-in attempts. " + RetryDelay.sentence(seconds: seconds)
        case .offline:
            "Can't reach Kobolink. Check your connection and try again."
        case .serverProblem:
            "Kobolink had a problem signing you in. Try again in a moment."
        case .incompatibleServer:
            "Kobolink's reply wasn't what this version of the app expects. Update the app and try again."
        case .storage:
            "Couldn't save your sign-in securely on this iPhone, so you weren't signed in. Try again; if it keeps happening, restart your iPhone."
        case .missingToken:
            "Kobolink accepted your details but didn't send what the app needs to keep you signed in. Try again."
        case .other(let message):
            message
        }
    }
}

/// How long to wait, in words.
public enum RetryDelay {
    public static func sentence(seconds: Int?) -> String {
        guard let seconds else { return "Wait a while, then try again." }
        switch seconds {
        case ..<1: return "Try again in a moment."
        case 1..<60: return "Try again in \(seconds) \(seconds == 1 ? "second" : "seconds")."
        case 60..<3600:
            let minutes = (seconds + 59) / 60
            return "Try again in \(minutes) \(minutes == 1 ? "minute" : "minutes")."
        default:
            let hours = (seconds + 3599) / 3600
            return "Try again in about \(hours) \(hours == 1 ? "hour" : "hours")."
        }
    }
}

/// The state of the login form.
///
/// What it keeps, and for how long:
/// - The password is moved out of `password` the moment the form is submitted. After that no state
///   object holds it, whether the sign-in succeeds, is refused, or never answers; a failed attempt
///   asks for it again.
/// - `reset()` empties every field and error. The screen calls it when it disappears (a payment link
///   opened over it, the person left) and after a successful sign-in, and a late answer to an attempt
///   made before a reset is dropped instead of surfacing on the cleared form.
@MainActor
@Observable
public final class LoginViewModel {
    public enum Field: Equatable, Sendable { case email, password }

    public var email = ""
    public var password = ""
    public private(set) var isSubmitting = false
    public private(set) var emailError: String?
    public private(set) var passwordError: String?
    public private(set) var formError: LoginFormError?
    /// The field that should take focus after a failed validation.
    public private(set) var invalidField: Field?
    /// Bumped whenever the password is cleared. The view gives the secure field this as its identity:
    /// a `SecureField` that is focused keeps showing (and can write back) what was typed when its
    /// binding is cleared from code, so the field is rebuilt instead of trusted to follow the binding.
    public private(set) var passwordResetCount = 0

    @ObservationIgnored private let session: any SigningIn
    @ObservationIgnored private var generation = 0

    public init(session: any SigningIn) {
        self.session = session
    }

    /// The person edited `field`: its error no longer describes what is typed.
    public func edited(_ field: Field) {
        switch field {
        case .email: emailError = nil
        case .password: passwordError = nil
        }
        formError = nil
    }

    public func submit() async {
        // Checked and set before the first `await`, so two taps cannot both get through.
        guard !isSubmitting else { return }

        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        emailError = address.isEmpty ? "Enter your email address." : nil
        passwordError = password.isEmpty ? "Enter your password." : nil
        formError = nil
        invalidField = emailError != nil ? .email : (passwordError != nil ? .password : nil)
        if invalidField != nil { return }

        isSubmitting = true
        defer { isSubmitting = false }
        let attempt = generation
        let secret = password
        clearPassword()

        do throws(SignInFailure) {
            try await session.signIn(email: address, password: secret)
            reset()
        } catch {
            guard attempt == generation else { return }
            apply(error)
        }
    }

    /// Empty the form: both fields, every error, and any attempt still in flight loses its say.
    public func reset() {
        generation += 1
        email = ""
        clearPassword()
        emailError = nil
        passwordError = nil
        formError = nil
        invalidField = nil
    }

    private func clearPassword() {
        password = ""
        passwordResetCount += 1
    }

    private func apply(_ failure: SignInFailure) {
        // The password was cleared on submit, so whatever went wrong the next step is typing it again.
        invalidField = .password
        switch failure {
        case .busy:
            // Another sign-in is running; its outcome is what the screen will show.
            return
        case .storage:
            formError = .storage
        case .missingToken:
            formError = .missingToken
        case .api(let error):
            apply(error)
        }
    }

    private func apply(_ error: APIError) {
        switch error {
        case .cancelled:
            return
        case .unreachable:
            formError = .offline
        case .undecodableResponse:
            formError = .incompatibleServer
        case .unexpectedResponse:
            formError = .serverProblem
        case .server(let server):
            apply(server)
        }
    }

    private func apply(_ server: ServerError) {
        switch server.code {
        case .unauthenticated:
            formError = .invalidCredentials
        case .rate_limited:
            formError = .rateLimited(retryAfterSeconds: server.retryAfterSeconds)
        case .validation_failed:
            emailError = server.fieldErrors["email"]?.first
            passwordError = server.fieldErrors["password"]?.first
            invalidField = emailError != nil ? .email : (passwordError != nil ? .password : nil)
            // A refusal that names no field of this form still has to say something.
            if emailError == nil && passwordError == nil { formError = .other(server.message) }
        case ._internal:
            formError = .serverProblem
        default:
            formError = .other(server.message)
        }
    }
}
