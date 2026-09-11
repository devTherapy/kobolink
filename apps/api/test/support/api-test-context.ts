import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import supertest, { type Agent } from 'supertest'
import { AppModule } from '../../src/app.module.js'
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * `drizzle-kit generate` (config: `../../drizzle.config.ts`) writes here.
 * B0 ships with nothing to generate — there is no table yet, only the
 * wiring — so the folder does not exist until B1 adds the domain schema.
 * `applyMigrations` below treats that as "nothing to apply" rather than an
 * error, so this harness needs no changes once B1 lands.
 */
const migrationsFolder = path.resolve(here, '../../drizzle')

export interface ApiTestContext {
  app: INestApplication
  /** A Supertest agent bound to the running app; requests still need the `/api` prefix, e.g. `request.get('/api/health')`. */
  request: Agent
  connectionString: string
  teardown: () => Promise<void>
}

async function applyMigrations(connectionString: string): Promise<void> {
  if (!existsSync(migrationsFolder)) return
  const pool = new Pool({ connectionString })
  try {
    await migrate(drizzle(pool), { migrationsFolder })
  } finally {
    await pool.end()
  }
}

/**
 * Starts one real Postgres container, applies whatever migrations exist,
 * boots the full Nest app against it (the same `AppModule`, filters and
 * prefix `main.ts` uses), and hands back a Supertest agent. Call
 * `teardown()` from `afterAll` so the container always stops, pass or fail.
 *
 * One container per call — call this once per test *file* (`beforeAll`), not
 * per test case, so a suite with many assertions still starts Postgres once.
 */
export async function startApiTestContext(): Promise<ApiTestContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine').start()
  const connectionString = container.getConnectionUri()

  try {
    await applyMigrations(connectionString)

    // DbService reads DATABASE_URL from ConfigService at construction time,
    // so it must be set before the testing module is compiled. Tests never
    // run concurrently against different containers in the same process, so
    // a process-wide env var is safe here.
    process.env.DATABASE_URL = connectionString

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new HttpExceptionFilter())
    await app.init()

    return {
      app,
      request: supertest(app.getHttpServer() as Server),
      connectionString,
      teardown: async () => {
        await app.close()
        await container.stop()
      },
    }
  } catch (error) {
    await container.stop()
    throw error
  }
}
