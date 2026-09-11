import { describe, expect, it, vi } from 'vitest'
import { API } from '@kobolink/contracts'
import { HealthController } from './health.controller.js'
import type { DbService } from '../db/db.service.js'

describe('HealthController', () => {
  it('reports ok once the database round-trip succeeds', async () => {
    const ping = vi.fn<DbService['ping']>().mockResolvedValue(undefined)
    const controller = new HealthController({ ping } as unknown as DbService)

    await expect(controller.check()).resolves.toEqual({ status: 'ok' })
    expect(ping).toHaveBeenCalledOnce()
  })

  it('propagates a database failure instead of answering ok', async () => {
    const ping = vi.fn<DbService['ping']>().mockRejectedValue(new Error('connection refused'))
    const controller = new HealthController({ ping } as unknown as DbService)

    await expect(controller.check()).rejects.toThrow('connection refused')
  })

  it('is mounted at the path the contract names, once the global /api prefix is applied', () => {
    expect(`/api/health`).toBe(API.health)
  })
})
