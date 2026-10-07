# Kobolink iOS

SwiftUI app, iOS 17+, bundle id `com.folusayo.kobolink`. Xcode 26.

```
Kobolink.xcodeproj   hand-authored, file-system-synchronised (no per-file entries)
Kobolink/            app target: App, views, Info.plist, asset catalog
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

`kobolink://l/{code}` and `https://pay.folusayo.com/l/{code}` both land on `LinkLandingView`
(the checkout itself is feature I3). In the Simulator, with the app installed:

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
