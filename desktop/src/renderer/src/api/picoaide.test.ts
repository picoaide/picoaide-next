import { describe, expect, it } from 'vitest'
import { errCode } from './picoaide'

describe('errCode', () => {
  it('extracts the code from a plain "code: message" error', () => {
    expect(errCode(new Error('invalid_credentials: 用户名或密码错误'))).toBe('invalid_credentials')
  })

  it('extracts the code when Electron wraps the IPC error', () => {
    const wrapped = new Error(`Error invoking remote method 'auth:login': invalid_credentials: 用户名或密码错误`)
    expect(errCode(wrapped)).toBe('invalid_credentials')
  })

  it('falls back to the message when no code separator is present', () => {
    expect(errCode(new Error('boom'))).toBe('boom')
  })

  it('keeps an explicit code property', () => {
    expect(errCode({ code: 'AUTH_REQUIRED', message: 'x' })).toBe('AUTH_REQUIRED')
  })
})
