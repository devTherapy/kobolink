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

## Generated models

Nothing generated is checked in. Every build of `KobolinkAPI` runs `GenerateAPI`, which
normalises `apps/api/openapi.json` (see `OpenAPITooling/Sources/SpecNormalizer`) and runs
swift-openapi-generator on it. Change a field in `packages/contracts`, run
`npm run generate:openapi -w apps/api`, and the next iOS build either regenerates cleanly
or fails to compile where the app still uses the old shape.

## API base URL

`Config/Debug.xcconfig` points at `http://localhost:3001`; Release at `https://pay.folusayo.com`.
Override per machine in `Config/Local.xcconfig` (gitignored; see `Local.xcconfig.example`).
The value reaches the app as the Info.plist key `KobolinkAPIBaseURL`. No secrets live here.
