import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const officialRoot = process.env.OFFICIAL_RC2_ROOT
const runRoot = process.env.EVALUATION_RUN_ROOT
if (!officialRoot || !runRoot) throw new Error('OFFICIAL_RC2_ROOT and EVALUATION_RUN_ROOT are required')

const [{ DesktopProjectManager }, { resolveDesktopPaths }, { loadProfileDirectory, createRuntimeResolution }] = await Promise.all([
  import(`${officialRoot}/apps/desktop/src/project-manager.ts`),
  import(`${officialRoot}/apps/desktop/src/paths.ts`),
  import(`${officialRoot}/packages/boot/app-boot/src/profile.ts`),
])

const home = join(runRoot, 'synthetic-profile-home')
const snapshot = join(runRoot, 'synthetic-profile-before')
const runtime = join(officialRoot, 'apps/desktop/.desktop-build/development/project')
const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
const paths = resolveDesktopPaths(home)
const manager = new DesktopProjectManager(paths, { dsh: runtime })

function write(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, value)
}

function fileHashes(root) {
  const result = {}
  function walk(dir, relative = '') {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const next = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) walk(join(dir, item.name), next)
      else if (item.isFile()) result[next] = createHash('sha256').update(readFileSync(join(dir, item.name))).digest('hex')
      else throw new Error(`Unexpected non-file in synthetic profile: ${next}`)
    }
  }
  walk(root)
  return result
}

if (existsSync(home) || existsSync(snapshot)) throw new Error('Synthetic profile must start fresh')
await manager.applyRelease()
const manifestPath = join(paths.profile, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const oldName = '@hanaworlds/legacy-fixture'
manifest.dependencies[oldName] = '0.1.5-alpha.1'
manifest.dsh.profile.bundles.push(oldName)
write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
write(join(paths.profile, 'node_modules', oldName, 'package.json'), `${JSON.stringify({
  name: oldName,
  version: '0.1.5-alpha.1',
  peerDependencies: { '@deepseek-ai/dsh': '0.1.5-alpha.1' },
  dsh: { bundle: { patch: './bundle.yml' } },
})}\n`)
write(join(paths.profile, 'node_modules', oldName, 'bundle.yml'), '[]\n')
write(join(paths.profile, 'hanaworlds-business-state.json'), '{"fixture":"preserve-me","revision":1}\n')
const before = fileHashes(paths.profile)
cpSync(paths.profile, snapshot, { recursive: true })

const oldProfile = loadProfileDirectory('eval', paths.profile, anchor)
assert.equal(oldProfile.layers.some(layer => layer.packageName === oldName), false)
assert.equal(oldProfile.skippedBundles.some(item => item.packageName === oldName && item.reason.includes('incompatible')), true)

const newName = 'hanaworlds-official-eval'
const migrated = JSON.parse(readFileSync(manifestPath, 'utf8'))
migrated.dependencies[newName] = 'file:./node_modules/hanaworlds-official-eval'
migrated.dsh.profile.bundles = migrated.dsh.profile.bundles.filter(name => name !== oldName)
migrated.dsh.profile.bundles.push(newName)
cpSync(join(runRoot, 'plugin-source'), join(paths.profile, 'node_modules', newName), { recursive: true })
write(manifestPath, `${JSON.stringify(migrated, null, 2)}\n`)
await manager.applyRelease()
const current = loadProfileDirectory('eval', paths.profile, anchor)
assert.equal(current.layers.some(layer => layer.packageName === newName), true)
assert.equal(current.layers.some(layer => layer.packageName === oldName), false)
assert.equal(current.skippedBundles.length, 0)
assert.equal(readFileSync(join(paths.profile, 'hanaworlds-business-state.json'), 'utf8'), '{"fixture":"preserve-me","revision":1}\n')
const resolution = await createRuntimeResolution({ installAnchor: anchor, profile: current, home })
assert.equal(resolution.entries.find(item => item.name === '@deepseek-ai/dsh')?.scope, 'installation')
assert.equal(resolution.localPackageNames.includes(newName), true)

rmSync(paths.profile, { recursive: true })
cpSync(snapshot, paths.profile, { recursive: true })
assert.deepEqual(fileHashes(paths.profile), before)
const rolledBack = loadProfileDirectory('eval', paths.profile, anchor)
assert.equal(rolledBack.skippedBundles.some(item => item.packageName === oldName), true)

console.log(JSON.stringify({
  status: 'PASS',
  source: 'synthetic-fixture',
  officialVersion: 'dsh-v0.2.0-rc.2',
  oldBundle: 'skipped-incompatible-and-preserved',
  migratedBundle: 'active',
  coreScope: 'installation',
  businessState: 'byte-preserved',
  rollback: 'exact-file-sha256-match',
  fileCount: Object.keys(before).length,
}, null, 2))
