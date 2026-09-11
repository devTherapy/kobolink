import 'reflect-metadata'
import { pathToFileURL } from 'node:url'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { configureApp } from './configure-app.js'

export async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  configureApp(app)
  // Runs DbService.onModuleDestroy (closing the pool) on SIGTERM/SIGINT
  // instead of the pool dying mid-connection when the process is killed.
  app.enableShutdownHooks()

  const port = Number(process.env.PORT ?? 3001)
  await app.listen(port)
  Logger.log(`listening on port ${port}`, 'Bootstrap')
  return app
}

// `npm run dev` (`tsc --watch` + `node --watch dist/main.js`) and a plain
// `node dist/main.js` both execute this module directly; the Testcontainers
// harness instead builds its own TestingModule from `AppModule` and never
// runs this branch. Comparing via `pathToFileURL` (not a hand-built
// `file://${argv[1]}` string) so a path containing a space, or a Windows
// drive letter, still matches correctly.
// (esbuild-based runners such as `tsx` are deliberately not used here —
// esbuild does not emit `emitDecoratorMetadata`, so Nest's
// constructor-parameter DI silently receives `undefined`. `tsc` does, and
// the Vitest configs use the `unplugin-swc` transform, which also does.)
const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  bootstrap().catch((error: unknown) => {
    Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap')
    process.exitCode = 1
  })
}
