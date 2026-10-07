import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANDROID_PACKAGE_NAME } from '@kobolink/contracts'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { E2E_API_PORT, E2E_WEB_PORT } from './ports'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '../..')
const apiDir = path.resolve(webDir, '../api')
const logDir = path.join(webDir, 'test-results', 'stack-logs')

/**
 * Non-secret placeholders for the association handlers' environment. The
 * handlers 503 without them (by design -- see `.env.example`), and the
 * `associations.spec.ts` guard needs something to compare against. Nothing
 * here is a real Team ID or signing fingerprint.
 */
export const E2E_APPLE_APP_ID = 'E2ETEAM001.com.folusayo.kobolink'
const E2E_ANDROID_FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':')

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
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    const databaseUrl = container.getConnectionUri()

    run('migrate', 'npx', ['drizzle-kit', 'migrate'], { cwd: apiDir, env: { DATABASE_URL: databaseUrl } })

    if (process.env.E2E_SKIP_BUILD !== '1') {
      run('build-api', 'npm', ['run', 'build'], { cwd: apiDir })
      run('build-web', 'npx', ['next', 'build'], {
        cwd: webDir,
        env: { API_ORIGIN: `http://localhost:${E2E_API_PORT}` },
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
      throw new Error(`e2e stack: "${name}" exited with ${String(result.status)}; see ${path.join(logDir, `${name}.log`)}`)
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
