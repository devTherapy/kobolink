package com.folusayo.kobolink.auth

/**
 * `POST /api/auth/login`'s response and `GET /api/auth/me`'s response both
 * embed the exact same shape as `packages/contracts/src/users.ts`'s
 * `UserSchema` — but the OpenAPI document inlines that object at each call
 * site rather than emitting a shared `$ref` (see `AuthResponse`/`MeResponse`
 * in `apps/api/openapi.json`), so `openApiGenerate` mints two unrelated
 * Kotlin classes, `AuthResponseUser` and `MeResponseUser`, for what is
 * conceptually one `User`. That is a B7/OpenAPI-generation detail this
 * feature does not own or touch; this type is where [AuthRepository]
 * flattens both into one shape so nothing above it — [AuthRepository]'s
 * callers, `LoginScreen`, `HomeScreen` — has to know or care which endpoint
 * produced the user it is holding.
 */
data class AuthenticatedUser(
    val id: String,
    val email: String,
    val displayName: String,
)
