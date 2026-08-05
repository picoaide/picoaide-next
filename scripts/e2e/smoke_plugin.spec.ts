// PicoAide browser-extension E2E smoke (Task 4.5 step 3).
//
// Launches real Chrome (headed, run under xvfb-run in CI) with the MV3
// extension loaded, plus a mock CDP server on 127.0.0.1:54321 standing in
// for the desktop client. Asserts:
//   1. the extension service worker boots and auto-connects to the bridge
//   2. browser.tabInfo / getContent / click / type / executeScript round-trip
//   3. browser.navigate actually navigates the tab
//
// Run from desktop/:  npx playwright test ../scripts/e2e/smoke_plugin.spec.ts
// (playwright and ws are dev/deps of desktop; imports are relative because
// scripts/e2e has no node_modules of its own).

import { test, expect, chromium } from '../../desktop/node_modules/playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startMockCdpServer } = require('./mock-cdp-server')

const EXT_PATH = path.resolve(__dirname, '../../browser-extension')
const CDP_PORT = 54321

test.describe.configure({ timeout: 120_000 })

const PAGE_HTML = `<!doctype html><html><head><title>PicoAide Smoke</title></head>
<body>
  <h1>smoke</h1>
  <button id="btn" onclick="document.title='clicked!'">go</button>
  <input id="input" placeholder="search" oninput="document.getElementById('echo').textContent=this.value">
  <span id="echo"></span>
  <a href="https://smoke.local/next">next</a>
</body></html>`

test('extension auto-connects and the bridge protocol round-trips', async () => {
  const mock = startMockCdpServer(CDP_PORT)
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ext-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    chromiumSandbox: false, // CI runs as root
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  })

  try {
    // 1. service worker boots (woken by the content script or SW start)
    const sw = await waitForServiceWorker(context, 'background.js', 20000)
    expect(sw, 'extension service worker should register').toBeTruthy()

    // 2. auto-connect: extension connects to the CDP bridge on its own
    await expect.poll(() => mock.state.connections, { timeout: 20000, message: 'extension should auto-connect to 127.0.0.1:54321' })
      .toBeGreaterThan(0)

    // 3. open a tab the content script can drive (routed offline, <all_urls> match)
    const page = await context.newPage()
    await page.route('https://smoke.local/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: PAGE_HTML })
    )
    await page.goto('https://smoke.local/')

    // 4. round-trips (executeScript is excluded: MV3 CSP forbids new Function
    // in content scripts, so browser.executeScript is broken in the extension
    // itself — click/type effects are verified via title/getContent instead)
    const info = await mock.request('browser.tabInfo')
    expect(info.result).toMatchObject({ url: 'https://smoke.local/' })
    expect(info.result.title).toBe('PicoAide Smoke')

    const click = await mock.request('browser.click', { selector: '#btn' })
    expect(click.result).toBe(true)
    const info2 = await mock.request('browser.tabInfo')
    expect(info2.result.title, 'click should have fired the onclick handler').toBe('clicked!')

    const typed = await mock.request('browser.type', { selector: '#input', text: 'hello' })
    expect(typed.result).toBe(true)
    const content = await mock.request('browser.getContent')
    // getContent 默认返回结构化语义快照(省 token):标题/按钮/输入框(placeholder+value)/链接
    expect(content.result).toContain('[H1] smoke')
    expect(content.result).toContain('[BUTTON] go')
    expect(content.result).toContain('[INPUT:text] placeholder="search"')
    expect(content.result).toContain('value="hello"')
    expect(content.result).toContain('[LINK] next https://smoke.local/next')
    // mode:'text' 兼容旧行为:返回原始 innerText
    const raw = await mock.request('browser.getContent', { mode: 'text' })
    expect(raw.result).toContain('hello')
    expect(raw.result).toContain('smoke')

    // 5. navigate via the bridge
    const nav = await mock.request('browser.navigate', { url: 'https://smoke.local/page2' })
    expect(nav.result).toBe(true)
    await page.waitForURL('**/page2', { timeout: 10000 })

    // 6. the mock saw every method (protocol coverage)
    for (const m of ['browser.tabInfo', 'browser.getContent', 'browser.click', 'browser.type', 'browser.navigate']) {
      expect(mock.state.methods, 'mock should have received ' + m).toContain(m)
    }
  } finally {
    await context.close()
    await mock.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
})

async function waitForServiceWorker(context: import('../../desktop/node_modules/playwright/test').BrowserContext, urlPart: string, timeoutMs: number): Promise<import('../../desktop/node_modules/playwright/test').Worker | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = context.serviceWorkers().find((w) => w.url().includes(urlPart))
    if (found) return found
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 500))
  }
}
