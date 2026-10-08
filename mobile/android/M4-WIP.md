# M4 Android result states - WIP note (weekly pause, owner ordered)

Branch feat/M4-android-results, off origin/main 4f904cf. Nothing implemented in code yet.

## Done
- Branch created; scope and rules re-read from the brief (verify settles slots only on a decided answer; separate key generator; M3 invariants kept).
- PLAN.md M4 row marked in-progress.

## Not done
- Everything in the build: verify gateway call, VerifyVerdict/slot settlement, result state machine (paid, failed, expired, disabled, already paid, not found, still processing with 2/4/8 s re-asks, unknown outcome), CheckoutCopy additions (web wording word for word), ResultScreen (Compose, M3, live region), tests and mutation proofs, README section.
- No Gradle run has happened; nothing is verified or compiled.

## Next step
Read iOS reference (CheckoutController, CheckoutModels, CheckoutCopy, PendingCheckout, ResultView, CheckoutVerifyTests, CheckoutResultCopyTests, mobile/ios/README.md I4) and the Android CheckoutController/Gateway/PendingCheckoutStore/CheckoutCopy, then port I4. Delete this file when M4 lands.
