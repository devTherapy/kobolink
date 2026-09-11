import { newLinkCode } from '@kobolink/contracts'

/**
 * A code generator as a pure function type, injected via `LINK_CODE_GENERATOR`
 * rather than `LinksService` importing `newLinkCode` directly. That is the
 * seam the collision-retry integration test uses: it overrides this provider
 * with a stub that returns an already-taken code once, then a fresh one, and
 * asserts `LinksService.create` retries and lands on 201 with the fresh code
 * — see `test/links-create-collision.integration.test.ts`.
 */
export type LinkCodeGenerator = () => string

export const LINK_CODE_GENERATOR = Symbol('LINK_CODE_GENERATOR')

/** The real generator — `packages/contracts`' mistranscription-safe alphabet. */
export const defaultLinkCodeGenerator: LinkCodeGenerator = newLinkCode
