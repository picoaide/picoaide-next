import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './gateway/config'
import { EMPTY } from './gateway/bootstrap'
import {
  clearCaches,
  establishSession,
  getBootstrapCache,
  getCurrentSession,
  validateServerURL,
} from './session_cache'

const SESSION: Session = { serverURL: 'https://srv.example.com', username: 'alice', token: 't1' }

afterEach(() => {
  clearCaches()
})

describe('validateServerURL', () => {
  it('accepts https for any host', () => {
    expect(validateServerURL('https://pico.example.com').ok).toBe(true)
    expect(validateServerURL('https://127.0.0.1:8443').ok).toBe(true)
  })

  it('accepts http for localhost / 127.0.0.1', () => {
    expect(validateServerURL('http://localhost:8080')).toEqual({ ok: true, url: 'http://localhost:8080' })
    expect(validateServerURL('http://127.0.0.1:8080').ok).toBe(true)
  })

  it('rejects http for remote hosts', () => {
    const r = validateServerURL('http://pico.example.com')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('HTTPS')
  })

  it('rejects garbage / missing scheme / empty input', () => {
    expect(validateServerURL('').ok).toBe(false)
    expect(validateServerURL('pico.example.com').ok).toBe(false)
    expect(validateServerURL('ftp://pico.example.com').ok).toBe(false)
  })

  it('strips trailing slashes', () => {
    expect(validateServerURL('https://pico.example.com/')).toEqual({ ok: true, url: 'https://pico.example.com' })
  })
})

describe('establishSession', () => {
  it('persists, caches bootstrap and notifies the caller', async () => {
    const onSessionEstablished = vi.fn()
    const deps = {
      flow: { saveSession: vi.fn().mockResolvedValue({ persisted: true }) },
      getBootstrap: vi.fn().mockResolvedValue({
        config: { ...EMPTY, default_model: 'm1', models: [{ id: 'm1', display_name: 'M1' }] },
        fellBack: false,
      }),
      onSessionEstablished,
    }
    const res = await establishSession(SESSION, deps)
    expect(res.session).toMatchObject({ ...SESSION, persisted: true })
    expect(res.bootstrap.default_model).toBe('m1')
    expect(getCurrentSession()).toEqual(SESSION)
    expect(getBootstrapCache().default_model).toBe('m1')
    expect(onSessionEstablished).toHaveBeenCalledWith(SESSION)
  })

  it('falls back to empty bootstrap when the fetch fails (offline restart)', async () => {
    const res = await establishSession(SESSION, {
      flow: { saveSession: vi.fn().mockResolvedValue({ persisted: false }) },
      getBootstrap: vi.fn().mockRejectedValue(new Error('network down')),
    })
    expect(res.bootstrap).toEqual(EMPTY)
    expect(getCurrentSession()).toEqual(SESSION)
    expect(getBootstrapCache()).toEqual(EMPTY)
  })
})
