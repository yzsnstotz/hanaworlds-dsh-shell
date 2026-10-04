import { randomUUID } from 'node:crypto'

export const inject = ['connection', 'webServer', 'sessions', 'sessionPersistence']

export function apply(ctx) {
  let grantActive = true
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
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { send(rejection, { error: 'CONNECTION_REJECTED' }); return }
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
      const session = ctx.sessions.get(input.sessionId)
      if (!session) { send(409, { error: 'SESSION_NOT_CURRENT' }); return }
      if (req.method === 'POST' && input.action === 'revoke') {
        grantActive = false
        send(200, { grant: 'fixture-revoked' })
        return
      }
      if (req.method === 'POST' && input.action !== 'record') {
        send(400, { error: 'ACTION_INVALID' })
        return
      }
      if (req.method === 'POST' && !grantActive) {
        send(403, { error: 'FIXTURE_GRANT_REVOKED' })
        return
      }
      try {
        if (req.method === 'POST') {
          const id = `hw-eval-${randomUUID()}`
          session.append('user/message', {
            id, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: 'HanaWorlds evaluation action' }],
          }, { surfaceOp: 'append' })
          if (await ctx.sessions.flush(session) !== true) throw new Error('SESSION_FLUSH_FAILED')
        }
        const handle = await ctx.sessionPersistence.open(session.id, 'read')
        let events
        try { ({ events } = await handle.read()) } finally { await handle.close() }
        if (!Array.isArray(events)) throw new Error('SESSION_READ_INVALID')
        const markers = events.filter(event => event.type === 'user/message'
          && typeof event.data?.id === 'string' && event.data.id.startsWith('hw-eval-')
          && event.data.content?.[0]?.text === 'HanaWorlds evaluation action')
        send(200, { sessionId: session.id, count: markers.length, grant: grantActive ? 'fixture-current' : 'fixture-revoked' })
      } catch (error) {
        send(503, { error: error instanceof Error ? error.message : 'SESSION_UNAVAILABLE' })
      }
    },
  }), 'hanaworlds-official-eval: route')
}
