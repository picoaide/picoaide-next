import { vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

// 页面级测试统一 mock 网络层(src/api.ts request):接口行为已由 Go 侧
// 测试与 E2E 覆盖,组件测试只验证 UI 渲染与交互驱动。
vi.mock('../api', () => ({
  request: vi.fn(),
  setCsrf: vi.fn(),
  ApiError: class extends Error {
    code: string
    status: number
    constructor(status = 0, code = 'INTERNAL', message = '') {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))
