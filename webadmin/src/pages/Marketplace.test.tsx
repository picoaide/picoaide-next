import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Marketplace from './Marketplace'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/skills') return { skills: [{ name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', git_url: 'file:///tmp/x', enabled: true }] }
    if (path === '/api/admin/mcp') return { mcp: [{ id: 1, name: 'time-now', description: '时间', transport: 'stdio', command: 'date', enabled: true }] }
    if (path === '/api/admin/mcp-downloads?size=20') return { downloads: [] }
    if (path === '/api/admin/skills/data-extract/grants') return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
    return {}
  })
})

describe('Marketplace 商城页', () => {
  it('渲染技能与 MCP 表格', async () => {
    render(<Marketplace />)
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
    expect(await screen.findByText('time-now')).toBeInTheDocument()
  })

  it('技能授权对话框:展示已有组授权并可撤销', async () => {
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('@研发部')).toBeInTheDocument()
    expect(dialog.queryByText(/未授权:所有用户均不可见/)).not.toBeInTheDocument()
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/skills/data-extract/grant',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ group: '研发部' }) }),
    )
  })

  it('技能授权对话框:输入 @组 提交调用 PUT grant', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/skills/data-extract/grants' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/admin/skills') return { skills: [{ name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', git_url: 'file:///tmp/x', enabled: true }] }
      if (path === '/api/admin/mcp') return { mcp: [] }
      if (path === '/api/admin/mcp-downloads?size=20') return { downloads: [] }
      if (path === '/api/admin/skills/data-extract/grants') return { grants: [] }
      return {}
    })
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/未授权:所有用户均不可见/)).toBeInTheDocument()
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '@人事部' } })
    fireEvent.click(dialog.getByRole('button', { name: '授权' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/skills/data-extract/grant',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ group: '人事部' }) }),
    )
  })
})
