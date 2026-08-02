# PicoAide-Next 全量实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全新重写 WorkBuddy 式桌面 AI 办公智能体:Go+Wails+React 桌面客户端(本地跑完整 Agent)+ Go 服务端纯网关(认证/AI 网关/双商城/知识库)。

**Architecture:** 客户端(Agent 引擎基于 google.golang.org/adk/v2,本地工具 + 本地 MCP/Skill 运行时 + SQLite 会话)经 Bearer token 连服务端;服务端(AI 网关 OpenAI 兼容代理 + LDAP/OIDC/本地认证 + Skill/MCP 商城 + 知识库远程 MCP + 极简管理页)。零代码迁移,旧仓库 `/data/picoaide` 仅作参考。

**Tech Stack:** Go 1.24+、Wails v2、React 18+TS+Vite、google.golang.org/adk/v2、gin、modernc.org/sqlite、argon2id、AES-GCM、FTS5。

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
cmd/server/ cmd/desktop/ internal/{agent,localtools,localmcp,localskill,gateway,localstore,serverauth,llmgateway,marketplace,knowledge,serverstore,util} ui/ webadmin/ docs/ scripts/
```

### 0.3 Makefile 目标(任务 1.1 建立,全程维护)

| 目标 | 内容 |
|------|------|
| `make test` | `go test ./... -count=1`(服务端+客户端 Go 代码) |
| `make test-server` | `go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/knowledge/... ./internal/serverstore/... -count=1` |
| `make test-client` | `go test ./internal/agent/... ./internal/localtools/... ./internal/localmcp/... ./internal/localskill/... ./internal/gateway/... ./internal/localstore/... -count=1` |
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

Wails binding 层发送给 React 的事件:

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

工具定义用 OpenAI function-calling schema(`name/description/parameters`),注册在 `internal/agent/tools_local.go` 的 ToolRegistry,格式与 ADK tool.Tool 兼容。

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

Run: `cd /data/picoaide-next && go mod init github.com/picoaide/picoaide && mkdir -p cmd/server cmd/desktop internal/{agent,localtools,localmcp,localskill,gateway,localstore,serverauth,llmgateway,marketplace,knowledge,serverstore,util} ui webadmin docs scripts`
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

**目标:** 桌面端登录服务端,Ask 模式完成一次对话,会话持久化,重启恢复。

**前置:** 阶段 1 完成(依赖 `/v1/chat/completions`、`/api/auth/*`)。

---

### Task 2.1: Wails + React 脚手架

**Files:**
- Create: `cmd/desktop/main.go`、`cmd/desktop/app.go`、`wails.json`、`ui/`(Vite React 模板)、`scripts/build-desktop.sh`

- [ ] **Step 1: 生成脚手架**

Run: `cd /data/picoaide-next && wails init -n picoaide-desktop -t react-ts`(在 `ui/` 生成模板)然后调整目录:模板 `frontend/` → `ui/`,`wails.json` 的 `frontend` 字段改为 `ui`
Expected: `wails dev` 能启动窗口显示 React 欢迎页

- [ ] **Step 2: 清理模板 + 写最小 binding**

Modify: `cmd/desktop/app.go` — 结构体 `App` 方法 `Version() string`(返回 `0.2.0`);`cmd/desktop/main.go` 用 `options.App{...}` 注册 `App`
Modify: `ui/src/App.tsx` — 调用 `window.go.main.App.Version()` 渲染到页面
Run: `wails dev`
Expected: 窗口显示版本号 0.2.0

- [ ] **Step 3: 建立测试目录**

Create: `cmd/desktop/app_test.go`(测试 `App.Version()` 返回非空)
Run: `go test ./cmd/desktop/ -count=1`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: wails react scaffold with version binding"
```

---

### Task 2.2: 本地 SQLite 存储层(localstore)

**Files:**
- Create: `internal/localstore/db.go`、`internal/localstore/conversations.go`、`internal/localstore/messages.go`、`internal/localstore/artifacts.go`、`internal/localstore/memories.go`、`internal/localstore/settings.go`、`internal/localstore/db_test.go`(每个文件配 `_test.go`)
- Create: `internal/localstore/migrations/0001_local.sql`

- [ ] **Step 1: 写测试(红)**

- `db_test.go`:Open(临时目录)创建 schema、版本迁移幂等、路径默认 `~/.local/share/picoaide` 可被覆盖
- `conversations_test.go`:CreateConversation/ListConversations(按 updated_at 倒序)/GetConversation/DeleteConversation(级联删 messages)
- `messages_test.go`:AppendMessage/ListMessages(按 id 升序)/tool_calls JSON 存取往返
- `artifacts_test.go`:AddArtifact/ListArtifacts(按会话)
- `memories_test.go`:SetMemory/GetMemory/ListMemories
- `settings_test.go`:Set/Get(与 serverstore 同语义)
Run: `go test ./internal/localstore/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

复用任务 1.2 的迁移框架思路(复制到 localstore,独立演进);`db.go` 提供 `Open(path string) (*Store, error)` 单例包装
`0001_local.sql` 表结构 = 设计文档 §3.5 的五张表 + `settings`,外键 `ON DELETE CASCADE`
所有时间用 SQLite `datetime('now','localtime')` 统一(与 serverstore 一致)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: local sqlite store for conversations and settings"
```

---

### Task 2.3: ADK 引擎探针(验证 session.Service 适配)

**Files:**
- Create: `internal/agent/provider.go`(Provider 接口 + GatewayProvider 骨架)、`internal/agent/session_sqlite.go`、`internal/agent/engine_probe_test.go`

**目的:** 本项目最大技术风险是 ADK v2 的 `session.Service` 与本地 SQLite 的适配。先写探针测试,只验证"接口契约可编译可跑",不依赖服务端。

- [ ] **Step 1: 写探针测试(红)**

`engine_probe_test.go`:
- 实现最小 `session.Service`(内存 map,参照 `/data/picoaide/internal/agent/adk_run.go` 中 sessionSvc 的调用方式:Create/Get/AppendEvent 被 runner 使用)
- 用 **mock Provider**(在 `internal/agent/provider_mock.go` 定义 `MockProvider` 实现 `StreamChat`,回放固定 SSE 文本)+ `llmagent.New` + `runner.New`(全部参数与 adk_run.go 一致:Config{AppName, Agent, SessionService, AutoCreateSession:true})发一条消息,断言收到文本事件
Run: `go test ./internal/agent/ -run TestEngineProbe -count=1`
Expected: FAIL(接口不存在或编译错)

- [ ] **Step 2: 实现 Provider 接口 + mock**

`provider.go`:
```go
type Provider interface {
  StreamChat(ctx context.Context, req *ChatRequest, cb func(StreamEvent)) error
}
type ChatRequest struct { Model string; System string; Messages []LLMMessage; Tools []ToolDef; MaxTokens int; Temperature float64; DisableTools bool; RequestTimeout int }
type StreamEvent struct { Type string; Data json.RawMessage }  // type: text|reasoning|tool_call|tool_result|done
```
`provider_mock.go`:`MockProvider{Responses []string}` 依次回放文本,发 `done`
Run: 同上
Expected: PASS(探针通过 → ADK 适配可行)

- [ ] **Step 3: 把 session.Service 切到 SQLite**

`session_sqlite.go`:用 localstore 的 messages 表实现 `session.Service` 三方法(Create/Get/AppendEvent;Get 时把 messages 重建为 `session.Event` 序列)
Modify: 探针测试改用 `session_sqlite`(临时目录库)
Run: `go test ./internal/agent/ -run TestEngineProbe -count=1`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: ADK engine probe with sqlite session service"
```

---

### Task 2.4: GatewayProvider(连接服务端 AI 网关)

**Files:**
- Create: `internal/gateway/client.go`、`internal/gateway/client_test.go`、`internal/gateway/auth.go`、`internal/gateway/auth_test.go`
- Modify: `internal/agent/provider.go`(补 `GatewayProvider` 实现 `agent.Provider`)

- [ ] **Step 1: 写测试(红)**

- `client_test.go`(httptest 假网关):`StreamChat` 发送请求体含 `stream:true`、`Authorization: Bearer <token>`;逐块解析 SSE 回调 text/reasoning/done;`[DONE]` 后正常结束
- `auth_test.go`:Login(serverURL, username, password) 成功存 token 到临时文件(权限 0600)、LoadToken/RestoreToken、失败登录返回错误
Run: `go test ./internal/gateway/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`client.go`:基于 `bufio.Scanner` 解析 SSE(`data:` 行 → JSON chunk → 转 `agent.StreamEvent`);超时由 ChatRequest.RequestTimeout 控制
`agent/provider.go` 增:
```go
func NewGatewayProvider(gatewayURL, token, modelID string) Provider
```
内部调用 `gateway.StreamChat`,把 `agent.ChatRequest` 翻译为 OpenAI 请求体(含 tools)
`auth.go`:Login 调 `/api/auth/login` 拿 token → 写 `~/.local/share/picoaide/config.json`(0600);`Restore` 读回;登出删除
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: gateway provider client with sse streaming and login"
```

---

### Task 2.5: Ask 模式引擎(可运行的最小 Agent)

**Files:**
- Create: `internal/agent/engine.go`、`internal/agent/modes.go`、`internal/agent/events.go`、`internal/agent/engine_test.go`
- Modify: `cmd/desktop/app.go`

- [ ] **Step 1: 写测试(红)**

`engine_test.go`(MockProvider,不连真服务端):
- `Run(convID, "你好", ModeAsk)` → 回调收到 text_delta 序列 + 最终 done;messages 表落库(role/content)
- Ask 模式请求 `DisableTools:true`,不注册工具集(断言 mock 收到的 req.DisableTools 为 true)
- `Cancel()` 后 Run 返回 context.Canceled
Run: `go test ./internal/agent/ -run TestEngine -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`events.go`:UI 事件结构(§0.4.3 契约)+ `func Emit(cb, ev)` 工具
`engine.go`:
```go
type Engine struct { store *localstore.Store; provider agent.Provider; cfg Config }
type Config struct { Model string; MaxIter int; SysPrompt string; AllowedDirs []string }
func NewEngine(store, provider, cfg) *Engine
func (e *Engine) Run(ctx, convID int64, content string, mode Mode, cb func(Event)) error
```
流程:读会话 → 构造 messages → `ADKRun`(先直接 import 旧库函数签名的等价实现,或自写 llmagent+runner 循环——**以探针 Task 2.3 落定为准**)→ 事件转 UI Event → 落库
`modes.go`:Ask 置 DisableToolCall;Plan/Craft 骨架(阶段 3 完成,先返回 ErrNotImplemented)
`app.go`:binding `RunAsk(convID, content)` 起 goroutine,`OnEvent(cb)` 注册回调,事件经 Wails 事件总线推前端
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: ask-mode agent engine with event emission"
```

---

### Task 2.6: React 聊天 UI

**Files:**
- Create: `ui/src/api/events.ts`(Wails event 封装)、`ui/src/api/client.ts`、`ui/src/components/{ChatInput,Messages,MessageItem,Markdown}.tsx`、`ui/src/pages/Main.tsx`、`ui/src/stores/chat.ts`(Zustand)
- Modify: `ui/src/App.tsx`、`ui/package.json`

- [ ] **Step 1: 安装依赖 + 状态层**

Run: `cd ui && npm i zustand react-markdown remark-gfm`
Create: `ui/src/stores/chat.ts` — state:`conversations[]`、`messages[]`、`streaming bool`、`mode`;actions:`newConversation/loadConversation/sendMessage/onEngineEvent/appendDelta/selectConversation`
Create: `ui/src/api/events.ts` — 封装 `window.runtime.EventsOn("agent_event", cb)` 分发到 store
Run: `npm run build`
Expected: 编译通过

- [ ] **Step 2: 组件**

- `Markdown.tsx`:react-markdown + remark-gfm 渲染 assistant 文本(代码块/表格)
- `Messages.tsx`:渲染 message 列表,streaming 时展示流式增量文本,自动滚动到底部(尾随元素 `scrollIntoView`)
- `ChatInput.tsx`:多行 textarea + Enter 发送 + 模式切换(Ask/Plan/Craft 三按钮,阶段 3 前仅 Ask 可用)
- `Main.tsx`:左侧会话列表(新建/切换/删除)+ 右侧聊天区
Run: `npm run build && wails dev`
Expected: 界面出现,输入发送后在 UI 看到流式文本(需本机服务端 + 已登录)

- [ ] **Step 3: Commit**

```bash
git add ui/src ui/package.json ui/package-lock.json && git commit -m "feat: react chat ui with streaming render"
```

---

### Task 2.7: 登录页 + token 持久化

**Files:**
- Create: `ui/src/pages/Login.tsx`、`ui/src/stores/auth.ts`、`ui/src/api/auth.ts`
- Modify: `cmd/desktop/app.go`(binding `Login/LoadAuth`)、`ui/src/App.tsx`(路由:未登录 → Login)

- [ ] **Step 1: binding + store**

`app.go` 增:
```go
func (a *App) Login(serverURL, username, password string) error   // gateway.Auth.Login + 配置持久化
func (a *App) LoadAuth() (AuthInfo, error)                         // 读 config.json,serverURL+user(不含 token)
func (a *App) Logout() error
```
`ui/src/api/auth.ts` 封装;`stores/auth.ts`:`status: idle|loading|authed`,persist 到 localStorage(仅 URL/用户名,token 在 Go 侧)
- [ ] **Step 2: Login 页**

Form:服务端 URL + 用户名 + 密码 + 登录按钮 + 错误提示(401 显示"用户名或密码错误",网络错误显示"无法连接服务器");登录成功跳 Main
`App.tsx`:用 `LoadAuth()` 判断初始路由
Run: `wails dev`,连本机服务端登录成功/失败两分支验证
Expected: 正常

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: login page with token persistence"
```

---

### Task 2.8: 离线检测与重连

**Files:**
- Create: `internal/gateway/health.go`、`internal/gateway/health_test.go`、`ui/src/stores/connection.ts`

- [ ] **Step 1: 测试(红)**

`health_test.go`:假服务端 `GET /api/auth/me` → Ping 返回 true/网络错误 false/401 false
Run: `go test ./internal/gateway/ -run TestPing -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`health.go`:`Ping(timeout)` 每 15s 轮询(后台 goroutine,可在 app.go 启动/停止),结果事件 `connection_status` 推前端
`ui/src/stores/connection.ts`:状态 `online|offline`,顶部横幅提示"已断开,将自动重连";发送时 offline 直接本地报错提示
Run: 同上 + `wails dev` 停服务端观察横幅
Expected: PASS/正常

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: offline detection and reconnect banner"
```

---

### Task 2.9: 阶段 2 验收

- [ ] **Step 1: 全量测试**

Run: `make test-client && go test ./... -count=1`
Expected: PASS

- [ ] **Step 2: 手工场景(本机服务端 + wails dev)**

1. 首次启动 → 登录页 → 输 URL/账号密码 → 进入主界面
2. 新建会话 → 输入"你好,介绍你自己" → 流式回复 → 刷新重启客户端 → 会话列表仍在 → 点开历史可见消息
3. 停掉服务端 → 顶部离线横幅出现 → 重启服务端 → 自动恢复在线
Expected: 三场景全部通过

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.2.0 -m "client skeleton milestone"
```

---

## 阶段 3:本地能力(约 3-4 周)

**目标:** Craft 模式全流程:真实文件任务("汇总桌面 Word 成 500 字汇报存回桌面")跑通;本地工具 + 高危确认 + Skill + MCP 插件 + 产物面板。

---

### Task 3.1: 文件工具

**Files:**
- Create: `internal/localtools/filesystem.go`、`internal/localtools/filesystem_test.go`、`internal/agent/tools_local.go`

- [ ] **Step 1: 写测试(红)**

用 `t.TempDir()` 建目录树,每工具验证:
- `file_read(path, encoding auto)`:UTF-8 正常;GBK 文件正确解码(先写 GBK 字节,断言输出中文)
- `file_write/file_edit/file_append`:内容正确、越界路径(`/etc/passwd`、`../x`)返回明确错误
- `file_delete`:存在删除、不存在报错
- `file_list/file_search`:递归、按名过滤
Run: `go test ./internal/localtools/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`filesystem.go`:结构体 `FileTools{AllowedDirs []string}` + 方法签名 `func (f *FileTools) List() []agent.ToolDef` / `Execute(name string, args map[string]any) (any, error)`;路径校验:`filepath.Abs` 后必须落在某 AllowedDir 前缀下;编码检测:UTF-8 BOM/校验 → GBK(用 `golang.org/x/text/encoding/simplifiedchinese` 探测,探测失败按 UTF-8 读)
`tools_local.go`:把 localtools 包装成 `agent.ToolRegistry` 注册表(与 ADK tool.Tool 兼容的封装)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: local filesystem tools with encoding detection"
```

---

### Task 3.2: 终端工具

**Files:**
- Create: `internal/localtools/terminal.go`、`internal/localtools/terminal_test.go`

- [ ] **Step 1: 写测试(红)**

- `command_exec("echo hello")` → stdout 正确、exit code 0
- 超时:`sleep 5` with 1s timeout → 返回超时错误且进程被 kill
- 输出截断:cat 10KB 文件 → 输出 ≤50KB 且有截断标记
Run: `go test ./internal/localtools/ -run TestTerminal -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`terminal.go`:`Execute(command string, cwd string, timeoutSec int) (stdout, stderr string, code int, err error)`;`exec.CommandContext` + 超时 kill(进程组:`Setpgid` + `kill -pgid`,防止子进程残留);cwd 默认工作目录;危险命令清单(首词 ∈ `rm,mv,dd,mkfs,shutdown,reboot,sudo` 时标记 `needsConfirm:true`,由确认协议拦截)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: terminal tool with timeout and output truncation"
```

---

### Task 3.3: Web 工具

**Files:**
- Create: `internal/localtools/web.go`、`internal/localtools/web_test.go`

- [ ] **Step 1: 写测试(红)**

- `web_fetch(url)`:httptest 假服务器返回 HTML → 提取正文文本(剥标签)与链接
- `web_search(query)`:假"搜索 API"响应 → 解析出结果列表;对目标站点不可达 → 明确错误
Run: `go test ./internal/localtools/ -run TestWeb -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`web.go`:`web_fetch`(GET + 5s 超时 + 大小上限 2MB + HTML 转文本:`golang.org/x/net/html` 提取 body 文本与 `<a href>`)、`web_search`(可配置搜索引擎端点,默认 DuckDuckGo HTML 端点或 `https://html.duckduckgo.com/html/?q=`,解析结果;实施时验证端点可用,不可用则换 Bing HTML 端点)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: web fetch and search tools"
```

---

### Task 3.4: 屏幕截图 + OCR

**Files:**
- Create: `internal/localtools/screen.go`、`internal/localtools/screen_test.go`、`internal/localtools/ocr.go`

- [ ] **Step 1: 写测试(红)**

- `screen.go`:`Capture(region?) (imagePNGB64 string, error)`;测试环境(CI 无显示器)下跳过,本地手工验证
- `ocr.go`:`OCRFromImage(pngBytes) (string, error)`;测试:用含文本的合成图片(Pillow 无 Go 依赖 → 用 `image` 包画黑白文本近似)验证返回非空
Run: `go test ./internal/localtools/ -run 'TestScreen|TestOCR' -count=1`
Expected: FAIL(OCR 引擎未接入)

- [ ] **Step 2: 实现**

`screen.go`:`github.com/kbinani/screenshot` 捕获主屏 → `png.Encode` → base64
`ocr.go`:引擎二选一(实施时在本机实测,选可用的):
- 优先:`github.com/otiai10/gosseract/v2`(Tesseract,需系统装 `tesseract-ocr` + `chi_sim` 语言包)
- 备选:纯 Go `github.com/auula/gos` 或 onnxruntime binding(无系统依赖)
**惰性加载:** 首次调用才初始化引擎(单例 + sync.Once),失败降级:返回错误信息"OCR 不可用(未安装引擎)",截图工具照常工作
Run: 同上 + 手工:截图 → OCR 输出中文文本
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: screen capture and lazy-loaded OCR"
```

---

### Task 3.5: 剪贴板工具

**Files:**
- Create: `internal/localtools/clipboard.go`、`internal/localtools/clipboard_test.go`

- [ ] **Step 1: 写测试(红)**

`clipboard_write` → `clipboard_read` 往返一致;读操作标记 `needsConfirm:true`(敏感)
Run: `go test ./internal/localtools/ -run TestClipboard -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`github.com/atotto/clipboard`:Write/Read;`clipboard_read` 工具元数据 `needsConfirm:true`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: clipboard tools"
```

---

### Task 3.6: 可访问目录模型 + 越界防护

**Files:**
- Create: `internal/agent/dirs.go`、`internal/agent/dirs_test.go`
- Modify: `internal/localtools/filesystem.go`(改用共享的路径校验)

- [ ] **Step 1: 写测试(红)**

`dirs_test.go`:`IsAllowed(path, allowedDirs)` — 前缀匹配、`/home/u/a` vs `/home/u/ab` 不误判(必须 `allowed + "/"` 边界)、符号链接 `filepath.EvalSymlinks` 后校验(指向外部 → 拒绝)
Run: `go test ./internal/agent/ -run TestDirs -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`dirs.go`:`func IsAllowed(absPath string, allowedDirs []string) bool`;工具层统一调用;Engine 启动时从 settings 读 `allowed_dirs`(默认 `workspaces/`)
Modify: `filesystem.go` 删掉自带校验,全部走 `IsAllowed`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: shared allowed-dirs path guard"
```

---

### Task 3.7: 高危操作确认协议

**Files:**
- Create: `internal/agent/confirm.go`、`internal/agent/confirm_test.go`
- Modify: `internal/agent/engine.go`、`cmd/desktop/app.go`、`ui/src/components/ConfirmModal.tsx`

- [ ] **Step 1: 写测试(红)**

`confirm_test.go`:`Engine.Run` 中注册工具返回 `needsConfirm` → 引擎发 `confirm_required` 事件并**暂停**(工具结果未返回给 ADK)→ `Confirm(ok=true)` 后继续 → 断言工具执行结果出现在后续事件;`Confirm(ok=false)` → 工具返回拒绝错误给 Agent;60s 未确认 → 自动拒绝
Run: `go test ./internal/agent/ -run TestConfirm -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`confirm.go`:确认状态机(请求表 `map[requestID]chan bool` + 超时);引擎在 ADK 工具执行前拦截:`tool needsConfirm` → 发事件 → 等 channel → 决定执行/拒绝
`app.go` binding:`Confirm(requestID string, ok bool) error`
`ConfirmModal.tsx`:弹窗(操作名 + 目标路径 + 原因 + 允许/拒绝按钮 + 60s 倒计时)
Run: 同上 + `wails dev` 手工:让 Agent 执行 `file_delete` 观察弹窗
Expected: PASS/正常

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: high-risk operation confirmation protocol"
```

---

### Task 3.8: Craft 模式全流程

**Files:**
- Modify: `internal/agent/modes.go`、`internal/agent/engine.go`、`internal/agent/engine_test.go`、`ui/src/stores/chat.ts`、`ui/src/components/ToolCalls.tsx`

- [ ] **Step 1: 写测试(红)**

`engine_test.go` 增(Craft):MockProvider 设计两轮:第一轮 LLM 返回 tool_call(file_read),第二轮返回文本 → 断言:工具执行结果回传、事件流含 tool_start/tool_end、最终 done;`MaxIter` 到达(让 mock 永远返回 tool_call)→ 引擎报错并提示"达到最大迭代次数"
Run: `go test ./internal/agent/ -run TestCraft -count=1`
Expected: FAIL(工具未接入引擎)

- [ ] **Step 2: 实现**

`engine.go`:注册全部 localtools 到 ToolRegistry;Craft 模式:请求带 tools,完整循环(ADK runner 默认行为);MaxIter 上限;事件 `tool_start/tool_end/tool_error` 按 §0.4.3 发
`ui/src/components/ToolCalls.tsx`:折叠卡片显示工具名/输入/输出/耗时/失败标红
Run: 同上 + 手工:登录后 Craft 模式让 Agent 读本机文件
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: craft mode full agent loop with tool cards"
```

---

### Task 3.9: 产物面板

**Files:**
- Create: `internal/agent/artifacts.go`、`internal/agent/artifacts_test.go`
- Modify: `ui/src/components/ArtifactsPanel.tsx`、`ui/src/pages/Main.tsx`

- [ ] **Step 1: 写测试(红)**

`artifacts_test.go`:工具写入 `workspaces/<conv>/` 下文件 → 引擎检测到(定时扫描或写入钩子)→ `artifact` 事件(路径/类型/大小)→ localstore.artifacts 落库
Run: `go test ./internal/agent/ -run TestArtifacts -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`artifacts.go`:工作目录管理器(创建/清理);文件写入后扫描(每次工具结束后扫描该会话目录,新增文件 → 事件 + 落库);类型按扩展名(map:`.md→report,.png/.jpg→image,.html→html,.pptx→ppt,.docx→docx,.xlsx→xlsx,其他→file`)
`ArtifactsPanel.tsx`:右侧面板列出当前会话产物,点击"在文件夹中显示"(binding `RevealInFolder(path)` → `exec open/explorer/xdg-open`)
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: artifact detection and side panel"
```

---

### Task 3.10: Plan 模式

**Files:**
- Modify: `internal/agent/modes.go`、`internal/agent/modes_test.go`、`ui/src/components/ChatInput.tsx`、`ui/src/stores/chat.ts`

- [ ] **Step 1: 写测试(红)**

`modes_test.go`:Plan 首轮 `DisableTools:true` 产出计划 → 用户确认(`ApprovePlan()`)→ 同会话第二轮带工具执行;拒绝则终止
Run: `go test ./internal/agent/ -run TestPlan -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`modes.go`:Plan 状态(会话表加 `plan_status` 列:planning|approved|rejected|executing;迁移 `0002_plan.sql`);UI:Plan 消息后显示"执行计划"按钮
Run: 同上 + 手工
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: plan-then-execute mode"
```

---

### Task 3.11: Skill 运行时

**Files:**
- Create: `internal/localskill/loader.go`、`internal/localskill/loader_test.go`、`internal/localskill/installer.go`、`internal/localskill/installer_test.go`
- Modify: `internal/agent/engine.go`、`ui/src/pages/Settings.tsx`

- [ ] **Step 1: 写测试(红)**

- `loader_test.go`:构造 `skills/<name>/`(SKILL.md + metadata.yaml + scripts/run.py)→ `Load(name)` 返回 `{Instruction string; Entrypoint string}`;缺 SKILL.md 报错
- `installer_test.go`:从假商城端点下载 tar.gz → 解压到 skills 目录(路径穿越防护:拒绝 `../` 条目)→ 版本记录在 settings;卸载删目录
Run: `go test ./internal/localskill/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`loader.go`:`Load(skillsDir, name)` 读 SKILL.md 全文为 instruction,metadata 校验(version 语义化);`installer.go`:调 `gateway.Marketplace` 下载 archive(带 token)→ 校验 tar 条目(复用 1.11 的 ValidatePackage 思路,客户端独立实现一份)→ 解压;已装列表记 settings `skills.installed`
`engine.go`:启动时把已装 skill 的 Instruction 拼入 SysPrompt(`## Skills\n` + 各 skill 正文);`skill_exec` 工具注册(scripts 入口,command 子进程,60s 超时,输出截断)
`Settings.tsx`:技能列表(安装/更新/卸载/详情)
Run: 同上 + 手工:安装示例技能 → 对话中生效
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: skill loader installer and prompt injection"
```

---

### Task 3.12: MCP 插件运行时

**Files:**
- Create: `internal/localmcp/runner.go`、`internal/localmcp/runner_stdio.go`、`internal/localmcp/runner_http.go`、`internal/localmcp/adk_toolset.go`、`internal/localmcp/runner_test.go`
- Modify: `internal/agent/engine.go`、`ui/src/pages/Settings.tsx`

- [ ] **Step 1: 写测试(红)**

- `runner_stdio_test.go`:假 stdio MCP server(起 `go run` 测试进程或 Python 脚本,响应 `initialize`/`tools/list`/`tools/call`)→ 客户端 `ListTools()` 返回工具、`CallTool(name, args)` 返回结果;进程崩溃 → `Restart()` 后可用(自动重启 1 次)
- `runner_http_test.go`:httptest 假 MCP HTTP server → 直连调用成功
Run: `go test ./internal/localmcp/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

选型:用 `github.com/mark3labs/mcp-go`(Go MCP client/server 库,实施时验证其 v1 版本 API,与本设计签名对齐)
- `runner.go`:插件注册表(settings 存已装插件 id → 启动时拉配置 → 起 runner)
- `runner_stdio.go`:spawn(command,args,env 注入)→ JSON-RPC over stdio;崩溃检测(进程退出)→ 自动重启 1 次
- `runner_http.go`:HTTP client → `POST {url}` JSON-RPC
- `adk_toolset.go`:把 mcp-go 的工具定义转换为 `agent.ToolDef` + 执行桥(适配 engine 的工具调用路径)
`engine.go`:启动时加载已启用插件,工具并入注册表;插件工具执行失败 → tool_error 事件
`Settings.tsx`:插件列表(启用/禁用/查看配置脱敏/卸载)
Run: 同上 + 手工:安装 xiaohongshu 类插件调用
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: local MCP plugin runtime with stdio and http"
```

---

### Task 3.13: 设置页

**Files:**
- Create: `ui/src/pages/Settings.tsx`(完整版)、`internal/localstore/settings.go` 扩展
- Modify: `cmd/desktop/app.go`(settings bindings)

- [ ] **Step 1: 实现**

设置项(binding `GetSettings/SetSettings`):
- 模型:拉 `/v1/models` 选择默认模型(settings `model.default`)
- 工作目录:默认 `~/.local/share/picoaide/workspaces`,可改
- 可访问目录:列表增删(settings `allowed_dirs`,JSON 数组)
- 插件/技能:复用 3.11/3.12 的管理区
- 服务端信息:URL/用户名显示,登出按钮
Run: `wails dev` 逐项验证保存/重启后生效
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: settings page for model dirs and plugins"
```

---

### Task 3.14: 阶段 3 验收

- [ ] **Step 1: 全量测试**

Run: `make test && go test ./... -count=1`
Expected: PASS

- [ ] **Step 2: 真实任务端到端(本机)**

准备:桌面目录放 2-3 个 .docx/.md 文件;服务端知识库上传一篇文档
1. Craft 模式:"汇总桌面/文档里的文件,生成 500 字汇报保存到桌面" → 产物出现在产物面板 → 打开文件内容正确
2. 高危:要求 Agent 删除文件 → 弹窗 → 拒绝后 Agent 收到拒绝
3. 技能:安装一个商城技能 → 新对话中生效
4. 插件:安装 stdio 插件 → 对话中调用成功
5. 知识库:Ask Agent 查询知识库文档 → 返回正确内容
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
- Create: `scripts/pkg-linux.sh`、`scripts/pkg-windows.sh`、`scripts/pkg-macos.sh`、`Makefile` 增 `pkg-*` 目标

- [ ] **Step 1: 编写打包脚本**

- Linux:Wails 产出二进制 → `deb`(用 `nFPM` 或 `dpkg-deb`,依赖 libwebkit2gtk-4.1)+ `AppImage`(可选);产物到 `dist/`
- Windows:Wails NSIS 安装器(icon/名称/版本);产物 `dist/picoaide-setup.exe`
- macOS:`wails build -platform darwin` + `dmg`(用 `hdiutil` 或 `create-dmg`)
Run: 三平台各跑一次(本机为 Linux 时,Windows/macOS 在 CI 或对应机器验证)
Expected: 三平台安装包产出,安装后可启动登录

- [ ] **Step 2: 版本号注入**

`wails.json`/`app.go` 从 `VERSION` 环境变量注入(`-X main.Version`),安装包文件名带版本
Run: `make pkg-linux VERSION=0.4.0`
Expected: 产物名 `picoaide_0.4.0_amd64.deb`

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: three-platform packaging scripts"
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

内容以设计文档(`docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md`)为准,更新为实际实现细节(端点/表/目录有出入处以代码为准)
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
- Modify: `internal/agent/engine.go`、`ui/src/components/Messages.tsx`、`internal/localstore/db.go`

- [ ] **Step 1: 实施与验证**

- 流式渲染节流:React `useDeferredValue`/requestAnimationFrame 合并 text_delta 渲染(>10 delta/s 时),验证长回复无卡顿
- SQLite WAL 自动检查点:`PRAGMA wal_autocheckpoint(1000)`,会话页加载 >200 条消息时分页(先加载最近 100,向上滚动加载更多)
- OCR 惰性加载回归确认(3.4 已做,此处复验)
Run: `wails dev` 长对话(50+ 轮)滚动流畅;`time go test ./...` 无明显退化
Expected: 流畅

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "perf: streaming throttle and message pagination"
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

在打包产物上:启动 → 自动登录(预设 config.json)→ 发起一次 Ask → 断言收到 done 事件(用 `wails dev` 日志或临时 E2E hook 输出结果文件)
Run: 打包机上执行
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: e2e smoke scripts"
```

---

### Task 4.6: 发布

- [ ] **Step 1: 版本与发布**

```bash
make pkg-linux VERSION=0.4.0 && make pkg-windows VERSION=0.4.0 && make pkg-macos VERSION=0.4.0
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
- §3.1 客户端技术栈 → Task 2.1(壳)/2.2(DB)/2.3(ADK)/2.4(网关客户端)
- §3.3 Agent 引擎三模式 → Task 2.3/2.5(Ask)、3.8(Craft)、3.10(Plan)
- §3.4 本地工具全表 → Task 3.1-3.5
- §3.5 本地 SQLite 五表 → Task 2.2
- §3.6 本地 MCP 运行时 → Task 3.12
- §3.7 Skill 运行时 → Task 3.11
- §4.1 认证(本地/LDAP/OIDC/token)→ Task 1.4-1.7
- §4.2 AI 网关 + 计量 → Task 1.8-1.10
- §4.3/4.4 商城 → Task 1.11-1.13
- §4.5 知识库 + 远程 MCP → Task 1.14-1.15
- §4.7 管理页 → Task 1.16/4.2
- §5 安全(高危确认/越界/加密)→ Task 1.13/3.6/3.7
- §6 错误边界 → 分散在各任务测试(超时/重连/确认超时)
- §8 实施阶段 → 全部映射为 Task 1.1-4.6

**待实施时确认的选型**(不影响任务结构,在每个任务内决策并记录):OCR 引擎(gosseract vs 纯 Go)、MCP Go 库(mark3labs/mcp-go 版本 API)、中文 FTS5(unicode61 vs trigram)、web_search 端点、Wails 前端模板目录名。

**类型/签名一致性检查:**
- `agent.Provider`/`agent.StreamEvent`(Task 2.3 定义)→ 2.4/2.5/3.8 一致引用
- `agent.ToolDef`(Task 3.1 引入)→ 3.11/3.12 复用
- `localstore.Store`(Task 2.2)→ 2.3/2.5/3.6/3.9 一致
- `Event`(§0.4.3)→ 2.5 定义、2.6/3.7/3.8/3.9 消费,字段名固定
- `Confirm(requestID, ok)`(Task 3.7)→ app.go binding 与 ConfirmModal 同签名
