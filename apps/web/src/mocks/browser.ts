import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/**
 * The browser worker for `npm run dev`. Started from `src/app/msw-provider.tsx`
 * only when `NEXT_PUBLIC_API_MOCKING=enabled`, so a developer can run the web
 * app against these handlers before `apps/api` has anything to serve, and
 * switch back to the real API by unsetting the flag.
 */
export const worker = setupWorker(...handlers)
