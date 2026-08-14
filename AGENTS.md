# AGENTS.md — PicoAide-Next

> 本文件是给 AI 编码代理的项目级指令。先读它,再读 `docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md`(架构设计)与 `docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md`(实施计划,任务级 TDD 步骤)。代码与文档冲突时以本文 + 设计文档为准,并同步修订计划。

## 1. 项目是什么(一句话)

**企业内网桌面 AI 办公智能体**:员工安装 Electron 客户端,登录企业内网 Go 服务端后**零配置**直接使用;AI Agent 在客户端本地运行,可操作本机文件/终端/浏览器(经本地 CDP 插件桥)/屏幕,LLM 调用统一经服务端网关(密钥不出服务端、按用户计量)。

## 2. 第一性原理(设计为什么是这样,改设计前先过一遍)

1. **Agent 必须本地运行**——操作本机文件/浏览器/屏幕只能在本地完成;会话/记忆本地 SQLite,离线可浏览历史 → 客户端承载完整 Agent 引擎。
2. **企业员工零配置**——员工装客户端登录即用;所有功能配置(模型/上游密钥/技能/MCP/凭证/知识库权限)由管理员在服务端管理页完成;登录后 `GET /api/config/bootstrap` 统一下发(默认模型+建议清单)。
3. **密钥不出服务端**——LLM 密钥只存服务端(AES-GCM + master key 文件),客户端只持登录 token,LLM 调用全走网关代理。
4. **高危操作必须人确认**——删除/截屏/剪贴板读/命令/浏览器操作/kb_upload 等 → 引擎层审批门控(60s 超时拒绝),不依赖任何 SDK 的审批 API。
5. **不可信代码必须隔离**——Agent 生成脚本/技能脚本在**本地受限会话**(`@ai-sdk/sandbox-just-bash`)执行,无用户文件权限、数据不出本机;不用 Vercel 云端沙盒。
6. **消息即状态**——不做状态机级 durable;任务中断 = `status` 标记 + 从最后一条 user 消息重跑(截断重放),零额外运行时。
7. **商城与知识库均为管理员授权制(严格默认)**——资源(知识库文件夹/技能/MCP)上架/创建后**未授权用户一律不可见不可用**(404 不泄露存在性);授权对象 = 用户或部门组(@组名约定,组名大小写不敏感);admin 恒全量不落表;授权变更必审计(kb_audit_logs);本地账号经 `PUT /api/admin/users/:id/groups` 进部门组,LDAP 登录每次全量同步组(空组即回收);改密/降权/禁用自动吊销全部 API token。
8. **浏览器操作 = 员工自己的浏览器**——客户端主进程固定监听 `127.0.0.1:54321`,Chrome/Edge 插件默认直连即装即用;纯本地 WebSocket 通道,不经服务端、离线可用。
9. **UI 不自写、函数不复刻**——见 §3 工程原则。

## 3. 不可违背的工程原则

1. **UI 组件一律使用 shadcn/ui,禁止自写 UI 组件**:按钮/输入框/文本域/卡片/对话框/表格/图表/下拉/开关等全部来自 `components/ui/`(不足时 `npx shadcn@latest add <name>` 拉取)。业务组件只做**组合与状态编排**,内部用 shadcn 原语 + Tailwind 工具类,不写裸 `<button>`、不写自定义样式组件。客户端 renderer 与 webadmin 统一。
2. **函数尽量复用,禁止复制粘贴**:新增代码前先搜仓库是否已有等价函数;同一逻辑只实现一次,重复 2 次即提取共享模块(客户端:`tools/paths.ts` 的 `isAllowed`、审批门控、编码检测、gateway 连接器;服务端:serverstore DAO、util 包、公共中间件)。
3. **TDD 红-绿-commit**:每个任务先写测试(红)→ 实现(绿)→ commit;每个非平凡逻辑模块必须有可运行测试(Go `_test.go` / TS `*.test.ts`)。
4. **每任务结束必须 commit**,提交信息 `feat:|fix:|test:|docs:|chore:` 单行 ≤72 字符。
5. **零配置原则**:客户端不得新增"员工功能配置"入口(模型/网关/插件配置);唯一本地配置项 = 可访问目录(安全边界)+ 建议安装管理 + 刷新按钮。
6. **安全边界不得绕过**:审批门控、`isAllowed` 路径校验、命令白名单判定、凭证不落盘(仅内存/启动重拉)、TOFU 指纹校验、插件启发式审批——一律不许为省事而移除。
7. **所有服务端 HTTP 走 `session.defaultSession.fetch`**(证书校验/TOFU 生效);登录页拒绝非 HTTPS 远程地址。

## 4. 架构总览

```
renderer = dsh Web UI(自建同名 frontend 包 + 品牌 shim)──HTTP/WS 127.0.0.1:随机端口──▶ Electron main
  ├─ Cordis 树:dsh-base + dsh-web-app bundle + 自研插件(auth-gate/gateway-model/bootstrap)
  ├─ 引擎/UI/工具/审批/沙盒/skill/MCP 全部来自 dsh;会话 = dsh jsonl 会话日志(DSH_HOME=userData/dsh)
  └─ 服务端连接器(登录/健康/bootstrap/TLS,TOFU)
main ──HTTPS/Bearer token──▶ Go 服务端
  ├─ 认证:local/LDAP/OIDC + api_tokens(90天过期)+ --bootstrap-admin
  ├─ AI 网关:/v1/chat/completions 代理 + per-user 限流 + usage 计量
  ├─ 商城:skills(建议清单)+ mcp_servers(凭证 AES-GCM,拉取限流+审计)
  ├─ 知识库:FTS5 前缀查询 + 远程 MCP(kb_search/read/list/upload,权限校验)
  └─ 管理页 webadmin(shadcn):用户/网关/用量/商城/知识库 —— 全部配置入口
```

## 5. 技术栈

- **服务端**:Go 1.24+、gin、modernc.org/sqlite(含 FTS5)、argon2id、AES-GCM、go-ldap/v3、coreos/go-oidc/v3、go-git
- **客户端**:Electron + electron-vite + TypeScript + React 18 + shadcn/ui + Tailwind + Zustand + Vercel AI SDK(`ai`/`@ai-sdk/openai-compatible`/`@ai-sdk/sandbox-just-bash`)+ better-sqlite3(`@electron/rebuild`)+ `@modelcontextprotocol/sdk` + tesseract.js + iconv-lite + mammoth + Vitest
- **浏览器插件**:Chrome MV3(manifest/background/content,无 options 页,零配置直连 54321)
- **webadmin**:Vite + React + shadcn/ui(与客户端统一)+ react-router-dom

## 6. 目录结构

```
cmd/server/            # 服务端入口(--bootstrap-admin 等)
internal/              # serverauth/llmgateway/marketplace/knowledge/serverstore/util/bootstrap
desktop/               # Electron 客户端(壳 + dsh 内嵌)
  src/main/            #   index(生命周期)/dsh-boot(进程内 boot)/picoaide-patches(安全补丁层)/plugins/(auth-gate/gateway-model/bootstrap)/server-connector/(auth/bootstrap/health/tls/config)/util/
  brand-shim/          #   自建 @deepseek-ai/dsh-client-ui-primitives(星导出遮蔽品牌组件)
  web/                 #   自建 @deepseek-ai/dsh-web-frontend(vite 入口)
  tests/               #   单测内嵌 src/**/*.test.ts
tests/                 # 仓库级冒烟(brand shim 解析断言等)
browser-extension/     # Chrome MV3 插件(默认 ws://127.0.0.1:54321)
webadmin/              # 服务端管理页(Vite React + shadcn)
docs/superpowers/      # 架构设计 + 实施计划(权威文档)
scripts/               # 打包脚本 + mock-upstream.go
data/                  # 服务端运行时数据(0700,gitignore)
```

## 7. 关键契约(两端必须一致)

- **事件协议**(主进程→renderer,`agent:event`):`text_delta`/`reasoning_delta`/`tool_start`/`tool_end`(含 `duration_ms`)/`tool_error`/`confirm_required`(含 `request_id`)/`artifact`/`done`/`canceled`/`error` —— 全部 snake_case
- **REST 错误**:`{"error":{"code":"ERR_CODE","message":"..."}}`;`AUTH_REQUIRED`/`AUTH_FAILED`/`FORBIDDEN`(管理端)/`NOT_FOUND`/`VALIDATION`/`UPSTREAM`/`RATE_LIMITED`/`INTERNAL`
- **bootstrap**:`{default_model, models, skills, mcp, web}`(服务端 `internal/bootstrap` ↔ 客户端 `desktop/src/main/server-connector/config.ts` `BootstrapConfig` 严格对齐)
- **CDP 桥**:固定 `127.0.0.1:54321`,JSON-RPC:`browser.tabInfo`/`getContent`/`click`/`type`/`navigate`/`scroll`/`executeScript`
- **DB**:客户端会话 = dsh session 持久化(jsonl 会话日志,DSH_HOME=userData/dsh);服务端 20+ 表(迁移 0001-0016,0007 废弃;0013 trigram FTS、0014 kb_chunks、0015 kb_chunk_embeddings、0016 skill_grants/mcp_grants)
- **知识库检索契约**:块级检索(kb_chunks 800 rune+标题路径);`kb_search` 返回 doc/chunk id、标题路径、snippet 与 score,混合检索 = trigram/unicode61 词法 + 向量余弦(网关 /v1/embeddings,模型名存 settings `kb.embedding_model`)→ RRF(k=60)融合,无向量时纯词法降级;`kb_read(doc_id, chunk_ids?)` 支持分块定点读取;长词(≥3 rune)走 trigram、短词走 unicode61 前缀 + LIKE(含 d.title);所有 folder(含根目录)须显式授权(`GetAccessibleFolderIDs` 严格模式)
- **项目体系**:项目 = 命名工作目录;项目内会话 workspace = `<项目目录>/<会话id>/`(chat:new 自动 mkdir),引擎工具 cwd/allowedDirs 以会话 workspace 为基准,无项目会话回退全局工作目录;删除项目仅解绑会话(移入未分类),不删文件
- **自动标题**:首轮对话 done 后后台调网关默认模型生成 ≤20 字标题(15s 超时),失败兜底截取首条用户消息 20 字;仅 title 为空时触发
- **Portable(仅 Windows/Linux)**:exe 同目录存在 `portable.txt` → 数据目录 = exe 同目录/data(不可写回退系统目录);macOS 一律走 `~/Library/Application Support/picoaide`(dmg 拖入 Applications 即用,标准 HIG:原生菜单 Cmd+Q/+/N、深色模式跟随系统)
- **文档访问边界**:知识库/文档一律经服务端远程 MCP(kb_search/kb_read/kb_list)查询,不做本地文档同步
- **审批签名**:`confirm(requestId, ok)`;命令判定 `needsApprovalFor(command, allowedDirs)`;路径 `isAllowed(absPath, allowedDirs)`

## 8. 常用命令

```bash
make test              # go test ./... -count=1(服务端)
make test-server       # 服务端各域测试
make test-client       # cd desktop && npm test && npm run typecheck
make build-server      # bin/picoaide-server
make build-client      # cd desktop && npm run build(electron-vite → desktop/out/)
make webadmin          # cd webadmin && npm run build
make check             # format + lint + test
cd desktop && npm run dev        # electron-vite 开发(窗口自动起)
cd desktop && npx electron .     # 生产模式(需先 build)
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin
bash scripts/mock-upstream.go 起假上游  # 无外网/无 key 环境验证网关
```

## 9. 文档与实施

- 架构设计:docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md(ADR D1-D25、安全设计 §5、错误边界 §6)
- 实施计划:docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md(4 阶段:1 服务端网关 1.1-1.17 → 2 客户端骨架 2.1-2.9 → 3 本地能力 3.1-3.16 → 4 产品化 4.1-4.6;按序执行,TDD 红-绿-commit)
- 阶段 1 完成后可 curl 全链路验收(1.17);阶段 3 验收含浏览器插件手工场景(3.16)
