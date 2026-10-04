import { randomUUID } from 'node:crypto'

export const inject = ['connection', 'webServer', 'sessions']

const fixtureCapabilities = {
  providerRef: 'fixture', capabilityRevision: '1', worldRef: null,
  engineBounds: null, limits: [], recoveryGuarantee: null,
  stateProfile: null, regionProtectionWriters: [], sessionDeleteSupported: false,
  imageMediaTypes: ['image/png'], model: 'fixture',
}

export function apply(ctx) {
  let grantActive = true
  const soleSession = id => {
    const live = ctx.sessions.list()
    return live.length === 1 && live[0].id === id && ctx.sessions.get(id) === live[0]
      ? live[0] : undefined
  }
  ctx.provide('hanaworldsAuthority', {
    verify: async (body, operation) => {
      if (!grantActive || !soleSession(body.sessionRef)) return { current: false }
      return {
        current: true,
        actorRef: body.actorRef,
        sessionRef: body.sessionRef,
        authorizationRef: body.authorizationRef,
        surface: 'SHELL',
        allowedActions: ['READ'],
        operation,
      }
    },
  })
  ctx.provide('hanaworldsCapabilities', fixtureCapabilities)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/desktop/hanaworlds-eval',
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { send(admission.rejection, { error: 'CONNECTION_REJECTED' }); return }
      if (req.method !== 'GET' && req.method !== 'POST') { send(405, { error: 'METHOD_NOT_ALLOWED' }); return }
      if (req.method === 'POST') {
        const origin = req.headers.origin
        const host = req.headers.host
        if (origin !== undefined && (typeof origin !== 'string' ||
          (origin !== 'dsh-app://app' && origin !== `http://${host}`))) {
          send(403, { error: 'ORIGIN_REJECTED' })
          return
        }
      }
      let input
      if (req.method === 'GET') {
        input = { sessionId: new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') }
      } else {
        let body = ''
        for await (const chunk of req) {
          body += chunk.toString('utf8')
          if (Buffer.byteLength(body) > 4096) { send(413, { error: 'BODY_TOO_LARGE' }); return }
        }
        try { input = JSON.parse(body) } catch { send(400, { error: 'INVALID_JSON' }); return }
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128
        || Object.keys(input).some(key => !['sessionId', 'action'].includes(key))) {
        send(400, { error: 'INVALID_INPUT' })
        return
      }
      const session = soleSession(input.sessionId)
      if (!session) { send(409, { error: 'SESSION_VIEW_UNBOUND' }); return }
      if (req.method === 'POST' && input.action === 'revoke') {
        grantActive = false
        send(200, { grant: 'fixture-revoked', sessionId: session.id })
        return
      }
      if (req.method === 'POST' && input.action !== 'start') {
        send(400, { error: 'ACTION_INVALID' })
        return
      }
      const workshop = ctx.get('hanaworldsWorkshop')
      if (typeof workshop?.call !== 'function') { send(503, { error: 'WORKSHOP_UNAVAILABLE' }); return }
      const operation = req.method === 'POST' ? 'StartOrResumeSession' : 'ReadSessionTurnDetails'
      try {
        const response = await workshop.call(operation, {
          contractVersion: 'session/v2',
          actorRef: 'fixture:operator',
          sessionRef: session.id,
          requestId: `hw-eval-${randomUUID()}`,
          authorizationRef: 'fixture:grant',
          ...(operation === 'StartOrResumeSession' ? { expectedRevision: null } : {}),
        })
        if (response?.error) {
          const code = response.error.code ?? 'WORKSHOP_FAILED'
          send(code === 'AUTHORIZATION_REVOKED' ? 403 : code === 'SESSION_NOT_FOUND' ? 404 : 503, { error: code })
          return
        }
        const result = response?.result
        const sessionId = operation === 'StartOrResumeSession' ? result?.context?.currentSession : result?.sessionRef
        const sessionRevision = operation === 'StartOrResumeSession' ? result?.context?.sessionRevision : result?.sessionRevision
        if (sessionId !== session.id || typeof sessionRevision !== 'string' || !sessionRevision
          || !Array.isArray(result?.turns)) {
          send(503, { error: 'WORKSHOP_RESULT_INVALID' })
          return
        }
        send(200, { operation, sessionId, sessionRevision, turns: result.turns.length, grant: 'fixture-current' })
      } catch {
        send(503, { error: 'WORKSHOP_UNAVAILABLE' })
      }
    },
  }), 'hanaworlds-official-eval: route')
}
