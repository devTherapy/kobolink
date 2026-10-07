package com.folusayo.kobolink.auth

/**
 * The signed-in user as the rest of the app needs to see them. `login` and
 * `me` both return the same `User` shape; this type is where
 * [AuthRepository] flattens the generated class into one so nothing above it
 * — `LoginScreen`, the wallet screens — depends on a generated name.
 */
data class AuthenticatedUser(
    val id: String,
    val email: String,
    val displayName: String,
)
