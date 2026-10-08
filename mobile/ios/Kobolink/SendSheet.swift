import KobolinkKit
import SwiftUI

/// The send flow, in a sheet: a focused task with a clear Close. Its steps are `SendController.screen`, so
/// closing and reopening it shows the same payment, and a payment of unknown outcome is still there.
struct SendSheet: View {
    let wallet: WalletController

    var body: some View {
        let send = wallet.send
        NavigationStack {
            content(for: send.screen)
                .navigationTitle(title(for: send.screen))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // The sent screen has its own Done; a second one in the bar would say it twice.
                    if !isSent(send.screen) {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { wallet.isSendPresented = false }
                                .disabled(isSending(send.screen))
                        }
                    }
                }
        }
        // Leaving while the request is in the air would hide the one thing the person is waiting to learn.
        .interactiveDismissDisabled(isSending(send.screen))
    }

    @ViewBuilder private func content(for screen: SendScreen) -> some View {
        switch screen {
        case .idle:
            Color.clear
        case .scan:
            ScanScreenView(wallet: wallet)
        case .form:
            SendFormView(wallet: wallet)
        case .confirm(let draft):
            ReviewView(send: wallet.send, draft: draft)
        case .sending(let attempt, let replay):
            SendingView(attempt: attempt, replay: replay)
        case .sent(let attempt, let receipt, let replayed):
            SentView(wallet: wallet, attempt: attempt, receipt: receipt, replayed: replayed)
        case .failed(let attempt, let failure):
            FailedView(wallet: wallet, attempt: attempt, failure: failure)
        case .blocked(let block):
            BlockedView(send: wallet.send, block: block, close: { wallet.isSendPresented = false })
        }
    }

    private func isSending(_ screen: SendScreen) -> Bool {
        if case .sending = screen { true } else { false }
    }

    private func title(for screen: SendScreen) -> String {
        switch screen {
        case .idle, .form: "Send Money"
        case .scan: "Scan to Pay"
        case .confirm: "Review"
        case .sending: "Sending"
        case .sent: "Sent"
        case .failed(_, let failure): failure.isSettled ? "Not Sent" : "Not Confirmed"
        case .blocked: "Can't Send Yet"
        }
    }

    private func isSent(_ screen: SendScreen) -> Bool {
        if case .sent = screen { true } else { false }
    }
}

// MARK: - The form

private struct SendFormView: View {
    let wallet: WalletController
    @Bindable private var form: SendForm
    @FocusState private var focus: SendField?

    init(wallet: WalletController) {
        self.wallet = wallet
        self.form = wallet.send.form
    }

    var body: some View {
        Form {
            Section {
                FieldRow(label: "Phone number", error: form.errors[.phone], activate: { focus = .phone }) {
                    TextField(
                        "Phone number", text: Binding(get: { form.phone }, set: { form.setPhone($0) }),
                        prompt: Text("0803 123 4567")
                    )
                    .keyboardType(.phonePad)
                    .focused($focus, equals: .phone)
                    .accessibilityLabel("Recipient's phone number")
                }
                .id(form.resetCount)

                if let name = form.scannedName {
                    QRNameRow(name: name)
                }

                Button {
                    focus = nil
                    wallet.startScanning()
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
            } header: {
                Text("Send to")
            }

            Section {
                FieldRow(label: "Amount", error: form.errors[.amount], activate: { focus = .amount }) {
                    HStack(spacing: 4) {
                        Text("₦").foregroundStyle(.secondary).accessibilityHidden(true)
                        TextField("Amount", text: $form.amountText, prompt: Text("0.00"))
                            .keyboardType(.decimalPad)
                            .focused($focus, equals: .amount)
                            .accessibilityLabel("Amount in naira")
                            .onChange(of: form.amountText) { form.edited(.amount) }
                    }
                }
                .id(form.resetCount)
            } footer: {
                Text("From \(Kobo.formatNaira(Kobo.minAmountKobo)) to \(Kobo.formatNaira(Kobo.maxAmountKobo)).")
            }

            Section {
                FieldRow(label: "Note (optional)", error: form.errors[.note], activate: { focus = .note }) {
                    TextField("Note", text: $form.note, prompt: Text("What is it for?"), axis: .vertical)
                        .lineLimit(1...4)
                        .focused($focus, equals: .note)
                        .accessibilityLabel("Note, optional")
                        .onChange(of: form.note) { form.edited(.note) }
                }
                .id(form.resetCount)
            } footer: {
                Text("Your recipient sees it with the payment. Up to \(TransferInstruction.noteMaxLength) characters.")
            }

            Section {
                Button {
                    focus = nil
                    wallet.send.review()
                } label: {
                    Text("Review").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .foregroundStyle(Color(.systemBackground))
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
            if let first = [SendField.phone, .amount, .note].first(where: { errors[$0] != nil }) { focus = first }
        }
    }
}

/// A field with a visible label above it and its validation message directly beneath, in the same row. The whole
/// row is the tap target (at least 44pt tall), as in a Settings form.
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

/// The name a scanned code carried: secondary, labelled as unverified, and never above the number.
struct QRNameRow: View {
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(WalletCopy.qrNameLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(name)
                .font(.body)
                .foregroundStyle(.secondary)
            Text(WalletCopy.qrNameWarning)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(WalletCopy.qrNameLabel): \(name). \(WalletCopy.qrNameWarning)")
    }
}

// MARK: - Review

private struct ReviewView: View {
    let send: SendController
    let draft: TransferDraft

    private var amount: String { Kobo.formatNaira(draft.instruction.amountKobo) }
    private var number: String { NigerianPhone.display(draft.instruction.toPhone) }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("You're sending")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(amount)
                        .font(.largeTitle.bold())
                        .monospacedDigit()
                        .lineLimit(1)
                    .minimumScaleFactor(0.4)
                        .accessibilityLabel(Kobo.spokenNaira(draft.instruction.amountKobo))
                }
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }

            Section {
                Text(number)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .accessibilityLabel(NigerianPhone.spoken(draft.instruction.toPhone))
                if let name = draft.payeeName {
                    QRNameRow(name: name)
                }
            } header: {
                Text("To")
            }

            if let note = draft.instruction.note {
                Section {
                    Text(note).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                } header: {
                    Text("Note")
                }
            }

            Section {
                Button(action: send.confirm) {
                    Text("Send \(amount)").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .foregroundStyle(Color(.systemBackground))
                .accessibilityLabel("Send \(Kobo.spokenNaira(draft.instruction.amountKobo)) to \(NigerianPhone.spoken(draft.instruction.toPhone))")

                Button(action: send.editDetails) {
                    Text("Edit Details").frame(maxWidth: .infinity, minHeight: 44)
                }
                .controlSize(.large)
            } footer: {
                Text(WalletCopy.reviewFooter)
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }
}
