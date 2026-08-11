// webadmin 管理端浏览器 E2E:连本地 dev-env(真实接口 + seed 数据)。
// 运行:cd desktop && npx playwright test ../scripts/e2e/admin_ui.spec.ts
import { test, expect, type Page } from '../../desktop/node_modules/playwright/test'

const BASE = process.env.PICOAI_SERVER_URL || 'http://127.0.0.1:18080'
const ADMIN_PASS = process.env.PICOAI_ADMIN_PASSWORD || 'DevAdmin@123456'

async function login(page: Page) {
  await page.goto(`${BASE}/admin/`)
  await page.getByLabel(/用户名/).fill('admin')
  await page.getByLabel(/密码/).fill(ADMIN_PASS)
  await page.getByRole('button', { name: /登录/ }).click()
  // 登录后进入侧边导航(默认页无内容区标题)
  await page.getByRole('link', { name: '网关' }).click()
  await expect(page.getByText('网关配置')).toBeVisible({ timeout: 15000 })
}

test('管理端:登录 → 网关添加上游(渠道联动) → 知识库命中测试 → 商城授权 → 用户部门组', async ({ page }) => {
  // ---- 登录 + 网关页 ----
  await login(page)

  // ---- 网关:添加上游对话框渠道联动 ----
  await page.getByRole('button', { name: '添加上游' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/模型自动从上游同步/)).toBeVisible()
  // 选择渠道 deepseek → base_url 自动回填、模型输入禁用
  await dialog.getByRole('combobox').click()
  await page.getByRole('option', { name: 'deepseek' }).click()
  await expect(page.locator('input[value="https://api.deepseek.com"]')).toBeVisible()
  await expect(dialog.getByPlaceholder(/保存后自动同步/)).toBeDisabled()
  await page.keyboard.press('Escape')

  // ---- 知识库:命中测试(块级结果) ----
  await page.goto(`${BASE}/admin/knowledge`)
  await expect(page.getByText('知识库管理')).toBeVisible()
  const searchBox = page.getByPlaceholder(/搜索知识库/)
  await searchBox.fill('报销')
  await page.getByRole('button', { name: '搜索' }).click()
  await expect(page.getByText(/score/).first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('纯关键词检索', { exact: true })).toBeVisible()
  // 授权对话框:输入 @财务部 授权
  await page.getByRole('button', { name: '授权' }).first().click()
  const kbDialog = page.getByRole('dialog')
  await kbDialog.getByRole('textbox').fill('@财务部')
  await kbDialog.getByRole('button', { name: '授权' }).click()
  await expect(kbDialog.getByText('@财务部')).toBeVisible()
  await page.keyboard.press('Escape')

  // ---- 商城:技能授权 ----
  await page.getByRole('link', { name: '商城' }).click()
  await expect(page.getByRole('cell', { name: 'data-extract', exact: true })).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: '授权' }).first().click()
  const mktDialog = page.getByRole('dialog')
  await mktDialog.getByRole('textbox').fill('@人事部')
  await mktDialog.getByRole('button', { name: '授权' }).click()
  await expect(mktDialog.getByText('@人事部')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(mktDialog).not.toBeVisible()

  // ---- 用户:部门组编辑 ----
  await page.goto(`${BASE}/admin/users`)
  await expect(page.getByText('alice')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('@研发部')).toBeVisible()
  await page.getByRole('button', { name: '部门组' }).first().click()
  const userDialog = page.getByRole('dialog')
  await expect(userDialog.getByPlaceholder(/研发部, 财务部/)).toBeVisible()
  await userDialog.getByRole('button', { name: '保存' }).click()
  await expect(userDialog).not.toBeVisible()
})
