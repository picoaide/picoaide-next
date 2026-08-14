# 桌面客户端基于 DeepSeek Harness 重构实现计划(v2:MVP 优先)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> v2 变更:按"dsh 套壳 + 登录页 + 网关配置注入"的最小产品形态重写;吸收 4 个独立审查 agent 的全部审计修正(阻塞级 + 安全级 + 治理级)。CDP 与审批加固移入 Phase 2 待办。

**Goal:** 完全放弃现有自研客户端。新客户端 = Electron 壳 + 进程内嵌入式 DeepSeek Harness(dsh)引擎与 UI + 自研登录页;登录成功后拉取服务端 `/api/config/bootstrap`,把网关地址与登录 token 注入 dsh 的模型配置,模型/工具/会话即全部可用。MVP 不含 CDP。

**Architecture:** Electron 43(main 内嵌 Node 24.18.1)main 进程中直接 boot dsh 的 Cordis 树(dsh-base + dsh-web-app bundle + 自研插件)。端口用官方 cmdline seam(`--host 127.0.0.1 --port 0`)随机分配,不 patch webserver 行。UI 用 npm `overrides` 同名替换 `@deepseek-ai/dsh-web-frontend`(自建 vite 入口),品牌组件(FishLogo/BrandWordmark)用 ESM 星导出遮蔽法换掉,不 fork dsh 源码。LLM 走 dsh 官方 `llm-deepseek` 适配器 `baseURL` 指向服务端网关 `/v1`,token 经环境变量每请求解析。升级 dsh = 改版本号 + 重 build 前端 + 跑契约测试。

**Tech Stack:** Electron 43(ESM main)、TypeScript、esbuild(插件预构建)、electron-vite、Vitest、`@deepseek-ai/dsh` 系列包(锁定精确版本)、Cordis 插件 API、React 18 + Vite(仅前端入口)、Go 服务端(不变)。

---

## 审计修正已吸收(任务代码按此编写)

| # | 审计发现 | 本计划处理 |
|---|---|---|
| 1 | 版本表 rc.5 大部分 E404;cordis 实为 4.0.1、schemastery 3.18.1 | Task 1 全表 rc.6 + 正确版本 + 显式声明 phantom 依赖 |
| 2 | `bareModuleBaseUrl` 必须 file:// URL 锚到 node_modules | Task 2:`pathToFileURL(app.getAppPath()).href` |
| 3 | `@picoaide/*` 裸包名不可解析 | 插件用**相对路径行**(`./plugins/<name>/index.js`,相对 config 解析)+ esbuild 预构建到 config 目录旁 |
| 4 | Task 1 overrides 指向未建的 web 包 | web 包骨架并入 Task 1 |
| 5 | launch-env 快照冻结 → 登录后写 env 不可见 | Task 2 prepare **不** provide 快照(launchEnvironmentOf 按当前 process.env 重建) |
| 6 | `settings.set()` 不存在 | 全部改 `settings.update(ns, patch)`(补丁语义,两插件写同一 ns 不互相覆盖) |
| 7 | config 路径三层不一致;asar 外 config 断裸包解析 | config+插件产物全在 asar 内(electron-vite `publicDir`),不用 extraResources |
| 8 | webserver 行整体替换会随升级静默退化 | **不 patch webserver**,用官方 `--port 0` cmdline seam |
| 9 | `danger-full-access` 预设 + `DSH_PERMISSION_MODE` env 可达 | Task 8:patch `permission` 行删危险预设;boot 前硬编码 env 白名单 |
| 10 | `DSH_TELEMETRY_DISABLED` env 是死代码 | patch `session-telemetry-otel` 行 disabled |
| 11 | 全 mock 测试 = 升级盲区 | Task 2 含 `config-contract.test.ts`(composeEntries 真实合成)+ 不 mock 真实 boot 冒烟测试 |
| 12 | 品牌是硬编码 SVG 组件,换不掉 | Task 4:override `dsh-client-ui-primitives` 代理包 + ESM 星导出遮蔽 |
| 13 | 关闭路径/单实例锁/npmRebuild 缺失 | Task 3/打包任务补齐 |
| 14 | safeStorage Linux basic_text 假加密 | Task 6:检测 backend,非 Linux 或 keyring 才落盘 |

## 明确的取舍(MVP 版)

1. **丢弃自研能力**:agent 引擎、Skill/MCP 运行时、compaction、沙盒、会话 DB、renderer/preload/IPC、屏幕/OCR/剪贴板/CDP(CDP 在 Phase 2 以插件回归)。
2. **审批 = dsh 内置**(policy `ask` + UI 弹窗)即可满足 MVP;60s 硬超时、/api 写面鉴权、OS 级对话框 answerer 在 Phase 2(已记录,不阻塞)。
3. **已知残留**:/api 与 WS 对同机进程无鉴权(随机端口 + loopback);UI 内少量英文/文案仍是 dsh 字典(MVP 不逐包替换 locale);Linux 无 keyring 时 token 不落盘(每次启动重登)。
4. **TOFU**:登录/健康检查/bootstrap 走 `session.defaultSession.fetch`(保留);LLM 流式请求由 dsh 适配器内置 fetch 发出(Node 24 严格证书校验)。

## 目录结构(全新 desktop/)

```
desktop/
├─ package.json                  # electron 43 + dsh rc.6 精确版本 + overrides → 自建 frontend/品牌 shim
├─ electron.vite.config.ts       # main 构建(dsh 包 external,其余全部打进 main bundle)
├─ src/
│  ├─ main/
│  │  ├─ index.ts                # Electron 入口:boot 编排/窗口/单实例/关闭 dispose
│  │  ├─ dsh-boot.ts             # 进程内 boot:程序化组装(补丁 = TS 常量,插件 = ctx.plugin 直挂)
│  │  ├─ picoaide-patches.ts     # 补丁层 TS 常量(permission 加固/telemetry 关/零配置)
│  │  ├─ plugins/
│  │  │  ├─ index.ts             # pluginEntries 数组(boot 时统一挂载)
│  │  │  ├─ session-service.ts   # SESSION_SERVICE 契约常量(唯一所有权)
│  │  │  ├─ auth-gate/           # 登录路由 + 登录页(?raw 内联)+ tapIndex 门控
│  │  │  ├─ gateway-model/       # token env + baseURL settings
│  │  │  └─ bootstrap/           # 会话服务 + bootstrap 拉取 → 模型清单/默认模型
│  │  ├─ server-connector/       # 从 master 搬运:auth/bootstrap/health/tls/config(+测试)
│  │  └─ util/electron.ts        # 搬运(lazy electron 模块)
│  └─ web/                       # 自建 @deepseek-ai/dsh-web-frontend(同名)
│     ├─ package.json / index.html / vite.config.ts / src/main.ts / src/brand.css
├─ brand-shim/                   # 自建 @deepseek-ai/dsh-client-ui-primitives(星导出遮蔽品牌组件)
└─ tests/                        # rebrand 断言 + 打包冒烟
```

> 关键简化:无 yml 补丁文件、无 esbuild 预构建、无资源拷贝。我们的补丁层是 TS 常量(`picoaide-patches.ts`)传给 `boot()`;我们的插件是普通 TS 模块,带 `Plugin.Base.inject` 元数据,在 `boot()` 的 prepare 钩子里 `hostCtx.plugin(...)` 直接挂载(cordis 注册表原生支持函数插件元数据,vendor/cordis/src/registry.ts `Plugin.Base.inject`)。唯一 yml 是 2 行 `[]` 锚点文件,运行时生成到 DSH_HOME。

---

## Phase 0:MVP

### Task 1:骨架 + 依赖锁定 + web 包雏形

**Files:**
- Delete: `desktop/src`(整个旧客户端)、`desktop/tests`(如存在)
- Create: `desktop/package.json`、`desktop/electron.vite.config.ts`
- Create: `desktop/web/package.json`、`desktop/web/index.html`、`desktop/web/vite.config.ts`、`desktop/web/src/main.ts`、`desktop/web/tsconfig.json`、`desktop/web/public/favicon.svg`

- [ ] **Step 1: 删除旧客户端源码**

```bash
git rm -r desktop/src desktop/tests 2>/dev/null || rm -rf desktop/src desktop/tests
```

- [ ] **Step 2: 写新 package.json(全部 rc.6,显式声明所有直接依赖)**

```json
{
  "name": "picoaide-desktop",
  "version": "0.5.0",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/cordis-plugin-include": "1.0.6",
    "@deepseek-ai/dsh-app-boot": "0.1.0-rc.6",
    "@deepseek-ai/dsh-base": "0.1.0-rc.6",
    "@deepseek-ai/dsh-cmdline": "0.1.0-rc.6",
    "@deepseek-ai/dsh-home-paths": "0.1.0-rc.6",
    "@deepseek-ai/dsh-launch-environment": "0.1.0-rc.6",
    "@deepseek-ai/dsh-llm-deepseek": "0.1.0-rc.6",
    "@deepseek-ai/dsh-settings": "0.1.0-rc.6",
    "@deepseek-ai/dsh-web-app": "0.1.0-rc.6",
    "@deepseek-ai/schemastery": "3.18.1"
  },
  "devDependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.6",
    "@types/node": "^24.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "electron": "43.4.0",
    "electron-builder": "^26.0.0",
    "electron-vite": "^4.0.0",
    "esbuild": "^0.25.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "typescript": "^6.0.3",
    "vite": "^6.0.0",
    "vitest": "^4.1.8"
  },
  "overrides": {
    "@deepseek-ai/dsh-web-frontend": "file:./web",
    "@deepseek-ai/dsh-client-ui-primitives": "file:./brand-shim"
  }
}
```

> `@deepseek-ai/dsh`(CLI)放 devDependencies:只用于 `npx dsh --dump-config` 开发核对,不进运行时闭包(省 100MB+)。安装时若 rc.6 未发布,以 `npm view @deepseek-ai/dsh-app-boot dist-tags` 实际 rc 号统一替换全表(必须同号)。

- [ ] **Step 3: 写 web 包雏形(overrides 的 file: 目标必须先存在)**

`desktop/web/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-web-frontend",
  "version": "0.0.0-pico",
  "private": true,
  "type": "module",
  "exports": {
    "./dist/*": "./dist/*",
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": { "build": "vite build" },
  "dependencies": {
    "@deepseek-ai/dsh-client-web": "0.1.0-rc.6",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^6.0.0",
    "typescript": "^6.0.3"
  }
}
```

`desktop/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PicoAide</title>
    <link rel="icon" href="/favicon.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`desktop/web/src/main.ts`:

```ts
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('pico web: missing #root')
void new AppWebEntry(el).run()
```

`desktop/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()], build: { outDir: 'dist', target: 'chrome120' } })
```

`desktop/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`desktop/web/public/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1f6feb"/></svg>
```

- [ ] **Step 4: 写 brand-shim 包雏形(星导出遮蔽品牌组件)**

`desktop/brand-shim/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-client-ui-primitives",
  "version": "0.0.0-pico",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json"
  },
  "scripts": { "build": "node build.mjs" },
  "dependencies": {
    "@deepseek-ai/dsh-client-ui-primitives-upstream": "npm:@deepseek-ai/dsh-client-ui-primitives@0.1.0-rc.6"
  }
}
```

`desktop/brand-shim/index.js`:

```js
export * from '@deepseek-ai/dsh-client-ui-primitives-upstream'
export { BrandWordmark, FishLogo } from './brand.js'
```

`desktop/brand-shim/brand.js`:

```js
import React from 'react'
import * as upstream from '@deepseek-ai/dsh-client-ui-primitives-upstream'

export function BrandWordmark(props) {
  return React.createElement('span', { ...props, style: { fontWeight: 600, letterSpacing: '-0.02em' } }, 'PicoAide')
}

export function FishLogo(props) {
  return React.createElement('span', {
    ...props,
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '1.25em', height: '1.25em', borderRadius: '0.35em', background: '#1f6feb',
      color: '#fff', fontWeight: 700, fontSize: '0.9em',
    },
  }, 'P')
}

export const upstreamForDebug = upstream
```

> 说明:显式命名导出遮蔽 `export *`(ES 语义)。若执行时发现 dsh 代码从该包导入**其他子路径**(如 `/icons`),在 shim 的 exports 补 `"./icons": "@deepseek-ai/dsh-client-ui-primitives-upstream/icons"` 类映射(通配:`"./*": "@deepseek-ai/dsh-client-ui-primitives-upstream/*"`)。执行时以 `grep -rh "dsh-client-ui-primitives" node_modules/@deepseek-ai/dsh-client-ui-* --include=*.js | grep -v upstream` 核对导入路径。

- [ ] **Step 5: 写 electron-vite 配置**

`desktop/electron.vite.config.ts`:

```ts
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { external: [/^@deepseek-ai\//, /^node:/] },
    },
  },
})
```

> 无 publicDir、无资源拷贝、无插件预构建:自研插件是普通 TS 模块,与 dsh-boot 一起被 electron-vite 打进 main bundle;登录页经 vite `?raw` import 内联。dsh 包保持 external,运行时从 node_modules(asar 内)解析。

- [ ] **Step 6: 安装并验证(顺序:web 依赖 → 根)**

```bash
cd desktop/web && npm install && npm run build && ls dist/index.html
cd desktop && npm install
node -e "console.log(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))"
node -e "console.log(require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json'))"
```
Expected: 分别解析到 `desktop/web/dist/index.html` 与 `desktop/brand-shim/package.json`。

- [ ] **Step 7: Commit**

```bash
git add desktop/package.json desktop/package-lock.json desktop/electron.vite.config.ts desktop/web desktop/brand-shim
git commit -m "chore(desktop): rebuild skeleton on dsh rc.6, web+shim overrides in place"
```

### Task 2:进程内 dsh boot(程序化组装,契约测试 + 真实冒烟)

**Files:**
- Create: `desktop/src/main/dsh-boot.ts`
- Create: `desktop/src/main/picoaide-patches.ts`(补丁层 TS 常量)
- Create: `desktop/src/main/plugins/index.ts`(pluginEntries 数组,初始为空)
- Create: `desktop/src/main/config-contract.test.ts`
- Create: `desktop/src/main/dsh-boot.test.ts`(不 mock,真实 boot)
- Create: `desktop/src/main/util/electron.ts`

- [ ] **Step 1: 搬运 electron 工具模块**

```bash
git show master:desktop/src/main/util/electron.ts > desktop/src/main/util/electron.ts
```

- [ ] **Step 2: 写补丁层 TS 常量(吸收审计修正 9/10/11)**

`desktop/src/main/picoaide-patches.ts`:

```ts
/**
 * picoaide 补丁层:应用在 dsh-base、dsh-web-app 两个 bundle 层之后。
 * 语义:行 id 命中即整体替换 config(不是 deep-merge)。安全值在此层锁定。
 */
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** dsh 行覆盖 + 禁用清单。字段名以 `npx dsh --dump-config` 核对(契约测试兜底)。 */
export const ourPatches: PatchOptions[] = [
  // 安全默认(audit 修正 9):permission 行只保留安全预设,删除 danger-full-access。
  // 整体替换语义 → 重述保留字段,字段名与 rc 版本对齐。
  { id: 'permission', config: { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  } } },
  // 遥测关闭(audit 修正 10)
  { id: 'session-telemetry-otel', disabled: true },
  // 零配置:禁用全部用户可触达的配置/权限 UI 行
  { id: 'ui-settings', disabled: true },
  { id: 'ui-settings-general', disabled: true },
  { id: 'ui-settings-models', disabled: true },
  { id: 'ui-settings-plugins', disabled: true },
  { id: 'ui-settings-plugin-inventory', disabled: true },
  { id: 'ui-model-selection', disabled: true },
  { id: 'ui-permission-presets', disabled: true },
]

// 说明:webserver 行不 patch(audit 修正 8),端口走官方 cmdline seam
// provideCmdline(args=['--host','127.0.0.1','--port','0'])。
// llm-deepseek 行不 patch:dsh-base 自带,baseURL 由 gateway-model 插件
// 经 settings.update 写入(每请求解析)。
```

`desktop/src/main/plugins/index.ts`:

```ts
/**
 * 自研插件登记表:boot 的 prepare 钩子里逐个 ctx.plugin 直挂。
 * Task 6/7 在此追加 auth-gate/gateway-model/bootstrap。
 */
import type { Plugin } from '@deepseek-ai/cordis'

export const pluginEntries: Array<{ plugin: Plugin; config: Record<string, unknown> }> = []
```

- [ ] **Step 3: 写契约测试(真实合成,升级主检测器)**

`desktop/src/main/config-contract.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { ourPatches } from './picoaide-patches'

const require = createRequire(import.meta.url)
const BIN = 'picoaide-contract'

function bundlePatches(bundle: string) {
  const manifestPath = require.resolve(`${bundle}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
  const patchRel = manifest.dsh?.bundle?.patch
  if (!patchRel) throw new Error(`${bundle}: no dsh.bundle.patch`)
  return loadOverlayPatches(BIN, join(manifestPath, '..', patchRel))
}

function composedRows() {
  const rows = new Map<string, { id?: string; disabled?: boolean; config?: Record<string, unknown> }>()
  for (const row of composeEntries([[...bundlePatches('@deepseek-ai/dsh-base'), ...bundlePatches('@deepseek-ai/dsh-web-app')], ourPatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  return rows
}

describe('picoaide patch contract vs dsh bundles', () => {
  it('every patched row id exists in the composed tree (no silent patch-miss)', () => {
    const rows = composedRows()
    for (const patch of ourPatches) {
      expect(rows.get(patch.id!), `patch id ${patch.id} missing from composed tree`).toBeDefined()
    }
  })

  it('permission presets exclude danger-full-access', () => {
    const row = composedRows().get('permission')
    const presets = (row?.config?.presets ?? {}) as Record<string, unknown>
    expect(Object.keys(presets)).not.toContain('danger-full-access')
  })

  it('approval policy stays ask', () => {
    const row = composedRows().get('approval')
    expect(row?.config?.policy).toBe('ask')
  })

  it('zero-config rows disabled', () => {
    const rows = composedRows()
    for (const id of ['ui-settings', 'ui-settings-models', 'ui-settings-plugins', 'ui-model-selection', 'ui-permission-presets']) {
      expect(rows.get(id)?.disabled, `${id} not disabled`).toBe(true)
    }
  })

  it('webserver row still present (official seam untouched)', () => {
    expect(composedRows().get('webserver')).toBeDefined()
  })
})
```

- [ ] **Step 4: 写失败测试(真实 boot,不 mock)**

`desktop/src/main/dsh-boot.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootDsh, webPort } from './dsh-boot'

describe('real dsh boot (no mocks)', () => {
  it('boots the full tree, binds loopback on an OS-assigned port, serves /', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pico-boot-'))
    const ctx = await bootDsh({ home, appRoot: join(import.meta.dirname, '..', '..') })
    try {
      const port = webPort(ctx)
      expect(port).toBeGreaterThan(0)
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)
})
```

> 前提:`desktop/web` 已 build(web-runtime 解析 dist)。测试前:`cd desktop/web && npm run build`。

- [ ] **Step 5: 跑契约测试(先红后绿:字段漂移按 dump 修 ourPatches,不改断言意图)**

```bash
cd desktop && npx dsh --dump-config 2>/dev/null | grep -B1 -A12 -E 'permission|approval|ui-model-selection|session-telemetry' || true
npx vitest run src/main/config-contract.test.ts
```
Expected: 首轮可能 FAIL(字段漂移)→ 按 dump 输出修正 `picoaide-patches.ts` → 直到 PASS。

- [ ] **Step 6: 实现 dsh-boot.ts**

`desktop/src/main/dsh-boot.ts`:

```ts
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { ourPatches } from './picoaide-patches'
import { pluginEntries } from './plugins'

export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const BIN = 'picoaide'
const require = createRequire(import.meta.url)

export interface BootOptions {
  /** 数据目录(userData/dsh),兼 DSH_HOME 与锚点文件位置。 */
  home: string
  /** 应用根(app.getAppPath();测试中=desktop 项目根),锚定裸包名解析。 */
  appRoot: string
  onCtx?: (ctx: Context) => void
  onExitRequested?: () => void
}

function loadBundlePatches(bundle: string): PatchOptions[] {
  const manifestPath = require.resolve(`${bundle}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
  const patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel !== 'string') throw new Error(`bundle ${bundle} declares no dsh.bundle.patch`)
  return loadOverlayPatches(BIN, join(manifestPath, '..', patchRel))
}

export async function bootDsh(options: BootOptions): Promise<Context> {
  process.env.DSH_HOME = options.home
  // 安全默认白名单(audit 修正 9):员工无法经环境变量开全权限。
  process.env.DSH_PERMISSION_MODE = 'workspace-write'
  process.env.DSH_TOOLS_MODE = 'native'

  const patches: PatchOptions[] = [...BUNDLES.flatMap(loadBundlePatches), ...ourPatches]
  // boot 需要真实 include 根文件锚定 baseUrl;内容恒为 `[]`,运行时生成,零静态资源。
  const rootConfig = join(options.home, 'cordis.yml')
  writeFileSync(rootConfig, '[]')

  // 审计修正 5:不 provide launch-env 快照 —— 登录后 gateway-model 写的
  // process.env token 要能被 credentials-local 每请求读到
  // (launchEnvironmentOf 无快照时按当前 process.env 重建)。
  const ctx = await boot(BIN, rootConfig, patches, (hostCtx) => {
    // 审计修正 8:官方 cmdline seam 随机端口,不 patch webserver 行。
    provideCmdline(hostCtx, { args: ['--host', '127.0.0.1', '--port', '0'], exit: () => options.onExitRequested?.() })
    // 自研插件直挂(cordis 注册表原生支持函数插件 inject 元数据)。
    for (const entry of pluginEntries) hostCtx.plugin(entry.plugin, entry.config)
    options.onCtx?.(hostCtx)
  }, pathToFileURL(options.appRoot).href + '/')

  return ctx
}

export function webPort(ctx: Context): number {
  const ws = ctx.get('webServer') as { port: number } | undefined
  if (!ws) throw new Error('picoaide: webserver service missing')
  return ws.port
}
```

- [ ] **Step 7: 跑真实 boot 测试(红 → 绿)**

Run: `cd desktop && npx vitest run src/main/dsh-boot.test.ts`
Expected: 首轮 FAIL(boot 模块不存在)→ 实现后 PASS。

- [ ] **Step 8: typecheck + Commit**

```bash
cd desktop && npm run typecheck
git add desktop/src/main/dsh-boot.ts desktop/src/main/dsh-boot.test.ts desktop/src/main/picoaide-patches.ts desktop/src/main/plugins/index.ts desktop/src/main/config-contract.test.ts desktop/src/main/util
git commit -m "feat(desktop): in-process dsh boot, programmatic patches and plugins"
```

### Task 3:Electron 入口(生命周期/单实例/关闭)

**Files:**
- Create: `desktop/src/main/index.ts`

- [ ] **Step 1: 写入口**

`desktop/src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { bootDsh, webPort } from './dsh-boot'
import type { Context } from '@deepseek-ai/cordis'

let ctx: Context | undefined
let disposed = false

function createWindow(port: number): void {
  const win = new BrowserWindow({ width: 1280, height: 800, show: false })
  void win.loadURL(`http://127.0.0.1:${port}/`)
  win.once('ready-to-show', () => win.show())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(async () => {
    ctx = await bootDsh({
      home: join(app.getPath('userData'), 'dsh'),
      appRoot: app.getAppPath(),
      onExitRequested: () => app.quit(),
    })
    createWindow(webPort(ctx))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && ctx) createWindow(webPort(ctx))
  })

  app.on('before-quit', (e) => {
    if (disposed || !ctx) return
    e.preventDefault()
    disposed = true
    void ctx.fiber.dispose().catch(() => {}).finally(() => app.quit())
  })
}
```

- [ ] **Step 2: 开发冒烟**

```bash
cd desktop/web && npm run build && cd .. && npm run dev
```
Expected: 窗口出现 dsh UI(dsh 官方界面 + 我们的登录页重定向,Task 6 前 tapIndex 无注入则直接见 UI;此时应为 PicoAide 标题)。第二次启动不产生新窗口(单实例)。随机端口监听 `ss -ltn | grep <pid>` 非 3080。

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/index.ts
git commit -m "feat(desktop): electron entry with single-instance and graceful dispose"
```

### Task 4:品牌替换验证(shim 生效断言)

**Files:**
- Test: `tests/rebrand.smoke.test.ts`

- [ ] **Step 1: 写断言(经真实解析链)**

`tests/rebrand.smoke.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('brand override integrity', () => {
  it('frontend resolves to our package version', () => {
    const pkg = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
    const manifest = JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }
    expect(manifest.version).toBe('0.0.0-pico')
  })

  it('ui-primitives resolves to our shim', () => {
    const pkg = require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')
    const manifest = JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }
    expect(manifest.version).toBe('0.0.0-pico')
  })

  it('shim shadows BrandWordmark/FishLogo (explicit export wins over star)', async () => {
    const mod = await import('@deepseek-ai/dsh-client-ui-primitives')
    expect(typeof mod.BrandWordmark).toBe('function')
    expect(typeof mod.FishLogo).toBe('function')
  })

  it('built index.html carries PicoAide title and no deepseek string', () => {
    const html = readFileSync(new URL('../desktop/web/dist/index.html', import.meta.url), 'utf8')
    expect(html).toContain('<title>PicoAide</title>')
    expect(html.toLowerCase()).not.toContain('deepseek')
  })
})
```

- [ ] **Step 2: 跑测试 + 手工核对**

```bash
cd desktop/web && npm run build
cd desktop && npx vitest run ../tests/rebrand.smoke.test.ts
```
Expected: PASS。手工:窗口侧栏显示 "PicoAide" 与 "P" 方块 logo,无鲸鱼 logo(若有 UI 组件从 ui-primitives 子路径导入,按 Task 1 Step 4 说明补 exports 映射后重跑)。

- [ ] **Step 3: Commit**

```bash
git add tests/rebrand.smoke.test.ts desktop/brand-shim desktop/web
git commit -m "test(desktop): brand shim shadowing verified through real resolution"
```

### Task 5:server-connector(搬运 + 适配)

**Files:**
- Create: `desktop/src/main/server-connector/{auth,bootstrap,health,tls,config}.ts`
- Test: `desktop/src/main/server-connector/{auth,bootstrap,health,tls}.test.ts`

- [ ] **Step 1: 搬运**

```bash
mkdir -p desktop/src/main/server-connector
for f in auth bootstrap health tls config; do
  git show master:desktop/src/main/gateway/$f.ts > desktop/src/main/server-connector/$f.ts
  git show master:desktop/src/main/gateway/$f.test.ts > desktop/src/main/server-connector/$f.test.ts 2>/dev/null || true
done
```

- [ ] **Step 2: 修 import(util 路径不变,config 内 electron 引用已走懒加载)**

核对每个文件头:`from '../util/electron'` 保持(util 已搬运);移除对已删除模块(如 `../debug`)的引用,若 `debug.ts` 被引用则一并搬运:`git show master:desktop/src/main/debug.ts > desktop/src/main/debug.ts`。

- [ ] **Step 3: 跑搬运测试**

Run: `cd desktop && npx vitest run src/main/server-connector`
Expected: 全部 PASS(原版通过;失败即修 import)。

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/server-connector
git commit -m "chore(desktop): port server-connector from old gateway"
```

### Task 6:auth-gate 插件(登录页 + 门控)

**Files:**
- Create: `desktop/src/main/plugins/session-service.ts`
- Create: `desktop/src/main/plugins/auth-gate/index.ts`
- Create: `desktop/src/main/plugins/auth-gate/index.test.ts`
- Create: `desktop/src/main/plugins/auth-gate/login.html`
- Modify: `desktop/src/main/plugins/index.ts`(登记 auth-gate)
- Create: `desktop/src/vite-env.d.ts`(`*.html?raw` 类型)

- [ ] **Step 1: 写共享契约模块(唯一所有权,audit G6)**

`desktop/src/main/plugins/session-service.ts`:

```ts
import type { Session } from '../server-connector/config'

export const SESSION_SERVICE = 'pico.session'

export interface SessionService {
  isLoggedIn(): boolean
  getSession(): Session | null
  setSession(session: Session): void
  clear(): void
}

export function getSessionService(ctx: { get(key: string): unknown }): SessionService | undefined {
  return ctx.get(SESSION_SERVICE) as SessionService | undefined
}
```

- [ ] **Step 2: 写 ?raw 类型声明**

`desktop/src/vite-env.d.ts`:

```ts
declare module '*.html?raw' {
  const content: string
  export default content
}
```

- [ ] **Step 3: 写失败测试**

`desktop/src/main/plugins/auth-gate/index.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

const register = vi.fn()
const tapIndex = vi.fn()
const fakeCtx = { webServer: { register, tapIndex }, get: vi.fn() }
const { apply } = await import('./index')

describe('auth-gate plugin', () => {
  it('registers login page route and auth routes', () => {
    apply(fakeCtx as never, { defaultServer: 'https://gw' })
    const paths = register.mock.calls.map(c => (c[0] as { path: string }).path)
    expect(paths).toEqual(expect.arrayContaining(['/login', '/api/pico/auth/login', '/api/pico/auth/state', '/api/pico/auth/logout']))
  })

  it('login page html contains our title and injected default server', async () => {
    apply(fakeCtx as never, { defaultServer: 'https://gw' })
    const loginRoute = register.mock.calls.find(c => (c[0] as { path: string }).path === '/login')![0] as { handler(_: unknown, res: { writeHead(n: number, h: Record<string, string>): void; end(b: string): void }): void }
    const chunks: string[] = []
    loginRoute.handler({}, { writeHead: () => {}, end: (b: string) => chunks.push(b) })
    const html = chunks.join('')
    expect(html).toContain('PicoAide')
    expect(html).toContain('https://gw')
  })

  it('tapIndex injects redirect when not logged in', () => {
    apply(fakeCtx as never, { defaultServer: 'https://gw' })
    const transform = tapIndex.mock.calls[0][0] as (html: string) => string
    expect(transform('<html><head></head></html>')).toContain('location.replace("/login")')
  })

  it('tapIndex passes through when logged in', () => {
    fakeCtx.get.mockReturnValue({ isLoggedIn: () => true })
    apply(fakeCtx as never, { defaultServer: 'https://gw' })
    const transform = tapIndex.mock.calls[0][0] as (html: string) => string
    expect(transform('<html>x</html>')).toBe('<html>x</html>')
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd desktop && npx vitest run src/main/plugins/auth-gate/index.test.ts`
Expected: FAIL

- [ ] **Step 5: 实现插件(登录页 ?raw 内联,函数插件带 inject 元数据)**

`desktop/src/main/plugins/auth-gate/index.ts`:

```ts
/**
 * 登录门控插件:未登录时 tapIndex 注入重定向到 /login;
 * 登录页表单 POST /api/pico/auth/login(走 server-connector 的
 * session.defaultSession.fetch → TOFU 生效);成功后经 SessionService
 * 通知 bootstrap/gateway-model 加载网关配置。
 * 挂载方式:plugins/index.ts 登记 → boot prepare 钩子 ctx.plugin 直挂,
 * inject 元数据保证 webServer 服务就绪后才执行(Plugin.Base.inject)。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { login } from '../../server-connector/auth'
import { getSessionService } from '../session-service'
import loginHtml from './login.html?raw'

export interface Config {
  defaultServer: string
}

export function apply(ctx: Context, config: Config): void {
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  ctx.webServer.register({
    kind: 'exact', path: '/login',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(loginHtml.replaceAll('__DEFAULT_SERVER__', config.defaultServer))
    },
  })

  ctx.webServer.register({
    kind: 'exact', path: '/api/pico/auth/login',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let body: { server?: unknown; username?: unknown; password?: unknown }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
      if (typeof body.server !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
        return json(res, 400, { error: 'missing fields' })
      }
      const svc = getSessionService(ctx)
      if (!svc) return json(res, 500, { error: 'session service missing' })
      try {
        svc.setSession(await login(body.server, body.username, body.password))
        json(res, 200, { ok: true })
      } catch (err) {
        json(res, 401, { error: err instanceof Error ? err.message : 'login failed' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact', path: '/api/pico/auth/state',
    handler: (_req: IncomingMessage, res: ServerResponse) => json(res, 200, { loggedIn: getSessionService(ctx)?.isLoggedIn() ?? false }),
  })

  ctx.webServer.register({
    kind: 'exact', path: '/api/pico/auth/logout',
    handler: (_req: IncomingMessage, res: ServerResponse) => { getSessionService(ctx)?.clear(); json(res, 200, { ok: true }) },
  })

  ctx.webServer.tapIndex((html) => {
    if (getSessionService(ctx)?.isLoggedIn()) return html
    return html.replace(
      '</head>',
      `<script>sessionStorage.setItem('pico-redirect','1');location.replace('/login')</script></head>`,
    )
  })
}

apply.inject = ['webServer']
apply.name = 'auth-gate'
```

- [ ] **Step 6: 写登录页**

`desktop/src/main/plugins/auth-gate/login.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>PicoAide 登录</title>
<style>
  body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#e6edf3}
  form{display:flex;flex-direction:column;gap:12px;width:300px}
  input{padding:10px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#e6edf3}
  button{padding:10px;border-radius:6px;border:0;background:#1f6feb;color:#fff;cursor:pointer}
  #err{color:#f85149;min-height:1em}
</style></head>
<body>
<form id="f">
  <h2>PicoAide</h2>
  <input id="server" placeholder="服务器地址 https://…">
  <input id="username" placeholder="用户名" autocomplete="username">
  <input id="password" type="password" placeholder="密码" autocomplete="current-password">
  <div id="err"></div>
  <button type="submit">登录</button>
</form>
<script>
document.getElementById('server').value = '__DEFAULT_SERVER__'
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err')
  err.textContent = ''
  const res = await fetch('/api/pico/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: document.getElementById('server').value,
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    }),
  })
  if (res.ok) location.replace('/')
  else err.textContent = ((await res.json().catch(() => ({}))).error) ?? '登录失败'
})
</script>
</body></html>
```

- [ ] **Step 7: 登记到 pluginEntries**

`desktop/src/main/plugins/index.ts` 改为:

```ts
/**
 * 自研插件登记表:boot 的 prepare 钩子里逐个 ctx.plugin 直挂。
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { apply as authGate } from './auth-gate'

export const pluginEntries: Array<{ plugin: Plugin; config: Record<string, unknown> }> = [
  { plugin: authGate as unknown as Plugin, config: { defaultServer: '' } },
]
```

- [ ] **Step 8: 跑测试确认通过 + typecheck + 冒烟(登录页出现)**

Run: `cd desktop && npx vitest run src/main/plugins/auth-gate/index.test.ts && npm run typecheck`
Expected: PASS + 无类型错误。冒烟(`npm run dev`):未登录 → 自动跳转 /login,登录页含 PicoAide 品牌。

- [ ] **Step 9: Commit**

```bash
git add desktop/src/main/plugins/session-service.ts desktop/src/main/plugins/auth-gate desktop/src/main/plugins/index.ts desktop/src/vite-env.d.ts
git commit -m "feat(desktop): auth-gate plugin with login page and index gating"
```

### Task 7:gateway-model + bootstrap 插件(登录 → 网关配置 → 模型可用)

**Files:**
- Create: `desktop/src/main/plugins/gateway-model/index.ts`
- Create: `desktop/src/main/plugins/gateway-model/index.test.ts`
- Create: `desktop/src/main/plugins/bootstrap/index.ts`
- Create: `desktop/src/main/plugins/bootstrap/index.test.ts`

- [ ] **Step 1: 写失败测试(settings API = update)**

`desktop/src/main/plugins/gateway-model/index.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

const settingsUpdate = vi.fn()
const fakeCtx = { on: vi.fn(), get: vi.fn(() => ({ update: settingsUpdate })) }
const { apply, TOKEN_ENV } = await import('./index')

describe('gateway-model plugin', () => {
  it('on session change: token env + llm-deepseek baseURL via settings.update', () => {
    apply(fakeCtx as never, {})
    const listener = fakeCtx.on.mock.calls[0][1] as (s: unknown) => void
    listener({ serverURL: 'https://gw.internal:8443', token: 'jwt-1' })
    expect(process.env[TOKEN_ENV]).toBe('jwt-1')
    expect(settingsUpdate).toHaveBeenCalledWith('llm-deepseek', expect.objectContaining({
      baseURL: 'https://gw.internal:8443/v1',
      apiKeyEnv: TOKEN_ENV,
    }))
  })

  it('clears token env on logout', () => {
    apply(fakeCtx as never, {})
    const listener = fakeCtx.on.mock.calls[0][1] as (s: unknown) => void
    listener(null)
    expect(process.env[TOKEN_ENV]).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd desktop && npx vitest run src/main/plugins/gateway-model/index.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 gateway-model**

`desktop/src/main/plugins/gateway-model/index.ts`:

```ts
/**
 * 网关模型插件:登录后把 dsh 官方 llm-deepseek 适配器指向服务端网关。
 * - baseURL = <server>/v1(OpenAI-compatible /chat/completions)
 * - 密钥 = 登录 token 经环境变量提供;llm-deepseek 的 apiKeyEnv 每请求解析,
 *   换 token 即时生效(audit 修正 5:boot 时不 provide launch 快照)。
 * - settings.update 是补丁语义:与 bootstrap 插件写 models 不互相覆盖。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../../server-connector/config'

export const TOKEN_ENV = 'PICOAI_GATEWAY_TOKEN'
const SETTINGS_NS = 'llm-deepseek'

interface SettingsLike { update(ns: string, patch: Record<string, unknown>): Promise<unknown> }

export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as SettingsLike
  ctx.on('pico.session-changed', (session: Session | null) => {
    if (!session) {
      process.env[TOKEN_ENV] = ''
      return
    }
    process.env[TOKEN_ENV] = session.token
    void settings.update(SETTINGS_NS, {
      baseURL: `${session.serverURL.replace(/\/+$/, '')}/v1`,
      apiKeyEnv: TOKEN_ENV,
    })
  })
}

apply.inject = ['settings']
apply.name = 'gateway-model'
```

- [ ] **Step 4: 实现 bootstrap(会话服务 + 下发)**

`desktop/src/main/plugins/bootstrap/index.ts`:

```ts
/**
 * bootstrap 插件:持有会话服务(登录态 + token 持久化)并在登录成功后
 * 拉取 /api/config/bootstrap 下发:默认模型 + 模型清单 → settings。
 * 技能/MCP 下发属于 Phase 2(skill/mcp 插件字段随 rc 漂移,暂不接)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBootstrap } from '../../server-connector/bootstrap'
import { loadElectronModule } from '../../util/electron'
import { SESSION_SERVICE, type SessionService } from '../session-service'
import type { Session } from '../../server-connector/config'

export interface Config {
  tokenFile: string
}

interface SettingsLike { update(ns: string, patch: Record<string, unknown>): Promise<unknown> }

export function apply(ctx: Context, config: Config): void {
  const settings = ctx.get('settings') as SettingsLike

  let session: Session | null = loadPersisted(config.tokenFile)
  const service: SessionService = {
    isLoggedIn: () => session !== null,
    getSession: () => session,
    setSession: (s: Session) => {
      session = s
      persist(config.tokenFile, s)
      ctx.emit('pico.session-changed', s)
      void sync(s)
    },
    clear: () => {
      session = null
      try { unlinkSync(config.tokenFile) } catch { /* absent is fine */ }
      ctx.emit('pico.session-changed', null)
    },
  }
  ctx.provide(SESSION_SERVICE, service)
  if (session) void sync(session)

  async function sync(s: Session): Promise<void> {
    try {
      const { config: cfg } = await getBootstrap(s)
      await settings.update('llm-deepseek', { models: cfg.models.map(m => ({ id: m.id, name: m.name })) })
      await settings.update('agent-default-model', { model: cfg.default_model })
    } catch (err) {
      console.error('[pico] bootstrap failed:', err)
    }
  }
}

apply.inject = ['settings']
apply.name = 'bootstrap'

function loadPersisted(tokenFile: string): Session | null {
  try {
    const ss = require('electron')?.safeStorage
    if (!ss || !ss.isEncryptionAvailable()) return null
    if (!existsSync(tokenFile)) return null
    return JSON.parse(ss.decryptString(readFileSync(tokenFile)).toString('utf8')) as Session
  } catch { return null }
}

function persist(tokenFile: string, s: Session): void {
  const ss = require('electron')?.safeStorage
  if (!ss || !ss.isEncryptionAvailable()) return
  writeFileSync(tokenFile, ss.encryptString(JSON.stringify(s)))
}
```

> `require('electron')` 在 vitest 下返回路径字符串(safeStorage undefined)→ loadPersisted 返回 null,测试不炸。`agent-default-model` 字段名以 `npx dsh --dump-config` 核对(dsh-base 的 agent-default-model 行 config 形状),不符则改此处与测试。

- [ ] **Step 5: 写 bootstrap 插件测试(会话服务 + 下发)**

`desktop/src/main/plugins/bootstrap/index.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

const settingsUpdate = vi.fn(async () => {})
const fakeCtx = { provide: vi.fn(), emit: vi.fn(), get: vi.fn(() => ({ update: settingsUpdate })) }
vi.mock('../../server-connector/bootstrap', () => ({
  getBootstrap: vi.fn(async () => ({
    config: { default_model: 'm1', models: [{ id: 'm1', name: 'M1' }], skills: [], mcp: [], web: {} },
    fellBack: false,
  })),
}))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

const { apply } = await import('./index')
const { getBootstrap } = await import('../../server-connector/bootstrap')
const { SESSION_SERVICE } = await import('../session-service')

describe('bootstrap plugin', () => {
  it('provides session service and syncs model config on login', async () => {
    apply(fakeCtx as never, { tokenFile: '/tmp/nonexistent-token' })
    const service = fakeCtx.provide.mock.calls[0][1] as { setSession(s: unknown): void }
    expect(fakeCtx.provide.mock.calls[0][0]).toBe(SESSION_SERVICE)
    service.setSession({ serverURL: 'https://gw', token: 't' })
    await vi.waitFor(() => expect(getBootstrap).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith('agent-default-model', { model: 'm1' }))
    expect(settingsUpdate).toHaveBeenCalledWith('llm-deepseek', expect.objectContaining({ models: [{ id: 'm1', name: 'M1' }] }))
  })
})
```

- [ ] **Step 6: 登记到 pluginEntries + 跑全部测试**

`desktop/src/main/plugins/index.ts` 追加 gateway-model 与 bootstrap(置于 auth-gate 之后):

```ts
import { apply as authGate } from './auth-gate'
import { apply as gatewayModel } from './gateway-model'
import { apply as bootstrap } from './bootstrap'

export const pluginEntries: Array<{ plugin: Plugin; config: Record<string, unknown> }> = [
  { plugin: authGate as unknown as Plugin, config: { defaultServer: '' } },
  { plugin: gatewayModel as unknown as Plugin, config: {} },
  { plugin: bootstrap as unknown as Plugin, config: { tokenFile: '' } },
]
```

同时 bootstrap 插件 apply 开头加一行兜底(不依赖 config 传路径):

```ts
const tokenFile = config.tokenFile || join(process.env.DSH_HOME!, 'session.json')
```

(替换 apply 内对 `config.tokenFile` 的三处引用。)

Run: `cd desktop && npx vitest run`
Expected: 全绿(契约测试 + 真实 boot + auth-gate + gateway-model + bootstrap)。

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/plugins/gateway-model desktop/src/main/plugins/bootstrap desktop/src/main/plugins/index.ts
git commit -m "feat(desktop): gateway-model and bootstrap wire login into dsh models"
```

### Task 8:安全默认补丁核对 + 全链路验收

**Files:**
- Modify: `desktop/src/main/picoaide-patches.ts`(dump 核对后定稿)

- [ ] **Step 1: dump 核对安全行并修正补丁常量**

```bash
cd desktop && npx dsh --dump-config 2>/dev/null | grep -B1 -A15 -E 'permission|approval' | head -60
```
逐项确认:permission presets 无 danger-full-access;approval policy = ask;session-telemetry-otel disabled;7 个 ui 行 disabled。字段与补丁不符则改 `picoaide-patches.ts` 并重跑契约测试至绿。

- [ ] **Step 2: 全链路验收(mock 上游 + 真服务端 + 客户端)**

```bash
go run scripts/mock-upstream.go &                 # 假 LLM 上游
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin &
cd desktop/web && npm run build && cd .. && npm run dev
```
逐项:登录页 → 登录(含自签证书 TOFU)→ 跳回主界面 → 模型列表 = 服务端 bootstrap 下发 → 发消息流式回复来自 mock 上游(经网关)→ 侧栏 "PicoAide" 无鲸鱼 logo → 重启自动恢复登录态(token 持久化)→ 无 ui-settings 入口。

- [ ] **Step 3: 打包冒烟(npmRebuild false + asar)**

`desktop/electron-builder.yml`:

```yaml
appId: com.picoaide.desktop
productName: PicoAide
directories:
  output: release
files:
  - out/**
  - package.json
npmRebuild: false
asarUnpack:
  - '**/*.node'
win:
  target: [nsis]
linux:
  target: [AppImage]
mac:
  target: [dmg]
```

```bash
cd desktop && npm run build && npx electron-builder --dir
./release/linux-unpacked/picoaide
```
Expected: 打包产物启动,登录 → 聊天全链路可用;`.node` 文件在 app.asar.unpacked 下。

- [ ] **Step 4: 文档收尾**

`AGENTS.md` §4 架构总览客户端行改为:

```
renderer = dsh Web UI(自建同名 frontend 包 + 品牌 shim)──HTTP/WS 127.0.0.1:随机端口──▶ Electron main
  ├─ Cordis 树:dsh-base + dsh-web-app bundle + 自研插件(auth-gate/gateway-model/bootstrap)
  ├─ 引擎/UI/工具/审批/沙盒/skill/MCP 全部来自 dsh;会话 = dsh jsonl 会话日志(DSH_HOME=userData/dsh)
  └─ 服务端连接器(登录/健康/bootstrap/TLS,TOFU)
```

§6 目录结构 desktop/ 部分同步替换;§7 契约中"客户端 5 表"替换为"dsh session 持久化(jsonl + 可选 sqlite 检索)"。

架构设计文档追加:

```markdown
## ADR D26:桌面客户端引擎与 UI 全面采用 DeepSeek Harness(dsh)

**状态**:已接受(2026-08-14)

**决策**:废弃自研 agent 引擎/UI/tools,Electron main 进程内嵌 dsh Cordis
树;UI 用 dsh Web UI(overrides 同名包 + 品牌 shim,不 fork);自研仅
auth-gate(登录)、gateway-model(网关)、bootstrap(配置下发)三个插件。

**理由**:dsh 的会话日志/工具/审批/沙盒/skill/MCP 成熟度高于自研,UI 质量
与维护成本优于自研;MVP 形态 = 壳 + 登录 + 网关配置注入。

**代价**:依赖 developer preview 的破坏性变更节奏(契约测试 + runbook 应对);
屏幕/OCR/剪贴板/CDP 暂缺(Phase 2 插件回归);审批 60s 硬超时与 /api
写面鉴权在 Phase 2;LLM 流式请求走 Node 证书校验(TOFU 仅覆盖登录面)。
```

- [ ] **Step 5: Commit**

```bash
git add desktop/electron-builder.yml desktop/src/main/picoaide-patches.ts AGENTS.md docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md
git commit -m "docs: security defaults verified and ADR D26 recorded"
```

---

## Phase 2 待办(不阻塞 MVP,每个独立成任务)

1. **CDP 回归**:cdp-bridge 插件(搬运 cdp_server.ts,加 Origin/Host 校验)+ cdp-tools 工具插件(`tools/pre-execute` waterfall 返回 ask 做审批)。
2. **审批加固**:60s 硬超时自研插件(`ctx.on('approval/request', …)` + `AbortSignal.timeout(60_000)` 一律视为拒绝);评估 main 进程原生 dialog answerer(同机进程无法伪造点击);/api 与 WS 加共享密钥门(frontend 注入 secret)。
3. **技能/商城与知识库远程 MCP 下发**:bootstrap 插件扩展,写 skill/MCP 插件 settings(dump 核对字段)。
4. **升级 runbook 自动化**:`scripts/upgrade-dsh.sh`(全表改版本 + web/shim 依赖同步 + 版本一致性断言 + 契约测试/真实 boot 测试进门禁)。
5. **体积裁剪**:已把 CLI 移 devDeps;进一步评估裁 node-pty/sharp/otel 的 bundle 级方案。
6. **打包完善**:packaging.test.ts(asar 内无 .node 断言)、企业内网更新通道(electron-updater generic provider)、Linux safeStorage basic_text 告警。
7. **沙盒验收**:真实跑 bash 工具的越界写断言 + fail-closed 验证(Windows ACL runner 与 Electron `process.execPath` 兼容性问题验证)。

---

## Self-Review 结果

**1. Spec 覆盖**:壳 + 登录页 + 网关配置注入 = Task 1-8 全链路 ✓;无 DeepSeek logo = Task 4(星导出遮蔽)✓;随机端口 = Task 2(官方 seam)✓;完全放弃旧客户端 = Task 1 ✓;安全默认(danger preset/零配置)= Task 2/8 ✓;CDP/审批加固/技能下发 = Phase 2 显式待办 ✓。

**2. Placeholder 扫描**:两处标注"以 dump 为准"(permission 行字段、agent-default-model 字段)——均为对第三方快速迭代 API 的核对步骤,附有核对命令与修正路径,非 TBD;bootstrap 插件不实现技能下发(明确为 Phase 2,函数未留空壳)。

**3. 类型一致性**:`SESSION_SERVICE`/`SessionService` 定义于 session-service.ts(Task 6),auth-gate 与 bootstrap 均从此导入;`TOKEN_ENV` 定义于 gateway-model,测试引用一致;`bootDsh`/`webPort` 定义于 Task 2,Task 3 与测试引用一致;`pluginEntries` 定义于 plugins/index.ts(Task 2 建空表,Task 6/7 登记),boot prepare 钩子统一挂载;bootstrap 的 tokenFile 经 `process.env.DSH_HOME` 兜底推导(Task 7 Step 6)。

**风险清单**:rc.6 版本号以安装时 registry 为准(Task 1 附替换说明);brand-shim 子路径导入面以执行时 grep 核对为准(Task 1 Step 4 说明);dsh 事件名 `pico.session-changed` 为自研协议(与 dsh 事件命名空间隔离,无冲突)。
