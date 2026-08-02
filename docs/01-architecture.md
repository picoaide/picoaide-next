# PicoAide-Next 系统架构

> 企业内网桌面 AI 办公智能体。本文描述系统的总体架构、进程模型、数据流与安全设计,与 `AGENTS.md` 保持一致;端点/表名以实际代码为准。

## 1. 总体形态

```
┌─────────────────────────── Electron 桌面客户端 ───────────────────────────┐
│ renderer(React 18 + shadcn/ui + Zustand)                                  │
│   │ contextBridge(preload 白名单 API)                                     │
│ main(Node + better-sqlite3)                                               │
│   ├─ Agent 引擎:AI SDK v7 streamText 多步循环 + 审批门控(60s)             │
│   ├─ 本地工具:文件/终端/沙盒/web/屏幕/OCR/剪贴板                           │
│   ├─ 浏览器插件桥:CDP 服务 127.0.0.1:54321(Chrome/Edge 插件直连)         │
│   ├─ 本地 MCP 运行时(stdio/http)+ Skill 运行时                            │
│   ├─ 本地 SQLite:conversations / messages / artifacts / settings          │
│   └─ 服务端连接器:登录/健康/bootstrap/商城/远程MCP/TLS                     │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ HTTPS + Bearer token
┌──────────────▼────────────────────────────────────────────────────────────┐
│ Go 服务端(gin + modernc.org/sqlite)                                       │
│   ├─ 认证:local/LDAP/OIDC + api_tokens(90 天过期,哈希存储)                │
│   ├─ AI 网关:/v1/chat/completions 代理 + per-user 限流 + usage 计量        │
│   ├─ 商城:skills(建议清单)+ mcp_servers(凭证 AES-GCM,拉取限流+审计)       │
│   ├─ 知识库:FTS5 前缀查询 + 远程 MCP(kb_search/read/list/upload)          │
│   └─ 管理页 webadmin(/admin/,shadcn):用户/网关/用量/商城/知识库            │
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程模型(三进程)

| 进程 | 职责 |
|------|------|
| **renderer** | React 界面:登录/主界面(对话+工具状态+审批弹窗)/设置(仅可访问目录+建议安装+刷新)。不直接接触 Agent 引擎与本地资源,全部经 preload 白名单 API。 |
| **main** | 承载完整 Agent 引擎:AI SDK 多步循环、审批门控、工具执行、本地 SQLite、CDP 桥服务、MCP/Skill 运行时、服务端连接器。所有本地能力(文件/终端/沙盒/屏幕/浏览器)只在 main 进程。 |
| **服务端 Go** | 认证、网关代理、商城、知识库、管理页静态资源。密钥只存在服务端,客户端只持登录 token。 |

renderer ↔ main 通信走 IPC(`ipcMain.handle` + `contextBridge`),事件通道 `agent:event` 推送 Agent 事件。

## 3. 端到端数据流

### 3.1 登录 → bootstrap

1. 用户在登录页输入服务端地址(仅 HTTPS 远程地址)+ 用户名/密码(OIDC 模式可走浏览器流程)。
2. `main` 调 `POST /api/auth/login` 取 `api_token`(90 天),存会话缓存(本地文件,进程内解密)。
3. 登录成功 → `GET /api/config/bootstrap` 拉取启动配置:`default_model`、`models`、`skills`(建议清单)、`mcp`(建议清单)、`web`(allow_private / search_endpoint)。
4. bootstrap 缓存供工具注册使用;设置页可"刷新"重新拉取。

### 3.2 对话 → 工具 → 产物

1. 用户在输入框提交(ask 模式)→ `chat:ask` IPC → 引擎 `streamText` 多步循环。
2. 模型产出文本流与工具调用:`text_delta` / `reasoning_delta` 实时推送 renderer。
3. 工具调用前过**审批门控**(见 §6):高危操作发 `confirm_required`,用户确认后执行;白名单命令/普通文件操作直通。
4. `tool_start` / `tool_end`(含 `duration_ms`)/ `tool_error` 事件推送;产物写入本地磁盘并登记 artifacts 表,发 `artifact` 事件。
5. 循环直至模型不再调用工具,发 `done`;用户取消发 `canceled`。

### 3.3 浏览器操作(CDP 桥)

- 客户端 main 进程固定监听 `127.0.0.1:54321`(纯本地 WebSocket,不回环外暴露)。
- Chrome/Edge 插件(MV3)默认直连该端口,即装即用;无鉴权(零配置原则,见 §7 风险缓解)。
- 引擎侧 `browser_*` 工具经 `sendCdp` 走 JSON-RPC;插件回执原样透传。

### 3.4 技能与 MCP 插件

- 技能(Skill):安装后指令注入系统提示词(`## Skills` 段),为 Agent 提供领域知识/流程,无独立执行环境。
- MCP 插件:安装后启动本地运行时(stdio 或 http),`listTools` 注册为 AI SDK 工具,名称格式 `<plugin>_<tool>`;高危工具经启发式判定进审批门控。

## 4. 事件协议(main → renderer,`agent:event`)

| 事件 | 字段 | 说明 |
|------|------|------|
| `text_delta` | `data: string` | 文本增量 |
| `reasoning_delta` | `data: string` | 推理增量 |
| `tool_start` | `{id, name, input}` | 工具开始 |
| `tool_end` | `{id, name, output, duration_ms}` | 工具结束 |
| `tool_error` | `{id, name, error}` | 工具失败 |
| `confirm_required` | `{request_id, op, target, reason}` | 审批请求,60s 内回执 |
| `artifact` | `{path, type, size}` | 产物生成 |
| `done` | `{usage?: {prompt_tokens, completion_tokens}}` | 本轮完成 |
| `canceled` | `{reason}` | 被取消 |
| `error` | `data: string` | 引擎错误 |

回执:`agent:confirm {requestId, ok}`。

## 5. 三种模式

| 模式 | 行为 |
|------|------|
| **ask** | 单轮问答,无工具(首轮直接回答;后续轮次带工具多步执行)。 |
| **plan** | 首轮无工具出计划(plan)→ 用户确认(`approvePlan`)→ 第二轮带工具执行(截断到最后一条 user 消息重跑);`!ok` 拒绝。 |
| **craft** | 多步执行循环,带全部工具与高危标记,直至模型停止调用工具或达 maxSteps。 |

## 6. 审批门控(安全核心)

- **触发对象**:高危工具集 + 越界命令 + 越界路径(`allow_dir`)。
- **高危工具清单**(代码 `HIGH_RISK_TOOLS` 汇总):`file_delete`、`screen_capture`、`clipboard_read`、`kb_upload`、`browser_click/type/navigate/scroll/execute_js`,以及 MCP 插件工具启发式命中者(名称含 `delete/remove/exec/upload/clear/reset` 等动词,或描述词边界命中)。
- **命令审批**:`needsApprovalFor(command, allowedDirs)` 判定;白名单命令免审批,其余弹窗确认,展示串 = 执行串。
- **路径审批**:`isAllowed(absPath, allowedDirs)`;越界访问触发 `allow_dir` 审批,用户同意后将目录加入可访问目录。
- **队列**:确认请求串行排队,任一时刻最多一个 `confirm_required` 在等回执;取消/新确认/会话结束清理队列。
- **超时**:自 `confirm_required` 发出起 **60 秒**未回执自动拒绝(`DEFAULT_APPROVAL_TIMEOUT_MS = 60_000`)。
- **测试钩子**:`PICOAI_TEST_AUTO_APPROVE=1` 自动通过、`=0` 自动拒绝(不弹窗、不发事件);仅测试环境使用。
- **取消**:`cancel()` 置 `canceling` 标记,竞速消费 fullStream,确保取消立即生效。

## 7. 安全设计摘要

| 措施 | 说明 |
|------|------|
| 密钥不出服务端 | LLM 上游密钥 AES-GCM 加密存服务端(`enc:v1:`,master key 文件 `PICOAI_MASTER_KEY` 可覆盖),客户端只持 token |
| 凭证不落盘 | MCP 凭证仅内存/启动重拉,SQLite 不存明文 |
| 审批门控 | 高危操作必须人确认,不依赖任何 SDK 的审批 API |
| 本地沙盒 | Agent 生成脚本在 `@ai-sdk/sandbox-just-bash` 本地受限会话执行,无用户文件权限、数据不出本机(注意:沙盒内无 python3) |
| TOFU | 客户端所有 HTTP 走 `session.defaultSession.fetch`,TLS 证书 TOFU 校验;登录页拒绝非 HTTPS 远程地址 |
| CDP 仅回环 | 端口 127.0.0.1:54321,零配置;本机恶意进程与客户端同信任级(风险缓解见设计文档 §9) |
| 服务端限流 | 登录限流 + 网关 per-user 令牌桶(`gateway.rate_limit`,默认 60/min)+ 商城凭证拉取限流(30/h) |
| 审计 | mcp_config_downloads 拉取审计、kb_audit_logs 知识库操作审计、usage 计量 |

## 8. 目录结构(代码现状)

```
cmd/server/            # 服务端入口(--bootstrap-admin/-addr/-data)
internal/              # serverauth/llmgateway/marketplace/knowledge/serverstore/util/bootstrap/webadmin
desktop/
  src/main/            # index/ipc/cdp_server + agent/ + tools/ + mcp/ + skill/ + store/ + gateway/
  src/preload/         # contextBridge 白名单 API
  src/renderer/        # api/ + components/ + pages/(Login/Main/Settings) + stores/
  tests/               # E2E 预留(单测内嵌 src/**/*.test.ts)
browser-extension/     # Chrome MV3 插件(默认 ws://127.0.0.1:54321)
webadmin/              # 服务端管理页(Vite React + shadcn)
docs/                  # 本文档集
scripts/               # 打包脚本 + mock-upstream.go
```

> 注:OCR(tesseract.js)已实现但默认惰性加载;`python3` 在沙盒内不可用(沙盒仅提供 bash)。
