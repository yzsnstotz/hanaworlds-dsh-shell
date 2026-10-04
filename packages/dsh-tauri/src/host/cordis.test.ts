import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../index'
import { clearHostRuntime } from './config/runtime'
import { hanaworlds } from './service/hanaworlds'

describe('dsh-tauri cordis injection', () => {
  it('activates with the actual host services needed by routes and Session binding', async () => {
    const root = new Context()
    const register = vi.fn(() => () => {})
    root.provide('connection', {
      requestRejection: () => undefined,
      authorizeIndex: () => true,
    } as never)
    root.provide('webServer', { register } as never)
    root.provide('sessions', { get: () => undefined, list: () => [] } as never)
    const canvas = { call: async () => ({ current: false }), recoverPending: async () => [] }
    const originalCanvasCall = canvas.call
    const originalRecoverPending = canvas.recoverPending
    root.provide('hanaworldsCanvasV4', canvas as never)
    try {
      const fiber = root.plugin(plugin)
      await fiber.await()
      expect(register).toHaveBeenCalledTimes(3)
      expect(root.get('hanaworldsAuthority')).toMatchObject({
        verify: expect.any(Function),
        verifyEngineBinding: expect.any(Function),
        verifyService: expect.any(Function),
      })
      expect(root.get('hanaworldsOperatorAuthority')).toMatchObject({ verify: expect.any(Function) })
      expect(canvas.call).not.toBe(originalCanvasCall)
      expect(canvas.recoverPending).not.toBe(originalRecoverPending)
      await expect(hanaworlds.context()).resolves.toMatchObject({
        status: 'unavailable',
        sessions: [],
      })
    }
    finally {
      await root.fiber.dispose()
      expect(canvas.call).toBe(originalCanvasCall)
      expect(canvas.recoverPending).toBe(originalRecoverPending)
      clearHostRuntime()
    }
  })
})
