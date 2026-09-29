import type { ClientContext } from '../types'
import { invoke } from '../service/invoke'
import { defineRegister } from './index'

interface PluginChange {
  reason?: string
}

interface RemoteEvents {
  $on?: (event: string, listener: (change: PluginChange) => void) => () => void
}

/** Core emits this after its native Plugins UI remove operation has finished. */
export const pluginUninstallReconcileFeature = defineRegister((controller, ctx: ClientContext) => {
  if (!('dshDesktop' in globalThis))
    return

  ctx.inject(['remote'], (scoped) => {
    const remote = (scoped as unknown as { remote?: RemoteEvents }).remote
    if (typeof remote?.$on !== 'function')
      return
    controller.add(remote.$on('plugin-manager/changed', (change) => {
      if (change.reason !== 'remove')
        return
      void invoke('reconcile_removed_plugin_residue').catch((error: unknown) => {
        console.warn('[dsh-tauri] Shell plugin uninstall reconciliation failed:', error)
      })
    }))
  })
})
