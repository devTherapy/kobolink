import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { NotFoundModule } from './common/not-found.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// `.env.local`/`.env` are documented in both `apps/api/.env.example` and
// the repo root's `.env.example` (copy either to `.env.local`), but
// `npm run dev -w apps/api` runs with cwd = apps/api, so a plain relative
// `envFilePath` never finds a root-level file and `getOrThrow('DATABASE_URL')`
// throws at boot. Resolve against the repo root explicitly; keep the
// apps/api-relative forms as a fallback for a `.env.local` placed there
// directly.
const repoRoot = path.resolve(here, '../../..')

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        path.join(repoRoot, '.env.local'),
        path.join(repoRoot, '.env'),
        '.env.local',
        '.env',
      ],
    }),
    DbModule,
    HealthModule,
    // Every real feature module goes above this line — NotFoundModule's
    // catch-all route must stay last so it never shadows a real one.
    NotFoundModule,
  ],
})
export class AppModule {}
