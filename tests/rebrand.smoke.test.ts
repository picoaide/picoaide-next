import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

// All package resolution anchors at desktop's dependency tree.
const require = createRequire(new URL('../desktop/package.json', import.meta.url))

describe('brand override integrity', () => {
  it('frontend resolves to our web package', () => {
    const pkg = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
    const manifest = JSON.parse(readFileSync(pkg, 'utf8')) as { picoaide?: boolean }
    expect(manifest.picoaide).toBe(true)
  })

  it('ui-primitives resolves to our shim', () => {
    const pkg = require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')
    const manifest = JSON.parse(readFileSync(pkg, 'utf8')) as { picoaide?: boolean }
    expect(manifest.picoaide).toBe(true)
  })

  it('shim shadows BrandWordmark/FishLogo (explicit export wins over star)', () => {
    // Plain-Node import of the shim evaluates upstream's `import "katex/dist/katex.min.css"`
    // (no .css loader outside vite), so shadowing is asserted on the resolved sources here and
    // on the real vite-built bundle below.
    const entry = require.resolve('@deepseek-ai/dsh-client-ui-primitives')
    const src = readFileSync(entry, 'utf8')
    const brand = readFileSync(join(dirname(entry), 'brand.js'), 'utf8')
    expect(src).toMatch(/export\s*\{\s*BrandWordmark,\s*FishLogo\s*\}\s*from\s*'\.\/brand\.js'/)
    expect(brand).toContain("'PicoAide'")
  })

  it('built UI bundle renders PicoAide brand (vite resolved our shim)', () => {
    const dist = new URL('../desktop/web/dist/assets/', import.meta.url)
    const bundles = readdirSync(dist).filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(new URL(f, dist), 'utf8'))
    expect(bundles.some((src) => src.includes('PicoAide'))).toBe(true)
  })

  it('built index.html carries PicoAide title and no deepseek string', () => {
    const html = readFileSync(new URL('../desktop/web/dist/index.html', import.meta.url), 'utf8')
    expect(html).toContain('<title>PicoAide</title>')
    expect(html.toLowerCase()).not.toContain('deepseek')
  })
})
