import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const installer = path.join(root, 'src-tauri/resources/hanaworlds/install.command')

function app(dir, identity, content) {
  const bundle = path.join(dir, 'HanaWorlds.app')
  const contents = path.join(bundle, 'Contents')
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources', 'resources', 'node', 'bin'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources', 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources', 'resources', 'pnpm', 'bin'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources', 'resources', 'node_modules', 'dsh-tauri'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources', 'resources', 'hanaworlds'), { recursive: true })
  writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identity}</string><key>CFBundleExecutable</key><string>HanaWorlds</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
  execFileSync('cp', ['/bin/echo', path.join(contents, 'MacOS', 'HanaWorlds')])
  writeFileSync(path.join(contents, 'Resources', 'resources', 'node', 'bin', 'node'), content)
  writeFileSync(path.join(contents, 'Resources', 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), content)
  writeFileSync(path.join(contents, 'Resources', 'resources', 'pnpm', 'bin', 'pnpm.cjs'), content)
  writeFileSync(path.join(contents, 'Resources', 'resources', 'node_modules', 'dsh-tauri', 'package.json'), '{}')
  writeFileSync(path.join(contents, 'Resources', 'resources', 'hanaworlds', 'build-id.txt'), `${'a'.repeat(64)}\n`)
  execFileSync('codesign', ['--force', '--sign', '-', bundle])
  return bundle
}

function legacyApplet(dir) {
  const bundle = path.join(dir, 'HanaWorlds.app')
  const contents = path.join(bundle, 'Contents')
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
  mkdirSync(path.join(contents, 'Resources', 'Scripts'), { recursive: true })
  writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>applet</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  execFileSync('cp', ['/bin/echo', path.join(contents, 'MacOS', 'applet')])
  writeFileSync(path.join(contents, 'Resources', 'Scripts', 'main.scpt'), 'old applet')
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'HanaWorlds', bundle])
  return bundle
}

test('same-application installer refuses changed identity without touching installed entry', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hanaworlds-installer-'))
  const installed = app(path.join(scratch, 'Applications'), 'HanaWorlds', 'old')
  const candidate = app(path.join(scratch, 'candidate'), 'AnotherApp', 'new')
  const result = spawnSync('bash', [installer, candidate, path.dirname(installed)], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /identity mismatch/)
  assert.equal(readFileSync(path.join(installed, 'Contents/Resources/resources/node/bin/node'), 'utf8'), 'old')
})

test('same-application installer replaces only the app and can roll back', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hanaworlds-installer-'))
  const installed = legacyApplet(path.join(scratch, 'Applications'))
  const candidate = app(path.join(scratch, 'candidate'), 'HanaWorlds', 'new')
  const backupRoot = path.join(scratch, 'backups')
  const installedData = path.join(scratch, 'data.txt')
  writeFileSync(installedData, 'preserve')
  const install = spawnSync('bash', [installer, candidate, path.dirname(installed), backupRoot], { encoding: 'utf8' })
  assert.equal(install.status, 0, install.stderr)
  assert.equal(readFileSync(path.join(installed, 'Contents/Resources/resources/node/bin/node'), 'utf8'), 'new')
  assert.equal(readFileSync(installedData, 'utf8'), 'preserve')
  const rollback = spawnSync('bash', [installer, 'rollback', path.dirname(installed), backupRoot], { encoding: 'utf8' })
  assert.equal(rollback.status, 0, rollback.stderr)
  assert.equal(readFileSync(path.join(installed, 'Contents/Resources/Scripts/main.scpt'), 'utf8'), 'old applet')
})

test('HanaWorlds product build declares the original identity and isolated data feature', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.hanaworlds.conf.json'), 'utf8'))
  assert.equal(config.identifier, 'HanaWorlds')
  assert.equal(config.productName, 'HanaWorlds')
  const cargo = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')
  assert.match(cargo, /hanaworlds-product\s*=\s*\[\]/)
})
