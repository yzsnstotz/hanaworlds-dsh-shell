import { Button } from '@heroui/react'
import { useMount } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'

interface Context {
  status: 'bound' | 'unbound' | 'unavailable'
  reason?: string
  sessionRef?: string
  worldRef?: string
  engineActorName?: string
  sessions: Array<{ sessionRef: string, label: string }>
  candidates?: Array<{ worldRef: string, engineActorName: string, scope: string }>
}

export function HanaWorldsBinding() {
  const { t } = useTranslation()
  const [context, setContext] = useState<Context | null>(null)
  const [sessionRef, setSessionRef] = useState('')
  const [candidateIndex, setCandidateIndex] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load(selectedSession: string) {
    setBusy(true)
    setError('')
    try {
      const current = await invoke<Context>('hanaworlds_request', {
        operation: 'context',
        input: { sessionRef: selectedSession },
      })
      setContext(current)
      setCandidateIndex(-1)
    }
    catch {
      setContext(null)
      setError(t('hanaworlds.host_unavailable'))
    }
    finally {
      setBusy(false)
    }
  }

  async function bind() {
    const candidate = context?.candidates?.[candidateIndex]
    if (!sessionRef || !candidate)
      return
    setBusy(true)
    setError('')
    try {
      await invoke('hanaworlds_request', {
        operation: 'bind',
        input: { sessionRef, worldRef: candidate.worldRef, engineActorName: candidate.engineActorName },
      })
      await load(sessionRef)
    }
    catch {
      setError(t('hanaworlds.bind_denied'))
      setBusy(false)
    }
  }

  useMount(() => {
    void load('')
  })

  return (
    <section className="mb-4 rounded-lg border border-line bg-panel2/40 p-4" data-testid="hanaworlds-binding-status">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 text-sm font-semibold text-ink">{t('hanaworlds.binding_title')}</p>
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => { void load(sessionRef) }}>
          {t('hanaworlds.refresh')}
        </Button>
      </div>
      <If cond={import.meta.env.VITE_HANAWORLDS_PRODUCT === '1'}>
        <p className="m-0 mt-2 text-xs text-warning" data-testid="hanaworlds-legacy-migration-notice">
          {t('hanaworlds.legacy_migration_notice')}
        </p>
      </If>
      <p className="m-0 mt-1 text-xs text-muted">
        {context?.status === 'bound'
          ? t('hanaworlds.bound', { player: context.engineActorName, world: context.worldRef })
          : t('hanaworlds.binding_unavailable')}
      </p>
      {error && <p className="m-0 mt-2 text-xs text-danger">{error}</p>}
      {context?.status === 'unavailable' && <p className="m-0 mt-2 text-xs text-warning">{t('hanaworlds.evidence_unavailable')}</p>}
      {context && context.sessions.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-muted" htmlFor="hanaworlds-session">{t('hanaworlds.session')}</label>
          <select
            id="hanaworlds-session"
            className="rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink"
            value={sessionRef}
            onChange={(event) => {
              const next = event.target.value
              setSessionRef(next)
              void load(next)
            }}
          >
            <option value="">{t('hanaworlds.select_session')}</option>
            {context.sessions.map(session => (
              <option key={session.sessionRef} value={session.sessionRef}>{session.label}</option>
            ))}
          </select>
          {sessionRef && !!context.candidates?.length && (
            <>
              <label className="text-xs text-muted" htmlFor="hanaworlds-world">{t('hanaworlds.world_player')}</label>
              <select
                id="hanaworlds-world"
                className="rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink"
                value={candidateIndex}
                onChange={event => setCandidateIndex(Number(event.target.value))}
              >
                <option value={-1}>{t('hanaworlds.select_world_player')}</option>
                {context.candidates.map((candidate, index) => (
                  <option key={`${candidate.worldRef}:${candidate.engineActorName}`} value={index}>
                    {candidate.engineActorName}
                    {' '}
                    ·
                    {candidate.worldRef}
                  </option>
                ))}
              </select>
              <Button size="sm" isDisabled={busy || candidateIndex < 0} onPress={() => { void bind() }}>
                {t('hanaworlds.bind')}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  )
}
