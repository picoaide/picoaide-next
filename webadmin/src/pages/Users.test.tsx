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
    if (path === '/api/admin/departments' && init?.method === 'POST') return { department: { id: 3, name: '财务部' } }
    if (path === '/api/admin/departments/1' && init?.method === 'PUT') return { ok: true }
    if (path === '/api/admin/departments/1' && init?.method === 'DELETE') return { ok: true }
    return {}
  })
})

describe('Users 用户管理页', () => {
  it('渲染用户表格与部门管理卡片', async () => {
    render(<Users />)
    expect((await screen.findAllByText('alice')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('部门管理')).toBeInTheDocument()
    expect(screen.getAllByText('研发部').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('前端组').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('管理员')).toBeInTheDocument()
  })

  it('部门表格:层级/主管/成员数/已授权徽标', async () => {
    render(<Users />)
    await screen.findByText('部门管理')
    expect(screen.getAllByText('alice').length).toBeGreaterThanOrEqual(1) // 用户表+主管列
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1) // 成员数
    expect(screen.getAllByText('已授权').length).toBeGreaterThanOrEqual(1)
  })

  it('员工部门归属:从部门树单选并保存', async () => {
    render(<Users />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getAllByRole('button', { name: '部门' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/从部门树选择归属/)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1/department',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ group_id: 1 }) }),
    )
  })

  it('新建部门:提交 POST /departments', async () => {
    render(<Users />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getByRole('button', { name: '新建部门' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByPlaceholderText('如 研发部'), { target: { value: '财务部' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('删除部门:确认后调用 DELETE(带约束提示)', async () => {
    render(<Users />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments/1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
