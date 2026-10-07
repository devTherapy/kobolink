import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPortsFree } from './assert-ports-free'

const servers: net.Server[] = []

function close(server: net.Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve())
    else resolve()
  })
}

/** Holds a port on one specific address and returns it (port 0 -> OS-chosen). */
function hold(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen({ host, port: 0 }, () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

async function freePort(): Promise<number> {
  const port = await hold('127.0.0.1')
  await close(servers.pop())
  return port
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close))
})

describe('assertPortsFree', () => {
  it('passes when nothing is listening', async () => {
    await expect(assertPortsFree([await freePort(), await freePort()])).resolves.toBeUndefined()
  })

  it('throws naming the port when 127.0.0.1 holds it', async () => {
    const port = await hold('127.0.0.1')
    await expect(assertPortsFree([port])).rejects.toThrow(`port ${port} already in use`)
  })

  it('throws naming the port when ::1 holds it', async (context) => {
    const port = await hold('::1').catch(() => undefined)
    if (port === undefined) return context.skip()
    await expect(assertPortsFree([port])).rejects.toThrow(`port ${port} already in use`)
  })

  it('throws when the wildcard address holds it', async () => {
    const port = await hold('0.0.0.0')
    await expect(assertPortsFree([port])).rejects.toThrow(`port ${port} already in use`)
  })

  it('names every busy port and only those', async () => {
    const busyA = await hold('127.0.0.1')
    const busyB = await hold('127.0.0.1')
    const free = await freePort()
    await expect(assertPortsFree([busyA, free, busyB])).rejects.toThrow(`ports ${busyA}, ${busyB} already in use`)
  })
})
