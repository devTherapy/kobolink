import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { INestApplication } from '@nestjs/common'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import supertest, { type Agent } from 'supertest'
import { AppModule } from '../../src/app.module.js'
import { configureApp } from '../../src/configure-app.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * `drizzle-kit generate` (config: `../../drizzle.config.ts`) writes here.
 * It is committed — currently as a valid *empty* migration set
 * (`drizzle/meta/_journal.json` with zero entries), since B0 has no domain
 * schema yet, only the wiring. `applyMigrations` below still guards with
 * `existsSync` for robustness (a clean checkout before the first
 * `drizzle-kit generate` ever ran, or the folder deleted by hand) — it is
 * not, and was never meant to be, "waiting for B1"; B1 lands real tables by
 * adding entries to the same folder, with no change needed here.
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

export interface ApiTestContextOptions {
  /**
   * Runs against the `TestingModuleBuilder` before `.compile()` — the seam a
   * test uses to override one provider (e.g. `LinksModule`'s
   * `LINK_CODE_GENERATOR`, for the collision-retry integration test) without
   * copying this whole function just to change one line. Identity by
   * default.
   */
  configureModule?: (builder: TestingModuleBuilder) => TestingModuleBuilder
}

/**
 * Starts one real Postgres container, applies whatever migrations exist,
 * boots the full Nest app against it (the same `AppModule` and
 * `configureApp` `main.ts` uses), and hands back a Supertest agent. Call
 * `teardown()` from `afterAll` so the container always stops, pass or fail.
 *
 * One container per call — call this once per test *file* (`beforeAll`), not
 * per test case, so a suite with many assertions still starts Postgres once.
 */
export async function startApiTestContext(options: ApiTestContextOptions = {}): Promise<ApiTestContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine').start()
  const connectionString = container.getConnectionUri()
  let app: INestApplication | undefined

  try {
    await applyMigrations(connectionString)

    // DbService reads DATABASE_URL from ConfigService at construction time,
    // so it must be set before the testing module is compiled. Tests never
    // run concurrently against different containers in the same process, so
    // a process-wide env var is safe here.
    process.env.DATABASE_URL = connectionString

    const builder = Test.createTestingModule({ imports: [AppModule] })
    const moduleRef = await (options.configureModule?.(builder) ?? builder).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()

    const startedApp = app
    return {
      app: startedApp,
      request: supertest(startedApp.getHttpServer() as Server),
      connectionString,
      teardown: async () => {
        await startedApp.close()
        await container.stop()
      },
    }
  } catch (error) {
    // `Test.createTestingModule(...).compile()` already instantiates every
    // provider (DbService's constructor — and its `pg.Pool` — included), so
    // a failure in `app.init()` after that still leaves a real pool open
    // unless it is closed here too, not just the container stopped.
    if (app !== undefined) await app.close()
    await container.stop()
    throw error
  }
}
