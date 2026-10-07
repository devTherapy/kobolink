package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.money.Kobo

/** What [validatePayer] decided. */
sealed interface PayerValidation {
    data class Valid(val input: PayerInput) : PayerValidation
    data class Invalid(val errors: Map<PayerField, String>) : PayerValidation
}

private const val MAX_NAME_LENGTH = 80
private const val MAX_EMAIL_LENGTH = 254

/**
 * Pragmatic on purpose. The server (`EmailSchema`, zod) is the real arbiter and its
 * `validation_failed` field errors are shown beside the field if it disagrees; this only
 * stops the obviously unsendable ones before a round trip: something, an `@`, something, a
 * dot, something, and no spaces.
 */
private val EMAIL_SHAPE = Regex("""^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$""")

/**
 * The checkout form's rules, mirroring `PayForm.validate` in apps/web: the payer's amount (only when the
 * link has none fixed) must be a whole number of kobo inside the contract's limits, the name is
 * 1-80 characters once trimmed, and the email is trimmed and lower-cased like `EmailSchema`.
 *
 * [fixedAmountKobo] is the link's own amount. When it is not null the payer's [amountText] is
 * ignored: the amount is the link's, never something typed.
 *
 * The messages name the problem and the fix, and the amount message states the limits through
 * [Kobo.formatNaira], never through arithmetic of its own.
 */
fun validatePayer(
    fixedAmountKobo: Int?,
    amountText: String,
    name: String,
    email: String,
): PayerValidation {
    val errors = linkedMapOf<PayerField, String>()

    val amountKobo: Int? = if (fixedAmountKobo != null) {
        fixedAmountKobo
    } else {
        Kobo.parseNaira(amountText)?.takeIf(Kobo::isValidAmountKobo).also {
            if (it == null) {
                errors[PayerField.Amount] =
                    "Enter an amount between ${Kobo.formatNaira(Kobo.MIN_AMOUNT_KOBO)} and ${Kobo.formatNaira(Kobo.MAX_AMOUNT_KOBO)}."
            }
        }
    }

    val trimmedName = name.trim()
    when {
        trimmedName.isEmpty() -> errors[PayerField.Name] = "Enter your name."
        trimmedName.length > MAX_NAME_LENGTH -> errors[PayerField.Name] = "Use $MAX_NAME_LENGTH characters or fewer."
    }

    val normalisedEmail = email.trim().lowercase()
    if (normalisedEmail.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.matches(normalisedEmail)) {
        errors[PayerField.Email] = "Enter a valid email address."
    }

    if (errors.isNotEmpty() || amountKobo == null) return PayerValidation.Invalid(errors)
    return PayerValidation.Valid(PayerInput(amountKobo = amountKobo, name = trimmedName, email = normalisedEmail))
}
