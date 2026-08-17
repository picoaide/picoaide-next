# 数据库

## 1. 服务端(modernc.org/sqlite,`data/picoaide.db`)

迁移在 `internal/serverstore/migrations/`(0001–0021,**0007 已废弃**,文件不存在)。

### users(0001)
| 列 | 说明 |
|----|------|
| id | PK 自增 |
| username | 唯一,登录名 |
| display_name / email | 显示名/邮箱 |
| password_hash | argon2id 哈希(local 模式) |
| source | `local` \| `ldap` \| `oidc`,默认 local |
| is_admin | 0/1 |
| status | 1=启用 |
| quota_tokens | 0021 新增,月流量配额三态:NULL=跟随全局默认(`usage.monthly_quota`),0=不限,>0=按月限额;admin 一律豁免(网关强制) |
| created_at / updated_at | datetime,localtime |

### groups + user_groups(0001)
`groups(id, name 唯一, created_at)`;`user_groups(user_id, group_id, PK 复合)`。组用于知识库授权(本地账号无组映射,以用户级授权兜底)。

### settings(0001)
`settings(key PK, value)`。键: `auth.mode` / `ldap.*` / `oidc.*` / `gateway.default_model` / `gateway.rate_limit` / `usage.monthly_quota`(员工默认月配额,0=不限)/ `web.allow_private` / `web.search_endpoint` 等(见 04-auth.md、03-api-reference.md)。

### api_tokens(0002)
`id, user_id→users, token_hash(唯一), name(默认 'desktop'), created_at, expires_at(NOT NULL), last_used_at, revoked(0/1)`;索引 `idx_tokens_user`。明文 token 不落库,只存哈希;90 天过期。

### gateway_providers + models(0003)
- `gateway_providers(id, name 唯一, base_url, api_key_enc, models JSON '[]', enabled 0/1)`——`api_key_enc` 为 AES-GCM 密文(`enc:v1:`)。
- `models(id, name 唯一, provider_id→providers, display_name, default_params JSON '{}')`。

### usage(0004)
`id, user_id, model, prompt_tokens, completion_tokens, created_at`;索引 `idx_usage_user_time`。网关每次调用计量写入;`CleanupPendingUsage` 清理挂起记录(全零待定行)。月度聚合:`UserMonthlyUsage`(当月 SUM,走索引)/ `UserMonthlyUsageBatch`(管理页批量附用量);配额判定 `EffectiveQuota`(admin 豁免 → 个人覆盖 → 全局默认),网关转发前检查,超限 429 `QUOTA_EXCEEDED`。

### skills(0005)
`id, name 唯一, version, description, author, git_url, git_ref(默认 main), checksum, enabled(0/1,下架置 0 不删行), created_at, updated_at`。bootstrap 建议清单只返回 enabled=1。

### mcp_servers + mcp_config_downloads(0006)
- `mcp_servers(id, name, description, transport('stdio'|'http'), command, args JSON '[]', url, env JSON '{}'(敏感值 AES-GCM 加密), headers JSON '{}', enabled, created_at, updated_at)`。
- `mcp_config_downloads(id, user_id, mcp_id, created_at)`——凭证拉取审计(防批量导出);索引 `idx_downloads_user`。
- **无 mcp_server_grants 表**:建议安装制,不建授权表。

### 知识库(0008,kb_ 前缀 6 表 + 1 FTS 虚拟表)
| 表 | 列 |
|----|----|
| kb_folders | id, name, parent_id(默认 0=根), created_at |
| kb_documents | id, folder_id(默认 0), title, content, content_type(默认 text), size, source(默认 upload), created_by, created_at |
| kb_folder_users | folder_id, username(PK 复合)——用户授权 |
| kb_folder_groups | folder_id, group_id(PK 复合)——组授权 |
| kb_audit_logs | id, username, action, detail, created_at |
| kb_fts | FTS5 虚拟表(title, content, content='kb_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2')——外内容表 + 增删改触发器(kb_ai/kb_ad/kb_au)同步索引 |

### admin_sessions(0009)
`id(PK, 随机), user_id, csrf_key, expires_at`。管理端 24h 会话 + CSRF 校验(见 04-auth.md §4)。

## 2. 客户端(better-sqlite3,`desktop/src/main/store/migrations.ts`)

用户数据目录下 SQLite,4 张业务表 + schema_migrations:

| 表 | 列 | 说明 |
|----|----|------|
| conversations | id, title(默认 ''), mode(默认 'ask'), status(默认 'done'), model(默认 ''), workspace(默认 ''), created_at, updated_at | 会话;status 为中断恢复标记 |
| messages | id, conversation_id(CASCADE), role, content, reasoning(默认 ''), tool_calls JSON '[]', tool_call_id, tool_name, is_error(0/1), created_at | 消息;工具调用链与错误标记;索引 idx_messages_conv |
| artifacts | id, conversation_id(CASCADE), path, type(默认 'file'), size, created_at | 产物登记(磁盘产物路径) |
| settings | key PK, value | 可访问目录/建议安装管理等(键见 08-development.md) |
| schema_migrations | version PK, applied_at | 迁移记录 |

客户端迁移为数组顺序执行(`migrations[i]` 对应 version i+1),事务包裹。
