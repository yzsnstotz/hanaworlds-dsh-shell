# Official Desktop rc.2 compatibility probe

This directory is a disposable evaluation plugin. It does not replace the HanaWorlds client or implement Luanti/Canvas authorization. The `Revoke fixture grant` control changes only an in-memory test flag; a Host restart resets it.

Pin the official source to `deepseek-ai/deepseek-harness` tag `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`. Install dependencies and build in an isolated checkout. Launch its development desktop with `DSH_HOME` and `DSH_DESKTOP_USER_DATA_DIR` pointed at a fresh cache directory, `DSH_TELEMETRY_MODE=DISABLED`, and the profile patch below:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
```

Use the official Plugins → Add plugin screen to install a copy of this directory, then enable it. Open a Session and use the dock's `Record action`, `Read after reload`, and `Revoke fixture grant` buttons. `Record action` appends one Core `user/message` with an evaluation marker; `Read after reload` reads the official Session persistence. Restart App and Host from the application menu before reading again. No model key or external game connection is needed.

Run the host checks with `node --test test/host.test.mjs`. For the synthetic profile/Node graph test, set `OFFICIAL_RC2_ROOT` to the isolated official checkout and `EVALUATION_RUN_ROOT` to a fresh run directory containing a `plugin-source` copy of this package, then run `tsx test/synthetic-profile.mjs` using the official checkout's `tsx`. The test refuses an existing synthetic profile, retains a fixture old bundle without activating it, activates this plugin in a new synthetic graph, and verifies rollback by file SHA-256. It does not migrate a real HanaWorlds profile.
