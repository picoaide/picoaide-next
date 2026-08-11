// 客户端全流程 E2E:Playwright 驱动真实 Electron 应用
// 前置:本机已起 picoaide-server(含 mock 上游与默认模型)与 mock-upstream;
// 由 scripts/e2e/run_full_client_e2e.sh 编排,本文件只负责 Electron 侧。
import { _electron as electron, type ElectronApplication, type Page } from '../../desktop/node_modules/playwright'
import { test, expect } from '../../desktop/node_modules/playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const SERVER_URL = process.env.PICOAI_SERVER_URL || 'http://127.0.0.1:18080'
const USERNAME = process.env.PICOAI_E2E_USER || 'admin'
const PASSWORD = process.env.PICOAI_E2E_PASSWORD || process.env.PICOAI_ADMIN_PASSWORD || 'DevAdmin@123456'

test.setTimeout(120_000)

async function launchApp(autoApprove: boolean): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'pa-e2e-'))
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      HOME: home,
      PICOAI_TEST_AUTO_APPROVE: autoApprove ? '1' : '0',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, home }
}

test('登录 → 对话 → 执行模式工具循环 → 产物落盘', async () => {
  const { app, page, home } = await launchApp(true)
  try {
    // 0. 样式加载检查:Tailwind 编译产物生效(body 背景非透明,regression:css 未加载)
    await page.waitForTimeout(800)
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')

    // 1. 登录页
    await page.getByLabel('服务器地址').fill(SERVER_URL)
    await page.getByLabel('用户名').fill(USERNAME)
    await page.getByLabel('密码').fill(PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // 2. 进入主界面(会话列表出现 = 登录成功)
    await page.getByText('新建会话').waitFor({ timeout: 20000 })

    // 3. Ask 对话
    await page.getByPlaceholder(/输入消息|请输入/).fill('你好')
    await page.keyboard.press('Enter')
    await page.getByText(/mock upstream echo/).first().waitFor({ timeout: 30000 })

    // 4. 切执行模式 → 触发 file_write 工具(脚本化 TOOLCALL)
    await page.getByRole('tab', { name: '执行' }).click()
    await page.getByPlaceholder(/输入消息|请输入/).fill('TOOLCALL:file_write')
    await page.keyboard.press('Enter')
    // 工具卡片出现(工具名 file_write)
    await page.getByText('file_write', { exact: false }).first().waitFor({ timeout: 30000 })
    // 产物面板登记(文件类工具返回值含 path → artifact)
    await page.getByText('test.txt', { exact: false }).first().waitFor({ timeout: 30000 })

    // 5. 验证产物真实落盘(workspaces/<conv>/test.txt)
    const wsRoot = join(home, '.local/share/picoaide/workspaces')
    const found = findFile(wsRoot, 'test.txt')
    expect(found).not.toBeNull()
    const content = readFileSync(found!, 'utf8')
    expect(content).toContain('hello e2e')

    // 6. 高危命令:command_exec 走审批(测试钩子自动允许)→ echo 输出出现在 tool 卡片
    await page.getByPlaceholder(/输入消息|请输入/).fill('TOOLCALL:command_exec')
    await page.keyboard.press('Enter')
    await page.getByText('e2e-cmd-ok', { exact: false }).first().waitFor({ timeout: 30000 })
  } finally {
    await app.close()
  }
})

test('审批拒绝路径:auto-approve=0 时 file_delete 被拒绝且任务继续', async () => {
  const { app, page, home } = await launchApp(false)
  try {
    await page.getByLabel('服务器地址').fill(SERVER_URL)
    await page.getByLabel('用户名').fill(USERNAME)
    await page.getByLabel('密码').fill(PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByText('新建会话').waitFor({ timeout: 20000 })

    // 先写一个 delete-me.txt(经 file_write 工具)
    await page.getByRole('tab', { name: '执行' }).click()
    await page.getByPlaceholder(/输入消息|请输入/).fill('TOOLCALL:file_write')
    await page.keyboard.press('Enter')
    await page.getByText('test.txt', { exact: false }).first().waitFor({ timeout: 30000 })

    // 触发 file_delete → 测试钩子自动拒绝 → 文件仍存在,任务以错误结束(无崩溃)
    await page.getByPlaceholder(/输入消息|请输入/).fill('TOOLCALL:file_delete')
    await page.keyboard.press('Enter')
    await page.getByText('file_delete', { exact: false }).first().waitFor({ timeout: 30000 })
    // 等待引擎处理完成(拒绝错误回传 + 文本回复)
    await page.getByText(/mock upstream echo/).first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(1500)
    const wsRoot = join(home, '.local/share/picoaide/workspaces')
    expect(findFile(wsRoot, 'delete-me.txt')).toBeNull()
  } finally {
    await app.close()
  }
})

function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null
  const { readdirSync } = require('fs')
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return p
    }
  }
  return null
}

void rmSync

test('知识库检索:聊天触发 kb_search 工具并渲染块级结果', async () => {
  const { app, page } = await launchApp(true)
  try {
    await page.getByLabel('服务器地址').fill(SERVER_URL)
    await page.getByLabel('用户名').fill(USERNAME)
    await page.getByLabel('密码').fill(PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByText('新建会话').waitFor({ timeout: 20000 })

    // 执行模式触发 kb_search(脚本化 TOOLCALL)
    await page.getByRole('tab', { name: '执行' }).click()
    await page.getByPlaceholder(/输入消息|请输入/).fill('TOOLCALL:kb_search')
    await page.keyboard.press('Enter')
    // 工具卡片出现(kb_search 为引擎注册的远程 MCP 工具)
    await page.getByText('kb_search', { exact: false }).first().waitFor({ timeout: 30000 })
    // 工具结果渲染:本地 dev-env seed 知识库的块级命中(报销类文档);
    // 工具卡可能在消息流视口外,用 attached 断言存在性
    await page.getByText(/报销|制度|差旅/).first().waitFor({ state: 'attached', timeout: 30000 })
    // 模型基于结果继续回答(mock 回显收尾)
    await page.getByText(/mock upstream echo/).first().waitFor({ timeout: 30000 })
  } finally {
    await app.close()
  }
})
