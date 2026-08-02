# API 参考(服务端 HTTP)

> 所有端点以代码为准(`internal/**/routes.go`、`cmd/server/main.go`)。错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`。

## 1. 错误码

| code | HTTP | 说明 |
|------|------|------|
| `AUTH_REQUIRED` | 401 | 缺少认证令牌 |
| `AUTH_FAILED` | 401 | 令牌无效或已过期 / 凭证错误 |
| `FORBIDDEN` | 403 | 管理端权限不足 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION` | 400 | 参数校验失败 |
| `UPSTREAM` | 502 | 上游 LLM 错误 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `INTERNAL` | 500 | 内部错误 |

## 2. 鉴权方式

| 方式 | 说明 |
|------|------|
| **Bearer token** | `Authorization: Bearer <api_token>`;`POST /api/auth/login` 签发,90 天过期,哈希存储 |
| **管理端 session** | Cookie `picoaide_session`(HttpOnly, SameSite=Lax, 24h);写操作需 header `X-CSRF-Token`(登录响应返回) |

## 3. 认证

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 无 | 密码登录(local/LDAP);body `{server_url?, username, password}` → `{token}` |
| POST | `/api/auth/logout` | Bearer | 吊销当前 token |
| GET | `/api/auth/me` | Bearer | 当前用户 `{id, username, display_name, email, is_admin, source}` |
| GET | `/api/auth/oidc/login` | 无 | 跳转 OIDC 授权页(配置后启用) |
| GET | `/api/auth/oidc/callback` | 无 | OIDC 回调,换取服务端 token |

## 4. 管理端(webadmin,全部 session 鉴权)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 管理员登录(仅 `is_admin=1` 用户;非管理员 → 403) |
| GET | `/api/admin/me` | 当前管理员信息 |
| POST | `/api/admin/logout` | 登出(清 session) |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users` | 创建用户 `{username, password?, display_name?, email?, is_admin?, source?}` |
| PUT | `/api/admin/users/:id` | 更新用户(改密/管理员/启用停用) |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/usage` | 用量汇总(按用户/模型/时间) |
| GET | `/api/admin/providers` | 网关上游列表 |
| POST | `/api/admin/providers` | 添加上游 `{name, base_url, api_key, models, enabled}`(api_key 服务端加密存储) |
| PUT | `/api/admin/providers/:id` | 更新上游 |
| DELETE | `/api/admin/providers/:id` | 删除上游 |
| GET | `/api/admin/models` | 模型列表 |
| POST | `/api/admin/models` | 创建模型 `{name, provider_id, display_name?, default_params?}` |
| PUT | `/api/admin/models/:id` | 更新模型 |
| DELETE | `/api/admin/models/:id` | 删除模型 |
| GET | `/api/admin/gateway` | 网关配置:`{rate_limit, default_model, allow_private, search_endpoint}` |
| PUT | `/api/admin/gateway` | 写网关配置(settings:`gateway.rate_limit`、`gateway.default_model`、`web.allow_private`、`web.search_endpoint`) |

## 5. AI 网关(客户端用,Bearer)

### POST `/v1/chat/completions`

OpenAI 兼容请求体 `{model, messages, stream?, ...}`。服务端按模型匹配上游 provider 代理转发;非流式/流式(SSE)均支持;响应按 per-user 令牌桶限流(`gateway.rate_limit`,默认 60/min),计量写入 usage 表。

### GET `/v1/models`

`[{id, display_name, ...}]` 可用模型列表(仅 enabled provider 的模型)。

## 6. 商城(客户端用,Bearer)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/marketplace/skills` | 技能建议清单 `[{name, version, description, author}]` |
| GET | `/api/marketplace/skills/:name` | 单个技能详情 |
| GET | `/api/marketplace/skills/:name/archive` | 下载技能包 `cacheDir/<name>-<version>.tar.gz` |
| GET | `/api/marketplace/mcp` | MCP 插件建议清单 |
| GET | `/api/marketplace/mcp/:id/config` | 拉取插件配置(含解密后的凭证;per-user 限流 30/小时,记录审计) |

## 7. 商城管理端(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/admin/skills` | 列表/上架技能(`{name, version, description, author, git_url, git_ref}`) |
| PUT/DELETE | `/api/admin/skills/:name` | 更新/下架(置 enabled=0,不删行) |
| GET/POST | `/api/admin/mcp` | 列表/配置 MCP 插件(`{name, transport, command, args, url, env, headers, enabled}`;env 敏感值 AES-GCM 加密) |
| PUT/DELETE | `/api/admin/mcp/:id` | 更新/删除 |
| GET | `/api/admin/mcp-downloads` | 凭证拉取审计记录 |

## 8. 知识库管理端(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/kb/upload` | 上传文档 `{title, content, folder_id?, content_type?}`(写入 FTS5 索引) |
| POST | `/api/admin/kb/folders` | 创建文件夹 |
| GET | `/api/admin/kb/folders` | 文件夹树 |
| GET | `/api/admin/kb/documents` | 文档列表 |
| DELETE | `/api/admin/kb/documents/:id` | 删除文档 |
| PUT | `/api/admin/kb/folders/:id/grant` | 文件夹授权(按用户名/组) |
| GET | `/api/admin/kb/search` | 搜索(FTS5 前缀查询 `词*` + LIKE 兜底) |

## 9. 知识库远程 MCP(Bearer)

### POST `/api/mcp/knowledge/message`

JSON-RPC 2.0 信封,`Content-Type: application/json`。方法:

| 方法 | 参数 | 说明 |
|------|------|------|
| `tools/list` | - | 返回工具清单(kb_search / kb_read / kb_list / kb_upload) |
| `tools/call` | `{name, arguments}` | 调用工具;权限校验:kb_read 校验文档所属 folder 可访问,kb_upload 校验目标 folder 授权,search 仅返回可访问 folder 内结果 |

响应信封 `{jsonrpc, id, result: {content: [{type, text}], isError}}` 或 `{jsonrpc, id, error: {code, message}}`;错误码 `-32700` 解析错误、`-32601` 方法不存在、`-32602` 参数无效。

## 10. Bootstrap

### GET `/api/config/bootstrap`(Bearer)

登录后统一下发启动配置,字段固定:

```json
{
  "default_model": "deepseek-chat",
  "models": [{ "id": "deepseek-chat", "display_name": "DeepSeek Chat" }],
  "skills": [{ "name": "invoice-helper", "version": "1.0.0", "description": "..." }],
  "mcp": [{ "id": 1, "name": "xiaohongshu", "description": "...", "transport": "stdio" }],
  "web": { "allow_private": false, "search_endpoint": "" }
}
```

客户端 `BootstrapConfig` 与之严格对齐;`default_model` 不在启用模型时自动回退到第一个可用模型。

## 11. 其他

| 路径 | 说明 |
|------|------|
| `/admin/` | webadmin SPA(未构建返回 "webadmin 未构建") |
| 其他 | 404 "not found" |

## 12. 客户端 IPC(renderer ↔ main)

| 通道 | 方向 | 说明 |
|------|------|------|
| `auth:login` / `auth:loadSession` / `auth:logout` / `auth:refreshBootstrap` / `auth:oidcLogin` | invoke | 会话管理 |
| `chat:new` / `chat:ask` / `chat:continue` / `chat:approvePlan` / `chat:cancel` / `chat:list` / `chat:listRunning` / `chat:messages` / `chat:artifacts` / `chat:delete` | invoke | 对话生命周期 |
| `agent:confirm` | invoke | 审批回执 `{requestId, ok}` |
| `agent:event` | 事件 | 引擎事件流(见 01-architecture.md §4) |
| `artifact:showInFolder` | invoke | 在系统文件管理器中显示产物 |
| `picoaide:version` / `picoaide:rendererReady` | invoke | 版本/就绪握手 |
| `workspace:setAllowedDirs` 等 | invoke | 设置页:可访问目录(安全边界)+ 建议安装管理 + 刷新 |

## 13. 浏览器插件桥(CDP,JSON-RPC over WebSocket)

固定 `ws://127.0.0.1:54321`,方法:`browser.tabInfo` / `getContent` / `click` / `type` / `navigate` / `scroll` / `executeScript`。无 method 的消息 = 插件回执,原样透传给请求方;未知方法返回 `-32601`。
