/**
 * Starts the MSW browser worker when `NEXT_PUBLIC_API_MOCKING=enabled` — the
 * escape hatch that lets `npm run dev` run the web app against
 * `packages/contracts` fixtures with no `apps/api` process running. Unset
 * the flag (the default) to talk to the real API via the `next.config.ts`
 * rewrite; MSW's worker only ever intercepts requests already inside the
 * browser (it is a Service Worker), never a server render or a route
 * handler, mocking flag or not.
 *
 * This file runs before React hydrates (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md),
 * which is why the worker starts here rather than inside a mounted
 * component's effect — that previous approach (see git history) only began
 * once the whole React tree had already committed, and gating rendering on
 * it turned out to unmount and remount the app once the worker caught up,
 * which is worse than the race it was trying to prevent.
 *
 * Next.js is explicit, though, that only *synchronous* top-level code here
 * is guaranteed to finish before hydration begins — an `import()` or a
 * `Promise`, this one included, is fire-and-forget and may still resolve
 * after hydration has started. There is no way to truly block on an async
 * Service Worker registration from this hook, so a request made in the
 * first tick of hydration can still occasionally race an unstarted worker.
 * That is an accepted limit of a dev-only convenience flag: it narrows the
 * window a great deal (starting before the tree exists beats starting after
 * it mounts) without pretending to close it, and no test relies on it —
 * RTL/Vitest use `msw/node` via `src/mocks/server.ts`, started synchronously
 * in `src/test/setup.ts`'s `beforeAll`, instead.
 */
if (process.env.NEXT_PUBLIC_API_MOCKING === 'enabled') {
  import('./mocks/browser')
    .then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass' }))
    .catch((error: unknown) => {
      console.error('MSW worker failed to start; requests will hit the real network.', error)
    })
}
