import { Global, Module } from '@nestjs/common'
import { DbService } from './db.service.js'

/**
 * Global so every feature module (auth, links, payments, ...) can inject
 * `DbService` without importing this module explicitly.
 */
@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
