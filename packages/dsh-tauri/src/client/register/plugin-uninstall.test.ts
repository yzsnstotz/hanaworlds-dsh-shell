import type { ClientContext } from '../types'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginUninstallReconcileFeature } from './plugin-uninstall'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string) => undefined) }))
vi.mock('../service/invoke', () => ({ invoke: mocks.invoke }))

afterEach(() => {
  mocks.invoke.mockClear()
  vi.unstubAllGlobals()
})

it('uses the completed Core remove event to request Shell cleanup only in desktop UI', async () => {
  vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
  let listener: ((change: { reason: string }) => void) | undefined
  const disposeRemote = vi.fn()
  const ctx = {
    inject: (_deps: string[], callback: (scoped: unknown) => void) => {
      callback({ remote: { $on: (_event: string, callback: typeof listener) => { listener = callback; return disposeRemote } } })
      return () => {}
    },
  } as unknown as ClientContext

  const dispose = pluginUninstallReconcileFeature.call(ctx)
  listener?.({ reason: 'install' })
  expect(mocks.invoke).not.toHaveBeenCalled()
  listener?.({ reason: 'remove' })
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('reconcile_removed_plugin_residue'))
  dispose()
  expect(disposeRemote).toHaveBeenCalledOnce()
})

it('does not subscribe from a normal browser window', () => {
  const inject = vi.fn()
  const ctx = { inject } as unknown as ClientContext
  const dispose = pluginUninstallReconcileFeature.call(ctx)
  expect(inject).not.toHaveBeenCalled()
  dispose()
})
