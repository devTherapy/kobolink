import Foundation
import Observation

/// What the person typed, checked the way the server will check it (`TransferRequestSchema`), so a mistake shows
/// beside its field instead of as a refused request. Money is integer kobo.
public enum SendValidation: Equatable, Sendable {
    case valid(TransferInstruction)
    case invalid([SendField: String])

    public static let phoneBlank = "Enter the recipient's phone number."
    public static let phoneInvalid = "Enter a Nigerian mobile number, like 0803 123 4567."
    public static let amountBlank = "Enter an amount."
    public static let amountUnreadable = "Use digits only, like 1,500 or 1,500.50."
    public static var amountTooSmall: String { "The smallest amount you can send is \(Kobo.formatNaira(Kobo.minAmountKobo))." }
    public static var amountTooLarge: String { "The most you can send at once is \(Kobo.formatNaira(Kobo.maxAmountKobo))." }
    public static let noteTooLong = "Keep the note to \(TransferInstruction.noteMaxLength) characters or fewer."

    public static func validate(phone: String, amountText: String, note: String) -> SendValidation {
        var errors: [SendField: String] = [:]
        if let problem = problem(with: .phone, text: phone, required: true) { errors[.phone] = problem }
        if let problem = problem(with: .amount, text: amountText, required: true) { errors[.amount] = problem }
        if let problem = problem(with: .note, text: note, required: false) { errors[.note] = problem }

        guard errors.isEmpty,
            let normalised = NigerianPhone.normalize(phone),
            let kobo = Kobo.parseNaira(amountText)
        else { return .invalid(errors) }
        return .valid(TransferInstruction(toPhone: normalised, amountKobo: kobo, note: TransferInstruction.cleanNote(note).note))
    }

    /// One field on its own. With `required: false` an empty field is fine; the form uses that when the person
    /// leaves a field they have not typed in, so nobody is told off for a field they have not reached yet.
    public static func problem(with field: SendField, text: String, required: Bool) -> String? {
        let blank = JavaScriptText.trimmed(text).isEmpty
        switch field {
        case .phone:
            if blank { return required ? phoneBlank : nil }
            return NigerianPhone.normalize(text) == nil ? phoneInvalid : nil
        case .amount:
            if blank { return required ? amountBlank : nil }
            guard let kobo = Kobo.parseNaira(text) else { return amountUnreadable }
            if kobo < Kobo.minAmountKobo { return amountTooSmall }
            if kobo > Kobo.maxAmountKobo { return amountTooLarge }
            return nil
        case .note:
            return TransferInstruction.cleanNote(text).tooLong ? noteTooLong : nil
        }
    }
}

/// The text fields of the send form, and the error beside each. Held by the controller (not by the view) so that
/// signing out can empty them synchronously, whatever the view is doing.
@MainActor
@Observable
public final class SendForm {
    /// What was typed, or filled in from a scanned code. Written only through `setPhone`, so the scanned name can
    /// follow it.
    public private(set) var phone = ""
    public var amountText = ""
    public var note = ""
    /// The name the scanned code carried. UNVERIFIED: shown labelled as such, and dropped as soon as the number it
    /// came with is no longer the number in the field.
    public private(set) var scannedName: String?
    /// The number that name came with, E.164.
    @ObservationIgnored private var scannedPhone: String?
    public internal(set) var errors: [SendField: String] = [:]
    /// Bumped by every reset. The view gives its fields this as their identity, so a field that is focused (and so
    /// keeps showing what it was last given) is rebuilt instead of trusted to follow the binding.
    public internal(set) var resetCount = 0

    public init() {}

    public var isEmpty: Bool { phone.isEmpty && amountText.isEmpty && note.isEmpty && scannedName == nil }

    /// The person edited the number. A name that came with another number does not describe this one.
    public func setPhone(_ text: String) {
        phone = text
        errors[.phone] = nil
        if scannedName != nil, NigerianPhone.normalize(text) != scannedPhone {
            scannedName = nil
            scannedPhone = nil
        }
    }

    /// Filled from a scanned code: the number (as people write it), the requested amount if there is one, and the
    /// name, kept beside the number it came with.
    func fill(from payee: ScannedPayee) {
        phone = NigerianPhone.display(payee.toPhone)
        amountText = payee.amountKobo.map(Kobo.fieldText) ?? ""
        note = ""
        errors = [:]
        scannedName = payee.displayName
        scannedPhone = payee.toPhone
        resetCount += 1
    }

    /// The person edited `field` (other than the number): its error no longer describes what is typed.
    public func edited(_ field: SendField) {
        errors[field] = nil
    }

    /// The person left `field`: say what is wrong with it now, rather than when they press Review.
    public func left(_ field: SendField) {
        let text: String
        switch field {
        case .phone: text = phone
        case .amount: text = amountText
        case .note: text = note
        }
        errors[field] = SendValidation.problem(with: field, text: text, required: false)
    }

    func reset() {
        phone = ""
        amountText = ""
        note = ""
        scannedName = nil
        scannedPhone = nil
        errors = [:]
        resetCount += 1
    }
}
