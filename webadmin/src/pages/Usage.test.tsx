import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Usage from './Usage'
import { request } from '../api'

const mockRequest = vi.mocked(request)

// VChart 依赖 canvas/RAF,jsdom 无法真实渲染;这里渲染占位节点,
// 测试聚焦数据驱动的 UI 行为而非图表内部实现。
vi.mock('@visactor/react-vchart', () => ({
  VChart: (props: any) => (
    <div data-testid="vchart" data-chart-type={props?.spec?.type}>
      vchart-{props?.spec?.type}
    </div>
  ),
}))

const usageRows = [
  { label: '2026-08-10', prompt_tokens: 1000, completion_tokens: 500, requests: 10 },
  { label: '2026-08-11', prompt_tokens: 2000, completion_tokens: 1000, requests: 20 },
]

// alice:显式配额 10000,已用 12000(超额);bob:不限(quota=0);
// carol:跟随全局默认(null → 网关 monthly_quota=5000),已用 3000(60%);
// boss:管理员(豁免)。
const users = [
  { id: 1, username: 'alice', is_admin: false, quota_tokens: 10000, monthly_usage: 12000, status: 1 },
  { id: 2, username: 'bob', is_admin: false, quota_tokens: 0, monthly_usage: 100, status: 1 },
  { id: 3, username: 'carol', is_admin: false, quota_tokens: null, monthly_usage: 3000, status: 1 },
  { id: 4, username: 'boss', is_admin: true, quota_tokens: null, monthly_usage: 5000, status: 1 },
]

const urlStub = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/admin/usage')) {
      return { rows: usageRows, group: 'day' }
    }
    if (path.startsWith('/api/admin/users')) {
      return { users, total: 4, page: 1, size: 200 }
    }
    if (path.startsWith('/api/admin/gateway')) {
      return { monthly_quota: '5000', default_model: 'm', rate_limit: '60', allow_private: false, search_endpoint: '', server_base_url: '' }
    }
    return {}
  })
  // jsdom 无 URL.createObjectURL
  vi.stubGlobal('URL', { ...URL, ...urlStub })
  Object.defineProperty(URL, 'createObjectURL', { writable: true, value: urlStub.createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: urlStub.revokeObjectURL })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Usage 用量统计页', () => {
  it('渲染汇总统计卡:请求数 / 总 tokens / 输入 / 输出(紧凑格式)', async () => {
    render(<Usage />)
    const cards = await screen.findByTestId('stat-cards')
    await waitFor(() => expect(within(cards).getByText('30')).toBeInTheDocument()) // 请求数
    expect(within(cards).getByText('4.5K')).toBeInTheDocument() // 总 tokens
    expect(within(cards).getByText('3K')).toBeInTheDocument() // 输入
    expect(within(cards).getByText('1.5K')).toBeInTheDocument() // 输出
  })

  it('点击快捷区间"近7天"重新查询并携带 from/to 参数', async () => {
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    fireEvent.click(screen.getByRole('button', { name: '近7天' }))
    await waitFor(() => {
      const calls = mockRequest.mock.calls.filter(([p]) => p.startsWith('/api/admin/usage'))
      const last = calls[calls.length - 1]
      expect(last[0]).toContain('from=')
      expect(last[0]).toContain('to=')
    })
  })

  it('首次加载默认携带近30天 from/to(避免无界全表聚合)', async () => {
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    const calls = mockRequest.mock.calls.filter(([p]) => p.startsWith('/api/admin/usage'))
    expect(calls[0][0]).toContain('from=')
    expect(calls[0][0]).toContain('to=')
  })

  it('配额面板:超额预警 / 管理员豁免 / 不限流 / 跟随全局默认计入', async () => {
    render(<Usage />)
    const list = await screen.findByTestId('quota-list')
    expect(within(list).getByText('alice')).toBeInTheDocument()
    expect(within(list).getByText(/120%/)).toBeInTheDocument() // 超额
    expect(within(list).getByText('carol')).toBeInTheDocument() // 跟随默认,已计入
    expect(within(list).getByText(/60%/)).toBeInTheDocument() // 3000/5000
    expect(within(list).queryByText('boss')).not.toBeInTheDocument() // 管理员豁免
    expect(within(list).queryByText(/100%/)).not.toBeInTheDocument() // bob 不限
  })

  it('图表 Tab 联动分组:切换到"占比"发起 group=model 查询', async () => {
    const user = userEvent.setup()
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    await user.click(screen.getByRole('tab', { name: '占比' }))
    await waitFor(() => {
      const calls = mockRequest.mock.calls.filter(([p]) => p.startsWith('/api/admin/usage'))
      const last = calls[calls.length - 1]
      expect(last[0]).toContain('group=model')
    })
  })

  it('起始日期晚于结束日期时提示并拒绝查询', async () => {
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    const fromInput = screen.getByLabelText('起始日期')
    const toInput = screen.getByLabelText('结束日期')
    fireEvent.change(fromInput, { target: { value: '2026-08-20' } })
    fireEvent.change(toInput, { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText(/起始日期不能晚于结束日期/)).toBeInTheDocument()
  })

  it('导出 CSV:点击后触发 Blob 下载且内容含表头(带 BOM)', async () => {
    const createSpy = vi.fn((_blob: Blob) => 'blob:usage')
    Object.defineProperty(URL, 'createObjectURL', { writable: true, value: createSpy })
    const revokeSpy = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: revokeSpy })
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }))
    await waitFor(() => expect(createSpy).toHaveBeenCalled())
    // 校验 Blob 内容:jsdom 的 text() 会剥离 BOM,用原始字节断言 EF BB BF(UTF-8 BOM)
    const blob = createSpy.mock.calls[0][0] as unknown as Blob
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes[0]).toBe(0xef)
    expect(bytes[1]).toBe(0xbb)
    expect(bytes[2]).toBe(0xbf)
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('label,requests,prompt_tokens,completion_tokens,total_tokens')
  })

  it('空数据时展示兜底文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/usage')) return { rows: [], group: 'day' }
      if (path.startsWith('/api/admin/users')) return { users, total: 4, page: 1, size: 200 }
      if (path.startsWith('/api/admin/gateway')) return { monthly_quota: '5000' }
      return {}
    })
    render(<Usage />)
    const hits = await screen.findAllByText('暂无数据')
    expect(hits.length).toBeGreaterThan(0)
  })
})
