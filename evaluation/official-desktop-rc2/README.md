# Official Desktop rc.2 compatibility probe

This directory is a disposable evaluation plugin. It does not replace the HanaWorlds client or implement Luanti/Canvas authorization. It calls the existing `hanaworldsWorkshop` Host service through its `StartOrResumeSession` and `ReadSessionTurnDetails` contract operations; it never substitutes a marker when that service is unavailable. The `Revoke fixture grant` control changes only an in-memory test flag; a Host restart resets it.

Pin the official source to `deepseek-ai/deepseek-harness` tag `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`. Install dependencies and build in an isolated checkout. Launch its development desktop with `DSH_HOME` and `DSH_DESKTOP_USER_DATA_DIR` pointed at a fresh cache directory, `DSH_TELEMETRY_MODE=DISABLED`, and the profile patch below:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
```

Use the official Plugins → Add plugin screen to install a copy of this directory and a separate local copy of the existing `hanaworlds-workshop` package. The Workshop copy must retain its original Host `src/` and vendored contracts, but omit its Tauri-only `dsh.client` metadata; install its declared dependencies inside that disposable copy. Enable both plugins. Open a single live Session and use the dock's `Start Workshop`, `Read Workshop`, and `Revoke fixture grant` buttons. The Host refuses every action when more than one Core Session is live, because rc.2 exposes only an operator Peer and has no Host-side attestation of the renderer's selected Session. Restart App and Host from the application menu before reading again. No model key or external game connection is needed for these two Workshop operations.

Run the host checks with `node --test test/host.test.mjs`. For the synthetic profile/Node graph test, set `OFFICIAL_RC2_ROOT` to the isolated official checkout and `EVALUATION_RUN_ROOT` to a fresh run directory containing a `plugin-source` copy of this package, then run `tsx test/synthetic-profile.mjs` using the official checkout's `tsx`. The test refuses an existing synthetic profile, retains a fixture old bundle without activating it, activates this plugin in a new synthetic graph, and verifies rollback by file SHA-256. It does not migrate a real HanaWorlds profile.
