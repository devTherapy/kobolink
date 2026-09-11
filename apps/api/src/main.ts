import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js'

export async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new HttpExceptionFilter())

  const port = Number(process.env.PORT ?? 3001)
  await app.listen(port)
  Logger.log(`listening on port ${port}`, 'Bootstrap')
  return app
}

// `npm run dev` (`tsc --watch` + `node --watch dist/main.js`) and a plain
// `node dist/main.js` both execute this module directly; the Testcontainers
// harness instead builds its own TestingModule from `AppModule` and never
// runs this branch. (esbuild-based runners such as `tsx` are deliberately
// not used here — esbuild does not emit `emitDecoratorMetadata`, so Nest's
// constructor-parameter DI silently receives `undefined`. `tsc` does, and
// the Vitest configs use the `unplugin-swc` transform, which also does.)
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error: unknown) => {
    Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap')
    process.exitCode = 1
  })
}
