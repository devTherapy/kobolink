import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANDROID_PACKAGE_NAME } from '@kobolink/contracts'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { assertPortsFree } from './assert-ports-free'
import { E2E_API_PORT, E2E_WEB_PORT } from './ports'
import { describeLogExcerpt } from './tail-log'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '../..')
const apiDir = path.resolve(webDir, '../api')
const logDir = path.join(webDir, 'test-results', 'stack-logs')

/**
 * Non-secret placeholders for the association handlers' environment. The
 * handlers 503 without them (by design -- see `.env.example`), and the
 * `associations.spec.ts` guard needs something to compare against. Nothing
 * here is a real Team ID or signing fingerprint.
 *
 * The fingerprint is deliberately LOWERCASE: the handler is what uppercases it
 * (`parseFingerprints`), and `associations.spec.ts` asserts the served value is
 * uppercase. An uppercase placeholder would pass even if that step were lost.
 */
export const E2E_APPLE_APP_ID = 'E2ETEAM001.com.folusayo.kobolink'
const E2E_ANDROID_FINGERPRINT = Array.from({ length: 32 }, () => 'ab').join(':')

/**
 * The e2e build lives apart from `apps/web/.next`. `rewrites()` is evaluated at
 * build time, so the e2e build bakes in the API on `E2E_API_PORT`; written to
 * the default `.next` it would replace a developer's `next build`/`next start`
 * output whose `/api` rewrite points at 3001. Nested under `.next/` so the
 * existing gitignore, eslint and tsconfig exclusions already cover it.
 * `next.config.ts` reads the same variable.
 */
const E2E_DIST_DIR = '.next/e2e'

/**
 * MSW must never be part of the e2e build. `NEXT_PUBLIC_*` is inlined at build
 * time and a developer's shell or `apps/web/.env.local` could set it to
 * `enabled`; Next does not overwrite a variable that is already defined, so an
 * explicit empty string wins over any dotenv file. Passed to `next build` AND
 * `next start`.
 */
const NO_MOCKING = { NEXT_PUBLIC_API_MOCKING: '' }

/**
 * Next's anonymous telemetry is on by default in CI. It never fails a build,
 * but it is one more outbound connection from a step that has to be
 * deterministic, and the Docker build already turns it off. Passed to
 * `next build` AND `next start`.
 */
const NO_TELEMETRY = { NEXT_TELEMETRY_DISABLED: '1' }

/**
 * How much of a failed step's log is echoed to the console. Both ends: a failed
 * Turbopack build puts its header and first error in the opening ~30 lines and
 * then repeats hundreds of stack frames (883 lines in the failures seen in CI).
 */
const LOG_HEAD_LINES = 30
const LOG_TAIL_LINES = 60

export interface RunningStack {
  stop: () => Promise<void>
}

/**
 * Starts the whole product once for the suite: Postgres (Testcontainers), the
 * migrated schema, `apps/api` and `apps/web` as production builds, wired
 * together the way a deployment is -- the browser only ever talks to the Next
 * origin, and `/api/*` is Next's rewrite to the API (`next.config.ts`).
 *
 * Both services are the *built* artefacts (`apps/api/dist`, `next start`), not
 * dev servers: the SSE stream crossing the Next proxy is the thing this suite
 * exists to exercise, and the dev server is a different proxy. Set
 * `E2E_SKIP_BUILD=1` to reuse existing builds while iterating on a spec -- it
 * is only safe if they were built with the same `E2E_*_PORT`s, because
 * `rewrites()` is evaluated at build time.
 *
 * Exactly one container is started and it is stopped in `stop()`; Testcontainers'
 * reaper removes it if the runner is killed before that.
 */
export async function startStack(): Promise<RunningStack> {
  mkdirSync(logDir, { recursive: true })
  const children: ChildProcess[] = []
  const logFds: number[] = []
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined

  const stop = async (): Promise<void> => {
    await Promise.all(children.map(terminate))
    for (const fd of logFds) closeSync(fd)
    await container?.stop()
  }

  try {
    // Before anything is started: a leftover server on these ports would answer
    // the readiness probes with a stale build and the suite would test the wrong
    // thing without saying so.
    await assertPortsFree([E2E_WEB_PORT, E2E_API_PORT])

    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    const databaseUrl = container.getConnectionUri()

    run('migrate', 'npx', ['drizzle-kit', 'migrate'], { cwd: apiDir, env: { DATABASE_URL: databaseUrl } })

    if (process.env.E2E_SKIP_BUILD !== '1') {
      run('build-api', 'npm', ['run', 'build'], { cwd: apiDir })
      run('build-web', 'npx', ['next', 'build'], {
        cwd: webDir,
        env: { API_ORIGIN: `http://localhost:${E2E_API_PORT}`, NEXT_DIST_DIR: E2E_DIST_DIR, ...NO_MOCKING, ...NO_TELEMETRY },
      })
    }

    // No NODE_ENV: the API's default is the production-shaped one (a `Secure`
    // session cookie). Chromium accepts that on http://localhost, so the
    // cookie behaves here exactly as it does behind TLS.
    const api = spawnLogged('api', process.execPath, ['dist/main.js'], {
      cwd: apiDir,
      env: { DATABASE_URL: databaseUrl, PORT: String(E2E_API_PORT) },
    })
    const web = spawnLogged('web', process.execPath, [createRequire(import.meta.url).resolve('next/dist/bin/next'), 'start', '-p', String(E2E_WEB_PORT)], {
      cwd: webDir,
      env: {
        API_ORIGIN: `http://localhost:${E2E_API_PORT}`,
        NEXT_DIST_DIR: E2E_DIST_DIR,
        ...NO_MOCKING,
        ...NO_TELEMETRY,
        APPLE_APP_ID: E2E_APPLE_APP_ID,
        ANDROID_PACKAGE_NAME,
        ANDROID_SHA256_FINGERPRINTS: E2E_ANDROID_FINGERPRINT,
      },
    })

    await Promise.all([
      waitForOk(`http://localhost:${E2E_API_PORT}/api/health`, 'api', api),
      waitForOk(`http://localhost:${E2E_WEB_PORT}/login`, 'web', web),
    ])
    // The proxy is the point: a request through the web origin must reach the API.
    await waitForOk(`http://localhost:${E2E_WEB_PORT}/api/health`, 'web -> api proxy', web)

    return { stop }
  } catch (error) {
    await stop()
    throw error
  }

  function run(name: string, command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): void {
    const fd = openSync(path.join(logDir, `${name}.log`), 'w')
    logFds.push(fd)
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', fd, fd],
    })
    if (result.status !== 0) {
      const logPath = path.join(logDir, `${name}.log`)
      // The log is also uploaded as a CI artifact, but the reason belongs in
      // the job log where the failure is read first.
      console.error(describeLogExcerpt(logPath, LOG_HEAD_LINES, LOG_TAIL_LINES))
      const how = result.error ? `could not start (${result.error.message})` : result.signal ? `was killed by ${result.signal}` : `exited with ${String(result.status)}`
      throw new Error(`e2e stack: "${name}" ${how}; see ${logPath}`)
    }
  }

  function spawnLogged(
    name: string,
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ): ChildProcess {
    const fd = openSync(path.join(logDir, `${name}.log`), 'w')
    logFds.push(fd)
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', fd, fd],
    })
    children.push(child)
    return child
  }
}

async function waitForOk(url: string, name: string, owner: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000
  let lastError = 'no response yet'
  while (Date.now() < deadline) {
    if (owner.exitCode !== null) {
      throw new Error(`e2e stack: ${name} exited with ${String(owner.exitCode)} before it was ready; see ${logDir}`)
    }
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`e2e stack: ${name} did not become ready at ${url} (${lastError}); see ${logDir}`)
}

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
