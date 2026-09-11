import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { NotFoundModule } from './common/not-found.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    DbModule,
    HealthModule,
    // Every real feature module goes above this line — NotFoundModule's
    // catch-all route must stay last so it never shadows a real one.
    NotFoundModule,
  ],
})
export class AppModule {}
