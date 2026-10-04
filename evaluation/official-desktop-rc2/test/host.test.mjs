import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

function harness() {
  const stored = []
  const appended = []
  const session = {
    id: 'session-eval-1',
    append(type, data, options) {
      const event = { seq: appended.length + 1, type, data, surfaceOp: options.surfaceOp }
      appended.push(event)
      return event
    },
  }
  const services = {
    connection: { requestRejection: request => request.headers.cookie === 'dsh=synthetic' ? undefined : 401 },
    sessions: {
      get: id => id === session.id ? session : undefined,
      flush: async value => {
        if (value !== session) return false
        stored.splice(0, stored.length, ...appended)
        return true
      },
    },
    sessionPersistence: {
      open: async () => ({ read: async () => ({ events: [...stored] }), close: async () => {} }),
    },
  }
  const routes = []
  const mount = () => {
    const ctx = {
      ...services,
      webServer: { register: route => { routes.push(route); return () => {} } },
      effect: install => install(),
    }
    apply(ctx)
    return routes.at(-1).handler
  }
  return { mount, stored, appended }
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

test('requires the official Host connection gate and a same-origin write', async () => {
  const { mount, appended } = harness()
  const handler = mount()
  assert.equal((await request(handler, 'GET', undefined, {})).status, 401)
  assert.equal((await request(handler, 'POST', { sessionId: 'session-eval-1', action: 'record' }, {
    cookie: 'dsh=synthetic', origin: 'https://foreign.invalid', host: '127.0.0.1:1234',
  })).status, 403)
  assert.equal(appended.length, 0)
})

test('accepts the authenticated desktop proxy write after it strips Origin and Host', async () => {
  const { mount } = harness()
  const result = await request(mount(), 'POST', { sessionId: 'session-eval-1', action: 'record' }, {
    cookie: 'dsh=synthetic',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.count, 1)
})

test('persists a scoped Core user message and reads it after Host remount', async () => {
  const { mount, stored } = harness()
  const first = mount()
  const headers = { cookie: 'dsh=synthetic', origin: 'dsh-app://app', host: '127.0.0.1:1234' }
  const written = await request(first, 'POST', { sessionId: 'session-eval-1', action: 'record' }, headers)
  assert.equal(written.status, 200)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].type, 'user/message')
  assert.equal(stored[0].data.content[0].text, 'HanaWorlds evaluation action')
  const second = mount()
  const read = await request(second, 'GET', undefined, { cookie: 'dsh=synthetic', url: '/api/desktop/hanaworlds-eval?sessionId=session-eval-1' })
  assert.equal(read.status, 200)
  assert.equal(read.body.count, 1)
})

test('rejects a record after fixture grant revocation', async () => {
  const { mount, appended } = harness()
  const handler = mount()
  const headers = { cookie: 'dsh=synthetic', origin: 'dsh-app://app', host: '127.0.0.1:1234' }
  assert.equal((await request(handler, 'POST', { sessionId: 'session-eval-1', action: 'revoke' }, headers)).status, 200)
  const denied = await request(handler, 'POST', { sessionId: 'session-eval-1', action: 'record' }, headers)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error, 'FIXTURE_GRANT_REVOKED')
  assert.equal(appended.length, 0)
})
