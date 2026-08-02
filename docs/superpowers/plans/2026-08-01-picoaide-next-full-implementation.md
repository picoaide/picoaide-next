# PicoAide-Next 全量实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全新重写 WorkBuddy 式桌面 AI 办公智能体:Electron+React+TS 桌面客户端(本地跑完整 Agent)+ Go 服务端纯网关(认证/AI 网关/双商城/知识库)。

**Architecture:** 客户端(Agent 引擎基于 Vercel AI SDK WorkflowAgent,本地工具 + 沙盒执行 + 本地 MCP/Skill 运行时 + better-sqlite3 会话,durable 可恢复)经 Bearer token 连服务端;服务端(AI 网关 OpenAI 兼容代理 + LDAP/OIDC/本地认证 + Skill/MCP 商城 + 知识库远程 MCP + 极简管理页)。零代码迁移,旧仓库 `/data/picoaide` 仅作参考。

**Tech Stack:** 服务端 Go 1.24+(gin、modernc.org/sqlite、argon2id、AES-GCM、FTS5);客户端 Electron + TypeScript + React 18 + Vite + Vercel AI SDK(`ai`、`@ai-sdk/openai-compatible`、`@ai-sdk/workflow`、`@ai-sdk/sandbox-vercel`)+ ai-elements + better-sqlite3 + @modelcontextprotocol/sdk + tesseract.js + Vitest。

**前置参考(只读,禁止复制):** `/data/picoaide/internal/agent/adk_run.go`(ADK 用法)、`/data/picoaide/internal/store/users.go`(argon2)、`/data/picoaide/internal/store/migrations/`(迁移命名)、`/data/picoaide/internal/authsource/`(认证注册表)、`/data/picoaide/internal/skill/`(技能解析)。

---

## 0. 总体执行框架(所有阶段通用)

### 0.1 仓库与约定

- 仓库:`/data/picoaide-next`,module 名 `github.com/picoaide/picoaide`
- 分支:开发在 `dev` 分支(自 `master` 切出),每任务完成后 commit 到 dev;阶段验收后合并 master
- 提交信息:`feat: / fix: / test: / docs: / chore:`,单行 ≤72 字符,如 `feat: add api token auth middleware`
- 每个任务结束必须 commit,不允许"多个任务一个 commit"

### 0.2 目录规约(与设计文档 §3.2 一致)

```
cmd/server/ internal/{serverauth,llmgateway,marketplace,knowledge,serverstore,util}(服务端 Go)
desktop/{src/{main,preload,renderer},tests}(Electron 客户端 TS)
webadmin/ docs/ scripts/ data/
```

### 0.3 Makefile 目标(任务 1.1 建立,全程维护)

| 目标 | 内容 |
|------|------|
| `make test` | `go test ./... -count=1`(服务端+客户端 Go 代码) |
| `make test-server` | `go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/knowledge/... ./internal/serverstore/... -count=1` |
| `make test-client` | `cd desktop && npm test && npm run typecheck`(客户端 Vitest) |
| `make ui` | `cd ui && npm run build` |
| `make webadmin` | `cd webadmin && npm run build` |
| `make build-server` | 编译 `bin/picoaide-server` |
| `make build-desktop` | `cd ui && npm run build && cd .. && wails build`(产出 `build/bin/`) |
| `make check` | format + lint(go vet)+ test |
| `make pkg-linux` / `pkg-windows` / `pkg-macos` | 阶段 4 打包 |

### 0.4 公共契约(先固化,所有实现对齐)

#### 0.4.1 REST 错误格式

所有非 2xx 响应体:

```json
{"error": {"code": "ERR_CODE", "message": "人类可读信息"}}
```

错误码约定:`AUTH_REQUIRED`(401)/ `AUTH_FAILED`(401)/ `FORBIDDEN`(403)/ `NOT_FOUND`(404)/ `VALIDATION`(400)/ `UPSTREAM`(502)/ `RATE_LIMITED`(429)/ `INTERNAL`(500)。

#### 0.4.2 认证头

- 客户端 API:`Authorization: Bearer <api_token>`
- 管理页:`Cookie: picoaide_session=<session_id>` + CSRF 头 `X-CSRF-Token`

#### 0.4.3 流式 LLM 事件(客户端 UI 协议)

Electron main 进程经 ipc(`agent:event`)发送给 renderer 的事件:

```json
{"type":"text_delta","data":"..."}
{"type":"reasoning_delta","data":"..."}
{"type":"tool_start","data":{"id":"...","name":"file_read","input":{...}}}
{"type":"tool_end","data":{"id":"...","name":"file_read","output":"...","duration_ms":120}}
{"type":"tool_error","data":{"id":"...","name":"...","error":"..."}}
{"type":"confirm_required","data":{"request_id":"...","op":"file_delete","target":"/home/u/x.doc","reason":"删除文件"}}
{"type":"artifact","data":{"path":"reports/2026-08-01.md","type":"file","size":1234}}
{"type":"done","data":{"usage":{"prompt_tokens":100,"completion_tokens":50}}}
{"type":"error","data":"错误信息"}
```

#### 0.4.4 工具 JSON Schema 约定

工具定义用 AI SDK `tool({ description, inputSchema: z.object({...}), execute })`(zod 模式,序列化后为 OpenAI function-calling schema,服务端网关原样转发)。注册在 `desktop/src/main/agent/engine.ts` 的工具注册表。

#### 0.4.5 里程碑判定

每个阶段末按"验收清单"逐条手工核对(见各阶段末 Task),全部通过才算完成;未通过则修复后重跑。

---

## 阶段 1:服务端网关(约 2-3 周)

**目标:** 可 curl 全链路验证的网关:登录 → token → AI 网关流式对话 → 拉技能包 → 拉 MCP 配置 → 知识库查询。管理页可用。

**顺序说明:** Task 1.1→1.2→1.3 是地基(串行);1.4→1.7 认证域(串行);1.8→1.10 网关域;1.11→1.13 商城域;1.14→1.15 知识库域;认证/网关/商城/知识库四域完成前互不依赖,可并行;1.16 管理页与 1.17 验收在全部之后。

---

### Task 1.1: 仓库骨架

**Files:**
- Create: `go.mod`, `Makefile`, `.gitignore`, `README.md`, `cmd/server/main.go`(最小 HTTP 服务), `internal/serverstore/db.go`(仅 Open + Ping), `internal/util/safe.go`

- [ ] **Step 1: 初始化 module 与目录**

Run: `cd /data/picoaide-next && go mod init github.com/picoaide/picoaide && mkdir -p cmd/server internal/{serverauth,llmgateway,marketplace,knowledge,serverstore,util} desktop/src/{main,preload,renderer} webadmin docs scripts data`
Expected: 目录创建成功,`go.mod` 第一行 `module github.com/picoaide/picoaide`

- [ ] **Step 2: 写最小 main + db 打开测试(红)**

Create: `cmd/server/main.go`(占位:监听 `:8080` 返回 200)、`internal/serverstore/db_test.go`(测试 `Open` 返回非 nil 且 Ping 成功;临时目录建库)
Run: `go test ./internal/serverstore/ -count=1`
Expected: FAIL(db.Open 未定义)

- [ ] **Step 3: 实现 db.Open**

Create: `internal/serverstore/db.go` — 签名 `func Open(path string) (*sql.DB, error)`,用 `modernc.org/sqlite` 驱动(`driverName="sqlite"`,`dsn="file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"`),带 `PRAGMA foreign_keys=ON` 验证
Run: `go test ./internal/serverstore/ -count=1`
Expected: PASS

- [ ] **Step 4: 写 Makefile + .gitignore + 目录 README**

Create: `Makefile`(§0.3 全部目标,先给 `test`/`build-server` 真实实现,其余占位 `@echo "not yet"`)、`.gitignore`(bin/ build/ node_modules/ dist/ data/ *.db)
Run: `make test && make build-server`
Expected: 测试通过,`bin/picoaide-server` 产出

- [ ] **Step 5: 写 util/safe.go 及测试**

Create: `internal/util/safe.go` — `SafePathSegment(s string) bool`(拒绝空、`/`、`\`、`..`、`.`)、`internal/util/safe_test.go`(表驱动:合法/非法样例)
Run: `go test ./internal/util/ -count=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: repo skeleton, Makefile, db open, safe path util"
```

---

### Task 1.2: 迁移框架 + 初始表

**Files:**
- Create: `internal/serverstore/migrate.go`, `internal/serverstore/migrations/0001_init.sql`, `internal/serverstore/migrate_test.go`

- [ ] **Step 1: 写迁移框架测试(红)**

测试要求:`ApplyMigrations(db)` 后 `schema_migrations` 表存在且 version=1;重复调用幂等;迁移失败时返回错误
Run: `go test ./internal/serverstore/ -run TestApplyMigrations -count=1`
Expected: FAIL(ApplyMigrations 未定义)

- [ ] **Step 2: 实现迁移框架**

`migrate.go`:嵌入式 SQL 文件列表(按文件名序),`schema_migrations(version INTEGER PRIMARY KEY, applied_at)`;每个迁移在一个事务内执行并记录版本;失败回滚该迁移
Create: `internal/serverstore/migrations/0001_init.sql`:
- `users(id INTEGER PK AUTOINCREMENT, username TEXT UNIQUE NOT NULL, display_name TEXT, email TEXT, password_hash TEXT, source TEXT NOT NULL DEFAULT 'local', is_admin INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, created_at, updated_at)`
- `groups(id, name UNIQUE, created_at)`、`user_groups(user_id, group_id, PRIMARY KEY(user_id,group_id))`
- `settings(key TEXT PK, value TEXT)`
Run: `go test ./internal/serverstore/ -run TestApplyMigrations -count=1`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: versioned migration framework with initial schema"
```

---

### Task 1.3: 用户/设置数据访问层

**Files:**
- Create: `internal/serverstore/users.go`, `internal/serverstore/users_test.go`, `internal/serverstore/settings.go`, `internal/serverstore/settings_test.go`

- [ ] **Step 1: 写测试(红)**

- `users_test.go`:`CreateUser`(username 冲突报错)、`GetUserByUsername`、`UpdateUser`(改 display_name/status)、`ListUsers`(分页)
- `settings_test.go`:`SetSetting/GetSetting`、`GetAllSettings`(展平 KV map)、覆盖写
Run: `go test ./internal/serverstore/ -run 'TestUsers|TestSettings' -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`users.go`:结构体 `User{ID, Username, DisplayName, Email, PasswordHash, Source, IsAdmin, Status, CreatedAt, UpdatedAt}`,方法签名:`CreateUser(db, *User) (int64, error)`(SQLite `INSERT`+`LastInsertId`,唯一冲突返回 `ErrDuplicate`)、`GetUserByUsername(db, username) (*User, error)`(not found 返回 `ErrNotFound`)、`UpdateUser(db, *User) error`、`ListUsers(db, offset, limit) ([]User, int64, error)`
`settings.go`:`SetSetting(db, key, value)`(UPSERT)、`GetSetting(db, key) (string, bool, error)`、`GetAllSettings(db) (map[string]string, error)`
错误变量集中在 `internal/serverstore/errors.go`:`ErrNotFound`/`ErrDuplicate`(用 `errors.Is` 判断)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: users and settings data access layer"
```

---

### Task 1.4: 密码哈希 + 本地认证

**Files:**
- Create: `internal/util/password.go`, `internal/util/password_test.go`
- Modify: `internal/serverstore/users.go`(加 `AuthenticateLocal`), `internal/serverstore/users_test.go`

- [ ] **Step 1: 写测试(红)**

- `password_test.go`:`HashPassword(pw)` 与 `VerifyPassword(hash, pw)` 往返成功;错误密码失败;hash 含 argon2id 前缀 `$argon2id$`;两次 Hash 不同 salt
- `users_test.go` 增:`CreateUser` 传入明文密码时自动 hash(`CreateUserWithPassword(db, username, password)`),`AuthenticateLocal(db, username, password) (User, error)` 正确/错误密码两分支
Run: `go test ./internal/util/ ./internal/serverstore/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`password.go`:`HashPassword(pw string) (string, error)`、`VerifyPassword(hash, pw string) bool`,参数沿用旧项目设计:memory 64MB、iterations 3、parallelism 2、keyLen 32、salt 16 字节随机;输出格式 `$argon2id$v=19$m=65536,t=3,p=2$<salt_b64>$<hash_b64>`
`users.go`:新增 `CreateUserWithPassword`(内部调 `HashPassword`)与 `AuthenticateLocal`(查用户 → `VerifyPassword` → 校验 status=1)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: argon2id password hashing and local auth"
```

---

### Task 1.5: Token 认证 + 登录/登出 API

**Files:**
- Create: `internal/serverstore/tokens.go`, `internal/serverstore/tokens_test.go`, `internal/serverauth/token.go`, `internal/serverauth/token_test.go`, `internal/serverauth/handler.go`, `internal/serverauth/handler_test.go`
- Create: `internal/serverstore/migrations/0002_tokens.sql`
- Modify: `cmd/server/main.go`(挂 gin 路由)

- [ ] **Step 1: 写测试(红)**

- `tokens_test.go`:CreateToken(存 hash)、GetTokenByHash、RevokeToken、TokenForUser(列出未吊销)
- `token_test.go`:`IssueToken(userID)` 返回随机 32 字节 base64url token(明文),内部存 `SHA256(token)`;`VerifyToken(raw) (*store.User, error)` 校验存在/未吊销/关联用户有效
- `handler_test.go`(httptest):`POST /api/auth/login`(正确/错误密码/限流)、`POST /api/auth/logout`、`GET /api/auth/me`(带 token 返回用户信息)
Run: `go test ./internal/serverstore/ ./internal/serverauth/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 0002 + 实现**

Create: `internal/serverstore/migrations/0002_tokens.sql`:
```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  last_used_at DATETIME,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_user ON api_tokens(user_id);
```
`handler.go`:gin 路由组 `/api/auth`;登录限流:内存滑动窗口 map[ip+username] 10 次/5 分钟(超出返回 429 `RATE_LIMITED`);登录成功更新 `last_used_at`
`main.go`:注册路由,`/api/auth/me` 走 `BearerAuth` 中间件(读 `Authorization` → `VerifyToken` → 注入 context)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: api token issuance and auth endpoints"
```

---

### Task 1.6: LDAP 认证 Provider

**Files:**
- Create: `internal/serverauth/provider.go`(注册表 + 接口), `internal/serverauth/ldap.go`, `internal/serverauth/ldap_test.go`(用测试假 LDAP server 或 mock)

- [ ] **Step 1: 写接口与测试(红)**

`provider.go`:
```go
type UserInfo struct { Username, DisplayName, Email string; Groups []string }
type PasswordProvider interface {
  Name() string
  Authenticate(username, password string) (UserInfo, error)
  Configure(cfg map[string]string) error
}
var providers = map[string]PasswordProvider{}
func Register(p PasswordProvider)
func Get(name string) (PasswordProvider, bool)
```
`ldap_test.go`:用 `github.com/jtblin/go-ldap-client`(或同等)的 mock 接口验证:绑定失败返回认证错误;成功返回 UserInfo 且组映射正确
Run: `go test ./internal/serverauth/ -run TestLDAP -count=1`
Expected: FAIL(接口未实现)

- [ ] **Step 2: 实现 LDAP**

`ldap.go`:配置键 `server_url`/`bind_dn`/`bind_password`/`base_dn`/`user_filter`/`group_filter`/`group_attr`,从 `settings` 加载(`serverauth.Configure`);`Authenticate`:匿名/服务账号绑定 → 用户搜索 → 用户绑定验证密码 → 组搜索
`handler.go` 修改:登录时按 settings `auth.mode`(local|ldap|both)路由到对应 provider;LDAP 用户首次登录自动建本地 `users` 行(source='ldap')
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: LDAP password provider with auto-provisioning"
```

---

### Task 1.7: OIDC 认证 Provider

**Files:**
- Create: `internal/serverauth/oidc.go`, `internal/serverauth/oidc_test.go`

- [ ] **Step 1: 写测试(红)**

用 `github.com/coreos/go-oidc/v3` + httptest 起假 IdP(issuer/discovery/keys/token 端点),验证:授权码兑换 token、ID token 解析出 username/email、错误 code 返回认证失败
Run: `go test ./internal/serverauth/ -run TestOIDC -count=1`
Expected: FAIL

- [ ] **Step 2: 实现 OIDC**

`oidc.go`:`BrowserProvider` 接口扩展(在 provider.go 中定义):
```go
type BrowserProvider interface {
  PasswordProvider
  AuthURL(state string) (string, error)     // 授权 URL
  HandleCallback(code, state string) (UserInfo, error)
}
```
端点:`GET /api/auth/oidc/login`(返回 authURL)、`GET /api/auth/oidc/callback`(code 兑换 → 建/取用户 → 发 token → 重定向 `picoaide://auth?token=...` 给客户端 scheme)
配置键:issuer/client_id/client_secret/redirect_url
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: OIDC browser provider with callback flow"
```

---

### Task 1.8: AI 网关 — OpenAI 兼容代理(核心)

**Files:**
- Create: `internal/llmgateway/handler.go`, `internal/llmgateway/upstream.go`, `internal/llmgateway/handler_test.go`
- Modify: `cmd/server/main.go`、`internal/serverstore/migrations/0003_gateway.sql`

- [ ] **Step 1: 写测试(红)**

- `handler_test.go`(httptest,假上游 server):
  - 非流式:`POST /v1/chat/completions` 带 token → 转发到上游(断言上游收到相同 body 和 key)→ 原样返回上游响应
  - 流式:`stream=true` → 上游返回 SSE 分块 → 网关逐块转发,Content-Type `text/event-stream`,无缓冲
  - 401:无 token;403:吊销 token;502:上游 5xx 或超时(重试 1 次后 502)
Run: `go test ./internal/llmgateway/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0003_gateway.sql`:
```sql
CREATE TABLE gateway_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,            -- openai|deepseek|qwen|glm|openrouter
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,            -- AES-GCM 加密
  models TEXT NOT NULL DEFAULT '[]',    -- 该上游可用的模型名 JSON
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,            -- 对外模型名,如 "deepseek-chat"
  provider_id INTEGER NOT NULL REFERENCES gateway_providers(id),
  display_name TEXT, default_params TEXT NOT NULL DEFAULT '{}'
);
```
`upstream.go`:`type Upstream struct { Name, BaseURL, APIKey, Models []string }`,`LoadUpstreams(db) ([]Upstream, error)`(解密 key)、`MatchModel(db, modelName) (*Upstream, error)`
`handler.go`:路由组 `/v1` 挂 `BearerAuth`;`chat/completions`:解析请求 `{model, messages, stream, ...}` → MatchModel → 拼接上游 `base_url + /chat/completions` → `http.Client` 转发(透传 body、Authorization 换成上游 key)→ 流式时逐行读 SSE 转写(保持 `data:` 行与 `[DONE]`)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: openai-compatible LLM gateway proxy with streaming"
```

---

### Task 1.9: usage 计量

**Files:**
- Create: `internal/serverstore/migrations/0004_usage.sql`, `internal/serverstore/usage.go`, `internal/serverstore/usage_test.go`
- Modify: `internal/llmgateway/handler.go`

- [ ] **Step 1: 写测试(红)**

- `usage_test.go`:`RecordUsage(db, userID, model, pt, ct)`、`UsageByUser(db, userID, since, until)`(按日聚合)、`UsageTotal(db, since, until)`
- `handler_test.go` 增:流式响应结束后 `usage` 表出现一行(prompt/completion tokens 取自 SSE 最后 chunk 的 `usage` 字段)
Run: `go test ./internal/serverstore/ ./internal/llmgateway/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0004_usage.sql`:
```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
```
`handler.go` 流式路径:最后一个 `data:` chunk 若含 `usage`,提取并 `RecordUsage`;非流式:取响应体 `usage`;两者都忽略解析失败(仅记日志,不阻断响应)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: per-user token usage metering"
```

---

### Task 1.10: 模型列表 API

**Files:**
- Create: `internal/llmgateway/models.go`, `internal/llmgateway/models_test.go`
- Modify: `cmd/server/main.go`

- [ ] **Step 1: 写测试(红)**

`GET /v1/models`(带 token)→ 200 返回 `{"models":[{"id":"deepseek-chat","display_name":"..."}]}`(来自 models 表 join provider);无 token 401
Run: `go test ./internal/llmgateway/ -run TestModels -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`models.go`:`ListModels(db) ([]Model, error)`(SQL join `models` + `gateway_providers`,`enabled=1`);handler 注册到 `/v1/models`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: models list endpoint"
```

---

### Task 1.11: Skill 商城(Git 源打包分发)

**Files:**
- Create: `internal/serverstore/migrations/0005_skills.sql`, `internal/serverstore/skills.go`, `internal/serverstore/skills_test.go`, `internal/marketplace/skill_pack.go`, `internal/marketplace/skill_pack_test.go`, `internal/marketplace/skill_api.go`, `internal/marketplace/skill_api_test.go`

- [ ] **Step 1: 写测试(红)**

- `skills_test.go`:AddSkill/UpdateSkill/DeleteSkill/ListSkills/GetSkill
- `skill_pack_test.go`:`BuildPackage(repoPath, name, version)` 产出合法 tar.gz:`metadata.yaml` 存在且字段正确、`SKILL.md` 存在、文件名单全是相对路径且无 `..`;`ValidatePackage(io.Reader)` 拒绝含绝对路径/`..` 的包、拒绝超 100MB
- `skill_api_test.go`(httptest):`GET /api/marketplace/skills`(列表)、`GET /api/marketplace/skills/:name/archive`(下载,Content-Type `application/gzip`,带 `X-Skill-Version`)
Run: `go test ./internal/serverstore/ ./internal/marketplace/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0005_skills.sql`:
```sql
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  git_url TEXT NOT NULL,
  git_ref TEXT NOT NULL DEFAULT 'main',
  checksum TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
```
`skill_pack.go`:clone(`go-git`)到 `data/skills-cache/<name>/` → 校验 metadata.yaml(结构:name/version/author/description/dependencies/entrypoint)与 SKILL.md 存在 → tar.gz 到 `data/skills-cache/<name>-<version>.tar.gz`(缓存命中直接返回);tar 写入时对每个 entry 校验 `filepath.Clean` 后不以 `..` 开头、非绝对路径
`skill_api.go`:四个端点,`archive` 从缓存读取;`POST/PUT/DELETE /api/admin/skills` 走超管中间件(admin_auth 中间件在 1.16 建,先留 TODO 中间件名 `AdminAuth`,在任务 1.16 落地)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: skill marketplace with git pack and download API"
```

---

### Task 1.12: MCP 插件商城(配置分发)

**Files:**
- Create: `internal/serverstore/migrations/0006_mcp.sql`, `internal/serverstore/mcp_servers.go`, `internal/serverstore/mcp_servers_test.go`, `internal/marketplace/mcp_api.go`, `internal/marketplace/mcp_api_test.go`

- [ ] **Step 1: 写测试(红)**

- `mcp_servers_test.go`:AddMCPServer/UpdateMCPServer/DeleteMCPServer/ListMCPServers/GetMCPServer;grants:AddGrant/RemoveGrant/GrantsForServer
- `mcp_api_test.go`(httptest):`GET /api/marketplace/mcp`(仅 enabled,已脱敏——env 中值替换为 `"***"`)、`GET /api/marketplace/mcp/:id/config`(带 token,返回完整 env 含解密后的敏感值)
Run: `go test ./internal/serverstore/ ./internal/marketplace/ -run TestMCP -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0006_mcp.sql`:
```sql
CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',   -- http|stdio
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '{}',            -- JSON,敏感值 AES-GCM 加密
  headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE TABLE mcp_server_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id),
  grant_type TEXT NOT NULL,                  -- user|group|all
  grant_value TEXT NOT NULL
);
```
`mcp_api.go`:`list` 脱敏(env 值全部 `"***"`)、`config` 解密(env 中标记 `"enc:v1:<base64>"` 的值用 AES-GCM 解密后返回);`config` 校验 grant:user 匹配 / group 匹配 / all;无 grant 403 `FORBIDDEN`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: MCP plugin marketplace with grant-scoped config"
```

---

### Task 1.13: 凭证加密(AES-GCM)

**Files:**
- Create: `internal/util/crypto.go`, `internal/util/crypto_test.go`
- Modify: `internal/serverstore/migrations/0007_gateway_key.sql`, `internal/marketplace/credentials.go`, `internal/llmgateway/upstream.go`

- [ ] **Step 1: 写测试(红)**

- `crypto_test.go`:Encrypt/Decrypt 往返;错误密文报错;密文带 `enc:v1:` 前缀;不同明文不同密文(随机 nonce)
- 集成:settings 无 master key 时 `EnsureMasterKey(db)` 生成 32 字节随机并存 settings(`gateway.master_key`),可被 `GetMasterKey(db)` 取回
Run: `go test ./internal/util/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`crypto.go`:AES-256-GCM,`Encrypt(key, plaintext) string`(输出 `enc:v1:<base64(nonce+ciphertext)>`)、`Decrypt(key, s string) (string, error)`;key 16/24/32 字节按长度
`credentials.go`:`EncryptEnv(db, env map[string]string) map[string]string`(值非空且 key 在敏感名单 `app_id,app_secret,token,api_key,password,secret,key` 中则加密)、`DecryptEnv(db, env)` 反向
`upstream.go` 修改:加载时用 `GetMasterKey` 解密 `api_key_enc`(0003 表已有该列,不再加迁移)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: AES-GCM credential encryption with master key"
```

---

### Task 1.14: 知识库(存储 + FTS5 检索)

**Files:**
- Create: `internal/serverstore/migrations/0008_kb.sql`, `internal/serverstore/knowledge.go`, `internal/serverstore/knowledge_test.go`, `internal/knowledge/index.go`, `internal/knowledge/search.go`, `internal/knowledge/knowledge_test.go`

- [ ] **Step 1: 写测试(红)**

- `knowledge_test.go`(store 层):CreateKBFolder/CreateKBDocument/DeleteKBDocument/ListKBFolders;权限:GrantFolderUser/GrantFolderGroup/GetAccessibleFolderIDs
- `knowledge_test.go`(服务层):`Search(db, userID, query, page, pageSize)` 命中 FTS5 中文(如"知识库"与"知识"前缀/包含)、结果按相关度排序、权限外文档不可见;`IndexDocument`(txt/md 抽取文本)
Run: `go test ./internal/serverstore/ ./internal/knowledge/ -run TestKB -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0008_kb.sql`:
```sql
CREATE TABLE kb_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE TABLE kb_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text', size INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'upload', created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE TABLE kb_folder_users (folder_id INTEGER NOT NULL, username TEXT NOT NULL, PRIMARY KEY(folder_id, username));
CREATE TABLE kb_folder_groups (folder_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(folder_id, group_id));
CREATE TABLE kb_audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE VIRTUAL TABLE kb_fts USING fts5(title, content, content='kb_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER kb_ai AFTER INSERT ON kb_documents BEGIN INSERT INTO kb_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
CREATE TRIGGER kb_ad AFTER DELETE ON kb_documents BEGIN INSERT INTO kb_fts(kb_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content); END;
CREATE TRIGGER kb_au AFTER UPDATE ON kb_documents BEGIN INSERT INTO kb_fts(kb_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content); INSERT INTO kb_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
```
`index.go`:`IndexDocument(db, doc)` 插入 kb_documents;`search.go`:`Search` 用 FTS5 `MATCH`(查询词用 `"..."` 包裹防语法注入),join `kb_documents`,按 `bm25(kb_fts)` 排序,分页;权限:先 `GetAccessibleFolderIDs`(用户直属 + 其组所属 + folder_id=0 全局),再 `WHERE folder_id IN (...)`
**注意:** unicode61 中文按字切分,查询"知识库"能命中"知识";**如验收发现中文效果差,在此任务内切换 trigram tokenize 并回归测试**(二选一,实施时用真实数据验证)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: knowledge base storage with FTS5 search"
```

---

### Task 1.15: 知识库远程 MCP

**Files:**
- Create: `internal/knowledge/mcp.go`, `internal/knowledge/mcp_test.go`
- Modify: `cmd/server/main.go`

- [ ] **Step 1: 写测试(红)**

`POST /api/mcp/knowledge/message`(带 token)JSON-RPC:
- `tools/list` → 返回 kb_search/kb_read/kb_list/kb_upload
- `tools/call` kb_search:合法查询 → 结果 JSON 文本;空 query → isError true
- 权限:无权限文档不出现在结果
Run: `go test ./internal/knowledge/ -run TestMCP -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`mcp.go`:JSON-RPC 2.0 请求/响应式处理器:
- 请求体 `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_search","arguments":{...}}}`
- 响应 `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}`
- 工具:`kb_search(query,page,page_size)`、`kb_read(doc_id)`、`kb_list(folder_id)`、`kb_upload(title,content,folder_id)`
- username 从 Bearer token 中间件 context 取
`main.go`:`/api/mcp/knowledge/message` 挂路由
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: knowledge base remote MCP endpoint"
```

---

### Task 1.16: 极简管理页(React)

**Files:**
- Create: `webadmin/`(Vite React 应用):`package.json`、`vite.config.ts`、`src/{main.tsx,App.tsx,api.ts,pages/{Login,Users,Gateway,Usage,Skills,Mcp,Knowledge}.tsx}`
- Create: `internal/serverstore/migrations/0009_admin_session.sql`, `internal/serverauth/admin_session.go`
- Modify: `cmd/server/main.go`(挂静态文件 + session 中间件 + `/api/admin/*` 路由)

- [ ] **Step 1: 写测试(红)**

- `admin_session_test.go`:AdminLogin(仅 is_admin=1 用户)、session 创建/校验/过期(24h)、CSRF token 签发与校验(带时间窗口容差)
- `handler_test.go` 增:`/api/admin/users`(GET/PUT/POST/DELETE,非超管 403)
Run: `go test ./internal/serverauth/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0009_admin_session.sql`:
```sql
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,             -- 随机 session id
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_key TEXT NOT NULL,          -- HMAC key
  expires_at DATETIME NOT NULL
);
```
`admin_session.go`:登录走现有 `AuthenticateLocal` + `is_admin` 校验;`AdminAuth` 中间件(cookie `picoaide_session` → 校验未过期);CSRF:HMAC-SHA256(csrf_key, 小时窗口)双窗口校验
`main.go`:`/api/admin/*` 挂 AdminAuth;`/admin/*` 返回 `webadmin/dist/index.html`(go:embed)
- [ ] **Step 3: 前端四个核心页(Users/Gateway/Usage/Skills+Mcp 合并到 Marketplace)**

`webadmin` 依赖仅:`react`、`react-dom`、`react-router-dom`、`fetch`(不引 UI 库,极简表格+表单);页面:
- Users:列表(分页)/创建(用户名+密码+admin 勾选)/禁用/删除
- Gateway:上游 provider CRUD(base_url + api_key 输入框,回显掩码)、models 管理
- Usage:按日/用户/模型的聚合表 + 简单柱状图(纯 CSS,不引图表库)
- Marketplace:skills 上架(Git URL 表单)/下架;mcp 插件 CRUD(transport/command/args/url/env/headers/grants)
Run: `cd webadmin && npm install && npm run build`,然后启动服务端访问 `/admin/` 手工验证四个页面 CRUD 与 `make test-server`
Expected: 页面可用,测试通过

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: minimal web admin with session auth and CRUD pages"
```

---

### Task 1.17: 阶段 1 验收

**Files:** 无(仅手工核对)

- [ ] **Step 1: 全量测试**

Run: `make test-server && go test ./... -count=1`
Expected: 全部 PASS

- [ ] **Step 2: curl 端到端冒烟(本地起服务端)**

Run(依次,每步断言):
```bash
bin/picoaide-server -addr :8080 -data ./data &
# 1. 建超管
curl -XPOST localhost:8080/api/auth/register -d '{"username":"admin","password":"Admin@123"}'   # 首次注册自动为超管
TOKEN=$(curl -XPOST localhost:8080/api/auth/login -d '{"username":"admin","password":"Admin@123"}' | jq -r .token)
# 2. 网关
curl -N -H "Authorization: Bearer $TOKEN" localhost:8080/v1/chat/completions -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}'   # 需先在管理页配好上游 key;SSE 流式返回
# 3. 商城
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/marketplace/skills | jq            # 列表(先上架一个)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/marketplace/mcp | jq
# 4. 知识库
curl -XPOST -H "Authorization: Bearer $TOKEN" localhost:8080/api/mcp/knowledge/message -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"测试"}}}'
```
Expected: 全链路成功;错误路径(错密码 401、无权限 403)按契约返回

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.1.0 -m "server gateway milestone"
```

---

## 阶段 2:客户端骨架(约 2-3 周)
## 阶段 2:客户端骨架(约 2-3 周)

**目标:** Electron 桌面端登录服务端,Ask 模式完成一次对话,会话持久化,重启恢复。

**前置:** 阶段 1 完成(依赖 `/v1/chat/completions`、`/api/auth/*`)。

**技术栈变更说明:** 客户端为 Electron + TypeScript(主进程 Node)+ React renderer,Vercel AI SDK 引擎。`desktop/` 是独立 npm 包;`internal/localstore` 等 Go 客户端包**不再存在**,数据层为 `desktop/src/main/store/`(better-sqlite3)。

---

### Task 2.1: Electron + React + Vite 脚手架

**Files:**
- Create: `desktop/package.json`、`desktop/tsconfig.json`、`desktop/electron-builder.yml`、`desktop/vite.config.ts`、`desktop/index.html`、`desktop/src/main/index.ts`、`desktop/src/preload/index.ts`、`desktop/src/renderer/{main.tsx,App.tsx}`、`desktop/scripts/dev.mjs`、`.gitignore` 追加 `desktop/dist`、`desktop/node_modules`

- [ ] **Step 1: 初始化 package + 依赖**

Run: `cd /data/picoaide-next && mkdir -p desktop/src/{main,preload,renderer}`
Create: `desktop/package.json`:
```json
{
  "name": "picoaide-desktop",
  "version": "0.2.0",
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.main.json && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "electron": "^33", "electron-builder": "^25", "vite": "^5", "typescript": "^5",
    "react": "^18", "react-dom": "^18", "@vitejs/plugin-react": "^4", "vitest": "^2"
  }
}
```
Run: `cd desktop && npm install`
Expected: 安装成功,`node_modules` 出现

- [ ] **Step 2: 最小 main/preload/renderer**

Create: `desktop/src/main/index.ts` — 创建 `BrowserWindow`(900x680,`webPreferences: { preload, contextIsolation: true, nodeIntegration: false }`),开发环境加载 `http://localhost:5173`,生产加载 `dist/renderer/index.html`;`app.whenReady` → 创建窗口
Create: `desktop/src/preload/index.ts` — `contextBridge.exposeInMainWorld('picoaide', { version: () => '0.2.0' })`
Create: `desktop/src/renderer/main.tsx` — React 渲染 `App.tsx`,`App.tsx` 显示 `window.picoaide.version()`
Create: `desktop/vite.config.ts` — react 插件,`root: src/renderer`,`base: './'`,`build.outDir: ../../dist/renderer`
Run: `cd desktop && npm run build`
Expected: `desktop/dist/main/index.js` 与 `desktop/dist/renderer/index.html` 产出

- [ ] **Step 3: 冒烟启动**

Run: `cd desktop && npx electron .`
Expected: 窗口出现,页面显示 `0.2.0`

- [ ] **Step 4: 写最小测试**

Create: `desktop/src/main/ipc.test.ts` — 测试 `registerIpcHandlers` 中 `picoaide:version` handler 返回 `0.2.0`(handler 抽成纯函数,不依赖 Electron API,便于 Vitest 单测)
Run: `cd desktop && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/ .gitignore
git commit -m "feat: electron react vite scaffold with version preload api"
```

---

### Task 2.2: 本地 SQLite 存储层(better-sqlite3)

**Files:**
- Create: `desktop/src/main/store/db.ts`、`desktop/src/main/store/migrations.ts`、`desktop/src/main/store/conversations.ts`、`desktop/src/main/store/messages.ts`、`desktop/src/main/store/artifacts.ts`、`desktop/src/main/store/memories.ts`、`desktop/src/main/store/settings.ts`、`desktop/src/main/paths.ts`
- Test: `desktop/src/main/store/*.test.ts`

- [ ] **Step 1: 安装依赖**

Run: `cd desktop && npm i better-sqlite3 && npm i -D @types/better-sqlite3`
Expected: 安装成功

- [ ] **Step 2: 写测试(红)**

- `db.test.ts`:`openDb(':memory:')` 执行迁移后 6 张表存在;重复 open 幂等;`PRAGMA journal_mode=WAL` 生效
- `conversations.test.ts`:create/list(updated_at 倒序)/get/delete(级联删 messages)
- `messages.test.ts`:append/list(按 id 升序)/tool_calls JSON 往返
- `artifacts.test.ts`、`memories.test.ts`、`settings.test.ts`:同语义
Run: `cd desktop && npx vitest run src/main/store`
Expected: FAIL(db 模块未实现)

- [ ] **Step 3: 实现**

`paths.ts`:`dataDir()` 按平台:`~/.local/share/picoaide`(Linux)/`~/Library/Application Support/picoaide`(macOS)/`%APPDATA%/picoaide`(Windows);`dbPath()`/`workspaceDir()`
`db.ts`:`openDb(filePath)` 返回 better-sqlite3 实例,WAL + `foreign_keys=ON`
`migrations.ts`:版本表 `schema_migrations(version INTEGER PRIMARY KEY, applied_at)` + 迁移数组(与设计文档 §3.5 表结构一致的 6 张表:conversations/messages/artifacts/memories/settings/workflow_state)
`workflow_state` 表(WorkflowAgent durable 恢复用):
```sql
CREATE TABLE workflow_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  state TEXT NOT NULL,             -- JSON 序列化的 workflow 状态
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
```
各表方法签名:与设计文档 §3.5 一致,全部同步 API(better-sqlite3 特性)
Run: `cd desktop && npx vitest run src/main/store`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/store desktop/src/main/paths.ts
git commit -m "feat: better-sqlite3 local store with migrations"
```

---

### Task 2.3: AI SDK 引擎探针(核心风险验证)

**Files:**
- Create: `desktop/src/main/agent/provider.ts`、`desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/events.ts`、`desktop/src/main/agent/engine.test.ts`

**目的:** 验证 `@ai-sdk/openai-compatible` 对接自研网关 + `streamText`/`WorkflowAgent` 基本链路。不依赖真服务端,用模拟 Provider。

- [ ] **Step 1: 安装依赖**

Run: `cd desktop && npm i ai @ai-sdk/openai-compatible @ai-sdk/react zod`
Expected: 安装成功

- [ ] **Step 2: 写探针测试(红)**

`engine.test.ts`:
- `MockProvider`:实现 `LanguageModelV2` 的最小桩(streamText 调用时返回固定文本分块)——或更简单:直接测 `provider.ts` 的 `createGatewayModel(serverURL, token, modelID)` 返回的对象是 OpenAI 兼容 chatModel;`events.ts` 的 `toAgentEvent` 把 AI SDK 的 stream part(`text-delta`/`tool-call`/`finish`)转成 UI 事件
- `WorkflowAgent` 探针:构造 `new WorkflowAgent({ model: mockModel, instructions: '...', tools: {} })` → `stream({ messages, writable: getWritable() })` → 断言收到 text-delta 流
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL(未实现)

- [ ] **Step 3: 实现**

`provider.ts`:
```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
export function createGatewayModel(serverURL: string, token: string, modelID: string) {
  return createOpenAICompatible({ name: 'gateway', baseURL: `${serverURL}/v1`, apiKey: token }).chatModel(modelID)
}
```
`events.ts`:UI 事件类型(§0.4.3 契约,TS 版)+ `agentEventStream(stream, cb)` 把 `ModelCallStreamPart` 流转换为 `text_delta`/`reasoning_delta`/`tool_start`/`tool_end`/`done` 回调
`engine.ts`(骨架):`EngineConfig{ model, serverURL, token, sysPrompt, maxSteps }`、`class AgentEngine { constructor(cfg) ; async ask(content, history): Promise<AsyncIterable<AgentEvent>> }` — Ask 模式用 `streamText`(无 tools);Craft 骨架留 `ErrNotImplemented` 抛错
Run: `cd desktop && npx vitest run src/main/agent`
Expected: PASS(探针通过 → AI SDK 链路可行)

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/agent desktop/package.json desktop/package-lock.json
git commit -m "feat: ai sdk engine probe with gateway provider"
```

---

### Task 2.4: 服务端连接器(登录/token/网关)

**Files:**
- Create: `desktop/src/main/gateway/auth.ts`、`desktop/src/main/gateway/health.ts`、`desktop/src/main/gateway/config.ts`、`desktop/src/main/gateway/auth.test.ts`、`desktop/src/main/gateway/health.test.ts`

- [ ] **Step 1: 写测试(红)**

- `auth.test.ts`:`login(serverURL, username, password)` 用 fetch mock 断言 POST `/api/auth/login`、成功返回 token;`saveSession/loadSession/clearSession` 用临时目录读写 `config.json`(仅存 URL/用户名/token,0600 权限)
- `health.test.ts`:`ping(serverURL, token)` — mock fetch:200 → true;网络错误 → false;401 → false
Run: `cd desktop && npx vitest run src/main/gateway`
Expected: FAIL

- [ ] **Step 2: 实现**

`config.ts`:`Session{ serverURL, username, token }`,`sessionPath()`(paths.ts)
`auth.ts`:`login` 用全局 `fetch`(Electron main 可用),超时 15s,401 抛 `AuthError`;`saveSession` 写 JSON(权限 0600,`fs.chmod`)、`loadSession` 读、`clearSession` 删
`health.ts`:`createHealthPoller(session, { intervalMs: 15000 })` — 返回 `{ start(cb), stop() }`,轮询 `GET /api/auth/me`,结果经回调输出 `online|offline`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/gateway
git commit -m "feat: gateway client with login session and health poller"
```

---

### Task 2.5: Ask 模式引擎(可运行的最小 Agent)

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/modes.ts`
- Create: `desktop/src/main/ipc.ts`、`desktop/src/main/ipc.test.ts`
- Modify: `desktop/src/main/index.ts`(注册 ipc)

- [ ] **Step 1: 写测试(红)**

`ipc.test.ts`(mock session + mock model):`handleChatAsk({ conversationId, content })` → 会话落库(user+assistant 两条)、流式事件经事件发射器推送、完成后 messages 表可读回
`modes.test.ts`:Ask 模式 `buildRunConfig(mode)` 返回 `{ tools: {}, maxSteps: 1 }`;Craft 返回 `{ tools: <注册表>, maxSteps: 20 }`
Run: `cd desktop && npx vitest run src/main/agent src/main/ipc.test.ts`
Expected: FAIL

- [ ] **Step 2: 实现**

`modes.ts`:
```ts
export type Mode = 'ask' | 'plan' | 'craft'
export function buildRunConfig(mode: Mode, tools: Record<string, Tool>, maxSteps: number) {
  if (mode === 'ask') return { tools: {}, maxSteps: 1 }
  return { tools, maxSteps }
}
```
`engine.ts` 完成 Ask 路径:
```ts
async ask(input: { conversationId: number; content: string }): Promise<RunHandle> {
  const history = store.messages.list(input.conversationId).map(toModelMessage)
  const result = await streamText({ model, system, messages: [...history, userMsg], tools: {} })
  // result.textStream → for await → emit('text_delta') ; finish → emit('done')
}
```
`ipc.ts`:`ipcMain.handle('chat:ask', ...)`、`ipcMain.handle('chat:new', ...)`、`webContents.send('agent:event', ev)` 推送;`index.ts` 注册
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main
git commit -m "feat: ask-mode engine with ipc bridge"
```

---

### Task 2.6: React 聊天 UI(AI Elements 起步)

**Files:**
- Create: `desktop/src/renderer/src/api/picoaide.ts`、`desktop/src/renderer/src/stores/chat.ts`、`desktop/src/renderer/src/stores/auth.ts`、`desktop/src/renderer/src/pages/Main.tsx`、`desktop/src/renderer/src/components/{ChatInput,Messages}.tsx`
- Modify: `desktop/src/renderer/App.tsx`、`desktop/package.json`

- [ ] **Step 1: 安装依赖 + 初始化 AI Elements**

Run: `cd desktop && npm i zustand && npx ai-elements init`
Expected: AI Elements 组件注册表初始化成功(组件在 `node_modules/ai-elements` 或生成到本地目录,以 init 输出为准,记录到文档)

- [ ] **Step 2: 状态层 + API 封装**

Create: `desktop/src/renderer/src/api/picoaide.ts` — 封装 `window.picoaide.*`(chatAsk/onEvent/loadConversations/…),事件订阅 `window.picoaide.onAgentEvent(cb)`(preload 的 ipcRenderer.on 包装)
Create: `desktop/src/renderer/src/stores/chat.ts`(Zustand):`conversations/messages/streaming/mode`,actions:`newConversation/loadConversation/sendMessage/onAgentEvent/appendDelta/selectConversation`
Create: `desktop/src/renderer/src/stores/auth.ts`:`status/login/logout`
Run: `cd desktop && npm run build`
Expected: 编译通过

- [ ] **Step 3: 组件**

- `Messages.tsx`:渲染消息列表,streaming 时展示流式增量,自动滚动(尾随 `scrollIntoView`)
- `ChatInput.tsx`:多行 textarea + Enter 发送 + 模式切换(Ask/Plan/Craft 按钮,阶段 3 前仅 Ask 可用)
- `Main.tsx`:左侧会话列表 + 右侧聊天区;AI Elements 组件用于输入框/按钮等基础 UI
Run: `cd desktop && npm run build`
Expected: 编译通过,`npx electron .` 手工验证(需本机服务端 + 已登录,阶段 2.7 后联调)

- [ ] **Step 4: Commit**

```bash
git add desktop/src/renderer desktop/package.json desktop/package-lock.json
git commit -m "feat: react chat ui with ai elements and zustand"
```

---

### Task 2.7: 登录页 + token 持久化

**Files:**
- Create: `desktop/src/renderer/src/pages/Login.tsx`
- Modify: `desktop/src/preload/index.ts`(暴露 login/loadSession/logout/onAgentEvent)、`desktop/src/main/ipc.ts`(auth handlers)、`desktop/src/renderer/App.tsx`(路由:未登录 → Login)

- [ ] **Step 1: preload + ipc 扩展**

`preload/index.ts` 增:`login(serverURL, username, password)`、`loadSession()`、`logout()`、`onAgentEvent(cb)`(返回取消函数)、`onConnectionStatus(cb)`
`ipc.ts` 增:`auth:login`、`auth:loadSession`、`auth:logout`(调 gateway/auth.ts)
Run: `cd desktop && npm run typecheck`
Expected: 类型通过

- [ ] **Step 2: Login 页**

Form:服务端 URL + 用户名 + 密码 + 登录按钮 + 错误提示(401 → "用户名或密码错误";网络错误 → "无法连接服务器");登录成功跳 Main;`App.tsx` 用 `loadSession()` 判断初始路由
Run: `cd desktop && npm run build && npx electron .`,连本机服务端验证成功/失败分支
Expected: 正常

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: login page with session persistence"
```

---

### Task 2.8: 离线检测与重连

**Files:**
- Create: `desktop/src/renderer/src/stores/connection.ts`
- Modify: `desktop/src/main/index.ts`(启动 health poller)、`desktop/src/preload/index.ts`

- [ ] **Step 1: 实现**

`index.ts`:登录成功后 `createHealthPoller(session, cb)` 启动,`cb` 经 `webContents.send('connection:status')` 推送
`connection.ts`:状态 `online|offline`,顶部横幅"已断开,将自动重连";发送时 offline 直接本地报错
Run: `cd desktop && npm run build && npx electron .` 停服务端观察横幅
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add desktop/src
git commit -m "feat: offline detection and reconnect banner"
```

---

### Task 2.9: 阶段 2 验收

- [ ] **Step 1: 全量测试**

Run: `cd desktop && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 2: 手工场景(本机服务端 + electron .)**

1. 首次启动 → 登录页 → 输 URL/账号密码 → 进入主界面
2. 新建会话 → 输入"你好,介绍你自己" → 流式回复 → 重启客户端 → 会话列表仍在 → 点开历史可见消息
3. 停掉服务端 → 顶部离线横幅出现 → 重启服务端 → 自动恢复在线
Expected: 三场景全部通过

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.2.0 -m "client skeleton milestone"
```

---

## 阶段 3:本地能力(约 3-4 周)

**目标:** Craft 模式全流程:真实文件任务("汇总桌面 Word 成 500 字汇报存回桌面")跑通;本地工具 + 审批确认 + Skill + MCP 插件 + 产物面板 + 沙盒执行。

---

### Task 3.1: 文件工具

**Files:**
- Create: `desktop/src/main/tools/filesystem.ts`、`desktop/src/main/tools/filesystem.test.ts`

- [ ] **Step 1: 写测试(红)**

用 `fs.mkdtempSync` 建临时目录树,每工具验证:
- `file_read(path, encoding)`:UTF-8 正常;GBK 文件正确解码(`iconv-lite` 或 `TextDecoder('gbk')` — 先写 GBK 字节,断言输出中文)
- `file_write/file_edit/file_append`:内容正确;越界路径(`/etc/passwd`、`../x`)返回明确错误
- `file_delete`:存在删除、不存在报错
- `file_list/file_search`:递归、按名过滤
Run: `cd desktop && npx vitest run src/main/tools/filesystem`
Expected: FAIL

- [ ] **Step 2: 实现**

`filesystem.ts`:
```ts
export interface FileToolContext { allowedDirs: string[]; cwd: string }
export function createFileTools(ctx: FileToolContext): Record<string, Tool>  // AI SDK tool 格式
export function isAllowed(absPath: string, allowedDirs: string[]): boolean  // 前缀边界 + realpath 校验
```
- 编码检测:GBK 用 `iconv-lite`(`npm i iconv-lite`),探测:BOM 优先,否则 UTF-8 严格校验失败回退 GBK
- 工具注册为 AI SDK `tool({ description, inputSchema: z.object({...}), execute })`,`file_delete` 标记 `needsApproval: true`(WorkflowAgent 审批流识别)
- 越界返回 `throw new ToolError('路径不在允许目录内: ' + path)`(AI SDK 工具错误 → tool_error 事件)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/filesystem.ts desktop/package.json desktop/package-lock.json
git commit -m "feat: local filesystem tools with encoding detection"
```

---

### Task 3.2: 终端工具

**Files:**
- Create: `desktop/src/main/tools/terminal.ts`、`desktop/src/main/tools/terminal.test.ts`

- [ ] **Step 1: 写测试(红)**

- `commandExec('echo hello')` → stdout 正确、exit code 0
- 超时:`sleep 5` with 1s timeout → 超时错误且进程被 kill(用 `child_process.spawn` + `AbortController` / `kill(-pid)` 进程组)
- 输出截断:cat 10KB 文件 → 输出 ≤50KB 且有截断标记
Run: `cd desktop && npx vitest run src/main/tools/terminal`
Expected: FAIL

- [ ] **Step 2: 实现**

`terminal.ts`:
```ts
export interface CommandResult { stdout: string; stderr: string; code: number }
export async function commandExec(command: string, opts: { cwd: string; timeoutSec: number; maxOutput: number }): Promise<CommandResult>
```
- `spawn(command, { shell: true, cwd })`,输出累计超 `maxOutput`(50KB)截断
- 超时:`setTimeout` → `process.kill(-child.pid, 'SIGKILL')`(posix 进程组,防子进程残留;Windows 用 `taskkill /pid /T /F` 分支)
- 危险命令首词清单(`rm,mv,dd,mkfs,shutdown,reboot,sudo`)→ `needsApproval: true`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/terminal.ts
git commit -m "feat: terminal tool with timeout and output truncation"
```

---

### Task 3.3: 沙盒执行工具(Vercel Sandbox)

**Files:**
- Create: `desktop/src/main/tools/sandbox.ts`、`desktop/src/main/tools/sandbox.test.ts`(mock)

- [ ] **Step 1: 安装 + 写测试(红)**

Run: `cd desktop && npm i @ai-sdk/sandbox-vercel`
`sandbox.test.ts`(mock `createVercelSandbox`):`sandboxExec({ command: 'cat hello.txt' })` → 调 `createSession().restricted().run()`;输出截断;会话停止
Run: `cd desktop && npx vitest run src/main/tools/sandbox`
Expected: FAIL

- [ ] **Step 2: 实现**

`sandbox.ts`:
```ts
import { createVercelSandbox } from '@ai-sdk/sandbox-vercel'
export function createSandboxTool(sandbox: ReturnType<typeof createVercelSandbox>): Tool
// sandboxExec({ command, timeoutSec }) → restricted 会话 run,stdout/stderr/code,输出截断 50KB
```
- 单例 sandbox 实例,惰性创建;不可信代码/技能脚本在此执行
- 生产若无 Sandbox 环境变量/凭证,工具返回明确错误"沙盒执行不可用"并降级提示
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/sandbox.ts desktop/package.json desktop/package-lock.json
git commit -m "feat: vercel sandbox exec tool"
```

---

### Task 3.4: 屏幕截图 + OCR

**Files:**
- Create: `desktop/src/main/tools/screen.ts`、`desktop/src/main/tools/ocr.ts`、`desktop/src/main/tools/screen.test.ts`

- [ ] **Step 1: 写测试(红)**

- `screen.ts`:`captureScreen()` 用 `desktopCapturer.getSources({ types: ['screen'] })` → `nativeImage.toPNG()` → base64;测试环境跳过真实截图,断言结构正确
- `ocr.ts`:`ocrImage(pngBase64)` 用 tesseract.js(`npm i tesseract.js`);测试:合成含文本图片 → 返回非空字符串(CI 无 GPU 可 skip,本地验证中文)
Run: `cd desktop && npx vitest run src/main/tools/screen src/main/tools/ocr`
Expected: FAIL

- [ ] **Step 2: 实现**

`screen.ts`:`captureScreen()` — Electron main 的 `desktopCapturer`,返回 `{ pngBase64, width, height }`(Base64 直传 renderer 预览)
`ocr.ts`:tesseract.js 惰性初始化(单例,首次调用 `createWorker('chi_sim+eng')`);失败降级:抛"OCR 不可用",截图工具照常工作
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/screen.ts desktop/src/main/tools/ocr.ts desktop/package.json desktop/package-lock.json
git commit -m "feat: screen capture and lazy ocr"
```

---

### Task 3.5: 剪贴板工具

**Files:**
- Create: `desktop/src/main/tools/clipboard.ts`

- [ ] **Step 1: 实现**

`clipboard.ts`:用 Electron `clipboard` 模块:`clipboardRead()`(标记 `needsApproval: true`)、`clipboardWrite(text)`
- AI SDK tool 注册,`clipboard_read` 触发审批流
Run: `cd desktop && npm run typecheck`
Expected: 通过

- [ ] **Step 2: Commit**

```bash
git add desktop/src/main/tools/clipboard.ts
git commit -m "feat: clipboard tools"
```

---

### Task 3.6: 可访问目录模型 + 越界防护

**Files:**
- Modify: `desktop/src/main/tools/filesystem.ts`(抽 `isAllowed` 到 `desktop/src/main/tools/paths.ts`)、`desktop/src/main/store/settings.ts`(allowed_dirs)
- Create: `desktop/src/main/tools/paths.ts`、`desktop/src/main/tools/paths.test.ts`

- [ ] **Step 1: 写测试(红)**

`paths.test.ts`:`isAllowed` — 前缀匹配、`/home/u/a` vs `/home/u/ab` 不误判(必须 `allowed + path.sep` 边界)、符号链接 `fs.realpathSync` 后校验(指向外部 → 拒绝)
Run: `cd desktop && npx vitest run src/main/tools/paths`
Expected: FAIL

- [ ] **Step 2: 实现**

`paths.ts`:`isAllowed(absPath, allowedDirs)`;引擎启动时从 settings 读 `allowed_dirs`(默认工作目录 `workspaces/`);所有工具统一调用
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools
git commit -m "feat: shared allowed-dirs path guard"
```

---

### Task 3.7: 高危操作审批(WorkflowAgent 审批流)

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/engine.test.ts`、`desktop/src/main/ipc.ts`
- Create: `desktop/src/renderer/src/components/ConfirmModal.tsx`

- [ ] **Step 1: 写测试(红)**

`engine.test.ts`(Craft 模式 + mock model):模型第一轮返回 tool-call 且该工具 `needsApproval` → `agent.stream()` 返回的 `toolCalls` 含未执行调用(审批前不执行)→ `confirm(requestId, true)` 后工具执行结果出现;`confirm(requestId, false)` → 工具返回拒绝错误;60s 未确认 → 自动拒绝(WorkflowAgent 审批超时配置)
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL

- [ ] **Step 2: 实现**

`engine.ts`:
```ts
// WorkflowAgent 审批流:工具 execute 声明 needsApproval
// → agent.stream() 产物中 toolCalls 未执行 → emit('confirm_required', { requestId, op, target, reason })
// → ipc 'agent:confirm' → confirm(requestId, ok) → 以批准输入继续
```
`ipc.ts` 增:`agent:confirm` handler;`index.ts` 转发 `confirm_required` 事件到 renderer
`ConfirmModal.tsx`:弹窗(操作名 + 目标路径 + 原因 + 允许/拒绝 + 60s 倒计时)
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: workflow approval flow for high-risk tools"
```

---

### Task 3.8: Craft 模式全流程

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/modes.ts`、`desktop/src/main/agent/engine.test.ts`
- Create: `desktop/src/renderer/src/components/ToolCalls.tsx`

- [ ] **Step 1: 写测试(红)**

`engine.test.ts` 增(Craft):mock model 两轮:第一轮 tool-call(file_read),第二轮文本 → 断言:工具执行结果回传、事件含 tool_start/tool_end、最终 done;`maxSteps` 到达(永远 tool-call)→ 引擎报错"达到最大步骤数"
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL

- [ ] **Step 2: 实现**

`engine.ts` Craft 路径:WorkflowAgent(`tools: 全部本地工具`、`maxSteps: 20`);事件 `tool_start/tool_end/tool_error` 按 §0.4.3 发;每 step 结束 `workflow_state` 落库(durable)
`ToolCalls.tsx`:折叠卡片(工具名/输入/输出/耗时/失败标红)
Run: 同上 + 手工:登录后 Craft 让 Agent 读本机文件
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: craft mode with workflow agent and tool cards"
```

---

### Task 3.9: 产物面板 + durable 恢复

**Files:**
- Create: `desktop/src/main/agent/artifacts.ts`、`desktop/src/main/agent/artifacts.test.ts`、`desktop/src/main/agent/resume.ts`、`desktop/src/renderer/src/components/ArtifactsPanel.tsx`
- Modify: `desktop/src/main/store/workflow_state.ts`、`desktop/src/main/index.ts`(恢复未完成任务)

- [ ] **Step 1: 写测试(红)**

- `artifacts.test.ts`:工具写入 `workspaces/<conv>/` 下文件 → 引擎检测(每次工具结束后扫描会话目录)→ `artifact` 事件 + artifacts 表落库
- `resume.test.ts`:workflow_state 表存了状态 → `resumeConversation(convId)` 恢复并继续,事件续推
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL

- [ ] **Step 2: 实现**

`artifacts.ts`:工作目录管理器(创建/清理);类型按扩展名 map(`.md→report,.png/.jpg→image,.html→html,.pptx→ppt,.docx→docx,.xlsx→xlsx,其他→file`)
`resume.ts`:启动时扫描 `workflow_state` 未完成会话 → UI 提示"有未完成任务,是否恢复" → WorkflowAgent 从持久化状态继续
`ArtifactsPanel.tsx`:右侧面板列出当前会话产物,点击"在文件夹中显示"(main `shell.showItemInFolder`)
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: artifacts panel and workflow resume"
```

---

### Task 3.10: Plan 模式

**Files:**
- Modify: `desktop/src/main/agent/modes.ts`、`desktop/src/main/agent/modes.test.ts`、`desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/components/ChatInput.tsx`、`desktop/src/renderer/src/stores/chat.ts`

- [ ] **Step 1: 写测试(红)**

`modes.test.ts`:Plan 首轮 `tools: {}`(无工具)产出计划 → 用户确认(`approvePlan()`)→ 同会话第二轮带 tools 执行;拒绝则终止
Run: `cd desktop && npx vitest run src/main/agent/modes`
Expected: FAIL

- [ ] **Step 2: 实现**

`modes.ts`:Plan 状态(conversations 表加 `plan_status` 列:planning|approved|rejected|executing;迁移 `0002_plan.ts`);UI:Plan 消息后显示"执行计划"按钮
Run: 同上 + 手工
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: plan-then-execute mode"
```

---

### Task 3.11: Skill 运行时(沙盒执行)

**Files:**
- Create: `desktop/src/main/skill/loader.ts`、`desktop/src/main/skill/loader.test.ts`、`desktop/src/main/skill/installer.ts`、`desktop/src/main/skill/installer.test.ts`
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: 写测试(红)**

- `loader.test.ts`:构造 `skills/<name>/`(SKILL.md + metadata.yaml + scripts/run.py)→ `load(name)` 返回 `{ instruction, entrypoint }`;缺 SKILL.md 报错
- `installer.test.ts`:从 mock 商城端点下载 tar.gz → 解压到 skills 目录(路径穿越防护:拒绝 `../` 条目)→ 版本记 settings;卸载删目录
Run: `cd desktop && npx vitest run src/main/skill`
Expected: FAIL

- [ ] **Step 2: 实现**

`loader.ts`:`load(skillsDir, name)` 读 SKILL.md 为 instruction,metadata 校验(语义化版本);`installer.ts`:调 `gateway.marketplace` 下载 archive(带 token)→ tar 条目安全校验(`tar` 流式读取,拒绝 `..`/绝对路径)→ 解压;已装列表记 settings `skills.installed`
`engine.ts`:启动时已装 skill 的 instruction 拼入 sysPrompt(`## Skills\n` + 正文);`skill_exec <name>` 工具注册(**走沙盒工具 sandboxExec 执行**,60s 超时,输出截断)
`Settings.tsx`:技能列表(安装/更新/卸载/详情)
Run: 同上 + 手工:安装示例技能 → 对话中生效
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/skill desktop/src/renderer/src/pages/Settings.tsx
git commit -m "feat: skill loader installer with sandbox exec"
```

---

### Task 3.12: MCP 插件运行时

**Files:**
- Create: `desktop/src/main/mcp/installer.ts`、`desktop/src/main/mcp/runner.ts`、`desktop/src/main/mcp/adapter.ts`、`desktop/src/main/mcp/runner.test.ts`
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: 安装依赖 + 写测试(红)**

Run: `cd desktop && npm i @modelcontextprotocol/sdk`
`runner.test.ts`:mock stdio MCP server(测试脚本进程,响应 `initialize`/`tools/list`/`tools/call`)→ `listTools()` 返回工具、`callTool(name, args)` 返回结果;进程崩溃 → 自动重启 1 次后可调用
Run: `cd desktop && npx vitest run src/main/mcp`
Expected: FAIL

- [ ] **Step 2: 实现**

`installer.ts`:商城配置拉取(`GET /api/marketplace/mcp/:id/config` 带 token)→ 存 `mcp/<plugin-id>/config.json`(env 敏感值仅在内存)
`runner.ts`:配置 `transport: stdio` → `StdioClientTransport(command, args, env)` + `Client`(initialize/handshake)→ 崩溃监听(进程退出)→ 自动重启 1 次;`transport: http` → `StreamableHTTPClientTransport(url, headers)`
`adapter.ts`:把 MCP 工具定义转换为 AI SDK `tool`(`inputSchema: z.object(JSON Schema 转换)`),execute 桥接 `callTool`
`engine.ts`:启动时加载已启用插件,工具并入注册表;插件失败 → tool_error
`Settings.tsx`:插件列表(启用/禁用/查看配置脱敏/卸载)
Run: 同上 + 手工:安装 xiaohongshu 类插件调用
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/mcp desktop/package.json desktop/package-lock.json
git commit -m "feat: local mcp plugin runtime with stdio and http"
```

---

### Task 3.13: 设置页

**Files:**
- Create: `desktop/src/renderer/src/pages/Settings.tsx`(完整版)、`desktop/src/main/store/settings.ts` 扩展
- Modify: `desktop/src/preload/index.ts`、`desktop/src/main/ipc.ts`

- [ ] **Step 1: 实现**

设置项(binding `settings:get`/`settings:set`):
- 模型:`GET /v1/models` 拉列表选择默认模型(settings `model.default`)
- 工作目录:默认 `workspaces/`,可改
- 可访问目录:列表增删(settings `allowed_dirs`,JSON 数组)
- 插件/技能:复用 3.11/3.12 的管理区
- 服务端信息:URL/用户名显示,登出按钮
Run: `cd desktop && npm run build && npx electron .` 逐项验证保存/重启生效
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add desktop/src
git commit -m "feat: settings page for model dirs and plugins"
```

---

### Task 3.14: 阶段 3 验收

- [ ] **Step 1: 全量测试**

Run: `cd desktop && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 2: 真实任务端到端(本机)**

准备:桌面目录放 2-3 个 .docx/.md 文件;服务端知识库上传一篇文档
1. Craft 模式:"汇总桌面/文档里的文件,生成 500 字汇报保存到桌面" → 产物出现在产物面板 → 打开文件内容正确
2. 高危:要求 Agent 删除文件 → 审批弹窗 → 拒绝后 Agent 收到拒绝
3. 技能:安装一个商城技能 → 新对话中生效(脚本在沙盒执行)
4. 插件:安装 stdio 插件 → 对话中调用成功
5. 知识库:Ask Agent 查询知识库文档 → 返回正确内容
6. 长任务:让 Agent 执行多步任务,任务中途重启客户端 → 提示恢复 → 继续完成
Expected: 全部通过

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.3.0 -m "local capabilities milestone"
```

---

## 阶段 4:产品化(约 2-3 周)

**目标:** 三平台打包分发、管理页完善、全套文档、性能优化、E2E 冒烟。

---

### Task 4.1: 三平台打包

**Files:**
- Create: `desktop/electron-builder.yml`(完善)、`scripts/pkg-linux.sh`、`scripts/pkg-windows.sh`、`scripts/pkg-macos.sh`、`Makefile` 增 `pkg-*` 目标

- [ ] **Step 1: 配置 electron-builder**

`desktop/electron-builder.yml`:
```yaml
appId: com.picoaide.desktop
productName: PicoAide
directories: { output: ../dist, buildResources: resources }
files: [dist/**]
linux: { target: [deb, AppImage], category: Utility }
win: { target: [nsis] }
nsis: { oneClick: false, allowToChangeInstallationDirectory: true }
mac: { target: [dmg], category: public.app-category.productivity }
```
- [ ] **Step 2: 打包脚本**

- Linux:`npm run build && electron-builder --linux` → `dist/picoaide_0.4.0_amd64.deb` + AppImage
- Windows:`electron-builder --win` → `dist/picoaide-setup.exe`(CI 或 Windows 机器)
- macOS:`electron-builder --mac` → `dist/picoaide.dmg`(CI 或 mac 机器)
- 版本号从 `package.json` version 注入
Run: `bash scripts/pkg-linux.sh`
Expected: Linux 安装包产出,安装后可启动登录(Windows/macOS 在 CI 或对应机器验证)

- [ ] **Step 3: Commit**

```bash
git add desktop/electron-builder.yml scripts/ Makefile
git commit -m "feat: three-platform electron packaging"
```

---

### Task 4.2: 管理页完善

**Files:**
- Modify: `webadmin/src/pages/Usage.tsx`、`webadmin/src/pages/Knowledge.tsx`

- [ ] **Step 1: 用量图表 + 知识库上传**

- Usage:按日柱状图(纯 CSS div 高度)、按模型/用户排行表、日期范围筛选(API:`/api/admin/usage?from=&to=&group=day|model|user`)
- Knowledge:文档上传(txt/md/docx/pdf → 后端抽取文本)、文件夹管理、用户/组授权、搜索预览
Run: `cd webadmin && npm run build`,手工验证
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: usage charts and knowledge admin"
```

---

### Task 4.3: 全套文档

**Files:**
- Create: `docs/01-architecture.md`、`docs/02-build-deploy.md`、`docs/03-api-reference.md`、`docs/04-auth.md`、`docs/05-agent-system.md`、`docs/06-database.md`、`docs/07-marketplace.md`、`docs/08-development.md`、`README.md`

- [ ] **Step 1: 按 §11 文档计划编写**

内容以设计文档为准,更新为实际实现细节(端点/表/目录有出入处以代码为准;客户端章节按 Electron/AI SDK/WorkflowAgent/Sandbox 实际实现写)
- `README.md`:项目简介、快速开始(服务端 + 客户端)、截图占位
Run: 通读全文,交叉检查 API/表名与代码一致(用 `grep` 抽查 3 处)
Expected: 一致

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs: full documentation set"
```

---

### Task 4.4: 性能优化

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/components/Messages.tsx`、`desktop/src/main/store/db.ts`

- [ ] **Step 1: 实施与验证**

- 流式渲染节流:React `useDeferredValue`/requestAnimationFrame 合并 text_delta 渲染(>10 delta/s 时),验证长回复无卡顿
- SQLite WAL 自动检查点:`PRAGMA wal_autocheckpoint(1000)`;会话页加载 >200 条消息时分页(先加载最近 100,向上滚动加载更多)
- OCR 惰性加载回归确认(3.4 已做,此处复验)
- Workflow 状态序列化大小控制:每 step 状态压缩/精简后落库
Run: `cd desktop && npm run build && npx electron .` 长对话(50+ 轮)滚动流畅;`npm test` 无明显退化
Expected: 流畅

- [ ] **Step 2: Commit**

```bash
git add desktop/src
git commit -m "perf: streaming throttle and message pagination"
```

---

### Task 4.5: E2E 冒烟

**Files:**
- Create: `scripts/e2e/smoke.sh`(服务端 curl 链路)、`scripts/e2e/smoke_client.sh`(客户端冒烟)

- [ ] **Step 1: 服务端冒烟脚本**

复用阶段 1 验收的 curl 链路脚本化,加断言(退出码非 0 即失败):注册→登录→网关对话(stream)→技能列表→MCP 列表→知识库搜索
Run: `bash scripts/e2e/smoke.sh`
Expected: 全绿

- [ ] **Step 2: 客户端冒烟**

在打包产物上:启动 → 自动登录(预设 config)→ 发起一次 Ask → 断言收到 done 事件(用 Electron 日志或临时 E2E hook 输出结果文件)
Run: 打包机上执行
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add scripts/e2e
git commit -m "test: e2e smoke scripts"
```

---

### Task 4.6: 发布

- [ ] **Step 1: 版本与发布**

```bash
bash scripts/pkg-linux.sh && bash scripts/pkg-windows.sh && bash scripts/pkg-macos.sh
git checkout master && git merge dev && git tag -a v0.4.0 -m "picoaide desktop 0.4.0"
```
Expected: 三平台安装包在 `dist/`,tag 建立

- [ ] **Step 2: 发布说明**

Create: `CHANGELOG.md`(汇总四阶段功能)
Run: 通读核对
Expected: 完成

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md && git commit -m "docs: changelog for 0.4.0"
```

---

## 自审记录(计划编写时完成)

**Spec 覆盖检查:**
- §3.1 客户端技术栈 → Task 2.1(壳)/2.2(DB)/2.3(引擎探针)/2.4(网关客户端)
- §3.3 Agent 引擎三模式 + durable + 沙盒 → Task 2.3/2.5(Ask)、3.8(Craft)、3.10(Plan)、3.9(恢复)、3.3/3.11(沙盒)
- §3.3a 长任务与恢复 → Task 3.9(resume)
- §3.3b 沙盒执行 → Task 3.3(工具)、3.11(skill 脚本)
- §3.4 本地工具全表 → Task 3.1-3.5
- §3.5 本地 SQLite 六表(含 workflow_state)→ Task 2.2
- §3.6 本地 MCP 运行时 → Task 3.12
- §3.7 Skill 运行时 → Task 3.11
- §4.1 认证(本地/LDAP/OIDC/token)→ Task 1.4-1.7
- §4.2 AI 网关 + 计量 → Task 1.8-1.10
- §4.3/4.4 商城 → Task 1.11-1.13
- §4.5 知识库 + 远程 MCP → Task 1.14-1.15
- §4.7 管理页 → Task 1.16/4.2
- §5 安全(审批/越界/加密)→ Task 1.13/3.6/3.7
- §6 错误边界 → 分散在各任务测试(超时/重连/审批超时)
- §8 实施阶段 → 全部映射为 Task 1.1-4.6

**待实施时确认的选型**(不影响任务结构,在每个任务内决策并记录):OCR 引擎(tesseract.js 语言包加载方式)、MCP TS SDK 版本 API(@modelcontextprotocol/sdk v1)、中文 FTS5(unicode61 vs trigram)、web_search 端点、Vercel Sandbox 生产凭证接入方式、ai-elements init 产物位置。

**类型/签名一致性检查:**
- `createGatewayModel(serverURL, token, modelID)`(Task 2.3 定义)→ 2.5/3.8 一致引用
- `AgentEvent`(§0.4.3 TS 版)→ 2.3 定义、2.6/3.7/3.8/3.9 消费,字段名固定
- `buildRunConfig(mode, tools, maxSteps)`(Task 2.5)→ 3.8/3.10 复用
- `isAllowed(absPath, allowedDirs)`(Task 3.6)→ 3.1/3.2 复用
- `confirm(requestId, ok)`(Task 3.7)→ preload/ipc 与 ConfirmModal 同签名
- `store.*` 方法(任务 2.2)→ 2.5/3.9/3.10 一致
- 服务端 Go 侧签名(阶段 1)不受客户端改动影响,保持任务 1.x 原文
