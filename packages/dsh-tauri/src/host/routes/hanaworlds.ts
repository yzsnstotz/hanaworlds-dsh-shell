import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { defineEventHandler, readBody } from 'h3'
import { hanaworlds } from '../service/hanaworlds'
import { defineRoutes } from './index'

export const hanaworldsRoutes = defineRoutes((routes) => {
  routes.post({ kind: 'exact', path: '/api/desktop/hanaworlds/context' }, defineEventHandler(async (event) => {
    event.res.headers.set('cache-control', 'no-store')
    if (!desktopRequest(event.req.headers.get('x-hanaworlds-desktop-token'))) {
      event.res.status = 403
      return { error: 'DESKTOP_CALL_REQUIRED' }
    }
    const input = await readBody<Record<string, unknown>>(event)
    if (!plainObject(input) || Object.keys(input).some(key => key !== 'sessionRef')) {
      event.res.status = 400
      return { error: 'INVALID_CONTEXT_SELECTION' }
    }
    try {
      return await hanaworlds.context(input.sessionRef as string | undefined)
    }
    catch {
      event.res.status = 503
      return { error: 'NATIVE_GRANT_EVIDENCE_UNAVAILABLE' }
    }
  }))

  routes.post({ kind: 'exact', path: '/api/desktop/hanaworlds/bindings' }, defineEventHandler(async (event) => {
    event.res.headers.set('cache-control', 'no-store')
    if (!desktopRequest(event.req.headers.get('x-hanaworlds-desktop-token'))) {
      event.res.status = 403
      return { error: 'DESKTOP_CALL_REQUIRED' }
    }
    const input = await readBody<Record<string, unknown>>(event)
    if (!plainObject(input) || Object.keys(input).sort().join(',') !== 'engineActorName,sessionRef,worldRef'
      || typeof input.sessionRef !== 'string' || typeof input.worldRef !== 'string'
      || typeof input.engineActorName !== 'string') {
      event.res.status = 400
      return { error: 'INVALID_BINDING_SELECTION' }
    }
    try {
      return await hanaworlds.bind(input.sessionRef, input.worldRef, input.engineActorName)
    }
    catch {
      event.res.status = 403
      return { error: 'NATIVE_GRANT_NOT_CURRENT' }
    }
  }))

  routes.post({ kind: 'exact', path: '/api/desktop/hanaworlds/workshop' }, defineEventHandler(async (event) => {
    event.res.headers.set('cache-control', 'no-store')
    if (!desktopRequest(event.req.headers.get('x-hanaworlds-desktop-token'))) {
      event.res.status = 403
      return { error: 'DESKTOP_CALL_REQUIRED' }
    }
    const input = await readBody<Record<string, unknown>>(event)
    if (!plainObject(input) || Object.keys(input).sort().join(',') !== 'operation,payload,sessionRef'
      || typeof input.sessionRef !== 'string' || typeof input.operation !== 'string'
      || !plainObject(input.payload)) {
      event.res.status = 400
      return { error: 'INVALID_WORKSHOP_INPUT' }
    }
    try {
      return await hanaworlds.call(input.sessionRef, input.operation, input.payload)
    }
    catch {
      event.res.status = 403
      return { error: 'TRUSTED_BINDING_REQUIRED' }
    }
  }))
})

function desktopRequest(value: string | null): boolean {
  const expected = process.env.HANAWORLDS_DESKTOP_TOKEN
  if (process.env.DSH_TAURI_EMBEDDED !== '1' || !expected
    || !/^[0-9a-f]{64}$/.test(expected) || !value || !/^[0-9a-f]{64}$/.test(value)) {
    return false
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'))
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
