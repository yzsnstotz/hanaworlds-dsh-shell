import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

function harness({ twoSessions = false, workshopAvailable = true } = {}) {
  const sessions = [{ id: 'session-a' }, ...(twoSessions ? [{ id: 'session-b' }] : [])]
  const services = {}
  const calls = []
  const revisions = new Map()
  const routes = []
  const workshop = {
    async call(operation, body) {
      calls.push({ operation, body })
      const proof = await services.hanaworldsAuthority.verify(body, operation)
      if (!proof.current) return { error: { code: 'AUTHORIZATION_REVOKED' }, result: null }
      const revision = revisions.get(body.sessionRef) ?? 'workshop-revision-a'
      revisions.set(body.sessionRef, revision)
      return { error: null, result: operation === 'StartOrResumeSession'
        ? { context: { currentSession: body.sessionRef, sessionRevision: revision }, turns: [] }
        : { sessionRef: body.sessionRef, sessionRevision: revision, turns: [] } }
    },
  }
  if (workshopAvailable) services.hanaworldsWorkshop = workshop
  const mount = () => {
    apply({
      connection: { admit: req => req.headers.cookie === 'dsh=synthetic' ? { peer: { id: 'operator' } } : { rejection: 401 } },
      sessions: { list: () => sessions, get: id => sessions.find(session => session.id === id) },
      webServer: { register: route => { routes.push(route); return () => {} } },
      get: name => services[name],
      provide: (name, service) => { services[name] = service },
      effect: install => install(),
    })
    return routes.at(-1).handler
  }
  return { mount, calls, revisions }
}

async function request(handler, method, body, headers = {}) {
  const req = {
    method,
    headers,
    url: headers.url ?? '/api/desktop/hanaworlds-eval',
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
  await handler(req, response)
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null }
}

const authenticated = { cookie: 'dsh=synthetic' }
const start = sessionId => ({ sessionId, action: 'start' })

test('requires the official operator gate and refuses an explicit foreign Origin', async () => {
  const { mount, calls } = harness()
  const handler = mount()
  assert.equal((await request(handler, 'GET', undefined, {})).status, 401)
  assert.equal((await request(handler, 'POST', start('session-a'), {
    ...authenticated, origin: 'https://foreign.invalid', host: '127.0.0.1:1234',
  })).status, 403)
  assert.equal(calls.length, 0)
})

test('calls the HanaWorlds Workshop port for the sole live Session', async () => {
  const { mount, calls } = harness()
  const response = await request(mount(), 'POST', start('session-a'), authenticated)
  assert.equal(response.status, 200)
  assert.equal(response.body.operation, 'StartOrResumeSession')
  assert.equal(response.body.sessionId, 'session-a')
  assert.equal(response.body.sessionRevision, 'workshop-revision-a')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].operation, 'StartOrResumeSession')
  assert.equal(calls[0].body.sessionRef, 'session-a')
})

test('reads the Workshop projection after Host remount', async () => {
  const { mount } = harness()
  assert.equal((await request(mount(), 'POST', start('session-a'), authenticated)).status, 200)
  const read = await request(mount(), 'GET', undefined, {
    ...authenticated, url: '/api/desktop/hanaworlds-eval?sessionId=session-a',
  })
  assert.equal(read.status, 200)
  assert.equal(read.body.sessionRevision, 'workshop-revision-a')
})

test('uses the fixture authority through the Workshop port and reports revocation', async () => {
  const { mount, calls } = harness()
  const handler = mount()
  assert.equal((await request(handler, 'POST', start('session-a'), authenticated)).status, 200)
  assert.equal((await request(handler, 'POST', { sessionId: 'session-a', action: 'revoke' }, authenticated)).status, 200)
  const denied = await request(handler, 'POST', start('session-a'), authenticated)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error, 'AUTHORIZATION_REVOKED')
  assert.equal(calls.length, 2)
})

test('refuses cross-Session actions for either target when two live Sessions exist', async () => {
  const { mount, calls } = harness({ twoSessions: true })
  const handler = mount()
  for (const sessionId of ['session-a', 'session-b']) {
    const write = await request(handler, 'POST', start(sessionId), authenticated)
    assert.equal(write.status, 409)
    assert.equal(write.body.error, 'SESSION_VIEW_UNBOUND')
    const read = await request(handler, 'GET', undefined, {
      ...authenticated, url: `/api/desktop/hanaworlds-eval?sessionId=${sessionId}`,
    })
    assert.equal(read.status, 409)
  }
  assert.equal(calls.length, 0)
})

test('refuses a forged Session id even when one different Session is live', async () => {
  const { mount, calls } = harness()
  const response = await request(mount(), 'POST', start('session-b'), authenticated)
  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'SESSION_VIEW_UNBOUND')
  assert.equal(calls.length, 0)
})

test('does not replace a missing Workshop port with a synthetic success', async () => {
  const { mount } = harness({ workshopAvailable: false })
  const response = await request(mount(), 'POST', start('session-a'), authenticated)
  assert.equal(response.status, 503)
  assert.equal(response.body.error, 'WORKSHOP_UNAVAILABLE')
})
