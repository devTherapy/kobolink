import KobolinkKit
import SwiftUI

/// The merchant's sign-in. A payer opening a payment link never reaches it: a link is pushed over the
/// session screen (see `RootView`), whatever the session state.
///
/// An inset grouped form, the system's idiom for entering details: no floating labels, no bordered
/// boxes. The email field offers the keyboard and AutoFill for a username, the password field is
/// secure, Return on the email moves to the password and Return on the password submits.
struct LoginView: View {
    let reason: SignedOutReason
    @State private var model: LoginViewModel
    @FocusState private var focus: LoginViewModel.Field?

    init(session: SessionController, reason: SignedOutReason) {
        self.reason = reason
        self._model = State(initialValue: LoginViewModel(session: session))
    }

    var body: some View {
        Form {
            if let notice = reason.notice {
                Section {
                    Label(notice, systemImage: "clock.badge.exclamationmark")
                }
            }

            Section {
                FieldRow(error: model.emailError) {
                    TextField("Email", text: $model.email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focus, equals: .email)
                        .onSubmit { focus = .password }
                        .onChange(of: model.email) { model.edited(.email) }
                }
                FieldRow(error: model.passwordError) {
                    SecureField("Password", text: $model.password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .focused($focus, equals: .password)
                        .onSubmit(submit)
                        .onChange(of: model.password) { model.edited(.password) }
                        .id(model.passwordResetCount)
                }
            } header: {
                Text("Sign in to create payment links and see who has paid you.")
                    .textCase(nil)
                    .font(.subheadline)
            } footer: {
                if let error = model.formError {
                    Label(error.message, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button(action: submit) {
                    HStack(spacing: 8) {
                        if model.isSubmitting {
                            ProgressView().tint(Color(.systemBackground))
                        }
                        Text(model.isSubmitting ? "Signing In" : "Sign In")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .foregroundStyle(Color(.systemBackground))
                .disabled(model.isSubmitting)
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        .navigationTitle("Sign In")
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: model.invalidField) { _, field in
            if let field { focus = field }
        }
        .onChange(of: model.formError) { _, error in
            if let error { AccessibilityNotification.Announcement(error.message).post() }
        }
        // A payment link opened over this screen, or the person left: nothing typed here stays.
        .onDisappear { model.reset() }
    }

    private func submit() {
        Task { await model.submit() }
    }
}

/// A field with its validation message directly under it, in the same row.
private struct FieldRow<Field: View>: View {
    let error: String?
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            field
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityLabel("Error: \(error)")
            }
        }
        .frame(minHeight: 44)
    }
}

#Preview("Signed out") {
    NavigationStack {
        LoginView(session: .preview(), reason: .noSession)
    }
}

#Preview("Session ended") {
    NavigationStack {
        LoginView(session: .preview(), reason: .sessionExpired)
    }
}

extension SessionController {
    /// A session over an in-memory store and an API that never answers, for previews.
    static func preview() -> SessionController {
        SessionController(auth: PreviewAuth(), store: InMemoryTokenStore(), installMarker: InMemoryInstallMarker(isSet: true))
    }
}

private struct PreviewAuth: AuthServing {
    func login(email: String, password: String) async throws(APIError) -> AuthSession { throw .unreachable(.notConnectedToInternet) }
    func currentUser() async throws(APIError) -> SignedInUser { throw .unreachable(.notConnectedToInternet) }
    func logout(revoking token: SessionToken) async throws(APIError) {}
}
