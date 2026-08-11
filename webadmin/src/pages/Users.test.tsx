import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Users from './Users'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/admin/users?page=')) {
      return {
        users: [
          { id: 1, username: 'alice', is_admin: false, status: 1, groups: ['研发部', '全员'] },
          { id: 2, username: 'boss', is_admin: true, status: 1, groups: [] },
        ],
        total: 2, page: 1, size: 20,
      }
    }
    if (path === '/api/admin/users/1/groups' && init?.method === 'PUT') return { ok: true, groups: ['人事部'] }
    return {}
  })
})

describe('Users 用户管理页', () => {
  it('渲染用户表格:部门组徽标与管理角色', async () => {
    render(<Users />)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('@研发部')).toBeInTheDocument()
    expect(screen.getByText('@全员')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()
    expect(screen.getByText('员工')).toBeInTheDocument()
  })

  it('部门组编辑:打开预填现有组,保存调用 PUT /groups', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '部门组' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    const input = dialog.getByPlaceholderText(/研发部, 财务部/) as HTMLInputElement
    expect(input.value).toBe('研发部, 全员')
    fireEvent.change(input, { target: { value: '人事部' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1/groups',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ groups: ['人事部'] }) }),
    )
  })

  it('空白组名保存为清空(空数组)', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '部门组' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByPlaceholderText(/研发部, 财务部/), { target: { value: '  ' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1/groups',
      expect.objectContaining({ body: JSON.stringify({ groups: [] }) }),
    )
  })
})
