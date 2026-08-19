import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Gateway from './Gateway'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const baseImpl = async (path: string, init?: RequestInit) => {
  if (path === '/api/admin/providers' && init?.method === 'POST') {
    return { provider: { id: 2, name: 'deepseek2', channel: 'deepseek' }, sync: { added: 2, removed: 0 } }
  }
  if (path === '/api/admin/providers') return { providers: [{ id: 1, name: 'deepseek', base_url: 'https://api.deepseek.com', api_key: '***', models: ['deepseek-chat'], enabled: true, channel: 'deepseek' }] }
  if (path === '/api/admin/models') return { models: [{ id: 1, name: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{}' }] }
  if (path === '/api/admin/gateway') return { default_model: 'deepseek-chat', rate_limit: '60', allow_private: false, search_endpoint: '', server_base_url: '' }
  if (path === '/api/admin/channels') return { channels: [{ name: 'deepseek', base_url: 'https://api.deepseek.com' }] }
  return {}
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(baseImpl)
})

async function openDialog() {
  render(<Gateway />)
  await screen.findByText('全局设置')
  fireEvent.click(screen.getByRole('button', { name: '添加上游' }))
  return within(await screen.findByRole('dialog'))
}

describe('Gateway 网关配置页', () => {
  it('渲染全局设置、上游表格与模型列表', async () => {
    render(<Gateway />)
    expect(await screen.findByText('全局设置')).toBeInTheDocument()
    expect((await screen.findAllByText('deepseek')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('DeepSeek Chat')).toBeInTheDocument()
  })

  it('添加上游:对话框渲染名称/密钥/模型字段(Radix Select 联动由浏览器 E2E 覆盖)', async () => {
    const dialog = await openDialog()
    expect(dialog.getByPlaceholderText('如 deepseek')).toBeInTheDocument()
    expect(dialog.getByPlaceholderText('sk-...')).toBeInTheDocument()
    expect(dialog.getByPlaceholderText(/保存后自动同步|deepseek-chat/)).toBeInTheDocument()
  })

  it('提交含 sync.added 时显示"已上架 N 个模型"', async () => {
    const dialog = await openDialog()
    fireEvent.change(dialog.getByPlaceholderText('如 deepseek'), { target: { value: 'deepseek2' } })
    fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/已上架 2 个模型/)).toBeInTheDocument()
  })

  it('提交 sync.error 时提示可重试', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/providers' && init?.method === 'POST') {
        return { provider: { id: 2, name: 'deepseek2', channel: 'deepseek' }, sync: { error: 'upstream 500' } }
      }
      return baseImpl(path, init)
    })
    const dialog = await openDialog()
    fireEvent.change(dialog.getByPlaceholderText('如 deepseek'), { target: { value: 'deepseek2' } })
    fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/已保存,但模型同步失败/)).toBeInTheDocument()
  })
})

  it('全局设置渲染默认月金额配额字段并可编辑保存', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/gateway' && init?.method === 'PUT') {
        return { ok: true }
      }
      return {
        ...(await baseImpl(path, init)),
        ...(path === '/api/admin/gateway' ? { monthly_quota: '100000', monthly_quota_money: '500' } : {}),
      }
    })
    render(<Gateway />)
    await screen.findByText('全局设置')
    // 默认月金额配额字段存在并渲染已保存值
    const moneyInput = screen.getByDisplayValue('500')
    expect(moneyInput).toBeInTheDocument()
    // 修改并保存
    fireEvent.change(moneyInput, { target: { value: '800' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/gateway',
      expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"monthly_quota_money":"800"') }),
    )
  })

  it('模型表格展示价格列:未定价徽标与价格显示', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/models') {
        return {
          models: [
            { id: 1, name: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{}', input_price_per_1m: 2, output_price_per_1m: 8 },
            { id: 2, name: 'free-model', display_name: 'Free', default_params: '{}', input_price_per_1m: null, output_price_per_1m: null },
          ],
        }
      }
      return baseImpl(path, init)
    })
    render(<Gateway />)
    expect(await screen.findByText(/入 2 \/ 出 8/)).toBeInTheDocument()
    const unpriced = await screen.findAllByText('未定价')
    expect(unpriced.length).toBeGreaterThan(0)
  })

  it('模型价格编辑:打开对话框提交价格 PUT', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getAllByRole('button', { name: '价格' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('输入价格(元/百万 token)'), { target: { value: '3' } })
    fireEvent.change(dialog.getByLabelText('输出价格(元/百万 token)'), { target: { value: '10' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/models/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-chat', input_price_per_1m: 3, output_price_per_1m: 10 }),
      }),
    )
  })
