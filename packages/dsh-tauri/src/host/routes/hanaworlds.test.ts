import type { AddressInfo } from 'node:net'
import type { HostRoute } from './index.type'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hanaworlds } from '../service/hanaworlds'
import { hanaworldsRoutes } from './hanaworlds'

const token = 'a'.repeat(64)
const originalToken = process.env.HANAWORLDS_DESKTOP_TOKEN
const originalEmbedded = process.env.DSH_TAURI_EMBEDDED

afterEach(() => {
  vi.restoreAllMocks()
  if (originalToken === undefined)
    delete process.env.HANAWORLDS_DESKTOP_TOKEN
  else
    process.env.HANAWORLDS_DESKTOP_TOKEN = originalToken
  if (originalEmbedded === undefined)
    delete process.env.DSH_TAURI_EMBEDDED
  else
    process.env.DSH_TAURI_EMBEDDED = originalEmbedded
})

async function host() {
  const routes = new Map<string, HostRoute>()
  const dispose = hanaworldsRoutes({
    connection: { requestRejection: () => undefined },
    webServer: { register(route: HostRoute) {
      routes.set(route.path, route)
      return () => {
        routes.delete(route.path)
      }
    } },
  } as never)
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.get(path)
    if (!route) {
      response.writeHead(404).end()
      return
    }
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

describe('hanaWorlds desktop host route', () => {
  it('requires the private desktop channel even when embedded HTTP accepts a local request', async () => {
    process.env.DSH_TAURI_EMBEDDED = '1'
    process.env.HANAWORLDS_DESKTOP_TOKEN = token
    const context = vi.spyOn(hanaworlds, 'context').mockResolvedValue({ status: 'unbound', sessions: [], candidates: [] })
    const runtime = await host()
    try {
      const url = `${runtime.base}/api/desktop/hanaworlds/context`
      const send = (headers: Record<string, string>) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      })
      expect((await send({})).status).toBe(403)
      expect((await send({ 'x-hanaworlds-desktop-token': 'b'.repeat(64) })).status).toBe(403)
      expect((await send({ 'origin': 'http://evil.invalid', 'x-hanaworlds-desktop-token': token })).status).toBe(403)
      expect(context).not.toHaveBeenCalled()
      const accepted = await send({ 'x-hanaworlds-desktop-token': token })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ status: 'unbound', sessions: [], candidates: [] })
      expect(context).toHaveBeenCalledOnce()
    }
    finally {
      await runtime.close()
    }
  })

  it('rejects a valid token without the desktop embedded host mode', async () => {
    delete process.env.DSH_TAURI_EMBEDDED
    process.env.HANAWORLDS_DESKTOP_TOKEN = token
    const context = vi.spyOn(hanaworlds, 'context')
    const runtime = await host()
    try {
      const response = await fetch(`${runtime.base}/api/desktop/hanaworlds/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hanaworlds-desktop-token': token },
        body: '{}',
      })
      expect(response.status).toBe(403)
      expect(context).not.toHaveBeenCalled()
    }
    finally {
      await runtime.close()
    }
  })
})
