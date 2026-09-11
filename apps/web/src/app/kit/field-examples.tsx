'use client'

import { useState } from 'react'
import { Field } from '@/components/ui/Field'

/**
 * `Field` needs a controlled `value`/`onChange` (or `valueKobo`/`onChangeKobo`
 * for the amount variant), so showing every state needs local state — the
 * one client boundary on an otherwise data-free, server-rendered kit page.
 */
export function TextFieldExample() {
  const [title, setTitle] = useState('')
  const [requiredValue, setRequiredValue] = useState('')
  const [disabledValue] = useState('Cannot edit')
  const [loadingValue, setLoadingValue] = useState('')
  const [email, setEmail] = useState('not-an-email')
  const [amount, setAmount] = useState<number | null>(1_850_000)
  const [amountEmpty, setAmountEmpty] = useState<number | null>(null)

  return (
    <>
      <Field
        label="Title"
        name="title"
        autoComplete="off"
        value={title}
        onChange={setTitle}
        hint="Shown to the payer"
        placeholder="e.g. Ankara Two-Piece Set…"
      />
      <Field
        label="Required field"
        name="required-field"
        autoComplete="off"
        value={requiredValue}
        onChange={setRequiredValue}
        required
      />
      <Field
        label="Disabled field"
        name="disabled-field"
        autoComplete="off"
        value={disabledValue}
        onChange={() => undefined}
        disabled
      />
      <Field
        label="Loading field"
        name="loading-field"
        autoComplete="off"
        value={loadingValue}
        onChange={setLoadingValue}
        loading
        hint="Fetching a default…"
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error="Enter a valid email address."
      />
      <Field
        variant="amount"
        label="Amount"
        name="amount"
        autoComplete="off"
        valueKobo={amount}
        onChangeKobo={setAmount}
      />
      <Field
        variant="amount"
        label="Amount (empty)"
        name="amount-empty"
        autoComplete="off"
        valueKobo={amountEmpty}
        onChangeKobo={setAmountEmpty}
        hint="Leave blank to let the payer choose"
      />
    </>
  )
}
