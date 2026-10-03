import type { HostContext, SessionId } from '../types'
import { randomUUID } from 'node:crypto'
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
  sessionRef: string
  actorRef: string
  authorizationRef: string
}

const bindings = new Map<string, Binding>()
const allowedOperations = new Set([
  'StartOrResumeSession',
  'SwitchWorldContext',
  'AppendMultimodalTurn',
  'AnswerClarification',
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
    if (!liveSession(sessionRef) || !worldRef || !engineActorName)
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
    if (!liveSession(sessionRef))
      throw new Error('SESSION_NOT_CURRENT')
    bindings.set(sessionRef, { ...candidate, actorRef: `luanti:${engineActorName}`, sessionRef, authorizationRef: randomUUID() })
    return { status: 'bound', sessionRef, worldRef, engineActorName }
  },

  async call(sessionRef: string, operation: string, payload: Record<string, unknown>) {
    if (!allowedOperations.has(operation) || !payload || Array.isArray(payload)
      || typeof payload !== 'object') {
      throw new Error('WORKSHOP_OPERATION_INVALID')
    }
    const binding = await currentBinding(sessionRef)
    if (!binding)
      throw new Error('TRUSTED_BINDING_REQUIRED')
    const host = getCurrentHostInstance() as unknown as HostContext
    const workshop = serviceOf(host, 'hanaworldsWorkshop') as { call?: (operation: string, body: unknown) => Promise<unknown> } | undefined
    if (typeof workshop?.call !== 'function')
      throw new Error('WORKSHOP_UNAVAILABLE')
    const body: Record<string, unknown> = { ...payload, actorRef: binding.actorRef, sessionRef: binding.sessionRef, authorizationRef: binding.authorizationRef }
    if ('worldRef' in body)
      body.worldRef = binding.worldRef
    delete body.authorizationBinding
    return workshop.call(operation, body)
  },

  async verify(request: Record<string, unknown>) {
    const binding = await bindingFor(request)
    if (!binding)
      return { current: false }
    return { current: true, actorRef: binding.actorRef, sessionRef: binding.sessionRef, worldRef: binding.worldRef, authorizationRef: binding.authorizationRef, engineActorName: binding.engineActorName, nativeGrantRef: binding.grantRef, authorRef: binding.actorRef, surface: 'SHELL', allowedActions: ['READ', 'APPEND', 'INSPECT', 'SELECT', 'ANALYZE', 'APPLY_RECOVERABLE'] }
  },

  async verifyEngineBinding(request: Record<string, unknown>) {
    return hanaworlds.verify(request)
  },

  async verifyService() {
    return { current: false }
  },

  clear() {
    bindings.clear()
  },
})

function serviceOf(host: HostContext, name: string): unknown {
  const resolver = host as HostContext & { get?: (name: string) => unknown }
  return typeof resolver.get === 'function' ? resolver.get(name) : undefined
}

function grantEvidence(): GrantEvidence | null {
  const host = getCurrentHostInstance() as unknown as HostContext
  const service = serviceOf(host, 'hanaworldsLuantiGrantEvidence') as Partial<GrantEvidence> | undefined
  return typeof service?.listCurrentLocalGrants === 'function'
    && typeof service.verifyCurrentLocalGrant === 'function'
    ? service as GrantEvidence
    : null
}

function liveSession(sessionRef: string): boolean {
  if (typeof sessionRef !== 'string' || !sessionRef)
    return false
  const host = getCurrentHostInstance() as unknown as HostContext
  return host.sessions.get(sessionRef as SessionId) !== undefined
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
  if (!liveSession(sessionRef)) {
    bindings.delete(sessionRef)
    return null
  }
  const evidence = grantEvidence()
  if (!evidence) {
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
    bindings.delete(sessionRef)
    return null
  }
  if (!validGrant(proof) || proof.grantRef !== binding.grantRef
    || proof.worldRef !== binding.worldRef || proof.engineActorName !== binding.engineActorName) {
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
