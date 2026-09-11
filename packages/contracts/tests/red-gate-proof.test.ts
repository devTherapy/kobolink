import { expect, it } from 'vitest'

// Deliberately failing. This PR exists only to prove that a red test makes
// the PR red; it is closed unmerged.
it('fails on purpose', () => {
  expect(1 + 1).toBe(3)
})
