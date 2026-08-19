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
  { label: '2026-08-10', prompt_tokens: 1000, completion_tokens: 500, requests: 10, cost: 0.6 },
  { label: '2026-08-11', prompt_tokens: 2000, completion_tokens: 1000, requests: 20, cost: 1.2 },
  { label: '2026-08-12', prompt_tokens: 3000, completion_tokens: 1000, requests: 30, embed_requests: 5, embed_tokens: 500, cost: 2.4 },
]

// alice:显式 token 配额 10000 已用 12000(超额);金额配额 100 已用 120(超额);
// bob:不限(quota=0);
// carol:跟随全局默认(null → 网关 monthly_quota=5000 / monthly_quota_money=50),
//       已用 3000(60%)/ 30 元(60%);
// boss:管理员(豁免)。
const users = [
  { id: 1, username: 'alice', is_admin: false, quota_tokens: 10000, monthly_usage: 12000, quota_money: 100, monthly_cost: 120, status: 1 },
  { id: 2, username: 'bob', is_admin: false, quota_tokens: 0, monthly_usage: 100, quota_money: 0, monthly_cost: 10, status: 1 },
  { id: 3, username: 'carol', is_admin: false, quota_tokens: null, monthly_usage: 3000, quota_money: null, monthly_cost: 30, status: 1 },
  { id: 4, username: 'boss', is_admin: true, quota_tokens: null, monthly_usage: 5000, quota_money: null, monthly_cost: 50, status: 1 },
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
      return { monthly_quota: '5000', monthly_quota_money: '50', default_model: 'm', rate_limit: '60', allow_private: false, search_endpoint: '', server_base_url: '' }
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
  it('渲染汇总统计卡:总费用(第一指标)/ 请求数 / 总 tokens / 输入', async () => {
    render(<Usage />)
    const cards = await screen.findByTestId('stat-cards')
    await waitFor(() => expect(within(cards).getByText('¥4.20')).toBeInTheDocument()) // 总费用 0.6+1.2+2.4
    expect(within(cards).getByText('60')).toBeInTheDocument() // 请求数
    expect(within(cards).getByText('8.5K')).toBeInTheDocument() // 总 tokens = 6000+2500
    expect(within(cards).getByText('6K')).toBeInTheDocument() // 输入 1000+2000+3000
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

  it('配额面板:token+金额双维度,超额预警 / 管理员豁免 / 跟随全局默认', async () => {
    render(<Usage />)
    const list = await screen.findByTestId('quota-list')
    expect(within(list).getByText('alice')).toBeInTheDocument()
    expect(within(list).getAllByText(/120%/).length).toBeGreaterThan(0) // token 与金额双超额
    expect(within(list).getByText('carol')).toBeInTheDocument() // 跟随默认,已计入
    expect(within(list).getAllByText(/60%/).length).toBeGreaterThan(0) // token 3000/5000 + 金额 30/50
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
    expect(text).toContain('label,requests,prompt_tokens,completion_tokens,total_tokens,cost')
  })

  it('用户分组行点击打开钻取弹窗并发起 username 过滤查询', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/usage')) {
        if (path.includes('username=')) return { rows: [{ label: '2026-08-10', prompt_tokens: 100, completion_tokens: 50, requests: 2, cost: 0.2 }], group: 'day' }
        return { rows: [{ label: 'alice', prompt_tokens: 100, completion_tokens: 50, requests: 2, cost: 0.2 }], group: 'user' }
      }
      if (path.startsWith('/api/admin/users')) return { users, total: 4, page: 1, size: 200 }
      if (path.startsWith('/api/admin/gateway')) return { monthly_quota: '5000', monthly_quota_money: '50' }
      return {}
    })
    const user = userEvent.setup()
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    // 切到按用户分组(键盘交互,jsdom 兼容 Radix Select)
    await user.click(screen.getByRole('combobox', { name: '分组' }))
    await user.click(await screen.findByRole('option', { name: '按用户' }))
    // 点击明细表 alice 行(配额面板也有 alice,需限定表格)
    await waitFor(() => {
      const cell = within(screen.getByRole('table')).getAllByText('alice')[0]
      expect(cell).toBeInTheDocument()
    })
    fireEvent.click(within(screen.getByRole('table')).getAllByText('alice')[0])
    await waitFor(() => {
      const calls = mockRequest.mock.calls.filter(([p]) => p.startsWith('/api/admin/usage') && p.includes('username='))
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[calls.length - 1][0]).toContain('username=alice')
    })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('空数据时展示兜底文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/usage')) return { rows: [], group: 'day' }
      if (path.startsWith('/api/admin/users')) return { users, total: 4, page: 1, size: 200 }
      if (path.startsWith('/api/admin/gateway')) return { monthly_quota: '5000', monthly_quota_money: '50' }
      return {}
    })
    render(<Usage />)
    const hits = await screen.findAllByText('暂无数据')
    expect(hits.length).toBeGreaterThan(0)
  })

  // 轮询(60s 静默刷新,仅 ≤7 天按日分组)依赖真实定时器,jsdom fake-timer
  // 与 setInterval+async load 组合不稳定,故不做定时断言;由手工验收覆盖。
})

  it('统计口径切换:选择"金额"后图表与 Total 展示费用', async () => {
    const user = userEvent.setup()
    render(<Usage />)
    await screen.findByTestId('stat-cards')
    // 默认金额口径(企业第一指标):Total 显示 ¥
    expect(await screen.findByText(/Total: ¥4\.20/)).toBeInTheDocument()
    // 切换到 tokens
    await user.click(screen.getByRole('combobox', { name: '统计口径' }))
    await user.click(await screen.findByRole('option', { name: 'tokens' }))
    expect(await screen.findByText(/Total: 8\.5K tokens/)).toBeInTheDocument()
  })

  it('存在未定价模型时展示提示条', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/usage')) return { rows: usageRows, group: 'day' }
      if (path.startsWith('/api/admin/users')) return { users, total: 4, page: 1, size: 200 }
      if (path.startsWith('/api/admin/gateway')) return { monthly_quota: '5000', monthly_quota_money: '50' }
      if (path.startsWith('/api/admin/models')) {
        return { models: [{ id: 1, name: 'free-model', input_price_per_1m: 0, output_price_per_1m: 0 }] }
      }
      return {}
    })
    render(<Usage />)
    expect(await screen.findByText(/未配置价格的模型/)).toBeInTheDocument()
  })

  it('配额面板展示金额进度行(token 与金额双行)', async () => {
    render(<Usage />)
    const list = await screen.findByTestId('quota-list')
    // alice 金额 120/100 → 超额;carol 金额 30/50 → 60%
    const aliceRow = within(list).getByText('alice').closest('div')!.parentElement!
    expect(within(aliceRow).getByText(/¥120\.00 \/ ¥100\.00/)).toBeInTheDocument()
    const carolRow = within(list).getByText('carol').closest('div')!.parentElement!
    expect(within(carolRow).getByText(/¥30\.00 \/ ¥50\.00/)).toBeInTheDocument()
  })
