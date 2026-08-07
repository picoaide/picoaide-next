# PicoAide E2E Smokes (Task 4.5)

Three automated smoke scripts covering the full stack with no external
services: server API chain, desktop client boot, and the browser-extension
bridge. All of them are safe to run locally and in CI.

## 1. Server smoke — `bash scripts/e2e/smoke.sh`

Scripted version of the plan's 1.17 acceptance curl chain, with a jq
assertion per step (`set -euo pipefail`; any failure exits non-zero):

build server + mock upstream → start both → bootstrap admin → user login →
admin login (session + CSRF) → configure mock provider/model/default model →
bootstrap returns `default_model=mock-chat` → gateway non-stream chat echoes
the mock upstream → gateway SSE stream (≥ 3 `data:` lines) → marketplace
skills/mcp lists → knowledge-base `tools/list` (4 tools) → usage aggregation
(≥ 2 requests). Kills both servers via `trap` on exit.

```
bash scripts/e2e/smoke.sh                 # SERVER_PORT=18080, MOCK_PORT=18081
SERVER_PORT=19001 MOCK_PORT=19002 bash scripts/e2e/smoke.sh
PICOAI_ADMIN_PASSWORD=Admin@123456 bash scripts/e2e/smoke.sh
```

Requires: `curl`, `jq`, `make`, Go toolchain (builds `bin/picoaide-server`
and a mock upstream binary in `/tmp`). No network or real LLM key needed.

## 2. Client smoke — `bash scripts/e2e/smoke_client.sh`

Launches the built Electron app under `xvfb-run` with
`PICOAI_TEST_AUTO_APPROVE=1` and asserts it boots to the login screen
without crashing (stays alive the full timeout; `timeout` kills it, exit 124
is success). Realistic scope: full UI assertions (auto-login, Ask, done
event, approval hooks) belong to the Playwright Electron spec, which needs a
display — CI runs it under xvfb.

Skips with a clear message if `desktop/out/main/index.js` (run
`make build-client`) or `xvfb-run` is missing.

```
bash scripts/e2e/smoke_client.sh          # SMOKE_CLIENT_TIMEOUT=8s default
```

## 3. Browser-extension smoke — `cd desktop && npx playwright test --config ../scripts/e2e smoke_plugin.spec.ts`

Playwright spec that launches **real Chrome** (headed, run under xvfb in CI)
with the MV3 extension loaded, plus a standalone mock CDP server
(`scripts/e2e/mock-cdp-server.js`, port 54321) standing in for the desktop
client. Asserts: the service worker boots and auto-connects to
`ws://127.0.0.1:54321`; `browser.tabInfo`/`getContent`/`click`/`type`/
`navigate` round-trip against a real tab (click/type effects verified via
title/getContent); the mock received every `browser.*` method (protocol
coverage).

`browser.executeScript` is deliberately NOT asserted: MV3 content-script CSP
forbids `new Function`, so that method is broken in the extension itself
(pre-existing bug this smoke exposed; the bridge round-trips fine without
it).

No desktop app required. `playwright` is a devDependency of `desktop/` and
the spec imports it relative to `desktop/node_modules` (scripts/e2e has no
node_modules of its own); `--config ../scripts/e2e` points the runner at the
spec's directory (tests outside the runner's default testDir are not found).

First-time setup (CI needs the same):

```
cd desktop
npm i -D playwright
npx playwright install chromium --with-deps   # apt system deps; headed run under xvfb still needs libs
```

Run:

```
cd desktop && xvfb-run -a npx playwright test --config ../scripts/e2e smoke_plugin.spec.ts
```

Typecheck the spec: `cd desktop && npx tsc --noEmit --strict --esModuleInterop --skipLibCheck --types node ../scripts/e2e/smoke_plugin.spec.ts`

## CI recap

```
make build-server
bash scripts/e2e/smoke.sh
bash scripts/e2e/smoke_client.sh          # needs make build-client + electron binary
cd desktop && xvfb-run -a npx playwright test --config ../scripts/e2e smoke_plugin.spec.ts
```
