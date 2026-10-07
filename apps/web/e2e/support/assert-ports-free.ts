import net from 'node:net'

/**
 * Errors that mean "this address family is not usable here", not "something is
 * listening": an IPv6-less machine answers a `::1` probe with one of these.
 */
const FAMILY_UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT', 'EHOSTUNREACH'])

/** True if something accepts TCP connections on `host:port`. */
function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (busy: boolean) => {
      socket.destroy()
      resolve(busy)
    }
    socket.once('connect', () => done(true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // ECONNREFUSED is the "free" answer. Anything unrecognised is treated as
      // busy: refusing to start is the safe failure for a guard.
      done(error.code !== 'ECONNREFUSED' && !FAMILY_UNAVAILABLE.has(error.code ?? ''))
    })
  })
}

/** True if the wildcard bind collides with an existing listener. */
function wildcardBindFails(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES')
    })
    server.listen(port, () => server.close(() => resolve(false)))
  })
}

/**
 * Whether anything already holds `port` on this machine.
 *
 * A bind-only probe is not enough: on macOS, `listen(port)` with no host binds
 * the dual-stack wildcard (`::`) with SO_REUSEADDR and succeeds even when
 * another process holds `127.0.0.1`, `::1` or `localhost` on that port -- the
 * very case that matters, since `localhost:<port>` is what the suite talks to.
 * So connect to both loopback addresses (a connection means busy; ECONNREFUSED
 * means free), then also try the wildcard bind for listeners that only a bind
 * can see (a non-loopback interface).
 */
export async function isPortBusy(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([isListening('127.0.0.1', port), isListening('::1', port)])
  if (v4 || v6) return true
  return wildcardBindFails(port)
}

/** Throws, naming every busy port, if anything is already listening on them. */
export async function assertPortsFree(ports: number[]): Promise<void> {
  const busy: number[] = []
  for (const port of ports) {
    if (await isPortBusy(port)) busy.push(port)
  }
  if (busy.length > 0) {
    throw new Error(
      `e2e stack: port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} already in use. Stop whatever is listening ` +
        '(a previous e2e run that was killed, or another server), or set E2E_WEB_PORT / E2E_API_PORT to free ports.',
    )
  }
}
