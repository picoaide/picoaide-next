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
| D5 | 客户端技术栈 | Go + Wails + React | Go 复用 ADK 生态;Wails 提供 WebView;React 做聊天类 UI 生态最丰富 |
| D6 | Agent 引擎 | 继续用 google.golang.org/adk/v2(外部库) | 成熟 LLM Agent 运行时,自家代码重写不重造引擎 |
| D7 | 服务端技术栈 | Go | 与客户端同语言同生态,一套工具链 |
| D8 | 平台 | Windows / macOS / Linux 三平台并行 | Wails 原生跨平台 |
| D9 | 认证 | LDAP / OIDC / 本地账号(保留企业集成) | 私有化部署刚需 |
| D10 | LLM 调用路径 | 全走服务端 AI 网关代理 | 密钥不出服务端,按用户计量 |
| D11 | MCP 工具运行位置 | 客户端本地运行(商城下发配置/凭证) | 工具需要本地环境(如小红书插件本地 HTTP 服务) |
| D12 | Skill 形态 | 混合型(指令 + 可执行包) | 简单技能用指令,复杂技能带脚本 |
| D13 | 知识库 | 服务端全新实现,客户端经远程 MCP 查询 | 数据集中服务端,跨设备一致 |
| D14 | 会话/记忆存储 | 客户端本地 SQLite | 离线可用,敏感数据不出本机 |
| D15 | 本地安全沙箱 | 不做 OS 级沙箱,只做高危操作确认弹窗 | 用户自有电脑运行,风险自担;防手滑不防恶意 |
| D16 | 服务端管理 | 极简 Web 管理页 | 用户管理/商城上架/用量统计需要界面 |
| D17 | 前端框架 | React(不用 Vue) | 用户决策:AI 聊天组件/流式渲染生态 React 最丰富 |
| D18 | 仓库名 | picoaide-next | 与旧仓库 picoaide 区分 |

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
┌─────────────── 桌面客户端 picoaide-desktop (Wails: Go + WebView) ─────────────┐
│                                                                              │
│  React UI (全新写)                                                           │
│  ├─ 登录页:服务器 URL/端口 + 用户名/密码                                     │
│  ├─ 主界面:会话列表 + 聊天区 + 右侧产物/可视化面板 + 底部状态栏               │
│  ├─ 交互模式:Ask(聊天) / Plan(先计划后执行) / Craft(Agent 执行)              │
│  └─ 设置页:模型选择、工作目录、可访问目录、MCP 插件管理、技能管理、离线状态    │
│                                                                              │
│  Go 后端 (Wails bindings + 本地 HTTP)                                        │
│  ├─ Agent 引擎:包装 google.golang.org/adk/v2(llmagent + runner)              │
│  ├─ 本地工具:文件 / 终端 / 浏览器 / 屏幕截图 / OCR / 剪贴板                    │
│  ├─ 本地 MCP 运行时:从商城安装,本地 spawn(stdio)或直连(http)                 │
│  ├─ Skill 运行时:从商城下载,指令注入系统提示 + scripts 本地执行               │
│  ├─ 会话/记忆:本地 SQLite(WAL 模式)                                          │
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
| 桌面壳 | Wails v2 | 最新稳定 |
| 后端语言 | Go | 1.24+ |
| Agent 引擎 | google.golang.org/adk/v2 | 最新(参考旧 go.mod) |
| 本地数据库 | modernc.org/sqlite(纯 Go)或 mattn/go-sqlite3(CGO) | 优先 modernc 免 CGO |
| 前端 | React 18 + TypeScript + Vite | 最新 |
| 前端 UI | 自研轻量组件(不引重型组件库)或 shadcn 风格 | 实施期定 |
| 流式渲染 | @ai-sdk/react 或手写 fetch + SSE 解析 | 实施期定 |
| 截图 | github.com/kbinani/screenshot | 三平台 |
| OCR | gosseract(Tesseract)或 onnxruntime Go binding | 实施期评估,惰性加载 |
| 剪贴板 | github.com/atotto/clipboard | 三平台 |
| 浏览器控制 | 一期:web_fetch/web_search(HTTP);二期:Playwright CDP | 实施期定 |

### 3.2 目录结构(仓库全景)

```
picoaide-next/
├── go.mod                        # 单 module:github.com/picoaide/picoaide
├── Makefile                      # 构建/测试/打包
├── cmd/
│   ├── server/main.go            # 服务端网关入口
│   └── desktop/main.go           # Wails 客户端入口
├── internal/
│   ├── agent/                    # Agent 引擎:ADK 包装、Provider、事件流
│   │   ├── engine.go             # AgentEngine:包装 llmagent+runner
│   │   ├── provider.go           # Provider 工厂(指向本地/网关)
│   │   ├── session_sqlite.go     # ADK session.Service → SQLite 实现
│   │   ├── tools_local.go        # 本地工具注册表
│   │   ├── events.go             # 流式事件模型(UI 协议)
│   │   └── modes.go              # Ask / Plan / Craft 三模式
│   ├── localtools/               # 本地工具实现
│   │   ├── filesystem.go         # 文件读/写/编辑/追加/删除/列表/搜索
│   │   ├── terminal.go           # 命令执行(超时/输出截断/工作目录)
│   │   ├── web.go                # web_fetch / web_search
│   │   ├── screen.go             # 屏幕截图
│   │   ├── ocr.go                # 截图 OCR(惰性加载)
│   │   └── clipboard.go          # 剪贴板读写
│   ├── localmcp/                 # 本地 MCP 插件运行时
│   │   ├── installer.go          # 从商城拉取安装
│   │   ├── runner_stdio.go       # stdio server 进程管理(JSON-RPC)
│   │   ├── runner_http.go        # http server 直连客户端
│   │   └── adk_toolset.go        # MCP client → ADK toolset 适配
│   ├── localskill/               # Skill 运行时
│   │   ├── loader.go             # SKILL.md + metadata.yaml + scripts 加载
│   │   ├── installer.go          # 商城下载/更新/卸载
│   │   └── inject.go             # 系统提示词注入
│   ├── gateway/                  # 服务端连接器(客户端侧)
│   │   ├── client.go             # AI 网关 OpenAI 兼容客户端(SSE)
│   │   ├── auth.go               # 登录、token 存取、刷新
│   │   ├── remote_mcp.go         # 服务端远程 MCP 客户端(知识库等)
│   │   └── marketplace.go        # 商城 API 客户端
│   ├── localstore/               # 本地 SQLite(会话/记忆/设置/缓存)
│   │   ├── db.go                 # 打开/迁移(WAL)
│   │   ├── conversations.go
│   │   ├── messages.go
│   │   ├── artifacts.go
│   │   ├── memories.go
│   │   └── settings.go
│   ├── serverauth/               # 服务端认证(全新实现)
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
├── ui/                           # React 客户端 UI
│   ├── src/
│   │   ├── App.tsx / main.tsx
│   │   ├── api/                  # Wails bindings 封装 + SSE 客户端
│   │   ├── components/           # ChatInput/Messages/ToolCalls/Artifacts/Modal
│   │   ├── pages/                # Login/Main/Settings
│   │   ├── stores/               # Zustand:会话/设置/连接状态
│   │   └── styles/
│   ├── package.json / vite.config.ts / tsconfig.json
│   └── wails.json                # Wails 配置(前端指向 ui/)
├── webadmin/                     # 服务端管理页(独立小 React 应用或复用 ui 组件)
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

#### 3.3.1 引擎封装

```go
// internal/agent/engine.go
type AgentEngine struct {
    cfg        *AgentConfig        // 模型/工作目录/工具开关
    registry   *ToolRegistry       // 本地工具
    mcpTools   []tool.Toolset      // 本地 MCP 插件 + 远程 MCP
    sessionSvc session.Service     // SQLite 会话
    provider   Provider            // 指向服务端网关
}

func NewAgentEngine(cfg *AgentConfig) (*AgentEngine, error)
func (e *AgentEngine) Run(ctx context.Context, conversationID int64, msg *agent.Message,
    mode Mode, cb func(Event)) error   // Ask/Plan/Craft 共用
func (e *AgentEngine) Cancel() error
```

基于 ADK v2 的 `llmagent` + `runner` 模式(参考旧 `internal/agent/adk_run.go` 的既有用法,重新实现):

```go
// 伪代码骨架
func (e *AgentEngine) runOnce(ctx, msg, sysPrompt, history) {
    llm := llmagent.New(agent.Model{ID: cfg.Model.ModelID, Provider: e.provider})
    llm.Tools = append(e.registry.AsADKToolset(), e.mcpTools...)
    r := runner.New(llm, runner.SessionService(e.sessionSvc), runner.MaxIter(cfg.MaxIter))
    events := r.Run(ctx, session.New("picoaide", cfg.UserID, convID), msg)
    for ev := range events {
        e.cb(mapADKEvent(ev))      // 转成 UI 事件流
    }
}
```

#### 3.3.2 Provider(LLM 通道)

```go
// internal/agent/provider.go — 全新实现,参考旧 provider_adapter.go 的设计
type Provider interface {
    StreamChat(ctx context.Context, req *ChatRequest, cb func(StreamEvent)) error
}

// NewGatewayProvider:OpenAI 协议客户端,指向服务端 AI 网关
func NewGatewayProvider(gatewayURL, token, modelID string) Provider

// 本地无直连模式:客户端一律经网关,不持有任何上游密钥
```

#### 3.3.3 事件流(UI 协议)

```go
type Event struct {
    Type string          // "text_delta" | "reasoning_delta" | "tool_start" |
                         // "tool_end" | "tool_error" | "artifact" | "confirm_required" |
                         // "done" | "error"
    Data json.RawMessage
}
```

React UI 通过 Wails binding 订阅(或本地 SSE),打字机渲染 `text_delta`,工具卡片渲染 `tool_start/end`。

#### 3.3.4 三模式

| 模式 | 行为 | 实现 |
|------|------|------|
| Ask | 纯聊天,不调工具 | 请求带 `DisableTools: true`,不注册工具集 |
| Plan | 第一轮禁用工具输出计划 → 用户确认 → 转 Craft | 同一会话,第二轮启用工具 |
| Craft | 完整 Agent 循环 | 默认全量 |

### 3.4 本地工具

| 工具名 | 能力 | 安全约束 |
|--------|------|----------|
| file_read | 读取文本文件(编码自动检测:UTF-8/GBK/Big5) | 可访问目录内 |
| file_write / file_edit / file_append | 写/编辑/追加 | 可访问目录内 |
| file_delete | 删除文件 | **高危:弹窗确认** |
| file_list / file_search | 列目录/搜索 | 可访问目录内 |
| command_exec | 执行命令(60s 默认超时,输出截断 50KB) | 工作目录内;需确认的命令模式(rm -rf 等)弹窗 |
| web_fetch / web_search | HTTP 抓取/搜索 | 无外发敏感数据 |
| screen_capture | 屏幕截图 → base64 | 无 |
| screen_ocr | 对截图 OCR | 惰性加载模型 |
| clipboard_read / write | 剪贴板 | 读剪贴板属敏感,**读取前弹窗确认** |

**可访问目录模型**:默认 = 用户工作目录(每次对话独立子目录 `workspaces/<conv>/`),用户在设置中可追加"可访问目录"列表。工具越界返回明确错误给 Agent 重试。

**高危操作确认协议**:

```
Agent 发起高危工具 → 引擎发出 Event{Type:"confirm_required", Data:{op, target, reason}}
→ UI 弹窗(显示操作内容 + 目标路径)→ 用户选择
→ 客户端调 engine.Confirm(convID, ok) → 继续/拒绝
→ 确认操作默认 60s 超时,超时按拒绝处理
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
- MCP client → ADK toolset 适配层(`AsADKToolset`),工具暴露给 Agent
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

- 加载:SKILL.md → 注入系统提示;scripts → 注册为 `skill_exec <name>` 工具(command 子进程,沙盒无,仅超时+输出截断)
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
