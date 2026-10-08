# Kobolink iOS

SwiftUI app, iOS 17+, bundle id `com.folusayo.kobolink`. Xcode 26.

```
Kobolink.xcodeproj   hand-authored, file-system-synchronised (no per-file entries)
Kobolink/            app target: App, views, Info.plist, asset catalog
KobolinkAppTests/    tests hosted by Kobolink.app (the real Keychain needs a host process)
Config/              xcconfigs: API base URL per configuration, version, deployment target
KobolinkKit/         package: typed API client, config, view model, and the generated models
  Sources/KobolinkAPI/openapi.json   symlink to apps/api/openapi.json (the only input)
OpenAPITooling/      package: normalise the spec + run swift-openapi-generator, as a build plugin
```

## Commands

```sh
# Build + run the unit tests on a Simulator (one command, the CI command).
xcodebuild test -project mobile/ios/Kobolink.xcodeproj -scheme Kobolink \
  -destination 'platform=iOS Simulator,name=iPhone 17' -skipPackagePluginValidation

# Tests for the generation tooling (they read the real spec from disk, so they run on the Mac).
cd mobile/ios/OpenAPITooling && swift test
```

`-skipPackagePluginValidation` is needed only on the command line; Xcode asks once
("Trust & Enable") for the `GenerateAPI` plugin.

## Deep links

`kobolink://l/{code}` and `https://pay.folusayo.com/l/{code}` both land on `LinkLandingView`,
which is the checkout (`CheckoutView`, feature I3; see "Checkout" below). In the Simulator, with the app installed:

```sh
xcrun simctl openurl booted 'kobolink://l/aBcDeFgH'
```

```
KobolinkKit/Sources/KobolinkKit/
  LinkCodeParser.swift      LinkCode + the parser. Pure, no I/O; the only thing that reads a URL
  DeepLinkNavigator.swift   LinkRouting (URL -> destination), DeepLinkNavigator (the stack's state)
Kobolink/RootView.swift     the NavigationStack; onOpenURL + onContinueUserActivity; SceneStorage
```

- A link lands as the only screen above home. A second link replaces it, so Back always returns
  home. The same link twice changes nothing (SwiftUI can report one universal link twice).
- Cold and warm starts take the same path: the handlers are on the root stack, not on a screen.
- The open link's code is saved with the scene (`@SceneStorage`) and restored on relaunch. A link
  that launched the app wins over a restored one.
- Anything that is not a link: another page of the web app (`https://pay.folusayo.com/dashboard`)
  opens in `SFSafariViewController`. Every other URL (a `kobolink://` URL that names nothing,
  `http`, another host, a port) lands on the "can't be opened" screen: an in-app browser around
  someone else's page, inside an app people trust, is a phishing surface. The host is read with the
  parser's WHATWG rules (`LinkCodeParser.isLinkHostWebURL`), not `URL.host`, because WebKit renders it.
- Dismissing the web page (Done) clears it, so the same page can open again. A saved link is restored
  once per launch and only if no URL launched the app, in either order of `.task` and `onOpenURL`.

### The parser and the oracle

`LinkCodeParser` accepts what `parseLinkCode` in `packages/contracts/src/routes.ts` accepts, on
`https://pay.folusayo.com` and `kobolink`, and nothing more. It does not use `URL`,
`URLComponents` or `NSRegularExpression`: they disagree with WHATWG (the URL parser `parseLinkCode`
is built on) about percent-escapes, `//`, backslashes, dot segments and a space in the query.
`LinkCodeParser`'s doc comment lists the quirks it inherits and the four ways it is deliberately
stricter (`scheme`, `host`, `port`, `host-alias`), never looser.

`KobolinkKitTests/Resources/link-parser-oracle.json` is contracts' answer for 14k generated inputs;
`OracleTableTests` requires the parser to match every row. Regenerate it after any change to
`routes.ts`, and to try a bigger corpus without committing it:

```sh
npm ci --ignore-scripts && npm run build -w packages/contracts
node mobile/ios/KobolinkKit/Tools/generate-link-parser-cases.mjs                      # the committed table
node mobile/ios/KobolinkKit/Tools/generate-link-parser-cases.mjs --big 400000 /tmp/oracle.json
```

The generator is deterministic (seeded) and does not edit contracts. The oracle ran on Node 22;
WHATWG URL is specified, but a different engine is worth a re-run. `npm run test` (the contracts
suite, `tests/ios-oracle-table.test.ts`) regenerates the table in memory from contracts' source and
fails if the committed file differs, so a change to `routes.ts` cannot leave it stale unnoticed.

### Universal links (needs a paid Apple Developer account)

The wiring is written and held back: `Config/Kobolink.entitlements` declares
`applinks:pay.folusayo.com`, and only `Config/Release.xcconfig` points `CODE_SIGN_ENTITLEMENTS` at
it. Debug does not, so a free personal team and every Simulator run build and launch as before
(`DeepLinkConfigurationTests` fails if Debug ever references it). The URL scheme is registered in
both `Info.plist` and `Info-Debug.plist`. `onContinueUserActivity(NSUserActivityTypeBrowsingWeb)` and
`onOpenURL` already handle the `https` form, so enabling universal links needs no code change.

What the owner has to do, once:

1. Join the Apple Developer Program (a free personal team cannot add Associated Domains).
2. Add `DEVELOPMENT_TEAM = <your Team ID>` to `Config/Release.xcconfig` (a Team ID is not a secret;
   `Config/Local.xcconfig` is read by Debug only, so it is the wrong file). Do **not** set the team,
   or add Associated Domains, in Xcode's Signing & Capabilities editor: it writes
   `DEVELOPMENT_TEAM` and `CODE_SIGN_ENTITLEMENTS` into `project.pbxproj`, which Debug reads too, so
   a free team would stop building and `DeepLinkConfigurationTests` fails. The entitlement is already
   in `Config/Kobolink.entitlements`; Xcode registers the capability with Apple on the first signed
   Release build.
3. Set `APPLE_APP_ID=<TEAMID>.com.folusayo.kobolink` on the web app. It already serves
   `/.well-known/apple-app-site-association` as a route handler (F8) and answers 503 until it is set,
   rather than caching a wrong value on Apple's CDN.
4. After the first install on a device, check with `?mode=developer` appended to the domain in
   the entitlement (Settings > Developer > Associated Domains Development), then remove it.
   Do not spend time on this in the Simulator: Apple's universal-link handling there is unreliable.
   X3 verifies the hosted file end to end.

## Login and the session (I2)

```
KobolinkKit/Sources/KobolinkKit/
  TokenStore.swift          SessionToken (redacts itself), TokenStore protocol, InMemoryTokenStore (tests, previews)
  KeychainTokenStore.swift  the real store
  InstallMarker.swift       first-launch flag, for the reinstall purge
  AuthMiddleware.swift      Authorization: Bearer, and the 401 report; Retry-After capture
  SessionController.swift   states: resolving, signedOut(reason), signedIn, offline, storageUnavailable
  LoginViewModel.swift      the form: validation, error mapping, what is cleared and when
Kobolink/LoginView.swift, SessionScreens.swift   the screens
```

- **Token.** The API returns it in `AuthResponse.token` for `client: "mobile"` and accepts it as
  `Authorization: Bearer`. It lives only in the Keychain: a generic password,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, `kSecAttrSynchronizable: false`. It is never in
  `UserDefaults`, a file, a log, a URL or a notification. `SessionToken` prints as `<redacted>`
  (`print`, interpolation, `dump`), so a stray `print(session)` cannot leak it; `reveal()` has two
  callers, the Keychain write and the header. Nothing in the app prints, and the generated request and
  response types hold the password and the token, so thrown errors are mapped to `APIError` and
  discarded, never described.
- **Cold start.** Read the token, ask `/api/auth/me`. 200: signed in. 401: the token is dead, clear it,
  signed out with "Your session ended" (involuntary, distinct from a chosen sign-out, which has no
  notice). No answer, a 5xx or an unreadable reply: **offline**, token kept, Try Again or Sign Out.
  A Keychain that cannot be READ is its own state (`storageUnavailable`, Try Again), not "signed out":
  the token may still be there (a locked Keychain after a restart), and nothing falls back to other
  storage. A slot holding something that is not a token is cleared.
- **Reinstall.** The Keychain outlives the app, `UserDefaults` does not. The first launch of an install
  has no `InstallMarker`, so the controller removes whatever token the Keychain holds before trusting
  it, then sets the marker. A purge that fails is reported and retried; the marker is set only after
  it succeeds. A leftover token is never sent to the server.
- **Sign out** removes the token and changes state first, then asks the server to revoke that token
  (best effort, with the token passed explicitly because the store is already empty). Being offline cannot
  leave the device signed in. If the Keychain refuses the removal the state says so (`tokenNotRemoved`).
- **Mid-session 401.** `AuthMiddleware` reports the token that was rejected; the controller acts only
  if it is still the stored one and the person is signed in, so a late 401 for an old token cannot sign
  out the session that replaced it.
- **The form.** The password leaves the view model the moment the form is submitted and the secure
  field is rebuilt (a focused `SecureField` otherwise keeps showing, and can write back, what was typed
  when its binding is cleared). A failed attempt asks for it again. The whole form is emptied when
  the screen disappears (a link opened over it) and on success; a late answer to an attempt made
  before that is dropped. Double taps send one request. The Keychain write after a 200 runs in a task the
  screen's cancellation cannot reach.
- **No silent retry.** `waitsForConnectivity` is off, URLSession does not resend a POST, and nothing in
  the client does either; a failed login is shown and the person retries. Tests assert one request per failed login.
- **Rate limit.** The API sets `Retry-After` on a 429, but the OpenAPI document does not declare it,
  so the generated models drop it. `ResponseNotesMiddleware` records it into a per-call box and the
  error carries `retryAfterSeconds`; the screen says "Try again in 14 minutes".
- **Deep links.** A link is pushed over whatever the session screen is, so it wins in every state,
  signed in or out, resolving or offline. A payer never meets the merchant login. The public calls
  (link lookup, health) carry no token.
- **Wrong password and unknown user** are one message on purpose; the API answers both the same.

Not yet: there is no refresh, biometric unlock, "remember me" choice, or password reset. Per-user state
must be removed on sign-out and on a user change, and an entry saved while the session was not yet known
must be owned before it is trusted. Per-user state today: the token, the cached user (it lives only in
`SessionState`), the login form, and (I3) the checkout's form fields and the payment attempts made under
a session; "Checkout" below says exactly what clears them and when. `@SceneStorage("openLinkCode")` holds
a public link code, not user data.

To run against a stub instead of the real API, point `KOBOLINK_API_BASE_URL` at it in
`Config/Local.xcconfig`; no real credentials are needed or used.

## Checkout (I3)

```
KobolinkKit/Sources/KobolinkKit/
  Kobo.swift                  the ONLY file that divides or multiplies by 100; mirrors contracts' money.ts
  PayerValidation.swift       name / email / amount rules; mirrors the server's Zod schemas
  CheckoutModels.swift        CheckoutLink, InitializeRequest, StartedCheckout, CheckoutServing, IdempotencyKey
  CheckoutState.swift         CheckoutScreen and its parts: what the screen shows
  CheckoutController.swift    every decision: keys, slot, verdicts, latest-wins, session reactions
  CheckoutCopy.swift          every sentence; the non-payable deck is the web's, word for word
  PendingCheckout.swift       the persisted attempt, AttemptOwner, the store protocol and the in-memory store
  KeychainPendingCheckoutStore.swift   the real store
Kobolink/CheckoutView.swift, CheckoutNotices.swift, Palette.swift   the screens
```

`RootView` follows the navigation stack's one link: when it arrives the checkout `open`s it, when Back or
Done removes it the checkout `close`s (the form is emptied), and a second link replaces the first. A payer
never meets the merchant login: the link is pushed over the session screen and asks nothing of the session.
The public calls carry no token (`AuthMiddleware` is an allow-list of secured operations, checked
against `apps/api/openapi.json`) and the API session refuses every redirect.

**Money** is `Int` kobo end to end. `MoneyDisciplineTests` fails if a `/ 100`, `Double`, `Decimal` or
`NumberFormatter` appears in any other file. `KoboTests` repeats contracts' `money.test.ts` case for case and
checks 100+ formatting and 600+ parsing inputs against contracts' own answers
(`Tools/generate-money-cases.mjs`, `Tools/generate-payer-cases.mjs`; JavaScript's whitespace and ASCII-only
`\d` differ from Swift's, so they are implemented, not assumed).

**The payment attempt** (the lessons of Android's M3 and M5):

- One idempotency key per attempt, made when the attempt is made and written to the Keychain
  (generic password, `AfterFirstUnlockThisDeviceOnly`, not synchronizable, no file, so nothing for a backup
  to include) BEFORE the request leaves. If it cannot be written, nothing is sent and the screen says no
  money was taken (true: there is no earlier attempt).
- One slot per link code per DEVICE, read by `open` before any session has resolved. Done, Back, a
  relaunch and a process kill all show "Payment started" (same reference) or the interrupted attempt, and
  "Try Again" resends the SAME request under the SAME key. While an attempt exists the form is not shown,
  so its request cannot be edited under the old key. A new key is made only from the form, which is shown
  only when there is no slot: after a settled refusal (the link is then read afresh, so a changed price is
  seen first) or the person's confirmed "Start a New Payment" ("If you already paid, check with the
  merchant first"; a failed clear changes nothing and says so).
- What settles an attempt (`SendVerdict`): a 201 (kept: `verify`, I4, settles it); `not_found`,
  `link_not_payable`, `amount_mismatch` WITH `moneyMoved: false` and their own status (the only results
  `PaymentsService.decideInitialize` computes inside the idempotency layer, so they are the answer for that
  key whether first send or replay, and would be replayed forever); `validation_failed` on the very first
  send ever (the server validates before it records anything). Everything else (429, 5xx, a dropped
  connection, an unreadable reply, a redirect, a 401, `idempotency_mismatch`, a validation error on a
  replay) is "we couldn't confirm", the attempt and key are kept, and the copy never says no money moved.
- No silent retry: `waitsForConnectivity` off, `URLSession` does not resend a POST, nothing in the client
  does, and a retry writes nothing first, so a storage failure cannot turn a replay into a new attempt.
- Latest wins: a lookup answer is applied only if its generation is current and its link is still open; a
  payment answer reaches the screen only while its attempt is still on it, but its reference is always
  stored, and it only ever updates or removes the slot that still holds its own key, so a late answer
  cannot bring back an attempt that sign-out cleared.

**Ownership** (`AttemptOwner`, the one rule): an attempt made with no stored session is a payer's; one
made with a session (signed in, `resolving` or `offline`) belongs to that session, with the user id filled in
once `/me` confirms it. The check and a sign-in ADOPT every unconfirmed attempt for the user they confirm (a
sign-in never drops one: it may be the same person's, outcome unknown, and forgetting it would mint a second
key); only another CONFIRMED user's attempts are removed, and that is derived again from the session at every
launch, so it needs no record. An involuntary 401 removes nothing.

Sign-out is the one thing that owes the device a removal, and it is gated. Before the session changes anything,
`SessionController.signOut` asks `CheckoutController.prepareSignOut`, which writes a `SignOutObligation` to the
Keychain naming every session attempt (and unreadable slot) on the device by link code and idempotency key. If
that cannot be written (or the device's attempts cannot be listed, or an earlier obligation cannot be read) the
sign-out DOES NOT HAPPEN: the person stays signed in with the token kept, and the app says "Couldn't sign out
safely". Naming attempts by key, not by a time, means a leftover obligation can never remove a later session's
attempt, whatever the clock says. The sign-out then removes what it named and takes the record back; a
removal that fails leaves the record, and what it names is hidden (`storageBlocked`) until it succeeds. A new
process reads the record BEFORE anything else a session event does: an adoption or a merge that ran first would
relabel or overwrite what it names. A record this build cannot read blocks every link, and the only way out
that cannot risk a second key is "Reset Checkout Data" (confirmed: "If you already paid, check with the
merchant first"), which forgets every payment saved on the device.

A stored name or email is never shown on any screen: `AttemptScreen` has no field for them, "Start a New
Payment" opens an empty form, and `CheckoutPrivacyTests` checks every presented state; they are only sent
again, in a same-key "Try Again". The words are neutral about who started a payment ("A payment on this iPhone
was started and not finished"): a different merchant who signs in after an expiry adopts an unconfirmed attempt
that was not theirs. Known limits: a payer's slot is per device, so two payers on one phone share it (they see
the amount, merchant and reference); every slot survives a reinstall; a reusable link cannot be paid twice until
`verify` (I4) settles the first, except through "Start a New Payment"; if the obligation record cannot be
taken back after a successful removal it names attempts that are gone, which keys make harmless.

**Tests**: `swift test` in `KobolinkKit` (macOS, fast, 350+ tests) and the command under "Commands" (the
Simulator, which also runs the hosted Keychain tests). Verification against a throwaway local stub API:
point `KOBOLINK_API_BASE_URL` at it in `Config/Local.xcconfig`, then
`xcrun simctl openurl booted 'kobolink://l/aBcDeFgH'`.

## Wallet (I5, Phase 2)

```
KobolinkKit/Sources/KobolinkKit/
  WalletModels.swift            WalletBalance, WalletActivity, TransferInstruction, TransferReceipt, WalletServing
  KobolinkAPIClient+Wallet.swift  the three secured calls
  TransferOutcome.swift         TransferFailure, MoneyOutcome, TransferVerdict: the one place that decides what an answer settles
  PendingTransfer.swift         TransferAttempt (key + exact request + user), the store protocol and the in-memory store
  KeychainPendingTransferStore.swift  the real store, one Keychain item per USER
  SendController.swift          the send state machine: keys, slot, verdicts, sign-out obligation, latest-wins
  SendForm.swift / SendState.swift    the typed fields, validation, what the sheet shows
  WalletHomeController.swift    balance (asOf), cursor paging, refresh generations
  ScanController.swift          camera states behind the CameraAccess seam
  QrPayloadDecoder.swift        the one place that knows the QR format
  WalletCopy.swift              every sentence; the money line is only ever a statement the app can back
  WalletController.swift        composition, session wiring, SignOutGate
Kobolink/WalletHomeView.swift, SendSheet.swift, SendResultViews.swift, ScanScreenView.swift,
  QRScannerView.swift, SystemCameraAccess.swift      the screens and the AVFoundation camera
```

The signed-in home is a tab bar: **Wallet** (large title, balance, Send Money, Scan to Pay, Recent activity with pull
to refresh) and **Account** (what I2 had). Send and Scan are one sheet; closing it and reopening it shows the same
payment. Wallet endpoints are secured operations, so the token rides on them, to the API origin only.

**The lessons of Android's M5**, each a test (the checklist is in the PR):

- **A note-less payment OMITS `note`** (contracts: optional, not nullable). `TransferWireTests` serialises through the
  generated client; `WalletConfigurationTests` pins the document's shape.
- **One key per payment, written to the Keychain BEFORE the request leaves**, in the signed-in user's slot, with the
  same item attributes as the checkout's store. `Try Again` is the identical request under the same key and writes
  nothing first. A relaunch, Close, or a killed process restores the payment as "we never saw how it ended".
- **What settles an attempt** (`TransferVerdict`): `not_found` 404, `insufficient_funds` 422 and the own-number
  `validation_failed` 400, each with `moneyMoved: false` (the only refusals `WalletService.decideTransfer` computes inside
  `IdempotencyService.run`, so they are the stored answer for the key), and the body-validation 400 on the very first
  send. Everything else (401, 429, 5xx, a dropped connection, an unreadable reply, a redirect, `idempotency_mismatch`, a
  validation error on a retry, a storage failure on a retry) keeps the attempt and the key. "No money was taken" is
  said only for those; unknown outcomes say "We couldn't confirm the payment. Check Recent activity before paying again."
  The only exits from an unknown outcome are a success, a stored refusal, "I Checked: It Didn't Go Through" (confirmed),
  and a confirmed sign-out.
- **The QR name is attacker-controlled.** The phone number is the identifier on every screen; the name sits under it,
  labelled "Name in the QR code (not verified)", and is dropped when the number is edited. The decoder is strict (one JSON
  object, four keys once each, `v` 1, E.164, a clean name, an amount inside the transfer bounds). B8 has no recipient lookup
  endpoint; until one exists nothing can verify a name.
- **No older balance as "now".** The balance is shown with its `asOf`; a read older than the one held, and a replay's
  stored original reply with nothing newer to compare, are not adopted. Every success and every `insufficient_funds`
  refreshes; opening Send refreshes. A stale "load more" after a refresh is dropped (generation), and so is any reply
  after a sign-out or user change (epoch).
- **Sign-out and user change** empty the form (phone, amount, note, scanned name), the balance and the activity. A
  sign-out is gated: `SignOutGate` makes the wallet's `SignOutObligation` (slot + key) and the checkout's both safe before
  the session changes, takes the wallet's back if the checkout refuses, and the confirmation says "A payment on this
  iPhone was started and not finished". An involuntary 401 clears nothing, and the same user signing back in gets the
  payment back; another user's session never loads, shows or removes it.

**Camera.** `NSCameraUsageDescription` is in both Info.plists. Never asked: a screen says what the camera is for, then the
system prompt. Denied: explains and opens Settings. Restricted: explains, no Settings button. No camera (the
Simulator): says so. "Enter Details Instead" is on every state. The camera view hands text to `ScanController`; it
has a metadata output for QR codes and no photo, movie or data output.

Not done: top-up (the endpoint exists, the app has no way to add money yet), transfer to a contact, a recipient lookup,
iPad, VoiceOver by ear, a physical device and a real camera.

## Generated models

Nothing generated is checked in. Every build of `KobolinkAPI` runs `GenerateAPI`, which
normalises `apps/api/openapi.json` (see `OpenAPITooling/Sources/SpecNormalizer`) and runs
swift-openapi-generator on it. Change a field in `packages/contracts`, run
`npm run generate:openapi -w apps/api`, and the next iOS build either regenerates cleanly
or fails to compile where the app still uses the old shape. A wire-incompatible change to a
field no Swift code references (a retyped or newly required field nothing reads yet) still
compiles; it fails at decode time, which is what the decode tests in `KobolinkKitTests` are for.

## API base URL

`Config/Debug.xcconfig` points at `http://localhost:3001`; Release at `https://pay.folusayo.com`.
Override per machine in `Config/Local.xcconfig` (gitignored; see `Local.xcconfig.example`), which
only Debug reads. The value reaches the app as the Info.plist key `KobolinkAPIBaseURL`. No secrets
live here. Release is https-only and has no `localhost` exception: only the Debug build uses
`Kobolink/Info-Debug.plist` (with the ATS local-networking key), and `APIConfiguration` refuses
an http URL or a URL with a path in a Release build.

For a physical device, put your signing team in `Config/Local.xcconfig`:
`DEVELOPMENT_TEAM = ABCDE12345` (a free personal team is enough for Debug).
