/**
 * @kobolink/contracts
 *
 * Every shape that crosses a process boundary lives here, once. The API
 * implements these, the web app mocks them, and the OpenAPI document generated
 * from them produces the Swift and Kotlin models. A disagreement between any
 * two of those is a compile error, not a conversation.
 *
 * Only the orchestrator edits this package. A domain agent that needs a shape
 * changed reports the exact change and stops.
 */
export const CONTRACTS_VERSION = '0.1.0' as const

export * from './money.js'
export * from './code.js'
export * from './primitives.js'
export * from './users.js'
export * from './links.js'
export * from './payments.js'
export * from './dashboard.js'
export * from './wallet.js'
export * from './errors.js'
export * from './routes.js'
export * from './status.js'
export * from './fixtures.js'
export * from './registry.js'
