/**
 * @kobolink/contracts
 *
 * Every shape that crosses a process boundary lives here, once. The API
 * implements these, the web app mocks them, and the OpenAPI document generated
 * from them produces the Swift and Kotlin models. A disagreement between any
 * two of those is a compile error, not a conversation.
 *
 * X1 populates this package. The version below is the only export until then,
 * so the workspace wiring, the gate and CI can be proven on their own.
 */
export const CONTRACTS_VERSION = '0.0.0' as const
