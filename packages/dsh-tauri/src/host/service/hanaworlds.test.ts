import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearHostRuntime, setCurrentHostInstance } from '../config/runtime'
import { hanaworlds } from './hanaworlds'

const firstGrant = { current: true as const, worldRef: 'luanti:world-a', engineActorName: 'player-a', scope: 'WORLD_BUILD_WITH_ENGINE_PROTECTION' as const, grantRef: 'grant-a' }

beforeEach(() => hanaworlds.clear())
afterEach(() => clearHostRuntime())

function host() {
  let currentGrant = { ...firstGrant }
  let online = true
  let worldRevision = 'world-rev-1'
  let recoveryRequest: Record<string, unknown> | null = null
  const calls: Array<{ operation: string, body: Record<string, unknown> }> = []
  const services: Record<string, unknown> = {
    hanaworldsWorldRevisionOracle: { read: async () => worldRevision },
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
  const canvas = {
    recoverPending: async (...arguments_: unknown[]) => {
      if (arguments_.length || !recoveryRequest)
        return { current: false }
      return hanaworlds.verifyService(recoveryRequest, 'RestoreTransaction')
    },
    subscribeCanvasEvents: async (request: Record<string, unknown>) => hanaworlds.verify({ ...request, contractVersion: 'canvas/v4' }, 'ListObjects'),
    call: async (operation: string, raw: unknown) => {
      const request = raw as Record<string, unknown>
      return (
        ['RestoreTransaction', 'AbortPreparedTransaction', 'AbortPreparedHistoryTransaction'].includes(operation)
          ? hanaworlds.verifyService(request, operation)
          : ['APPLY_RECOVERABLE', 'INSPECT', 'READBACK', 'HISTORY', 'UNDO', 'REDO'].includes(operation)
              ? hanaworlds.verifyEngineBinding(request, operation)
              : hanaworlds.verify(request, operation))
    },
  }
  services.hanaworldsCanvasV4 = canvas
  const sessions = new Map([['session-a', { id: 'session-a' }]])
  setCurrentHostInstance({
    sessions: {
      get: (id: string) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    get: (name: string) => services[name],
  } as never)
  hanaworlds.attachCanvas(canvas)
  return {
    calls,
    canvas,
    services,
    sessions,
    revoke: () => { online = false },
    regrant: () => {
      online = true
      currentGrant = { ...firstGrant, grantRef: 'grant-b' }
    },
    revise: (revision: string) => { worldRevision = revision },
    setRecoveryRequest: (request: Record<string, unknown>) => { recoveryRequest = request },
  }
}

describe('hanaWorlds Canvas authority', () => {
  it('attests a running local world only through a current host process fact', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    const request = { action: 'BIND_RUNNING_WORLD', worldPath: '/isolated/world-a', worldRef: firstGrant.worldRef }
    await expect(hanaworlds.verifyOperator(request)).resolves.toEqual({ current: false })
    let connected = true
    runtime.services.hanaworldsLocalWorldProcessEvidence = {
      verifyRunningWorld: async () => connected ? { current: true, worldPath: request.worldPath, worldRef: request.worldRef, processRef: 'process-a', running: true } : { current: false },
    }
    await expect(hanaworlds.verifyOperator(request)).resolves.toMatchObject({ current: true, worldPath: request.worldPath, worldRef: request.worldRef, action: 'BIND_RUNNING_WORLD' })
    connected = false
    await expect(hanaworlds.verifyOperator(request)).resolves.toEqual({ current: false })
    await expect(hanaworlds.verifyOperator({ ...request, action: 'PROVISION_PAYLOAD' })).resolves.toEqual({ current: false })
  })

  it('returns only the exact Canvas operation and current trusted world revision', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    const body = runtime.calls[0]!.body
    const canvasRequest = { ...body, contractVersion: 'canvas/v4' }
    await expect(hanaworlds.verify(canvasRequest, 'ApplyRecoverableCommit')).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('ApplyRecoverableCommit', canvasRequest)).resolves.toMatchObject({
      current: true,
      allowedActions: ['ApplyRecoverableCommit'],
      currentWorldRevision: 'world-rev-1',
      actorRef: 'luanti:player-a',
      sessionRef: 'session-a',
      worldRef: firstGrant.worldRef,
    })
    await expect(runtime.canvas.call('AuthorizeBinding', { ...body, contractVersion: 'world-adapter/v4', actorRef: 'hanaworlds-canvas' })).resolves.toMatchObject({
      current: true,
      actorRef: 'hanaworlds-canvas',
      allowedActions: ['AuthorizeBinding'],
      domainOwner: 'hanaworlds-canvas',
    })
    runtime.revise('world-rev-2')
    await expect(runtime.canvas.call('ApplyRecoverableCommit', { ...canvasRequest, expectedWorldRevision: 'world-rev-1' })).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('InspectObject', { ...canvasRequest, expectedRevision: 'world-rev-1' })).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('UnknownOperation', canvasRequest)).resolves.toEqual({ current: false })
  })

  it('preserves exact Workshop permissions for the existing Session actions', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    const request = { ...runtime.calls[0]!.body, contractVersion: 'session/v2' }
    await expect(hanaworlds.verify(request, 'StartOrResumeSession')).resolves.toMatchObject({ current: true, allowedActions: ['READ'] })
    await expect(hanaworlds.verify(request, 'ApplyCurrentBuild')).resolves.toMatchObject({ current: true, allowedActions: ['APPLY_RECOVERABLE'] })
    await expect(hanaworlds.verify(request, 'NoSuchSessionAction')).resolves.toEqual({ current: false })
  })

  it('keeps Canvas event subscriptions under the same trusted service scope', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    await expect(runtime.canvas.subscribeCanvasEvents(runtime.calls[0]!.body)).resolves.toMatchObject({ current: true, allowedActions: ['ListObjects'] })
  })

  it('rejects browser shaped engine identity and only accepts a current bound principal', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    const body = runtime.calls[0]!.body
    await expect(hanaworlds.verifyEngineBinding({ ...body, contractVersion: 'world-adapter/v4', actorRef: 'hanaworlds-canvas' }, 'READBACK')).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('APPLY_RECOVERABLE', { ...body, actorRef: 'hanaworlds-canvas', authorizationBinding: { actorRef: 'luanti:player-a' } })).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('APPLY_RECOVERABLE', { ...body, actorRef: 'hanaworlds-canvas', authorizationBinding: { actorRef: 'luanti:player-a' }, contractVersion: 'world-adapter/v4' })).resolves.toMatchObject({ current: true, actorRef: 'luanti:player-a', allowedActions: ['APPLY_RECOVERABLE'] })
    await expect(runtime.canvas.call('READBACK', { ...body, actorRef: 'hanaworlds-canvas', contractVersion: 'world-adapter/v4' })).resolves.toMatchObject({ current: true, actorRef: 'luanti:player-a', allowedActions: ['READBACK'] })
    runtime.revoke()
    await expect(runtime.canvas.call('APPLY_RECOVERABLE', { ...body, actorRef: 'hanaworlds-canvas', authorizationBinding: { actorRef: 'luanti:player-a' }, contractVersion: 'world-adapter/v4' })).resolves.toEqual({ current: false })
  })

  it('limits service recovery to Canvas durable pending entrypoint after grant withdrawal', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    const body = runtime.calls[0]!.body
    const request = { contractVersion: 'world-adapter/v4', actorRef: 'hanaworlds-canvas', sessionRef: body.sessionRef, authorizationRef: body.authorizationRef, worldRef: firstGrant.worldRef, requestId: 'recover-1', originTransactionId: 'tx-1', operationDigest: 'a'.repeat(64), beforeImageDigest: 'b'.repeat(64), restoreAttemptIdentity: 'c'.repeat(64), guarantee: 'RECOVERABLE_VERIFIED' }
    runtime.setRecoveryRequest(request)
    await expect(hanaworlds.verifyService(request, 'RestoreTransaction')).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('RestoreTransaction', request)).resolves.toEqual({ current: false })
    await expect(runtime.canvas.recoverPending()).resolves.toMatchObject({ current: true, domainOwner: 'hanaworlds-canvas', worldRef: firstGrant.worldRef, sessionRef: 'session-a', authorizationRef: body.authorizationRef, allowedActions: ['RestoreTransaction'] })
    await expect(runtime.canvas.recoverPending('tx-forged')).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('AbortPreparedTransaction', { ...request, transactionId: 'tx-1' })).resolves.toMatchObject({ current: true, allowedActions: ['AbortPreparedTransaction'] })
    await expect(hanaworlds.verifyService(request, 'InspectRegion')).resolves.toEqual({ current: false })
    runtime.revoke()
    await expect(runtime.canvas.call('ApplyRecoverableCommit', { ...body, contractVersion: 'canvas/v4' })).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('RestoreTransaction', request)).resolves.toEqual({ current: false })
    await expect(runtime.canvas.call('AbortPreparedTransaction', { ...request, transactionId: 'tx-1' })).resolves.toEqual({ current: false })
    await expect(runtime.canvas.recoverPending()).resolves.toMatchObject({ current: true, domainOwner: 'hanaworlds-canvas', worldRef: firstGrant.worldRef, sessionRef: 'session-a', authorizationRef: body.authorizationRef, allowedActions: ['RestoreTransaction'] })
    for (const invalid of [
      { actorRef: 'browser' },
      { worldRef: '' },
      { originTransactionId: '' },
      { sessionRef: '' },
      { authorizationRef: '' },
      { operationDigest: 'wrong' },
      { beforeImageDigest: 'wrong' },
      { restoreAttemptIdentity: 'wrong' },
      { domainOwner: 'hanaworlds-canvas' },
    ]) {
      runtime.setRecoveryRequest({ ...request, ...invalid })
      await expect(runtime.canvas.recoverPending()).resolves.toEqual({ current: false })
    }
    runtime.setRecoveryRequest(request)
    runtime.regrant()
    await expect(runtime.canvas.call('ApplyRecoverableCommit', { ...body, contractVersion: 'canvas/v4' })).resolves.toEqual({ current: false })
    await expect(runtime.canvas.recoverPending()).resolves.toMatchObject({ current: true, authorizationRef: body.authorizationRef })
    runtime.sessions.delete('session-a')
    await expect(runtime.canvas.recoverPending()).resolves.toMatchObject({ current: true, sessionRef: 'session-a', authorizationRef: body.authorizationRef })
    runtime.services.hanaworldsCanvasV4 = { ...runtime.canvas }
    await expect(runtime.canvas.recoverPending()).resolves.toEqual({ current: false })
  })

  it('rejects a Canvas provider withdrawn during world revision lookup', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'StartOrResumeSession', {})
    let release!: (revision: string) => void
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    runtime.services.hanaworldsWorldRevisionOracle = {
      read: () => {
        reading()
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
    }
    const request = { ...runtime.calls[0]!.body, contractVersion: 'canvas/v4' }
    const pending = runtime.canvas.call('ApplyRecoverableCommit', request)
    await started
    delete runtime.services.hanaworldsCanvasV4
    release('world-rev-1')
    await expect(pending).resolves.toEqual({ current: false })
  })
})

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

const undoStatus = { contractVersion: 'session/v2', requestId: 'undo-status-1' }
const undoBuild = { ...undoStatus, requestId: 'undo-1', expectedTurnRevision: 'turn-rev-1', expectedHistoryRevision: 'history-rev-1' }

describe('hanaWorlds trusted undo bridge', () => {
  it.each(['ReadCurrentUndoStatus', 'UndoCurrentBuild'])('forwards %s with host identity and explicit history/undo authority', async (operation) => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    const payload = operation === 'UndoCurrentBuild' ? undoBuild : undoStatus
    await expect(hanaworlds.call('session-a', operation, payload)).resolves.toEqual({ ok: true })
    const body = runtime.calls[0]!.body
    expect(body).toEqual({ ...payload, actorRef: 'luanti:player-a', sessionRef: 'session-a', worldRef: firstGrant.worldRef, authorizationRef: expect.any(String) })
    const proof = await hanaworlds.verify(body, operation)
    expect(proof).toMatchObject({ current: true, worldRef: firstGrant.worldRef, allowedActions: [operation === 'UndoCurrentBuild' ? 'UNDO' : 'HISTORY'] })
    runtime.revoke()
    await expect(hanaworlds.verify(body, operation)).resolves.toEqual({ current: false })
    runtime.regrant()
    await expect(hanaworlds.verify(body, operation)).resolves.toEqual({ current: false })
  })

  it.each([['ReadCurrentUndoStatus', 'HISTORY'], ['UndoCurrentBuild', 'UNDO']])('does not classify %s as READ', async (operation, action) => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', operation!, operation === 'UndoCurrentBuild' ? undoBuild : undoStatus)
    await expect(hanaworlds.verify(runtime.calls[0]!.body, operation)).resolves.toMatchObject({ current: true, allowedActions: [action] })
  })

  it('keeps a new binding when an old in-flight proof completes', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    let resolve!: (value: typeof firstGrant) => void
    let checked!: () => void
    const started = new Promise<void>((done) => {
      checked = done
    })
    const evidence = {
      listCurrentLocalGrants: async () => [firstGrant],
      verifyCurrentLocalGrant: async () => {
        checked()
        return new Promise<typeof firstGrant>((done) => {
          resolve = done
        })
      },
    }
    runtime.services.hanaworldsLuantiGrantEvidence = evidence
    const pending = hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)
    const rejected = expect(pending).rejects.toThrow('TRUSTED_BINDING_REQUIRED')
    await started
    evidence.verifyCurrentLocalGrant = async () => firstGrant
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    resolve(firstGrant)
    await rejected
    expect(runtime.calls).toHaveLength(0)
    await expect(hanaworlds.call('session-a', 'ReadCurrentUndoStatus', undoStatus)).resolves.toEqual({ ok: true })
  })

  it('checks the acting principal on Adapter engine binding rather than its Canvas service actor', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)
    const body = { ...runtime.calls[0]!.body, contractVersion: 'world-adapter/v4', actorRef: 'hanaworlds-canvas', authorizationBinding: { actorRef: 'luanti:player-a' } }
    await expect(runtime.canvas.call('UNDO', body)).resolves.toMatchObject({ current: true, actorRef: 'luanti:player-a', allowedActions: ['UNDO'] })
    await expect(runtime.canvas.call('UNDO', { ...body, authorizationBinding: { actorRef: 'forged' } })).resolves.toEqual({ current: false })
  })

  it.each(['actorRef', 'sessionRef', 'worldRef', 'authorizationRef', 'authorizationBinding', 'nativeGrantRef', 'objectRef', 'transactionId', 'headTransactionId', 'turnRef', 'allowedActions'])('rejects caller supplied %s before forwarding undo', async (key) => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', { ...undoBuild, [key]: 'forged' })).rejects.toThrow('WORKSHOP_OPERATION_INVALID')
    expect(runtime.calls).toHaveLength(0)
  })

  it.each([
    ['ReadCurrentUndoStatus', { ...undoStatus, expectedHistoryRevision: 'extra' }],
    ['ReadCurrentUndoStatus', { ...undoStatus, contractVersion: 'session/v1' }],
    ['ReadCurrentUndoStatus', { ...undoStatus, requestId: '' }],
    ['UndoCurrentBuild', undoStatus],
    ['UndoCurrentBuild', { ...undoBuild, expectedTurnRevision: '' }],
    ['UndoCurrentBuild', { ...undoBuild, expectedHistoryRevision: 1 }],
    ['Undo', undoBuild],
    ['RedoCurrentBuild', undoBuild],
  ])('rejects invalid typed input for %s', async (operation, payload) => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await expect(hanaworlds.call('session-a', operation as string, payload as Record<string, unknown>)).rejects.toThrow('WORKSHOP_OPERATION_INVALID')
    expect(runtime.calls).toHaveLength(0)
  })

  it.each(['revoke', 'regrant', 'disconnect', 'replace-session', 'world'])('rejects undo after %s', async (change) => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    if (change === 'revoke')
      runtime.revoke()
    if (change === 'regrant')
      runtime.regrant()
    if (change === 'disconnect')
      runtime.sessions.clear()
    if (change === 'replace-session')
      runtime.sessions.set('session-a', { id: 'session-a' })
    if (change === 'world')
      runtime.services.hanaworldsLuantiGrantEvidence = { listCurrentLocalGrants: async () => [], verifyCurrentLocalGrant: async () => ({ ...firstGrant, worldRef: 'world-b' }) }
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)).rejects.toThrow('TRUSTED_BINDING_REQUIRED')
    expect(runtime.calls).toHaveLength(0)
  })

  it('rejects a Session disappearing during the asynchronous grant check', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.services.hanaworldsLuantiGrantEvidence = {
      listCurrentLocalGrants: async () => [firstGrant],
      verifyCurrentLocalGrant: async () => {
        runtime.sessions.clear()
        return firstGrant
      },
    }
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)).rejects.toThrow('TRUSTED_BINDING_REQUIRED')
    expect(runtime.calls).toHaveLength(0)
  })

  it('does not authorize forged actors or old authorization references', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await hanaworlds.call('session-a', 'ReadCurrentUndoStatus', undoStatus)
    const body = runtime.calls[0]!.body
    await expect(hanaworlds.verify({ ...body, actorRef: 'forged' }, 'ReadCurrentUndoStatus')).resolves.toEqual({ current: false })
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    await expect(hanaworlds.verify(body, 'ReadCurrentUndoStatus')).resolves.toEqual({ current: false })
  })

  it('preserves typed Workshop denial and rejects unavailable or throwing Workshop', async () => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    const denied = { contractVersion: 'session/v2', requestId: undoBuild.requestId, result: null, error: { code: 'AUTHORIZATION_REVOKED', stage: 'authorize', reason: 'GRANT_REVOKED' } }
    runtime.services.hanaworldsWorkshop = { call: async () => denied }
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)).resolves.toEqual(denied)
    runtime.services.hanaworldsWorkshop = { call: async () => {
      throw new Error('WORKSHOP_DENIED')
    } }
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)).rejects.toThrow('WORKSHOP_DENIED')
    delete runtime.services.hanaworldsWorkshop
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)).rejects.toThrow('WORKSHOP_UNAVAILABLE')
  })
})

describe('hanaWorlds undo result release', () => {
  it.each(['revoke', 'rebind', 'disconnect', 'replace-workshop'])('does not release a stale success after %s while Workshop is pending', async (change) => {
    const runtime = host()
    await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
    runtime.services.hanaworldsWorkshop = { call: async () => {
      if (change === 'revoke')
        runtime.revoke()
      if (change === 'rebind')
        await hanaworlds.bind('session-a', firstGrant.worldRef, firstGrant.engineActorName)
      if (change === 'disconnect')
        runtime.sessions.clear()
      if (change === 'replace-workshop')
        runtime.services.hanaworldsWorkshop = { call: async () => ({ ok: true }) }
      return { ok: true }
    } }
    await expect(hanaworlds.call('session-a', 'UndoCurrentBuild', undoBuild)).rejects.toThrow('SESSION_OR_GRANT_CHANGED')
  })
})
