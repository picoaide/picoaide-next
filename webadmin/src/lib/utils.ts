import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 部门树选项(缩进层级):平铺 → "研发部"、"研发部 / 前端组"
export interface DeptOption {
  id: number
  label: string
}

export function deptTreeOptions(depts: { id: number; parent_id: number; name: string }[], parentId = 0, depth = 0): DeptOption[] {
  const out: DeptOption[] = []
  for (const d of depts) {
    if (d.parent_id !== parentId) continue
    const prefix = depth > 0 ? `${'　'.repeat(depth)}↳ ` : ''
    out.push({ id: d.id, label: `${prefix}${d.name}` })
    out.push(...deptTreeOptions(depts, d.id, depth + 1))
  }
  return out
}
