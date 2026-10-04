import type { HostContext, Session, SessionId, UserMessage } from '../types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { getCurrentHostInstance } from '../config/runtime'
import { defineService } from './index'

interface Grant {
  current: true
  worldRef: string
  engineActorName: string
  scope: 'WORLD_BUILD_WITH_ENGINE_PROTECTION'
  grantRef: string
}

interface GrantEvidence {
  listCurrentLocalGrants: () => Promise<Grant[]>
  verifyCurrentLocalGrant: (candidate: {
    worldRef: string
    engineActorName: string
    expectedGrantRef: string
  }) => Promise<Grant | { current: false }>
}

interface Binding extends Grant {
  session: Session
  sessionRef: string
  actorRef: string
  authorizationRef: string
}

interface StoredEvent {
  type: string
  seq: number
  surfaceOp?: string
  data: Record<string, unknown>
}

interface SessionPersistenceReader {
  open: (sessionRef: SessionId, access: 'read') => Promise<{
    read: () => Promise<{ events: StoredEvent[] }>
    close: () => Promise<void>
  }>
}

const bindings = new Map<string, Binding>()
const confirmationLocks = new Map<string, Promise<void>>()
const confirmedTurns = new Map<string, Map<string, { requestId: string, answer: string }>>()
const canvasCalls = new AsyncLocalStorage<object>()
const canvasOperations = new Set(['ListWorldConnections', 'SelectWorldConnection', 'SwitchWorldConnection', 'ListObjects', 'CreateObject', 'NameObject', 'RenameObject', 'SetObjectSelection', 'InspectObject', 'AnalyzeAffectedObjects', 'DecideAffectedObjectNotification', 'ApplyRecoverableCommit', 'Readback', 'Undo', 'Redo', 'HistoryQuery', 'InspectPlacementRegion'])
const adapterOperations = new Set(['DiscoverConnections', 'ListWorlds', 'AuthorizeBinding', 'InspectWorld', 'PrepareRecoverableTransaction', 'ApplyCompiledTransaction', 'Readback', 'QueryTransaction', 'QueryPreparedTransaction', 'PrepareHistoryTransaction', 'QueryPreparedHistoryTransaction', 'ApplyHistoryTransaction', 'InspectRegion'])
const engineActions = new Set(['APPLY_RECOVERABLE', 'INSPECT', 'READBACK', 'HISTORY', 'UNDO', 'REDO'])
const serviceOperations = new Set(['RestoreTransaction', 'AbortPreparedTransaction', 'AbortPreparedHistoryTransaction'])
const workshopActions = new Map<string, string>([
  ['StartOrResumeSession', 'READ'],
  ['SwitchWorldContext', 'SELECT'],
  ['AppendMultimodalTurn', 'APPEND'],
  ['AnswerClarification', 'APPEND'],
  ['ReadSessionTurnDetails', 'READ'],
  ['ReadCurrentUndoStatus', 'HISTORY'],
  ['UndoCurrentBuild', 'UNDO'],
  ['ListObjects', 'READ'],
  ['SelectObjects', 'SELECT'],
  ['BeginFirstBuilding', 'INSPECT'],
  ['CreateBuildPlan', 'INSPECT'],
  ['CompileCurrentBuild', 'INSPECT'],
  ['AnalyzeCurrentBuild', 'ANALYZE'],
  ['ApplyCurrentBuild', 'APPLY_RECOVERABLE'],
  ['InvokeAction', 'INSPECT'],
  ['RecordActionReceipt', 'APPEND'],
  ['PersistRequiredArtifactResources', 'APPEND'],
  ['ReopenExistingArtifact', 'READ'],
])
const allowedOperations = new Set([
  'StartOrResumeSession',
  'SwitchWorldContext',
  'AppendMultimodalTurn',
  'AnswerClarification',
  'ReadSessionTurnDetails',
  'ReadCurrentUndoStatus',
  'UndoCurrentBuild',
  'ListObjects',
  'SelectObjects',
  'BeginFirstBuilding',
  'CreateBuildPlan',
  'CompileCurrentBuild',
  'AnalyzeCurrentBuild',
  'ApplyCurrentBuild',
  'InvokeAction',
  'RecordActionReceipt',
  'PersistRequiredArtifactResources',
  'ReopenExistingArtifact',
])
const worldRefOperations = new Set(['SwitchWorldContext', 'ListObjects', 'CreateBuildPlan', 'ReadCurrentUndoStatus', 'UndoCurrentBuild'])

export const hanaworlds = defineService({
  async context(sessionRef?: string) {
    const host = getCurrentHostInstance() as unknown as HostContext
    const sessions = host.sessions.list().map((session, index) => ({
      sessionRef: session.id,
      label: `Session ${index + 1}`,
    }))
    const evidence = grantEvidence()
    if (!evidence)
      return { status: 'unavailable', reason: 'NATIVE_GRANT_EVIDENCE_UNAVAILABLE', sessions }
    const grants = await evidence.listCurrentLocalGrants()
    const candidates = grants.filter(validGrant).map(({ worldRef, engineActorName, scope }) => ({
      worldRef,
      engineActorName,
      scope,
    }))
    if (typeof sessionRef !== 'string' || !sessionRef)
      return { status: 'unbound', sessions, candidates }
    const binding = await currentBinding(sessionRef)
    return binding
      ? { status: 'bound', sessionRef, worldRef: binding.worldRef, engineActorName: binding.engineActorName, sessions, candidates }
      : { status: 'unbound', sessionRef, sessions, candidates }
  },

  async bind(sessionRef: string, worldRef: string, engineActorName: string) {
    const session = liveSession(sessionRef)
    if (!session || !worldRef || !engineActorName)
      throw new Error('SESSION_OR_CANDIDATE_INVALID')
    const evidence = grantEvidence()
    if (!evidence)
      throw new Error('NATIVE_GRANT_EVIDENCE_UNAVAILABLE')
    const grants = await evidence.listCurrentLocalGrants()
    const candidate = grants.find(grant => validGrant(grant)
      && grant.worldRef === worldRef && grant.engineActorName === engineActorName)
    if (!candidate)
      throw new Error('NATIVE_GRANT_NOT_CURRENT')
    const proof = await evidence.verifyCurrentLocalGrant({
      worldRef,
      engineActorName,
      expectedGrantRef: candidate.grantRef,
    })
    if (!validGrant(proof) || proof.grantRef !== candidate.grantRef
      || proof.worldRef !== worldRef || proof.engineActorName !== engineActorName) {
      throw new Error('NATIVE_GRANT_NOT_CURRENT')
    }
    if (liveSession(sessionRef) !== session)
      throw new Error('SESSION_NOT_CURRENT')
    bindings.set(sessionRef, { ...candidate, session, actorRef: `luanti:${engineActorName}`, sessionRef, authorizationRef: randomUUID() })
    return { status: 'bound', sessionRef, worldRef, engineActorName }
  },

  async call(sessionRef: string, operation: string, payload: Record<string, unknown>) {
    if (!allowedOperations.has(operation) || !payload || Array.isArray(payload)
      || typeof payload !== 'object') {
      throw new Error('WORKSHOP_OPERATION_INVALID')
    }
    if (operation === 'ReadCurrentUndoStatus' || operation === 'UndoCurrentBuild') {
      const fields = operation === 'UndoCurrentBuild'
        ? ['contractVersion', 'requestId', 'expectedTurnRevision', 'expectedHistoryRevision']
        : ['contractVersion', 'requestId']
      if (payload.contractVersion !== 'session/v2'
        || Object.keys(payload).some(key => !fields.includes(key))
        || fields.some(key => typeof payload[key] !== 'string' || !payload[key])) {
        throw new Error('WORKSHOP_OPERATION_INVALID')
      }
    }
    const binding = await currentBinding(sessionRef)
    if (!binding)
      throw new Error('TRUSTED_BINDING_REQUIRED')
    const host = getCurrentHostInstance() as unknown as HostContext
    const workshop = serviceOf(host, 'hanaworldsWorkshop') as { call?: (operation: string, body: unknown) => Promise<unknown> } | undefined
    if (typeof workshop?.call !== 'function')
      throw new Error('WORKSHOP_UNAVAILABLE')
    const workshopCall = workshop.call.bind(workshop)
    const body: Record<string, unknown> = { ...payload, actorRef: binding.actorRef, sessionRef: binding.sessionRef, authorizationRef: binding.authorizationRef }
    if (worldRefOperations.has(operation) || 'worldRef' in body)
      body.worldRef = binding.worldRef
    delete body.authorizationBinding
    if (operation === 'AnswerClarification') {
      return withConfirmationLock(sessionRef, async () => {
        await persistConfirmation(host, binding, body)
        return workshopCall(operation, body)
      })
    }
    const result = await workshopCall(operation, body)
    if ((operation === 'ReadCurrentUndoStatus' || operation === 'UndoCurrentBuild')
      && (await currentBinding(sessionRef) !== binding
        || serviceOf(host, 'hanaworldsWorkshop') !== workshop)) {
      throw new Error('SESSION_OR_GRANT_CHANGED')
    }
    return result
  },

  async verify(request: Record<string, unknown>, operation?: string) {
    const contract = request?.contractVersion
    const canvas = contract === 'canvas/v4' && canvasOperations.has(operation ?? '')
    const adapter = contract === 'world-adapter/v4' && adapterOperations.has(operation ?? '')
    const workshop = contract === 'session/v2' && workshopActions.has(operation ?? '')
    if (!canvas && !adapter && !workshop)
      return { current: false }
    const caller = canvas || adapter ? activeCanvas() : null
    if ((canvas || adapter) && !caller)
      return { current: false }
    const binding = await bindingFor(request)
    if (!binding || request.actorRef !== (adapter ? 'hanaworlds-canvas' : binding.actorRef))
      return { current: false }
    const revision = await currentWorldRevision(binding, request, operation)
    if (!revision || (caller && activeCanvas() !== caller))
      return { current: false }
    const allowedActions = workshop ? [workshopActions.get(operation ?? '')] : [operation]
    return { current: true, actorRef: request.actorRef, sessionRef: binding.sessionRef, worldRef: binding.worldRef, authorizationRef: binding.authorizationRef, engineActorName: binding.engineActorName, nativeGrantRef: binding.grantRef, authorRef: binding.actorRef, surface: 'SHELL', allowedActions, currentWorldRevision: revision, ...(adapter ? { domainOwner: 'hanaworlds-canvas' } : {}) }
  },

  async verifyEngineBinding(request: Record<string, unknown>, operation?: string) {
    const caller = activeCanvas()
    if (request?.contractVersion !== 'world-adapter/v4' || request.actorRef !== 'hanaworlds-canvas'
      || !engineActions.has(operation ?? '') || !caller) {
      return { current: false }
    }
    const binding = await bindingFor(request)
    const statedActor = (request.authorizationBinding as { actorRef?: unknown } | undefined)?.actorRef
    if (!binding || (statedActor !== undefined && statedActor !== binding.actorRef))
      return { current: false }
    const revision = await currentWorldRevision(binding, request)
    if (!revision || activeCanvas() !== caller)
      return { current: false }
    return { current: true, actorRef: binding.actorRef, sessionRef: binding.sessionRef, worldRef: binding.worldRef, authorizationRef: binding.authorizationRef, engineActorName: binding.engineActorName, nativeGrantRef: binding.grantRef, authorRef: binding.actorRef, surface: 'SHELL', allowedActions: [operation], currentWorldRevision: revision, domainOwner: 'hanaworlds-canvas' }
  },

  async verifyService(request: Record<string, unknown>, operation?: string) {
    if (request?.contractVersion !== 'world-adapter/v4' || request.actorRef !== 'hanaworlds-canvas'
      || !serviceOperations.has(operation ?? '') || typeof request.transactionId !== 'string' || !request.transactionId) {
      return { current: false }
    }
    const canvas = activeCanvas()
    const binding = await bindingFor(request)
    if (!binding || !canvas) {
      return { current: false }
    }
    const revision = await currentWorldRevision(binding, request)
    if (!revision || activeCanvas() !== canvas)
      return { current: false }
    return { current: true, actorRef: 'hanaworlds-canvas', sessionRef: binding.sessionRef, worldRef: binding.worldRef, authorizationRef: binding.authorizationRef, domainOwner: 'hanaworlds-canvas', allowedActions: [operation], currentWorldRevision: revision }
  },

  async verifyOperator(request: Record<string, unknown>) {
    if (request?.action !== 'BIND_RUNNING_WORLD' || typeof request.worldPath !== 'string'
      || !isAbsolute(request.worldPath) || typeof request.worldRef !== 'string' || !request.worldRef) {
      return { current: false }
    }
    const host = getCurrentHostInstance() as unknown as HostContext
    const evidence = serviceOf(host, 'hanaworldsLocalWorldProcessEvidence') as { verifyRunningWorld?: (worldPath: string, worldRef: string) => Promise<unknown> } | undefined
    if (typeof evidence?.verifyRunningWorld !== 'function')
      return { current: false }
    for (const candidate of bindings.values()) {
      if (candidate.worldRef !== request.worldRef || await currentBinding(candidate.sessionRef) !== candidate)
        continue
      try {
        const proof = await evidence.verifyRunningWorld(request.worldPath, request.worldRef) as Record<string, unknown>
        if (proof?.current === true && proof.running === true
          && proof.worldPath === request.worldPath && proof.worldRef === request.worldRef
          && typeof proof.processRef === 'string' && proof.processRef
          && serviceOf(host, 'hanaworldsLocalWorldProcessEvidence') === evidence
          && await currentBinding(candidate.sessionRef) === candidate) {
          return { current: true, action: 'BIND_RUNNING_WORLD', worldPath: request.worldPath, worldRef: request.worldRef, processRef: proof.processRef }
        }
      }
      catch {
        return { current: false }
      }
    }
    return { current: false }
  },

  attachCanvas(canvas: { call?: (operation: string, request: unknown) => Promise<unknown>, subscribeCanvasEvents?: (context: Record<string, unknown>, callback?: unknown) => Promise<unknown> }) {
    if (typeof canvas?.call !== 'function')
      return
    const original = canvas.call
    const originalSubscribe = canvas.subscribeCanvasEvents
    canvas.call = function (operation, request) {
      return canvasCalls.run(canvas, () => original.call(this, operation, request))
    }
    if (typeof originalSubscribe === 'function') {
      canvas.subscribeCanvasEvents = function (context, callback) {
        return canvasCalls.run(canvas, () => originalSubscribe.call(this, context, callback))
      }
    }
    return () => {
      if (canvas.call !== original)
        canvas.call = original
      if (originalSubscribe && canvas.subscribeCanvasEvents !== originalSubscribe)
        canvas.subscribeCanvasEvents = originalSubscribe
    }
  },

  clear() {
    bindings.clear()
    confirmedTurns.clear()
  },
})

function serviceOf(host: HostContext, name: string): unknown {
  const resolver = host as HostContext & { get?: (name: string) => unknown }
  return typeof resolver.get === 'function' ? resolver.get(name) : undefined
}

function activeCanvas(): object | null {
  const canvas = canvasCalls.getStore()
  const host = getCurrentHostInstance() as unknown as HostContext
  return canvas && serviceOf(host, 'hanaworldsCanvasV4') === canvas ? canvas : null
}

async function currentWorldRevision(binding: Binding, request: Record<string, unknown>, operation?: string): Promise<string | null> {
  const host = getCurrentHostInstance() as unknown as HostContext
  const oracle = serviceOf(host, 'hanaworldsWorldRevisionOracle') as { read?: (worldRef: string) => Promise<unknown> } | undefined
  if (typeof oracle?.read !== 'function')
    return null
  try {
    const revision = await oracle.read(binding.worldRef)
    let expectedWorldRevision = request.expectedWorldRevision
    if (expectedWorldRevision === undefined && request.contractVersion === 'canvas/v4'
      && ['InspectObject', 'AnalyzeAffectedObjects'].includes(operation ?? '')) {
      expectedWorldRevision = request.expectedRevision
    }
    if (typeof revision !== 'string' || !revision
      || (expectedWorldRevision !== undefined && expectedWorldRevision !== revision)
      || await currentBinding(binding.sessionRef) !== binding
      || serviceOf(host, 'hanaworldsWorldRevisionOracle') !== oracle) {
      return null
    }
    return revision
  }
  catch {
    return null
  }
}

function grantEvidence(): GrantEvidence | null {
  const host = getCurrentHostInstance() as unknown as HostContext
  const service = serviceOf(host, 'hanaworldsLuantiGrantEvidence') as Partial<GrantEvidence> | undefined
  return typeof service?.listCurrentLocalGrants === 'function'
    && typeof service.verifyCurrentLocalGrant === 'function'
    ? service as GrantEvidence
    : null
}

function liveSession(sessionRef: string): Session | undefined {
  if (typeof sessionRef !== 'string' || !sessionRef)
    return undefined
  const host = getCurrentHostInstance() as unknown as HostContext
  return host.sessions.get(sessionRef as SessionId)
}

function validGrant(value: unknown): value is Grant {
  const proof = value as Partial<Grant> | null
  return proof?.current === true && typeof proof.worldRef === 'string' && !!proof.worldRef
    && typeof proof.engineActorName === 'string' && !!proof.engineActorName
    && proof.scope === 'WORLD_BUILD_WITH_ENGINE_PROTECTION'
    && typeof proof.grantRef === 'string' && !!proof.grantRef
}

async function currentBinding(sessionRef: string): Promise<Binding | null> {
  const binding = bindings.get(sessionRef)
  if (!binding)
    return null
  if (liveSession(sessionRef) !== binding.session) {
    if (bindings.get(sessionRef) === binding)
      bindings.delete(sessionRef)
    return null
  }
  const evidence = grantEvidence()
  if (!evidence) {
    if (bindings.get(sessionRef) === binding)
      bindings.delete(sessionRef)
    return null
  }
  let proof: Grant | { current: false }
  try {
    proof = await evidence.verifyCurrentLocalGrant({
      worldRef: binding.worldRef,
      engineActorName: binding.engineActorName,
      expectedGrantRef: binding.grantRef,
    })
  }
  catch {
    if (bindings.get(sessionRef) === binding)
      bindings.delete(sessionRef)
    return null
  }
  if (bindings.get(sessionRef) !== binding || liveSession(sessionRef) !== binding.session
    || grantEvidence() !== evidence
    || !validGrant(proof) || proof.grantRef !== binding.grantRef
    || proof.worldRef !== binding.worldRef || proof.engineActorName !== binding.engineActorName) {
    if (bindings.get(sessionRef) === binding)
      bindings.delete(sessionRef)
    return null
  }
  return binding
}

async function bindingFor(request: Record<string, unknown>): Promise<Binding | null> {
  if (!request || typeof request.sessionRef !== 'string')
    return null
  const binding = await currentBinding(request.sessionRef)
  return binding && binding.authorizationRef === request.authorizationRef
    && (request.worldRef === undefined || request.worldRef === binding.worldRef)
    ? binding
    : null
}

async function withConfirmationLock<T>(sessionRef: string, action: () => Promise<T>): Promise<T> {
  const previous = confirmationLocks.get(sessionRef)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  confirmationLocks.set(sessionRef, current)
  if (previous)
    await previous
  try {
    return await action()
  }
  finally {
    if (confirmationLocks.get(sessionRef) === current)
      confirmationLocks.delete(sessionRef)
    release()
  }
}

async function persistConfirmation(host: HostContext, binding: Binding, body: Record<string, unknown>): Promise<void> {
  const { requestId, answer } = body
  if (body.contractVersion !== 'session/v2' || typeof requestId !== 'string' || !requestId
    || typeof answer !== 'string' || typeof body.turnRef !== 'string' || !body.turnRef
    || typeof body.clarificationId !== 'string' || !body.clarificationId
    || typeof body.expectedRevision !== 'string' || !body.expectedRevision
    || Object.keys(body).some(key => ![
      'contractVersion',
      'actorRef',
      'sessionRef',
      'requestId',
      'authorizationRef',
      'turnRef',
      'expectedRevision',
      'clarificationId',
      'answer',
    ].includes(key))) {
    throw new Error('CONFIRMATION_INPUT_INVALID')
  }
  const turnKey = JSON.stringify([body.turnRef, body.clarificationId])
  const previousConfirmation = confirmedTurns.get(binding.sessionRef)?.get(turnKey)
  if (previousConfirmation) {
    const exact = previousConfirmation.requestId === requestId && previousConfirmation.answer === answer
    throw new Error(exact ? 'CONFIRMATION_DUPLICATE' : 'CONFIRMATION_CONFLICT')
  }
  const persistence = serviceOf(host, 'sessionPersistence') as SessionPersistenceReader | undefined
  if (typeof persistence?.open !== 'function')
    throw new Error('SESSION_PERSISTENCE_UNAVAILABLE')
  const session = host.sessions.get(binding.sessionRef as SessionId)
  if (!session)
    throw new Error('SESSION_NOT_CURRENT')
  const beforeSeq = session.seq
  await assertCurrentConfirmation(host, binding, session)
  await flushConfirmation(host, session)
  const before = await readStoredEvents(persistence, session.id)
  await assertCurrentConfirmation(host, binding, session, beforeSeq)
  const duplicate = before.find(event => event.type === 'user/message' && event.data.id === requestId)
  if (duplicate) {
    const content = duplicate.data.content
    const exact = duplicate.surfaceOp === 'append' && duplicate.data.role === 'user'
      && (duplicate.data.source as { kind?: string } | undefined)?.kind === 'user'
      && Array.isArray(content) && content.length === 1
      && content[0]?.type === 'text' && content[0]?.text === answer
    throw new Error(exact ? 'CONFIRMATION_DUPLICATE' : 'CONFIRMATION_CONFLICT')
  }
  const message: UserMessage = {
    id: requestId as UserMessage['id'],
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: answer }],
  }
  let event: ReturnType<Session['append']>
  try {
    event = session.append('user/message', message, { surfaceOp: 'append' })
  }
  catch {
    throw new Error('CONFIRMATION_WRITE_FAILED')
  }
  let sessionTurns = confirmedTurns.get(binding.sessionRef)
  if (!sessionTurns) {
    sessionTurns = new Map()
    confirmedTurns.set(binding.sessionRef, sessionTurns)
  }
  sessionTurns.set(turnKey, { requestId, answer })
  await flushConfirmation(host, session)
  const after = await readStoredEvents(persistence, session.id)
  const landed = after.filter(item => item.type === 'user/message' && item.data.id === requestId)
  if (landed.length !== 1 || landed[0]?.seq !== event.seq || landed[0]?.surfaceOp !== 'append'
    || landed[0]?.data.role !== 'user'
    || (landed[0]?.data.source as { kind?: string } | undefined)?.kind !== 'user'
    || !Array.isArray(landed[0]?.data.content) || landed[0]?.data.content.length !== 1
    || landed[0]?.data.content[0]?.type !== 'text' || landed[0]?.data.content[0]?.text !== answer) {
    throw new Error('CONFIRMATION_NOT_DURABLE')
  }
  await assertCurrentConfirmation(host, binding, session)
}

async function readStoredEvents(persistence: SessionPersistenceReader, sessionRef: SessionId): Promise<StoredEvent[]> {
  try {
    const handle = await persistence.open(sessionRef, 'read')
    try {
      const result = await handle.read()
      if (!Array.isArray(result.events))
        throw new Error('SESSION_READ_INVALID')
      return result.events
    }
    finally {
      await handle.close()
    }
  }
  catch {
    throw new Error('SESSION_READ_INVALID')
  }
}

async function flushConfirmation(host: HostContext, session: Session): Promise<void> {
  let flushed: boolean
  try {
    flushed = await host.sessions.flush(session)
  }
  catch {
    throw new Error('SESSION_FLUSH_UNAVAILABLE')
  }
  if (flushed !== true)
    throw new Error('SESSION_FLUSH_UNAVAILABLE')
}

async function assertCurrentConfirmation(host: HostContext, binding: Binding, session: Session, expectedSeq?: Session['seq']): Promise<void> {
  if (host.sessions.get(binding.sessionRef as SessionId) !== session
    || (expectedSeq !== undefined && session.seq !== expectedSeq)
    || await currentBinding(binding.sessionRef) !== binding) {
    throw new Error('SESSION_OR_GRANT_CHANGED')
  }
}
