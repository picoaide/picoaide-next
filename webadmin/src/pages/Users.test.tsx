import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Users from './Users'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

const depts = [
  { id: 1, name: '研发部', parent_id: 0, leader_id: 2, leader_name: 'alice', description: '', member_count: 1, child_count: 1, granted_count: 1 },
  { id: 2, name: '前端组', parent_id: 1, leader_id: 0, leader_name: '', description: '', member_count: 1, child_count: 0, granted_count: 0 },
]

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/admin/users?page=')) {
      return {
        users: [
          { id: 1, username: 'alice', is_admin: false, status: 1, groups: ['研发部'] },
          { id: 2, username: 'boss', is_admin: true, status: 1, groups: [] },
        ],
        total: 2, page: 1, size: 20,
      }
    }
    if (path === '/api/admin/departments') return { departments: depts }
    if (path === '/api/admin/users/1/department' && init?.method === 'PUT') return { ok: true }
    return {}
  })
})

describe('Users 用户管理页', () => {
  it('渲染用户表格:部门徽标与管理角色', async () => {
    render(<Users />)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('研发部')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()
    expect(screen.getByText('员工')).toBeInTheDocument()
  })

  it('员工部门归属:打开对话框从部门树单选并保存', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '部门' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/从部门树选择归属/)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1/department',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ group_id: 1 }) }),
    )
  })

  it('未分配部门用户显示占位', async () => {
    render(<Users />)
    await screen.findByText('boss')
    // boss 无部门
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
