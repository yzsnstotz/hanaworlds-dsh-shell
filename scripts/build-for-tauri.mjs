import { spawnSync } from 'node:child_process'

// Tauri sets a production environment for beforeBuildCommand. Invoking pnpm's
// script runner there can purge development tools before the frontend compiles.
const env = {
  ...process.env,
  NODE_ENV: 'development',
  npm_config_production: 'false',
  CI: 'true',
}
for (const [binary, args] of [
  ['node_modules/tsx/dist/cli.mjs', ['scripts/build-plugins.ts']],
  ['node_modules/typescript/bin/tsc', []],
  ['node_modules/vite/bin/vite.js', ['build']],
]) {
  const result = spawnSync(process.execPath, [binary, ...args], { stdio: 'inherit', env })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    process.exit(result.status ?? 1)
}
