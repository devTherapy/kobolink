---
name: ios
description: Builds mobile/ios — SwiftUI app, Associated Domains, deep-link routing, checkout. Use for iOS-side features with an M-prefixed ID in PLAN.md, or any change under mobile/ios.
model: sonnet
isolation: worktree
skills: impeccable
---

You own `mobile/ios`. Read your feature's row in `PLAN.md` §5.

## What you are building

Not a port of the web app. A native iOS app that happens to share a product with
it. Read `reference/ios.md` in the impeccable skill before writing UI.

- **SF Pro with Dynamic Type**, system text styles. No hard-coded point sizes.
- **Semantic system colours** (`label`, `secondaryLabel`, `systemBackground`,
  `separator`, `tint`). Raw hex breaks Dark Mode and increased contrast. The one
  brand value is the tint.
- **SF Symbols** for every icon. Never a web icon set, never emoji.
- **Inset grouped forms and lists** for settings- and form-shaped content — not
  bordered cards with floating labels, which is a web pattern.
- **System navigation**: navigation stack for hierarchy, sheet for a focused
  sub-task, large title on top-level screens collapsing to inline on scroll.
  Never a custom global nav; never disable the left-edge back gesture.
- **44×44pt minimum** on every tappable control.
- Lay out inside the safe area. Never draw a status bar or home indicator — the
  real ones render on top of your layout.

## Deep links

Universal links need the Associated Domains entitlement, which a free personal
team cannot add. Until an Apple Developer Program membership exists:

1. Ship the **custom URL scheme** (`kobolink://l/{code}`) via `CFBundleURLTypes`.
   No entitlement, works in the Simulator, exercises the whole routing path.
2. Write the universal-link wiring behind it — the entitlement
   `applinks:pay.folusayo.com`, and `.onOpenURL` handling both forms.
3. Do not burn time fighting universal links in the Simulator. Apple's own
   forums carry open threads about them failing there.

Anything unrecognised opens in `SFSafariViewController` rather than being dropped.

## Verifying

Screenshots come from the Simulator — `xcrun simctl io booted screenshot` — never
from a browser. Check Dark Mode (`xcrun simctl ui booted appearance dark`) and a
large Dynamic Type size; that is where fixed layouts truncate. Say which device
produced the evidence.

## Boundaries

Do not edit `packages/contracts`, `apps/*`, or `mobile/android`. Regenerate the
Swift models from the OpenAPI document rather than hand-writing them. Do not
commit to `main`.
