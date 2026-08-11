import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Knowledge from './Knowledge'
import { request } from '../api'

const confirmSpy = vi.fn(() => true)

const mockRequest = vi.mocked(request)

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/kb/folders') return { folders: [{ id: 1, name: '研发部', parent_id: 0 }] }
    if (path === '/api/admin/departments') return { departments: [{ id: 1, name: '研发部', parent_id: 0 }, { id: 4, name: '财务部', parent_id: 0 }] }
    if (path.startsWith('/api/admin/kb/documents')) return { documents: [], total: 0 }
    if (path === '/api/admin/kb/import-status') return { status: { pending: 0, ready: 0, error: 0, total: 0 }, errors: [] }
    if (path === '/api/admin/kb/embedding-model') return { model: '' }
    if (path.startsWith('/api/admin/kb/folders/1/grants')) return { users: ['alice'], groups: ['研发部'] }
    if (path.startsWith('/api/admin/kb/search')) {
      return {
        mode: 'hybrid',
        total: 1,
        results: [{ chunk_id: 11, doc_id: 1, title: '差旅管理管理制度', title_path: '第一章 总则', content: '差旅费报销政策及流程说明', score: 0.85 }],
      }
    }
    return {}
  })
})

describe('Knowledge 知识库页', () => {
  it('渲染文件夹列表与文档表格空态', async () => {
    render(<Knowledge />)
    expect(await screen.findByText('研发部')).toBeInTheDocument()
    expect(await screen.findByText(/暂无文档/)).toBeInTheDocument()
  })

  it('命中测试:输入关键词后渲染块级结果(标题路径 + score)', async () => {
    render(<Knowledge />)
    await screen.findByText('研发部')
    fireEvent.change(screen.getByPlaceholderText(/搜索知识库/), { target: { value: '报销' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('差旅管理管理制度')).toBeInTheDocument()
    expect(screen.getByText(/› 第一章 总则/)).toBeInTheDocument()
    expect(screen.getByText(/score 0.85/)).toBeInTheDocument()
    expect(screen.getAllByText('混合检索').length).toBeGreaterThanOrEqual(1)
  })

  it('授权对话框:展示已有授权(用户/组)并撤销', async () => {
    render(<Knowledge />)
    await screen.findByText('研发部')
    // 文件夹行的授权按钮
    const grantBtn = screen.getAllByRole('button', { name: '授权' })[0]
    fireEvent.click(grantBtn)
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('alice')).toBeInTheDocument()
    expect(dialog.getByText('@研发部')).toBeInTheDocument()
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/kb/folders/1/grant',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('授权对话框:勾选部门多选保存(整组替换)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/kb/folders/1/grants' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/admin/kb/folders/1/grants') return { users: [], groups: [] }
      return {
        folders: [{ id: 1, name: '研发部', parent_id: 0 }],
        departments: [{ id: 1, name: '研发部', parent_id: 0 }, { id: 4, name: '财务部', parent_id: 0 }],
        documents: [], total: 0,
        status: { pending: 0, ready: 0, error: 0, total: 0 }, errors: [],
        model: '',
      } as any
    })
    render(<Knowledge />)
    await screen.findByText('研发部')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    // 勾选研发部 → 保存部门授权(整组替换)
    fireEvent.click(dialog.getByLabelText(/研发部/))
    fireEvent.click(dialog.getByRole('button', { name: '保存部门授权' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/kb/folders/1/grants',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ groups: ['研发部'] }) }),
    )
  })
})
