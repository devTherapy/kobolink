import { describe, expect, it } from 'vitest'
import { CONTRACTS_VERSION } from '../src/index.js'

describe('@kobolink/contracts', () => {
  it('exposes a version string so a consumer can assert which contract it built against', () => {
    expect(CONTRACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
