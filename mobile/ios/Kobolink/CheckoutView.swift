import KobolinkKit
import SwiftUI

/// Where a payment link lands. It renders `CheckoutController.screen` and forwards taps; every decision
/// (which key, what to keep, what to forget) is in the controller.
///
/// A payer never meets the merchant sign-in here: this view is pushed over the session screen and asks
/// nothing of the session.
struct CheckoutView: View {
    let code: LinkCode
    let checkout: CheckoutController
    let onDone: () -> Void

    var body: some View {
        // Only ever the screen for THIS link. For the frame between a link replacing another on the stack
        // and the controller being told, show the skeleton, never the previous link's content.
        let screen = checkout.screen.code == code ? checkout.screen : .loading(code)
        Group {
            switch screen {
            case .idle, .loading:
                CheckoutSkeleton()
            case .notFound:
                NoticeScreen(
                    symbol: "questionmark.circle", symbolStyle: .secondary, notice: CheckoutCopy.notFound,
                    actions: [NoticeAction("Done", .prominent, onDone)])
            case .loadFailed(_, let failure):
                NoticeScreen(
                    symbol: "exclamationmark.icloud", symbolStyle: Color.errorText, notice: CheckoutCopy.loadFailed(failure),
                    actions: [NoticeAction("Try Again", .prominent, checkout.reload), NoticeAction("Done", .plain, onDone)])
            case .storageBlocked(_, let block):
                StorageBlockedView(block: block, checkout: checkout, onDone: onDone)
            case .link(let linkScreen):
                if linkScreen.availability == .payable {
                    PayableForm(checkout: checkout, link: linkScreen.link, pay: linkScreen.pay)
                } else {
                    NoticeScreen(
                        symbol: "exclamationmark.triangle.fill", symbolStyle: Color.warningText,
                        eyebrow: linkScreen.link.merchantName, subtitle: linkScreen.link.title,
                        notice: CheckoutCopy.notice(for: linkScreen.availability, link: linkScreen.link),
                        actions: [NoticeAction("Check Again", .prominent, checkout.reload), NoticeAction("Done", .plain, onDone)])
                }
            case .attempt(let attempt):
                AttemptView(checkout: checkout, attempt: attempt, onDone: onDone)
            }
        }
        .navigationTitle("Payment link")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Skeleton

/// The shape of the payable screen, redacted: what the person is about to see, in the places it will
/// appear, so the screen does not jump when the link arrives.
private struct CheckoutSkeleton: View {
    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Merchant name").font(.subheadline)
                    Text("Payment link title").font(.title2.bold())
                    Text("What is being paid for, in a sentence or two.").font(.body)
                    Text("₦18,500").font(.largeTitle.bold())
                }
                .padding(.vertical, 4)
            }
            Section {
                Text("Your name").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                Text("Email address").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            } header: {
                Text("Your details")
            }
            Section {
                Text("Pay ₦18,500").frame(maxWidth: .infinity, minHeight: 44)
            }
        }
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading payment link")
    }
}

// MARK: - The payable form

private struct PayableForm: View {
    let checkout: CheckoutController
    let link: CheckoutLink
    let pay: PayPhase
    @Bindable private var form: CheckoutForm
    @FocusState private var focus: PayerField?

    init(checkout: CheckoutController, link: CheckoutLink, pay: PayPhase) {
        self.checkout = checkout
        self.link = link
        self.pay = pay
        self.form = checkout.form
    }

    private var fields: [PayerField] { link.amountKobo == nil ? [.amount, .name, .email] : [.name, .email] }

    var body: some View {
        Form {
            Section {
                LinkSummary(link: link)
            }

            if let banner = Banner(pay) {
                Section {
                    Label(banner.text, systemImage: banner.symbol)
                        .foregroundStyle(banner.style)
                        .font(.subheadline.weight(.medium))
                        .accessibilityLabel(banner.spoken)
                }
            }

            Section {
                if link.amountKobo == nil {
                    FieldRow(label: "Amount", error: form.errors[.amount], activate: { focus = .amount }) {
                        TextField("Amount", text: $form.amountText, prompt: Text("₦0.00"))
                            .keyboardType(.decimalPad)
                            .focused($focus, equals: .amount)
                            .accessibilityLabel("Amount in naira")
                            .onChange(of: form.amountText) { form.edited(.amount) }
                    }
                    .id(form.resetCount)
                }
                FieldRow(label: "Your name", error: form.errors[.name], activate: { focus = .name }) {
                    TextField("Your name", text: $form.name, prompt: Text("Full name"))
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.next)
                        .focused($focus, equals: .name)
                        .onSubmit { focus = .email }
                        .onChange(of: form.name) { form.edited(.name) }
                }
                .id(form.resetCount)
                FieldRow(label: "Email", error: form.errors[.email], activate: { focus = .email }) {
                    TextField("Email", text: $form.email, prompt: Text("Email address"))
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focus, equals: .email)
                        .onSubmit { checkout.pay() }
                        .onChange(of: form.email) { form.edited(.email) }
                }
                .id(form.resetCount)
            } header: {
                Text("Your details")
            } footer: {
                Text("Your name and email go to \(link.merchantName) with the payment.")
            }
            .disabled(pay.isBusy)

            Section {
                Button {
                    focus = nil
                    checkout.pay()
                } label: {
                    HStack(spacing: 8) {
                        if pay.isBusy { ProgressView().tint(Color(.systemBackground)) }
                        Text(pay.isBusy ? "Starting Payment" : CheckoutCopy.payButtonTitle(fixedAmountKobo: link.amountKobo, typedAmount: form.amountText))
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .foregroundStyle(Color(.systemBackground))
                .disabled(pay.isBusy)
                .accessibilityLabel(pay.isBusy ? "Starting payment" : CheckoutCopy.payButtonSpoken(fixedAmountKobo: link.amountKobo, typedAmount: form.amountText))
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focus = nil }
            }
        }
        .onChange(of: form.errors) { _, errors in
            if let first = fields.first(where: { errors[$0] != nil }) { focus = first }
        }
        .onChange(of: pay) { _, phase in
            if let banner = Banner(phase) { AccessibilityNotification.Announcement(banner.spoken).post() }
        }
    }
}

/// The merchant, the title, the description and (for a fixed link) the amount.
private struct LinkSummary: View {
    let link: CheckoutLink

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(link.merchantName, systemImage: "storefront")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(link.title)
                .font(.title2.bold())
                .accessibilityAddTraits(.isHeader)
            if let description = link.description {
                Text(description)
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            if let amount = link.amountKobo {
                Text(Kobo.formatNaira(amount))
                    .font(.largeTitle.bold())
                    .monospacedDigit()
                    .accessibilityLabel(Kobo.spokenNaira(amount))
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A line above the fields about the last attempt to pay.
private struct Banner {
    let text: String
    let spoken: String
    let symbol: String
    let style: Color

    init?(_ phase: PayPhase) {
        switch phase {
        case .editing, .submitting:
            return nil
        case .rejected(let message):
            text = message
            spoken = "Error. " + message
            symbol = "exclamationmark.circle.fill"
            style = .errorText
        case .notRecorded:
            text = CheckoutCopy.notRecorded
            spoken = "Error. " + CheckoutCopy.notRecorded
            symbol = "lock.trianglebadge.exclamationmark.fill"
            style = .errorText
        case .priceChanged(let price):
            text = CheckoutCopy.priceChanged(newAmountKobo: price)
            spoken = "Price changed. " + CheckoutCopy.priceChanged(newAmountKobo: price)
            symbol = "exclamationmark.triangle.fill"
            style = .warningText
        }
    }
}

/// A field with a visible label above it and its validation message directly beneath, in the same row. The
/// whole row is the tap target (at least 44pt tall, label and error included): tapping the label, or the
/// space beside the text, puts the cursor in the field, as in a Settings form.
private struct FieldRow<Field: View>: View {
    let label: String
    let error: String?
    let activate: () -> Void
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            field
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.errorText)
                    .accessibilityLabel("Error: \(error)")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: activate)
    }
}
