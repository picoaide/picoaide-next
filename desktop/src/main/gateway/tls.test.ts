import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'picotls-'))
})

afterEach(() => {})

async function loadTls() {
  return import('./tls')
}

describe('sha256Fingerprint', () => {
  it('computes sha256 hex of DER bytes', async () => {
    const { sha256Fingerprint } = await loadTls()
    const der = randomBytes(64)
    expect(sha256Fingerprint(der)).toBe(createHash('sha256').update(der).digest('hex'))
  })

  it('strips PEM armor before hashing', async () => {
    const { sha256Fingerprint } = await loadTls()
    const der = randomBytes(32)
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----`
    expect(sha256Fingerprint(pem)).toBe(createHash('sha256').update(der).digest('hex'))
  })
})

describe('TOFU store', () => {
  it('unknown -> saved -> trusted; different cert -> mismatch', async () => {
    const { checkFingerprint, saveFingerprint, loadFingerprints } = await loadTls()
    const store = join(tmp, 'fingerprints.json')
    const fp1 = createHash('sha256').update(randomBytes(32)).digest('hex')

    expect(checkFingerprint(store, 'gw.example.com', fp1)).toBe('unknown')
    saveFingerprint(store, 'gw.example.com', fp1)
    expect(checkFingerprint(store, 'gw.example.com', fp1)).toBe('trusted')
    expect(checkFingerprint(store, 'other.example.com', fp1)).toBe('unknown')

    const fp2 = createHash('sha256').update(randomBytes(32)).digest('hex')
    expect(checkFingerprint(store, 'gw.example.com', fp2)).toBe('mismatch')
    expect(loadFingerprints(store)).toEqual({ 'gw.example.com': fp1 })
  })

  it('persists across store reloads with 0600 perms', async () => {
    const { saveFingerprint, checkFingerprint } = await loadTls()
    const store = join(tmp, 'fingerprints.json')
    const fp = createHash('sha256').update(randomBytes(32)).digest('hex')

    saveFingerprint(store, 'gw.example.com', fp)
    expect(existsSync(store)).toBe(true)
    expect(statSync(store).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(store, 'utf8')).fingerprints['gw.example.com']).toBe(fp)
    expect(checkFingerprint(store, 'gw.example.com', fp)).toBe('trusted')
  })

  it('loadFingerprints returns empty object for missing store', async () => {
    const { loadFingerprints } = await loadTls()
    expect(loadFingerprints(join(tmp, 'nope.json'))).toEqual({})
  })
})

describe('installCertificateVerification', () => {
  it('is a no-op under plain vitest (no electron session) and does not throw', async () => {
    const { installCertificateVerification } = await loadTls()
    const store = join(tmp, 'fingerprints.json')
    const onUnknown = () => {
      throw new Error('should not be called without a session')
    }
    await expect(installCertificateVerification(store, { onUnknownFingerprint: onUnknown })).resolves.toBeUndefined()
  })
})
