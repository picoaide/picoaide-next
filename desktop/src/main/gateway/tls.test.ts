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

  it('pins an unknown fingerprint on first connect, then rejects mismatches', async () => {
    const { installCertificateVerification, loadFingerprints, sha256Fingerprint } = await loadTls()
    const store = join(tmp, 'fingerprints.json')
    const cert1 = randomBytes(64)
    const cert2 = randomBytes(64)
    const cert3 = randomBytes(64)
    const fp1 = sha256Fingerprint(cert1)
    const fp2 = sha256Fingerprint(cert2)
    const fp3 = sha256Fingerprint(cert3)

    const results: number[] = []
    const notified: Array<[string, string]> = []
    let proc: ((req: any, cb: (n: number) => void) => void) | null = null
    const fakeSession = {
      setCertificateVerifyProc: (fn: (req: any, cb: (n: number) => void) => void) => {
        proc = fn
      },
    }

    await installCertificateVerification(store, {
      onUnknownFingerprint: (host, fp) => notified.push([host, fp]),
      getSession: () => fakeSession as never,
    })
    expect(proc).toBeTruthy()

    // 1st connect: unknown cert → trusted (pinned)
    proc!({ hostname: 'gw', port: 443, certificate: { data: cert1 } }, (n) => results.push(n))
    // 2nd connect: same cert → trusted
    proc!({ hostname: 'gw', port: 443, certificate: { data: cert1 } }, (n) => results.push(n))
    // 3rd connect: different cert on same port (MITM) → rejected
    proc!({ hostname: 'gw', port: 443, certificate: { data: cert2 } }, (n) => results.push(n))
    // 4th connect: other host unknown → trusted+pinned
    proc!({ hostname: 'other', port: 443, certificate: { data: cert3 } }, (n) => results.push(n))
    // 5th connect: same host, different port → separate pin (cert1 not shared across ports)
    proc!({ hostname: 'gw', port: 8443, certificate: { data: cert1 } }, (n) => results.push(n))

    expect(results).toEqual([0, 0, -2, 0, 0])
    expect(notified).toEqual([['gw:443', fp1], ['other:443', fp3], ['gw:8443', fp1]])
    expect(loadFingerprints(store)).toEqual({ 'gw:443': fp1, 'other:443': fp3, 'gw:8443': fp1 })
  })
})
