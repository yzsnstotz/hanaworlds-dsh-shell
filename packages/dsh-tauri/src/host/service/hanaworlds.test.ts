import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearHostRuntime, setCurrentHostInstance } from '../config/runtime'
import { hanaworlds } from './hanaworlds'

const firstGrant = { current: true as const, worldRef: 'luanti:world-a', engineActorName: 'player-a', scope: 'WORLD_BUILD_WITH_ENGINE_PROTECTION' as const, grantRef: 'grant-a' }

beforeEach(() => hanaworlds.clear())
afterEach(() => clearHostRuntime())

function host() {
  let currentGrant = { ...firstGrant }
  let online = true
  const calls: Array<{ operation: string, body: Record<string, unknown> }> = []
  const services: Record<string, unknown> = {
    hanaworldsLuantiGrantEvidence: {
      listCurrentLocalGrants: async () => online ? [currentGrant] : [],
      verifyCurrentLocalGrant: async ({ expectedGrantRef }: { expectedGrantRef: string }) =>
        online && expectedGrantRef === currentGrant.grantRef ? currentGrant : { current: false },
    },
    hanaworldsWorkshop: {
      call: async (operation: string, body: Record<string, unknown>) => {
        calls.push({ operation, body })
        return { ok: true }
      },
    },
  }
  const sessions = new Set(['session-a'])
  setCurrentHostInstance({
    sessions: {
      get: (id: string) => sessions.has(id) ? { id } : undefined,
      list: () => [...sessions].map(id => ({ id })),
    },
    get: (name: string) => services[name],
  } as never)
  return {
    calls,
    services,
    sessions,
    revoke: () => { online = false },
    regrant: () => {
      online = true
      currentGrant = { ...firstGrant, grantRef: 'grant-b' }
    },
  }
}

describe('hanaWorlds trusted Shell binding', () => {
  it('takes session and player selection only as intent, then fills Workshop identity from host binding', async () => {
    const runtime = host()
    await expect(hanaworlds.bind('not-live', firstGrant.worldRef, firstGrant.engineActorName))
      .rejects
      .toThrow('SESSION_OR_CANDIDATE_INVALID')
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    const visible = await hanaworlds.context('session-a')
    expect(visible).toMatchObject({ status: 'bound', worldRef: firstGrant.worldRef, engineActorName: firstGrant.engineActorName })
    expect(JSON.stringify(visible)).not.toContain(firstGrant.grantRef)
    expect(JSON.stringify(visible)).not.toContain('authorizationRef')
    const result = await hanaworlds.call('session-a', 'SwitchWorldContext', {
      actorRef: 'forged',
      sessionRef: 'forged',
      worldRef: 'forged',
      authorizationRef: 'forged',
      authorizationBinding: { actorRef: 'forged' },
      requestId: 'intent-a',
    })
    expect(result).toEqual({ ok: true })
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]?.body).toMatchObject({
      actorRef: 'luanti:player-a',
      sessionRef: 'session-a',
      worldRef: firstGrant.worldRef,
      requestId: 'intent-a',
    })
    expect(runtime.calls[0]?.body.authorizationRef).not.toBe('forged')
    expect(runtime.calls[0]?.body).not.toHaveProperty('authorizationBinding')
  })

  it('rejects revoked and regranted old bindings before calling Workshop', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.revoke()
    await expect(hanaworlds.call('session-a', 'StartOrResumeSession', {}))
      .rejects
      .toThrow('TRUSTED_BINDING_REQUIRED')
    runtime.regrant()
    await expect(hanaworlds.call('session-a', 'StartOrResumeSession', {}))
      .rejects
      .toThrow('TRUSTED_BINDING_REQUIRED')
    expect(runtime.calls).toHaveLength(0)
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    expect(runtime.calls).toHaveLength(1)
  })

  it('fails closed when the live Session or Adapter evidence disappears', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    delete runtime.services.hanaworldsLuantiGrantEvidence
    await expect(hanaworlds.context('session-a')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'NATIVE_GRANT_EVIDENCE_UNAVAILABLE',
    })
    await expect(hanaworlds.call('session-a', 'StartOrResumeSession', {}))
      .rejects
      .toThrow('TRUSTED_BINDING_REQUIRED')
    runtime.services.hanaworldsLuantiGrantEvidence = {
      listCurrentLocalGrants: async () => [firstGrant],
      verifyCurrentLocalGrant: async () => firstGrant,
    }
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.sessions.delete('session-a')
    await expect(hanaworlds.call('session-a', 'StartOrResumeSession', {}))
      .rejects
      .toThrow('TRUSTED_BINDING_REQUIRED')
    expect(runtime.calls).toHaveLength(0)
  })
})
