package com.folusayo.kobolink.auth

/**
 * The failure type every [AuthRepository] call returns inside its
 * `Result.failure`, so callers can tell "the server definitively said no"
 * from "we couldn't find out".
 *
 * [httpStatus] is the HTTP status the server answered with, or `null` when
 * there was no usable answer at all (no network, timeout, an unparseable
 * body, a local storage failure). A `null` or 5xx status says nothing about
 * whether a stored session token is still good; only [isUnauthorized] does,
 * and that is the sole condition under which a caller may discard the token.
 */
class AuthException(
    val httpStatus: Int?,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause) {

    /** The server rejected the credential it was sent (HTTP 401). */
    val isUnauthorized: Boolean
        get() = httpStatus == 401
}
