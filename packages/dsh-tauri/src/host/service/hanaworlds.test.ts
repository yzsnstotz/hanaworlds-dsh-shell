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

function confirmationHost() {
  const trace: string[] = []
  const events: Array<{ type: string, seq: number, surfaceOp?: string, data: Record<string, unknown> }> = []
  let stored = [] as typeof events
  let flushResult = true
  let failAfterAppend = false
  let withholdAppend = false
  let throwAppend = false
  let throwFlush = false
  let live = true
  let grantCurrent = true
  let currentGrant = { ...firstGrant }
  let onFlush: (() => void) | undefined
  const calls: Array<{ operation: string, body: Record<string, unknown> }> = []
  const session = {
    id: 'session-a',
    get seq() { return events.length },
    append(type: string, data: Record<string, unknown>, options: { surfaceOp: string }) {
      if (throwAppend)
        throw new Error('fixture write failure')
      trace.push('append')
      const event = { type, seq: events.length, surfaceOp: options.surfaceOp, data }
      events.push(event)
      return event
    },
  }
  const services: Record<string, unknown> = {
    hanaworldsLuantiGrantEvidence: {
      listCurrentLocalGrants: async () => grantCurrent ? [currentGrant] : [],
      verifyCurrentLocalGrant: async ({ expectedGrantRef }: { expectedGrantRef: string }) =>
        grantCurrent && expectedGrantRef === currentGrant.grantRef ? currentGrant : { current: false },
    },
    sessionPersistence: {
      open: async (id: string, access: string) => {
        expect([id, access]).toEqual(['session-a', 'read'])
        return {
          read: async () => ({ events: stored.map(event => structuredClone(event)) }),
          close: async () => {},
        }
      },
    },
    hanaworldsWorkshop: {
      call: async (operation: string, body: Record<string, unknown>) => {
        trace.push('workshop')
        calls.push({ operation, body })
        return { ok: true }
      },
    },
  }
  setCurrentHostInstance({
    sessions: {
      get: (id: string) => live && id === 'session-a' ? session : undefined,
      list: () => [session],
      flush: async () => {
        trace.push('flush')
        if (throwFlush)
          throw new Error('fixture flush failure')
        onFlush?.()
        if (failAfterAppend && events.length > 0)
          return false
        if (flushResult && (!withholdAppend || events.length === 0))
          stored = events.map(event => structuredClone(event))
        return flushResult
      },
    },
    get: (name: string) => services[name],
  } as never)
  return {
    calls,
    trace,
    services,
    stored: () => stored,
    appendTitle: () => {
      trace.push('title')
      events.push({ type: 'session/title', seq: events.length, data: { title: 'Current world' } })
    },
    failFlush: () => { flushResult = false },
    failAfterAppend: () => { failAfterAppend = true },
    withholdAppend: () => { withholdAppend = true },
    throwAppend: () => { throwAppend = true },
    throwFlush: () => { throwFlush = true },
    switchSession: () => { live = false },
    revoke: () => { grantCurrent = false },
    regrant: () => {
      grantCurrent = true
      currentGrant = { ...firstGrant, grantRef: 'grant-b' }
    },
    onFlush: (action: () => void) => { onFlush = action },
  }
}

const confirmation = {
  contractVersion: 'session/v2',
  requestId: 'answer-1',
  turnRef: 'turn-1',
  expectedRevision: 'revision-1',
  clarificationId: 'clarification-1',
  answer: '确认',
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
    const withoutWorld = await hanaworlds.call('session-a', 'SwitchWorldContext', {
      requestId: 'intent-no-world',
    })
    expect(withoutWorld).toEqual({ ok: true })
    expect(runtime.calls[0]?.body).toMatchObject({
      actorRef: 'luanti:player-a',
      sessionRef: 'session-a',
      worldRef: firstGrant.worldRef,
      requestId: 'intent-no-world',
    })
    const result = await hanaworlds.call('session-a', 'SwitchWorldContext', {
      actorRef: 'forged',
      sessionRef: 'forged',
      worldRef: 'forged',
      authorizationRef: 'forged',
      authorizationBinding: { actorRef: 'forged' },
      requestId: 'intent-a',
    })
    expect(result).toEqual({ ok: true })
    expect(runtime.calls).toHaveLength(2)
    expect(runtime.calls[1]?.body).toMatchObject({
      actorRef: 'luanti:player-a',
      sessionRef: 'session-a',
      worldRef: firstGrant.worldRef,
      requestId: 'intent-a',
    })
    expect(runtime.calls[1]?.body.authorizationRef).not.toBe('forged')
    expect(runtime.calls[1]?.body).not.toHaveProperty('authorizationBinding')
    await hanaworlds.call('session-a', 'StartOrResumeSession', { requestId: 'start' })
    expect(runtime.calls[2]?.body).not.toHaveProperty('worldRef')
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

describe('hanaWorlds durable confirmation', () => {
  it('persists the exact current Core user message before forwarding and allows typed details readback', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).resolves.toEqual({ ok: true })
    expect(runtime.trace).toEqual(['flush', 'append', 'flush', 'workshop'])
    expect(runtime.stored()).toEqual([{
      type: 'user/message',
      seq: 0,
      surfaceOp: 'append',
      data: { id: 'answer-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '确认' }] },
    }])
    expect(runtime.calls[0]).toMatchObject({
      operation: 'AnswerClarification',
      body: { actorRef: 'luanti:player-a', sessionRef: 'session-a', requestId: 'answer-1', answer: '确认' },
    })
    expect(runtime.calls[0]?.body).not.toHaveProperty('worldRef')
    await hanaworlds.call('session-a', 'ReadSessionTurnDetails', { contractVersion: 'session/v2', requestId: 'details-1' })
    expect(runtime.calls[1]).toMatchObject({ operation: 'ReadSessionTurnDetails', body: { sessionRef: 'session-a', requestId: 'details-1' } })
  })

  it('forwards a durable confirmation when Core appends a title event after it', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.onFlush(() => {
      if (runtime.trace.includes('append'))
        runtime.appendTitle()
    })
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).resolves.toEqual({ ok: true })
    expect(runtime.stored()).toMatchObject([
      { type: 'user/message', seq: 0, data: { id: 'answer-1', content: [{ type: 'text', text: '确认' }] } },
      { type: 'session/title', seq: 1, data: { title: 'Current world' } },
    ])
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.trace).toEqual(['flush', 'append', 'flush', 'title', 'workshop'])
  })

  it('rejects duplicate and inconsistent request IDs before calling Workshop again', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'AnswerClarification', confirmation)
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('CONFIRMATION_DUPLICATE')
    await expect(hanaworlds.call('session-a', 'AnswerClarification', { ...confirmation, answer: '修改尺寸' })).rejects.toThrow('CONFIRMATION_CONFLICT')
    await expect(hanaworlds.call('session-a', 'AnswerClarification', { ...confirmation, requestId: 'answer-2' })).rejects.toThrow('CONFIRMATION_CONFLICT')
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.stored()).toHaveLength(1)
  })

  it('rejects persistence and flush failures without forwarding', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    delete runtime.services.sessionPersistence
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_PERSISTENCE_UNAVAILABLE')
    expect(runtime.calls).toHaveLength(0)
    runtime.services.sessionPersistence = {
      open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
    }
    runtime.failFlush()
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_FLUSH_UNAVAILABLE')
    expect(runtime.calls).toHaveLength(0)
    expect(runtime.trace).not.toContain('append')
  })

  it('does not forward when the post-append flush fails or durable readback is absent', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.failAfterAppend()
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_FLUSH_UNAVAILABLE')
    expect(runtime.calls).toHaveLength(0)
    hanaworlds.clear()
    const second = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    second.withholdAppend()
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('CONFIRMATION_NOT_DURABLE')
    expect(second.calls).toHaveLength(0)
  })

  it('rejects thrown Core append and flush errors without forwarding', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.throwAppend()
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('CONFIRMATION_WRITE_FAILED')
    expect(runtime.calls).toHaveLength(0)
    hanaworlds.clear()
    const second = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    second.throwFlush()
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_FLUSH_UNAVAILABLE')
    expect(second.calls).toHaveLength(0)
  })

  it('serializes simultaneous confirmations for the same request ID', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    const results = await Promise.allSettled([
      hanaworlds.call('session-a', 'AnswerClarification', confirmation),
      hanaworlds.call('session-a', 'AnswerClarification', confirmation),
    ])
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { ok: true } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('CONFIRMATION_DUPLICATE') })
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.stored()).toHaveLength(1)
  })

  it('rejects session replacement and grant revocation before appending', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.onFlush(runtime.switchSession)
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_OR_GRANT_CHANGED')
    expect(runtime.trace).not.toContain('append')
    expect(runtime.calls).toHaveLength(0)
    hanaworlds.clear()
    const second = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    second.onFlush(second.revoke)
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_OR_GRANT_CHANGED')
    expect(second.trace).not.toContain('append')
    expect(second.calls).toHaveLength(0)
  })

  it('keeps a durable but unforwarded confirmation rejected after grant revocation and regrant', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.onFlush(() => {
      if (runtime.trace.includes('append'))
        runtime.revoke()
    })
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_OR_GRANT_CHANGED')
    expect(runtime.stored()).toHaveLength(1)
    expect(runtime.calls).toHaveLength(0)
    runtime.regrant()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('CONFIRMATION_DUPLICATE')
    expect(runtime.stored()).toHaveLength(1)
    expect(runtime.calls).toHaveLength(0)
  })

  it('does not forward a durable confirmation when the live Session switches after flush', async () => {
    const runtime = confirmationHost()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.onFlush(() => {
      if (runtime.trace.includes('append'))
        runtime.switchSession()
    })
    await expect(hanaworlds.call('session-a', 'AnswerClarification', confirmation)).rejects.toThrow('SESSION_OR_GRANT_CHANGED')
    expect(runtime.stored()).toHaveLength(1)
    expect(runtime.calls).toHaveLength(0)
  })
})
