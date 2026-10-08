/**
 * Off the dev ports (3000 web, 3001 api) so `npm run test:e2e` never collides
 * with a running `npm run dev`. Overridable for a machine where these are taken.
 */
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100)
export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 3101)
