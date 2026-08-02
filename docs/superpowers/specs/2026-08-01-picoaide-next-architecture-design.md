# PicoAide(Next)架构设计文档

> 项目:picoaide-next(全新重写)
> 日期:2026-08-01
> 状态:设计定稿,待实施
> 上一代:picoaide(沙箱模式)已冻结,本仓库仅作参考,零代码迁移

---

## 0. 设计决策记录(ADR 摘要)

| # | 决策 | 结论 | 理由 |
|---|------|------|------|
| D1 | 产品形态 | WorkBuddy 式桌面 AI 办公智能体 | 沙箱模式能力受限(无法操作真实桌面),同类产品已验证(腾讯 WorkBuddy 月活 2000 万) |
| D2 | 与旧项目关系 | 全新仓库、全新重写,零继承 | 用户决策:干净起步,架构按新形态自由设计 |
| D3 | Agent 循环位置 | 客户端本地运行 | 操作本机文件/浏览器/屏幕必须在本地;会话/记忆本地存储,离线可用 |
| D4 | 旧沙箱模式 | 退役 | 服务端不再跑沙箱/picoagent |
| D5 | 客户端技术栈 | Electron + React + TypeScript | Electron 桌面壳成熟度远超 Wails(WebView 跨平台差异/调试/打包生态);React 聊天 UI 生态最丰富 |
| D6 | Agent 引擎 | Vercel AI SDK(`ai` + `@ai-sdk/workflow`,TS) | 事实标准的 TS LLM/Agent 框架;WorkflowAgent 提供 durable 执行 + 工具审批流;streamText 流式 UI 一流;provider baseURL 直连自研网关 |
| D7 | 服务端技术栈 | Go | 网关/认证/知识库重负载场景 Go 稳、部署单二进制 |
| D8 | 平台 | Windows / macOS / Linux 三平台并行 | Electron 原生跨平台,electron-builder 打包成熟 |
| D9 | 认证 | LDAP / OIDC / 本地账号(保留企业集成) | 私有化部署刚需 |
| D10 | LLM 调用路径 | 全走服务端 AI 网关代理 | 密钥不出服务端,按用户计量 |
| D11 | MCP 工具运行位置 | 客户端本地运行(商城下发配置/凭证) | 工具需要本地环境(如小红书插件本地 HTTP 服务) |
| D12 | Skill 形态 | 混合型(指令 + 可执行包) | 简单技能用指令,复杂技能带脚本 |
| D13 | 知识库 | 服务端全新实现,客户端经远程 MCP 查询 | 数据集中服务端,跨设备一致 |
| D14 | 会话/记忆存储 | 客户端本地 SQLite | 离线可用,敏感数据不出本机 |
| D15 | 沙盒执行 | Vercel Sandbox(`@ai-sdk/sandbox-vercel`)运行 Agent 生成的不可信代码 | AI SDK 官方沙盒适配,受限会话跑 untrusted 代码/脚本,防本机损坏;本地工具(文件/桌面)仍直连用户授权目录 |
| D16 | 服务端管理 | 极简 Web 管理页 | 用户管理/商城上架/用量统计需要界面 |
| D17 | 前端框架 | React + TypeScript(不用 Vue) | AI 聊天组件/流式渲染生态 React 最丰富,与 AI SDK 原生契合 |
| D18 | 仓库名 | picoaide-next | 与旧仓库 picoaide 区分 |
| D19 | 客户端本地存储 | better-sqlite3 | Node 生态最稳的同步 SQLite 驱动,主进程内使用 |
| D20 | 客户端本地 MCP | 官方 @modelcontextprotocol/sdk(Client) | MCP 标准 TypeScript SDK,stdio + HTTP 双传输 |
| D21 | 客户端 OCR | tesseract.js | 纯 JS/WASM,三平台免系统依赖,惰性加载 |
| D22 | 长任务 | @ai-sdk/workflow(WorkflowAgent) | durable + resumable:任务可中断恢复、工具审批流内置(承接高危确认) |
| D23 | UI 组件 | ai-elements(AI Elements 组件注册表) | Vercel 官方 AI 原生组件库,聊天/流式/工作台组件开箱即用 |
| D24 | 网关接入 | 自研 Go 网关;AI SDK provider baseURL 直连 | 不用 Vercel AI Gateway 云服务;客户端零密钥,计量在服务端 |

---

## 1. 背景与动机

### 1.1 上一代问题

PicoAide(旧)是浏览器 Web UI + 服务端沙箱(overlayfs + netns)模式,存在四类根本问题:

1. **能力受限**:沙箱只能做纯数字世界任务(文本/代码/API),无法操作真实桌面——不能生成并直接交付 Office 文档、不能操作本机应用、不能屏幕识别/OCR、不能做 RPA 自动化。
2. **产物割裂**:Agent 产物在服务端沙箱,用户需手动下载,体验断裂。
3. **部署沉重**:每用户一个沙箱,资源开销大,单机承载低,运维复杂。
4. **形态落后**:主流已转向"桌面客户端 + 本地执行 + 云端网关"(WorkBuddy / OpenClaw 等),AI 直接操作用户电脑。

### 1.2 新项目目标

构建 **WorkBuddy 式桌面 AI 办公智能体**:

- **桌面客户端**:完整 Agent 在本机运行,直接操作文件/浏览器/屏幕,完成"整理文件、做表格、写方案、生成 PPT、信息检索"等实际办公任务
- **服务端网关**:自研轻量基础设施——AI 网关(统一 LLM 入口/密钥/计量)+ Skill 商城 + MCP 插件商城 + 知识库(远程 MCP)
- **私有化可部署**:服务端可部署企业内网,支持 LDAP/OIDC 对接

### 1.3 非目标(本期明确不做)

- 本地 OS 级沙箱隔离(用户自有电脑,风险自担)
- 多设备会话同步(会话/记忆只存本地)
- 移动端 App
- 商业化计费扣费(只做用量统计)
- 旧项目代码迁移(仅作参考,零继承)

---

## 2. 总体架构

### 2.1 架构图

```
┌─────────────── 桌面客户端 picoaide-desktop (Electron: main + renderer) ──────┐
│                                                                              │
│  React UI (renderer, 全新写)                                                  │
│  ├─ 登录页:服务器 URL/端口 + 用户名/密码                                     │
│  ├─ 主界面:会话列表 + 聊天区 + 右侧产物/可视化面板 + 底部状态栏               │
│  ├─ 交互模式:Ask(聊天) / Plan(先计划后执行) / Craft(Agent 执行)              │
│  └─ 设置页:模型选择、工作目录、可访问目录、MCP 插件管理、技能管理、离线状态    │
│                                                                              │
│  Electron 主进程 (Node + TS)                                                 │
│  ├─ Agent 引擎:Vercel AI SDK(streamText + tools + maxSteps)                  │
│  ├─ 本地工具:文件 / 终端 / 浏览器 / 屏幕截图 / OCR(tesseract.js) / 剪贴板     │
│  ├─ 本地 MCP 运行时:@modelcontextprotocol/sdk Client,本地 spawn(stdio)/直连(http)│
│  ├─ Skill 运行时:从商城下载,指令注入系统提示 + scripts 本地执行               │
│  ├─ 会话/记忆:better-sqlite3(WAL 模式)                                       │
│  └─ 服务端连接器:登录/token 管理、AI 网关客户端(SSE 流式)、远程 MCP 客户端    │
│                                                                              │
└────────────────────────────┬─────────────────────────────────────────────────┘
                             │ HTTPS(WSS)
                             │ Bearer token
┌────────────────────────────▼─────────────────────────────────────────────────┐
│  服务端 picoaide-server (Go,私有化可部署)                                     │
│                                                                              │
│  ├─ 认证:LDAP / OIDC / 本地账号(全新实现,参考旧 authsource 设计)              │
│  ├─ AI 网关:OpenAI 兼容 /v1/chat/completions 代理                              │
│  │    上游:openai / deepseek / qwen / glm / openrouter / anthropic(二期)      │
│  │    密钥只存服务端,usage 计量表                                              │
│  ├─ Skill 商城:元数据 + Git 源 + 打包下载 API                                  │
│  ├─ MCP 插件商城:mcp_servers + grants,配置/凭证分发 API                        │
│  ├─ 知识库:全新实现(存储 + 全文/向量检索),暴露远程 MCP 工具                    │
│  └─ 极简 Web 管理页:用户/组、商城上架下架、用量统计、网关密钥配置              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流(一次完整 Craft 任务)

```
1. 用户启动客户端,输入服务端 URL + 用户名密码 → 服务端认证(LDAP/OIDC/本地) → 返回 token
2. 客户端拉取启动配置:模型列表(网关)、技能清单(商城)、MCP 插件清单(商城)
3. 用户输入任务:"把桌面/文档里的 Word 汇总成 500 字汇报存回桌面"
4. 本地 Agent 引擎(Craft 模式)启动:
   a. 向服务端 AI 网关发流式 LLM 请求(OpenAI 协议)
   b. 服务端鉴权 → 计量 → 转发上游 LLM → SSE 流式回传客户端
   c. Agent 决策调用工具:
      - 本地工具:文件读/写/编辑、终端命令、浏览器搜索、屏幕截图/OCR
      - 云端工具:知识库(远程 MCP 经网关)
      - 插件工具:本地 MCP 插件
   d. 高危操作(删除/外发)→ UI 弹窗确认 → 用户允许/拒绝
   e. 循环直到任务完成(MaxIter 上限保护)
5. 产物写入本地工作目录,会话/记忆写入本地 SQLite
6. 全程事件流推送到 React UI(打字机 + 工具调用状态 + 产物预览)
```

---

## 3. 客户端详细设计

### 3.1 技术栈与依赖

| 层 | 技术 | 版本建议 |
|----|------|----------|
| 桌面壳 | Electron | 最新稳定(主进程 Node + renderer) |
| 主进程语言 | TypeScript(Node) | Node 20+ 内置于 Electron |
| Agent 引擎 | Vercel AI SDK(`ai` + `@ai-sdk/workflow` + `@ai-sdk/openai-compatible`) | 最新 |
| 长任务/审批 | `@ai-sdk/workflow`(WorkflowAgent) | durable + resumable + 工具审批流 |
| 沙盒执行 | `@ai-sdk/sandbox-vercel` | 不可信代码/脚本在 Vercel Sandbox 受限会话运行 |
| 流式 UI | `@ai-sdk/react`(useChat/streamText) | 随 ai 包 |
| UI 组件 | ai-elements(AI Elements 注册表) | 官方 AI 原生组件 |
| 本地数据库 | better-sqlite3 | 最新(主进程同步 API) |
| 前端 | React 18 + TypeScript + Vite | 最新 |
| 本地 MCP | @modelcontextprotocol/sdk(Client) | 最新 |
| 截图 | Electron `desktopCapturer` + `nativeImage` | 内置,免依赖 |
| OCR | tesseract.js(纯 JS/WASM,中文 `chi_sim`) | 惰性加载 |
| 剪贴板 | Electron `clipboard` | 内置 |
| 浏览器控制 | 一期:web_fetch/web_search(HTTP);二期:Playwright CDP | 实施期定 |
| 测试 | Vitest(main + renderer) | 最新 |

**客户端架构模型(Electron 三进程):**

```
renderer (React UI) ──contextBridge──▶ preload ──ipcMain──▶ main (Node: 引擎/工具/DB/MCP)
                                                              │
                                                              ▼
                                                      服务端 (HTTPS)
```

- **main 进程**:Agent 引擎、本地工具、better-sqlite3、MCP 运行时、网关客户端、token 存储(不在 renderer 持敏感数据)
- **renderer 进程**:纯 UI,经 preload 的 `window.picoaide.*` API 与 main 通信,流式事件经 ipc 推送
- **preload 脚本**:contextBridge 暴露白名单 API(登录/发消息/事件订阅/设置/确认),contextIsolation 开启

### 3.2 目录结构(仓库全景)

```
picoaide-next/
├── go.mod                        # 单 module:github.com/picoaide/picoaide(服务端)
├── Makefile                      # 构建/测试/打包
├── cmd/server/main.go            # 服务端网关入口
├── internal/                     # 服务端 Go 代码(serverauth/llmgateway/marketplace/knowledge/serverstore/util)
├── desktop/                      # Electron 客户端(TypeScript monorepo 子包)
│   ├── package.json              # name: picoaide-desktop,main: dist/main/index.js
│   ├── electron-builder.yml      # 三平台打包配置
│   ├── src/
│   │   ├── main/                 # 主进程(Node)
│   │   │   ├── index.ts          # app 生命周期、窗口创建、安全策略
│   │   │   ├── ipc.ts            # ipcMain 路由注册(与 preload API 一一对应)
│   │   │   ├── agent/
│   │   │   │   ├── engine.ts     # AgentEngine:WorkflowAgent + streamText + 审批流
│   │   │   │   ├── provider.ts   # createOpenAICompatible({baseURL: 自研网关})
│   │   │   │   ├── modes.ts      # Ask / Plan / Craft 三模式
│   │   │   │   ├── events.ts     # 流式事件模型(UI 协议)
│   │   │   │   └── resume.ts     # durable 恢复(从 SQLite 恢复 workflow 状态)
│   │   │   ├── tools/            # 本地工具
│   │   │   │   ├── filesystem.ts # 文件读/写/编辑/追加/删除/列表/搜索(GBK 检测)
│   │   │   │   ├── terminal.ts   # 命令执行(超时/输出截断/进程组 kill)
│   │   │   │   ├── sandbox.ts    # Vercel Sandbox 受限会话(@ai-sdk/sandbox-vercel)
│   │   │   │   ├── web.ts        # web_fetch / web_search
│   │   │   │   ├── screen.ts     # desktopCapturer 截图
│   │   │   │   ├── ocr.ts        # tesseract.js 惰性加载
│   │   │   │   └── clipboard.ts  # Electron clipboard
│   │   │   ├── mcp/              # 本地 MCP 插件运行时
│   │   │   │   ├── installer.ts  # 商城拉取/安装
│   │   │   │   ├── runner.ts     # stdio(http) Client 生命周期管理
│   │   │   │   └── adapter.ts    # MCP tools → AI SDK tool 适配
│   │   │   ├── skill/            # Skill 运行时
│   │   │   │   ├── loader.ts     # SKILL.md + metadata + scripts
│   │   │   │   ├── installer.ts  # 下载/更新/卸载
│   │   │   │   └── inject.ts     # 系统提示注入
│   │   │   ├── store/            # better-sqlite3 数据层
│   │   │   │   ├── db.ts         # 打开/迁移(WAL)
│   │   │   │   ├── conversations.ts / messages.ts / artifacts.ts / memories.ts / settings.ts / workflow_state.ts
│   │   │   ├── gateway/          # 服务端连接器
│   │   │   │   ├── client.ts     # AI 网关请求(SSE 解析)
│   │   │   │   ├── auth.ts       # 登录/token 存取/登出
│   │   │   │   ├── health.ts     # 离线检测轮询
│   │   │   │   ├── remote_mcp.ts # 服务端远程 MCP(知识库)
│   │   │   │   └── marketplace.ts# 商城 API 客户端
│   │   │   └── paths.ts          # 数据目录定位(per-platform)
│   │   ├── preload/index.ts      # contextBridge 白名单 API
│   │   └── renderer/             # React UI
│   │       ├── src/
│   │       │   ├── App.tsx / main.tsx
│   │       │   ├── api/picoaide.ts        # preload API 封装
│   │       │   ├── components/            # ChatInput/Messages/ToolCalls/Artifacts/ConfirmModal
│   │       │   ├── pages/                # Login/Main/Settings
│   │       │   └── stores/               # Zustand:chat/auth/connection
│   │       ├── vite.config.ts / index.html / tsconfig.json
│   ├── tests/                   # Vitest(main 逻辑 + renderer 组件)
│   └── resources/               # 图标/安装资源
├── webadmin/                     # 服务端管理页(独立小 React 应用)
├── docs/
├── scripts/                      # 打包脚本(NSIS/dmg/deb/AppImage)
└── data/                         # 服务端运行时数据(库/缓存,gitignore)
```
│   │   ├── provider.go           # Provider 接口 + 注册表
│   │   ├── local.go              # 本地账号(argon2id)
│   │   ├── ldap.go               # LDAP(参考旧 go-ldap 用法)
│   │   ├── oidc.go               # OIDC 授权码流
│   │   └── token.go              # api_tokens 颁发/校验(hash 存储)
│   ├── llmgateway/               # AI 网关(服务端)
│   │   ├── handler.go            # /v1/chat/completions 代理
│   │   ├── upstream.go           # 上游路由(openai系直通/anthropic转换)
│   │   ├── usage.go              # 计量记账
│   │   └── models.go             # 模型列表/模型权限
│   ├── marketplace/              # 商城(服务端)
│   │   ├── skill_api.go          # Skill 商城 API
│   │   ├── skill_pack.go         # Git 源拉取 + tar.gz 打包
│   │   ├── mcp_api.go            # MCP 插件商城 API
│   │   └── credentials.go        # 凭证加密存储
│   ├── knowledge/                # 知识库(服务端,全新实现)
│   │   ├── store.go              # 文档/文件夹/标签/权限
│   │   ├── index.go              # 全文索引(SQLite FTS5)+ 向量(可选)
│   │   ├── search.go             # 搜索
│   │   ├── mcp.go                # 暴露为远程 MCP 工具
│   │   └── admin.go              # 管理端 API
│   ├── serverstore/              # 服务端 SQLite
│   │   ├── db.go                 # 迁移
│   │   ├── users.go / groups.go / settings.go
│   │   ├── tokens.go / usage.go / skills.go / mcp_servers.go
│   │   └── knowledge.go
│   └── util/                     # 通用工具(参考旧 util 设计,全新实现)
│       ├── password.go           # argon2id / bcrypt
│       ├── safe.go               # SafePathSegment 等
│       └── crypto.go             # AES-GCM 加密(凭证/密钥)
├── webadmin/                     # 服务端管理页(独立小 React 应用)
│   └── src/                      # Users/Marketplace/Usage/Gateway
├── docs/
│   ├── 01-architecture.md
│   ├── 02-build-deploy.md
│   ├── 03-api-reference.md
│   ├── 04-auth.md
│   ├── 05-agent-system.md
│   ├── 06-database.md
│   ├── 07-marketplace.md
│   ├── 08-development.md
│   └── superpowers/specs/2026-08-01-picoaide-next-architecture-design.md(本文档)
└── scripts/                      # 打包脚本(NSIS/dmg/deb/AppImage)
```

### 3.3 Agent 引擎(核心)

#### 3.3.1 引擎封装(主进程,TypeScript)

```ts
// desktop/src/main/agent/engine.ts
export class AgentEngine {
  private cfg: EngineConfig          // 模型/工作目录/工具开关
  private tools: Record<string, Tool>  // AI SDK tool 注册表(本地 + MCP + 远程 + 沙盒)
  private aborter: AbortController | null

  constructor(cfg: EngineConfig, store: Store, deps: EngineDeps)
  // Ask/Plan/Craft 共用入口
  run(opts: { conversationId: number; content: string; mode: Mode }): Promise<RunHandle>
  cancel(): void
  confirm(requestId: string, ok: boolean): void   // 审批流回执
}
```

Agent 骨架(基于 `@ai-sdk/workflow` 的 WorkflowAgent,durable + resumable):

```ts
// desktop/src/main/agent/engine.ts — 骨架伪代码
import { WorkflowAgent, type ModelCallStreamPart } from '@ai-sdk/workflow'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { getWritable } from 'workflow'
import { z } from 'zod'

const provider = createOpenAICompatible({
  name: 'gateway',
  baseURL: `${serverURL}/v1`,        // 自研 Go AI 网关
  apiKey: token,
})

const agent = new WorkflowAgent({
  model: provider.chatModel(modelID),
  instructions: buildSysPrompt(skills, mode),
  tools: this.tools,                 // 本地/MCP/远程/沙盒工具
  // 高危工具审批流(WorkflowAgent 内置):
  //   tool.execute 标记 needsApproval → agent.stream() 返回未执行 toolCalls
  //   → UI 弹窗 → confirm(requestId, ok) → 以 approved input 继续
})

const result = await agent.stream({
  messages: history.map(toModelMessage),
  writable: getWritable<ModelCallStreamPart>(),
  onStepEnd: (step) => this.persistStep(step),   // durable 落库
})
// result.stream → text-delta → ipc 推 text_delta;tool-call → tool_start
```

#### 3.3.1a 长任务与恢复(WorkflowAgent)

- 办公任务可能执行数分钟甚至更久,`WorkflowAgent` 支持 durable execution:
  - **中断恢复**:应用重启后可从最近 step 恢复(状态序列化到 better-sqlite3)
  - **内置审批流**:工具可声明需要人工批准,审批前不执行(见 3.4 高危确认,实现层直接复用 WorkflowAgent 审批机制,不再自建状态机)
- Ask 模式用轻量 `streamText`(无工具、无持久化 step);Craft/Plan 用 WorkflowAgent

#### 3.3.1b 沙盒执行(Vercel Sandbox)

- 不可信代码(Agent 生成的脚本、技能自带的 run.py 等)在 Vercel Sandbox 受限会话运行:
  ```ts
  import { createVercelSandbox } from '@ai-sdk/sandbox-vercel'
  const sandbox = createVercelSandbox({ runtime: 'node24', ports: [0] })
  const session = (await sandbox.createSession()).restricted()
  const { stdout } = await session.run({ command: 'python3 script.py' })
  ```
- 用途:`sandbox_exec` 工具(替代/补充本地 terminal)、技能 scripts 执行、产物生成任务
- **边界**:沙盒内无用户文件访问权限;需要访问用户授权目录的操作仍走本地工具(文件/桌面/剪贴板)

#### 3.3.2 Provider(LLM 通道)

```ts
// desktop/src/main/agent/provider.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
// createOpenAICompatible({ name, baseURL: 服务端网关, apiKey: 登录 token })
```

- 客户端一律经网关,不持有上游密钥
- AI SDK 的 OpenAI 兼容 provider 直接对接服务端 `/v1/chat/completions`(streaming 原生支持,SSE 由 SDK 处理,无需手写解析)

#### 3.3.3 事件流(UI 协议)

```ts
// desktop/src/main/agent/events.ts — 主进程经 ipc 推送给 renderer
export type AgentEvent =
  | { type: 'text_delta'; data: string }
  | { type: 'reasoning_delta'; data: string }
  | { type: 'tool_start'; data: { id: string; name: string; input: unknown } }
  | { type: 'tool_end'; data: { id: string; name: string; output: unknown; durationMs: number } }
  | { type: 'tool_error'; data: { id: string; name: string; error: string } }
  | { type: 'confirm_required'; data: { requestId: string; op: string; target: string; reason: string } }
  | { type: 'artifact'; data: { path: string; type: string; size: number } }
  | { type: 'done'; data: { usage?: { promptTokens: number; completionTokens: number } } }
  | { type: 'error'; data: string }
```

renderer 经 preload 暴露的 `window.picoaide.onEvent(cb)` 订阅(底层 ipcRenderer.on),打字机渲染 `text_delta`,工具卡片渲染 `tool_start/end`。

#### 3.3.4 三模式

| 模式 | 行为 | 实现 |
|------|------|------|
| Ask | 纯聊天,不调工具 | `tools: {}`(不注册工具),纯 streamText |
| Plan | 第一轮禁用工具输出计划 → 用户确认 → 转 Craft | 同一会话,第二轮带 tools |
| Craft | 完整 Agent 循环 | 默认全量:tools + maxSteps(默认 20) |

### 3.4 本地工具

| 工具名 | 能力 | 安全约束 |
|--------|------|----------|
| file_read | 读取文本文件(编码自动检测:UTF-8/GBK/Big5) | 可访问目录内 |
| file_write / file_edit / file_append | 写/编辑/追加 | 可访问目录内 |
| file_delete | 删除文件 | **高危:审批流弹窗** |
| file_list / file_search | 列目录/搜索 | 可访问目录内 |
| command_exec | 执行命令(60s 默认超时,输出截断 50KB) | 工作目录内;需确认的命令模式(rm -rf 等)弹窗 |
| sandbox_exec | Vercel Sandbox 受限会话运行不可信代码/脚本 | 无用户文件权限;时间/网络受限 |
| web_fetch / web_search | HTTP 抓取/搜索 | 无外发敏感数据 |
| screen_capture | 屏幕截图 → base64 | 无 |
| screen_ocr | 对截图 OCR | 惰性加载模型 |
| clipboard_read / write | 剪贴板 | 读剪贴板属敏感,**读取前审批弹窗** |

**可访问目录模型**:默认 = 用户工作目录(每次对话独立子目录 `workspaces/<conv>/`),用户在设置中可追加"可访问目录"列表。工具越界返回明确错误给 Agent 重试。

**高危操作确认协议(WorkflowAgent 审批流)**:

```
Agent 发起高危工具(needsApproval: true)
→ WorkflowAgent 不执行,stream() 返回未执行 toolCalls(含 requestId)
→ 引擎发 confirm_required 事件 → UI 弹窗(操作内容 + 目标路径 + 60s 倒计时)
→ 用户允许 → engine.confirm(requestId, true) → 以批准的输入继续执行
→ 用户拒绝/超时 → confirm(requestId, false) → 工具返回拒绝错误给 Agent
```

### 3.5 本地 SQLite

存储根目录:

- Linux:`~/.local/share/picoaide/`
- macOS:`~/Library/Application Support/picoaide/`
- Windows:`%APPDATA%/picoaide/`

文件布局:

```
picoaide/
├── picoaide.db          # 主库(WAL 模式)
├── config.json          # 服务端 URL/token(权限 0600)
├── workspaces/<conv-id>/   # 产物
├── skills/<name>/       # 已安装技能
└── mcp/<plugin-id>/     # 已安装插件配置
```

表结构:

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'ask',            -- ask | plan | craft
  model TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                          -- user | assistant | tool
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_messages_conv ON messages(conversation_id);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',           -- file|image|report|ppt|docx|xlsx|html
  size INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 3.6 本地 MCP 插件运行时

商城返回插件配置:

```json
{
  "id": 3,
  "name": "xiaohongshu",
  "transport": "http",                    // http | stdio
  "command": "npx",
  "args": ["-y", "mcp-server-xiaohongshu"],
  "url": "http://127.0.0.1:3000/mcp",
  "env": {"APP_ID": "<加密下发,客户端解密>"},
  "headers": {"Authorization": "Bearer ..."}
}
```

- `stdio`:本地 spawn,JSON-RPC over stdio,进程生命周期随客户端,崩溃自动重启 1 次
- `http`:客户端起 MCP client 直连 URL(本地服务或内网地址)
- MCP client → AI SDK `tool` 适配层(`adapter.ts`),工具暴露给 Agent
- 插件开关在设置页;凭证敏感字段服务端加密存储、HTTPS 传输、客户端仅存进程内存(可选落盘时加密)

### 3.7 Skill 运行时

技能包格式(商城分发,tar.gz):

```
skill-name-v1.2.3.tar.gz
├── SKILL.md            # 指令:行为/用法/边界(注入系统提示词)
├── metadata.yaml       # name/version/author/description/dependencies/entrypoint
├── scripts/            # 可执行部分
│   └── run.py|run.sh|run.go
└── tools/              # 可选:技能自带工具定义(JSON schema)
```

- 加载:SKILL.md → 注入系统提示;scripts → 注册为 `skill_exec <name>` 工具(**在 Vercel Sandbox 受限会话执行**,仅超时+输出截断;需要用户文件的操作仍走本地工具)
- 更新:商城版本检测,手动更新;卸载:删目录 + 移除提示注入
- 来源信任:仅商城官方渠道;第三方 skill 首次安装弹窗提示风险

---

## 4. 服务端详细设计

### 4.1 认证

#### 4.1.1 Provider 注册表(参考旧设计,全新实现)

```go
type PasswordProvider interface {
    Authenticate(username, password string) (UserInfo, error)
}
type BrowserProvider interface {
    StartFlow(...) / HandleCallback(...)
}
type DirectoryProvider interface {
    ListUsers() / ListGroups() / UserGroups()
}
```

- **local**:用户名密码,argon2id 哈希(SQLite users 表)
- **ldap**:go-ldap,绑定查询 + 组映射(参考旧 internal/ldap + authsource)
- **oidc**:授权码流,客户端打开系统浏览器 → 回调本地端口 `http://127.0.0.1:<port>/callback`

#### 4.1.2 Token 认证(客户端)

```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256(token),不存明文
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  last_used_at DATETIME,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

- 登录:`POST /api/auth/login` → 服务端验证 → 返回 `{token, user, permissions}`
- 后续请求:`Authorization: Bearer <token>`
- 登录限流:10 次/5 分钟(按 IP+用户名)
- 服务端管理页另用 session cookie + CSRF(参考旧机制,全新实现)

### 4.2 AI 网关

#### 4.2.1 端点

```
POST /v1/chat/completions        # OpenAI 兼容,支持 stream=true(SSE)
GET  /v1/models                  # 用户可见模型列表
```

#### 4.2.2 流程

```
客户端 → 网关(鉴权+限流) → 计量 → 上游路由 → 流式回传
```

上游路由表(服务端 settings 配置):

| 上游 | 协议 | 实现 |
|------|------|------|
| openai / openrouter / qwen / glm / deepseek | OpenAI 兼容 | 直通转发(请求体/SSE 原样转) |
| anthropic | Anthropic Messages API | 请求/响应格式转换(二期) |

#### 4.2.3 计量

```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
```

- 流式场景:从 SSE 流末段 usage 字段取 token,会话结束落库
- 管理页:按用户/模型/时间聚合图表

#### 4.2.4 密钥管理

- 上游 key 存服务端 settings(展平 KV),**AES-GCM 加密落盘**,密钥来自 `PICOAI_MASTER_KEY` 环境变量或首次启动生成
- 管理页配置,超管可见(掩码展示)

### 4.3 Skill 商城

```
GET  /api/marketplace/skills                  # 列表(元数据)
GET  /api/marketplace/skills/:name            # 详情
GET  /api/marketplace/skills/:name/archive    # 下载 tar.gz 包
POST /api/admin/skills                        # 上架(Git 源 URL + metadata)
DELETE /api/admin/skills/:name                # 下架
PUT  /api/admin/skills/:name                  # 更新
```

- 存储:`skills` 表(名称/版本/描述/作者/Git 源/校验和/上架时间)
- 打包:服务端 clone Git 源 → 校验 metadata.yaml → tar.gz → 缓存目录 `data/skills-cache/`
- 校验:包内文件名白名单(拒绝绝对路径/..),大小上限(默认 100MB)

### 4.4 MCP 插件商城

```
GET  /api/marketplace/mcp                     # 插件列表(客户端可见)
GET  /api/marketplace/mcp/:id/config          # 配置+凭证(加密传输)
POST /api/admin/mcp                           # 上架(transport/command/args/url/env/headers)
```

- 复用概念:`mcp_servers` + `mcp_server_grants`(表结构参考旧库,全新实现)
- 凭证:env 内敏感值 AES-GCM 加密;`/config` 仅在持有有效 token 时下发并解密

### 4.5 知识库(全新实现)

#### 4.5.1 存储与检索

- 文档/文件夹/标签/权限/审计:SQLite(表结构参考旧 knowledge 域,全新实现)
- 全文检索:**SQLite FTS5**(中文用 `tokenize='unicode61'` 或 trigram;中文分词可选 jieba 扩展,实施期评估)
- 向量检索(二期可选):纯 Go 嵌入模型(m3e/bge-small 经 ONNX)或调用服务端网关 embedding API
- 上传:管理页/API 导入(txt/md/docx/pdf → 文本抽取)

#### 4.5.2 远程 MCP 暴露

```
POST /api/mcp/knowledge/message    # JSON-RPC 请求/响应(一期)
GET  /api/mcp/knowledge/sse        # SSE(二期,若需流式)
```

工具集:`kb_search(query, scope, page)`、`kb_read(doc_id)`、`kb_list(folder_id)` 等
权限:按用户 + 文件夹授权(参考旧 KBFolderUser/KBFolderGroup,全新实现)

### 4.6 服务端 SQLite 总表

```
users / groups / user_groups / settings(展平 KV)
api_tokens / usage
skills / mcp_servers / mcp_server_grants
kb_folders / kb_documents / kb_tags / kb_document_tags / kb_permissions / kb_audit_logs
```

迁移:版本化迁移(参考旧 store/migrations 模式,全新实现),`schema_migrations` 表记录版本。

### 4.7 极简 Web 管理页

独立小 React 应用(`webadmin/`),打包后由服务端静态服务:

| 页面 | 功能 |
|------|------|
| 登录 | 超管账号(session cookie) |
| 用户/组 | 增删改查、绑定 LDAP 组 |
| 网关 | 上游 key 配置(加密)、模型列表管理 |
| 用量 | usage 聚合图表(按日/用户/模型) |
| Skill 商城管理 | 上架/下架/更新 |
| MCP 商城管理 | 插件上架/下架/授权 |
| 知识库 | 上传/删除文档、文件夹权限 |

---

## 5. 安全设计

| 面 | 措施 |
|----|------|
| 密码 | argon2id(本地账号) |
| token | 只存 SHA-256 hash;支持吊销;过期策略(默认 90 天) |
| 上游密钥/插件凭证 | AES-GCM 加密落库;HTTPS 传输;管理页掩码 |
| 客户端 token | config.json 权限 0600;进程内持有 |
| 高危操作 | 删除/外发/剪贴板读取 → UI 确认弹窗(60s 超时拒绝) |
| 文件越界 | 可访问目录白名单(默认工作目录) |
| Skill 包安全 | 文件名白名单、大小上限、第三方来源风险提示 |
| 登录爆破 | 10 次/5 分钟限流 |
| 管理端 | 超管 + session cookie + CSRF(HMAC,按小时滚动) |
| 传输 | 全链路 TLS(服务端可选自签证书,客户端首次连接校验指纹) |

---

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| 服务端不可达 | 客户端离线态,可浏览历史;新任务提示需联网;自动重连 |
| 上游 LLM 失败 | 网关 502 + 错误体;客户端重试 1 次,失败展示错误 |
| 工具超时 | command 默认 60s;超时结果回传 Agent |
| Agent 死循环 | MaxIter 默认 20;超限提示"继续/停止" |
| 高危确认超时 | 默认拒绝 |
| MCP 插件崩溃 | 自动重启 1 次,再失败停用并提示 |
| 磁盘不足 | 产物写入失败 → UI 提示,不崩溃 |
| 会话删除 | 级联删 messages/artifacts,产物目录可选删除 |
| 服务端重启 | usage 落库不丢;token 有效期内不受影响 |

---

## 7. 测试策略

| 层 | 内容 | 工具 |
|----|------|------|
| 服务端单元 | 认证/token/网关转发/计量/商城 API/知识库检索 | Go testing + httptest |
| 服务端集成 | 登录→拉技能→拉 MCP 配置→知识库查询全链路 | Go integration tests |
| 客户端单元 | localstore/工具/会话/MCP runner/skill loader | Go testing |
| 客户端集成 | 引擎 + mock Provider 的完整 Craft 流 | Go testing + ADK mock model |
| UI 单测 | 组件渲染/状态(少量) | Vitest + Testing Library |
| E2E(阶段 4) | 打包后冒烟:登录→对话→工具→产物 | Playwright(WebView) |

每个非平凡逻辑模块必须带至少一个可运行测试(`_test.go`),CI 跑 `make check`。

---

## 8. 实施阶段(共 4 阶段)

### 阶段 1 — 服务端网关(约 2-3 周)

1. 仓库骨架:go.mod、Makefile、目录、CI
2. serverstore:迁移框架 + users/groups/settings/tokens/usage 表
3. serverauth:local + LDAP + OIDC + token 颁发/校验
4. llmgateway:OpenAI 兼容代理(openai 系直通)+ 计量 + 模型列表
5. marketplace:skill 打包下载 + mcp 配置分发
6. knowledge:存储 + FTS5 检索 + 远程 MCP(请求/响应式)
7. webadmin:登录/用户/用量/商城管理

**验收**:curl 全链路:登录拿 token → 网关流式对话 → 拉技能包 → 拉 MCP 配置 → 知识库查询,全部通过;`make test` 绿。

### 阶段 2 — 客户端骨架(约 2-3 周)

1. Wails 项目 + React 脚手架 + 登录页
2. localstore:会话/设置表 + 迁移
3. agent 引擎:ADK 接入 + gateway provider + Ask 模式
4. React 聊天 UI:消息流、打字机、会话列表
5. gateway 客户端:登录/token 持久化/离线检测

**验收**:桌面端登录服务端,Ask 模式完成对话,会话持久化,重启恢复。

### 阶段 3 — 本地能力(约 3-4 周)

1. localtools:文件/终端/web/屏幕/OCR/剪贴板
2. Craft 模式全流程 + 产物面板 + 高危确认弹窗
3. Plan 模式
4. localskill:下载/注入/执行
5. localmcp:stdio + http 插件运行
6. 可访问目录设置页

**验收**:"汇总桌面 Word 成 500 字汇报存回桌面"完整跑通;安装调用一个小红书类 MCP 插件成功;高危删除有确认弹窗。

### 阶段 4 — 产品化(约 2-3 周)

1. 三平台打包(NSIS / dmg / deb+AppImage)
2. webadmin 用量/管理完善
3. 文档全套(docs/)
4. 性能优化:OCR 惰性加载、流式渲染节流、SQLite WAL 检查点
5. E2E 冒烟测试

**验收**:全新机器下载→安装→登录→完成真实办公任务;`make build` 一键出三平台包。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| ADK v2 本地化会话接口适配成本 | 高 | 阶段 2 先做最小 session.Service;参考旧项目 adk_run.go 既有用法 |
| 三平台本地工具差异(路径/OCR/权限) | 中 | 工具层 platform 抽象;CI 三平台构建;阶段 3 逐平台验证 |
| OCR 引擎 Go 生态选择困难 | 中 | 备选:gosseract(Tesseract 依赖)或 onnxruntime;降级:先仅截图+肉眼 |
| 全新重写周期长 | 高 | 严格按阶段验收推进;每阶段可独立发布验证 |
| 中文全文检索效果 | 中 | FTS5 trigram 兜底;二期接入分词/向量 |
| WebView 三平台渲染差异 | 中 | 标准 React 组件库约束;避免过度动画 |
| 服务端被内部滥用 | 中 | 限流 + 计量 + 管理页监控 |

---

## 10. 开放问题(实施中决策)

1. OCR 具体引擎(gosseract vs onnxruntime)
2. 知识库向量检索是否二期引入
3. anthropic 上游转换一期还是二期
4. React 组件库(自研 vs shadcn 风格)
5. 客户端 SQLite 是否加密(SQLCipher 评估)
6. 服务端部署形态(Docker 镜像)

---

## 11. 文档计划

| 文档 | 时机 |
|------|------|
| docs/01-architecture.md | 阶段 1 初 |
| docs/02-build-deploy.md | 阶段 4 |
| docs/03-api-reference.md | 阶段 1 末 |
| docs/04-auth.md | 阶段 1 末 |
| docs/05-agent-system.md | 阶段 2 末 |
| docs/06-database.md | 阶段 1 末 |
| docs/07-marketplace.md | 阶段 1 末 |
| docs/08-development.md | 阶段 2 初 |
