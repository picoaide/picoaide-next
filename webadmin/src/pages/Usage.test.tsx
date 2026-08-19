import { describe, expect, it, vi, beforeEach } from 'vitest'
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

const users = [
  { id: 1, username: 'alice', is_admin: false, quota_tokens: 10000, monthly_usage: 12000, status: 1 },
  { id: 2, username: 'bob', is_admin: false, quota_tokens: 0, monthly_usage: 100, status: 1 },
  { id: 3, username: 'boss', is_admin: true, quota_tokens: null, monthly_usage: 5000, status: 1 },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/admin/usage')) {
      return { rows: usageRows, group: 'day' }
    }
    if (path.startsWith('/api/admin/users')) {
      return { users, total: 3, page: 1, size: 200 }
    }
    return {}
  })
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

  it('配额面板:超额用户标记预警,管理员豁免,不限流用户不显示进度', async () => {
    render(<Usage />)
    const list = await screen.findByTestId('quota-list')
    expect(within(list).getByText('alice')).toBeInTheDocument()
    // alice 12000 / 10000 = 120% → 超额(red)
    expect(within(list).getByText(/120%/)).toBeInTheDocument()
    // 管理员 boss 豁免,不在配额列表
    expect(within(list).queryByText('boss')).not.toBeInTheDocument()
    // bob 不限流(quota=0)不显示进度条占比
    expect(within(list).queryByText(/100%/)).not.toBeInTheDocument()
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

  it('空数据时展示兜底文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/usage')) return { rows: [], group: 'day' }
      if (path.startsWith('/api/admin/users')) return { users, total: 3, page: 1, size: 200 }
      return {}
    })
    render(<Usage />)
    const hits = await screen.findAllByText('暂无数据')
    expect(hits.length).toBeGreaterThan(0)
  })
})
