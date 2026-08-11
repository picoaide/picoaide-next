import { _electron as electron } from '../../desktop/node_modules/playwright'
import { test } from '../../desktop/node_modules/playwright/test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

test('dbg kb', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pa-e2e-'))
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, HOME: home, PICOAI_TEST_AUTO_APPROVE: '1' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByLabel('服务器地址').fill('http://127.0.0.1:18080')
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('DevAdmin@123456')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText('新建会话').waitFor({ timeout: 20000 })
  await page.getByRole('tab', { name: '执行' }).click()
  await page.getByPlaceholder(/输入消息|请输入/).fill('TOOLCALL:kb_search')
  await page.keyboard.press('Enter')
  await page.getByText('kb_search', { exact: false }).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(8000)
  const txt = await page.evaluate(() => document.body.innerText)
  console.log('BODY_TEXT_START>>>')
  console.log(txt.slice(0, 2000))
  console.log('<<<END')
  await app.close()
})
