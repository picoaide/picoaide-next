import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
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

  it('禁用用户需确认(高2):确认后 PUT status 0,取消不发送', async () => {
    render(<Users />)
    await screen.findByText('alice')
    // 取消 → 不发送请求
    confirmSpy.mockReturnValueOnce(false)
    fireEvent.click(screen.getAllByRole('button', { name: '禁用' })[0])
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/users/1', expect.objectContaining({ method: 'PUT' }))
    // 确认 → 发送 PUT status:0
    confirmSpy.mockReturnValueOnce(true)
    fireEvent.click(screen.getAllByRole('button', { name: '禁用' })[0])
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 0 }) }),
    ))
  })

  it('新建用户失败:错误显示在对话框内(中3)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/admin/departments') return { departments: depts }
      if (path === '/api/admin/users' && init?.method === 'POST') throw new Error('密码至少 10 位')
      return {}
    })
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: '新建用户' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('用户名'), { target: { value: 'eve' } })
    fireEvent.change(dialog.getByLabelText('密码'), { target: { value: 'short' } })
    fireEvent.click(dialog.getByRole('button', { name: '创建' }))
    // 错误必须出现在对话框内
    expect(await dialog.findByText('密码至少 10 位')).toBeInTheDocument()
  })
})

  it('员工金额配额:打开对话框设置 token+金额并保存', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '配额' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/流量配额/)).toBeInTheDocument()
    const tokenInput = dialog.getByLabelText('月度 token 配额')
    const moneyInput = dialog.getByLabelText('月度金额配额(元)')
    fireEvent.change(tokenInput, { target: { value: '50000' } })
    fireEvent.change(moneyInput, { target: { value: '100' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quota_tokens: 50000, quota_money: 100 }),
      }),
    )
  })

  it('员工金额配额:留空清空金额(quota_money_clear)', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '配额' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quota_clear: true, quota_money_clear: true }),
      }),
    )
  })
