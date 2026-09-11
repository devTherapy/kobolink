import { ServiceUnavailableException } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
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

  it('answers 503 (not a bare 500) when the database round-trip fails', async () => {
    const ping = vi.fn<DbService['ping']>().mockRejectedValue(new Error('connection refused'))
    const controller = new HealthController({ ping } as unknown as DbService)

    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('is actually mounted at the path the contract names — reads the route metadata off the class, so a change to either side breaks this', () => {
    // @Get() on the method contributes '' (empty); the full path is the
    // global prefix set in main.ts ('api') plus @Controller('health')'s path.
    const controllerPath = Reflect.getMetadata(PATH_METADATA, HealthController) as string
    expect(`/api/${controllerPath}`).toBe(API.health)
  })
})
