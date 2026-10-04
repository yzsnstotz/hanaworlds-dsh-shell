window.__ModuleLoader__.load({
  id: 'hanaworlds-official-eval',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    function EvaluationDock({ sessionId }) {
      const [result, setResult] = React.useState('Ready')
      const [busy, setBusy] = React.useState(false)

      const run = async action => {
        setBusy(true)
        try {
          const path = '/api/desktop/hanaworlds-eval'
          const response = action === 'read'
            ? await fetch(`${path}?sessionId=${encodeURIComponent(sessionId)}`)
            : await fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, action }),
            })
          const body = await response.json()
          setResult(response.ok
            ? action === 'revoke'
              ? `Session ${body.sessionId ?? sessionId}: fixture grant revoked`
              : `Workshop ${body.sessionId ?? sessionId}: revision ${body.sessionRevision}, ${body.turns} turn(s), ${body.grant}`
            : `HTTP ${response.status}: ${body.error ?? 'unknown error'}`)
        } catch (error) {
          setResult(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const button = (label, action) => h('button', {
        type: 'button',
        disabled: busy,
        onClick: () => { void run(action) },
        style: { marginRight: 6, padding: '3px 7px', border: '1px solid currentColor', borderRadius: 4 },
      }, label)
      return h('div', { 'data-hanaworlds-evaluation': true, style: { padding: '5px 8px', fontSize: 12 } },
        h('strong', null, 'HanaWorlds Workshop · FIXTURE grant'),
        h('div', { style: { marginTop: 4 } },
          button('Start Workshop', 'start'),
          button('Read Workshop', 'read'),
          button('Revoke fixture grant', 'revoke')),
        h('div', { role: 'status', style: { marginTop: 4 } }, result))
    }

    module.exports.inject = ['slots']
    module.exports.apply = ctx => {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'hanaworlds-official-eval',
        order: 15,
        inject: sessionId => ({ sessionId }),
      }, EvaluationDock))
    }
    return module.exports
  },
})
