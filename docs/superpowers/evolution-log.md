# PicoAide 进化日志(Evolution Log)

> 本文件是自我进化循环的状态记录。每轮完成后更新:调研发现、实施功能、验证结果。
> 主会话上下文被压缩后,凭本文件恢复循环状态。

## 循环框架

1. 派调研子代理研究市场桌面端 agent 方案(逆向/源码/文档)
2. 汇总差距清单 → 选高价值项 → 派子代理 TDD 实施
3. 每轮 1-2 个功能;完成后全量验证(make check)+ push
4. 更新本文件(压缩上下文)

## Round 0(2026-08-05):全仓过度工程审计落刀

- 派 3 个子代理审计(server / desktop main / renderer+extension),逐项核实后批准落刀
- 删除:`engine.run()` 遗留循环+测试钩子、mcp/adapter.ts 死文件、skill loader 死代码、AgentEventEmitter、6 组 serverstore 仅测试 DAO、store 仅测试导出链、version IPC 死面、detachIfAttached、4 个未用 npm 依赖(mermaid/remark-gfm/react-tabs/react-separator)
- shrink:chat.ts 四 run 块合一、Electron 加载三合一、parseUsage/randomHex/modelEnabled 共享助手
- commits:`5c2d9a0` `29d5c0f` `4045725`(server)+ `99b832b` `49a9864` `776c1c6` `372e314`(desktop main)+ `3cc34e2` `9ab8e15` `75c9a9c`(renderer/ext/deps)
- 结果:净删 ~1300 行 + 4 依赖;make check 全绿(基线 448 passed)

## Round 1(2026-08-06):上下文与信息保真

**调研结论**(2 个子代理):
- harness 差距:硬截断不可逆(50 条外永久丢失)、按条数不感知 token、resume=重跑、无跨会话记忆、无上下文健康显示
- 办公差距:无任务步骤卡片、缺文档表格技能(pdf/xlsx)、浏览器桥缺语义定位、artifact 无预览、缺粘贴图片/拖拽文件

**实施**:
1. `02c85b8` feat: inject workspace AGENTS.md into agent system prompt
   - ipc.ts `loadProjectInstructions(workspace)`:读 `<workspace>/AGENTS.md`(≤4096 字符截断)拼入 sysPrompt;四个调用点注入(craft/plan/continue/approvePlan/editAndRerun);每次运行重读
   - 引擎改动最小:CraftInput/PlanInput/ContinueInput/ApprovePlanInput 加可选 `sysPrompt?`(缺省 cfg.sysPrompt)
   - 7 个新测试(引擎契约 2 + ipc 集成 3 + 单测 3)
2. `f3799cf` feat: spill oversized tool outputs to workspace files
   - `agent/artifacts.ts` 新增 `spillToolOutput(workspace, toolCallId, value)`:`<workspace>/tool-outputs/<toolCallId>.txt`,摘要=前 400 字符,常量阈值 6000
   - 改写点在 `wrapTool` 的 execute 包装(engine.ts):tool_end 事件/上下文消息/DB 落库三处同源,一次替换全生效;workspace 空则跳过
   - 3 个新测试(大输出落盘+引用回传、小输出不变、空 workspace 跳过)

**验证**:448 passed | 2 skipped,typecheck 0,make check EXIT 0

## Round 2(2026-08-06):长会话与多模态输入

**实施**:
1. `8f3baae` feat: LLM-summary compaction for long conversations
   - 新 agent/compact.ts:CONTEXT_TOKEN_BUDGET=40000 字符;超预算从后往前保留(至少 20 条),更早 user/assistant 文本拼块→单轮 streamText 中文摘要→{role:'user'} 置顶;剪口孤儿 tool 行丢弃
   - ask/plan/craft/continue 四处统一走 compactContext(注入 session.fetch+abort);摘要失败/超时→回退原截断;不落库
   - 8 新测试;481 passed
2. `312b1d4` feat: paste images and drag files into chat
   - renderer 粘图/拖文件→dataUrl→新 IPC chat:attach(校验 png/jpeg/webp≤5MB、文件≤100MB、文件名清洗)→落盘 <workspace>/attachments/→content 存路径引用,base64 永不落 DB
   - 引擎 userContentParts() 解析引用→AI SDK image part;重放/历史/continue 均恢复;读失败降级纯文本
   - 关键发现:@ai-sdk/openai-compatible v3 序列化 image part 变 null,但 streamText 自动转 v4 file part→实际请求体 image_url,网关零改动
   - 新 src/shared/attachments.ts(renderer/main 共享);37 新测试;485 passed

**验证**:make check EXIT 0;485 passed | 2 skipped;build 成功;已 push

## Round 3(2026-08-06):浏览器语义定位 + 任务可视化

**实施**:
1. `96f9070` feat: semantic browser fill/select/waitFor/dialog
   - 插件端 background.js:locate() 语义定位(label[for]/placeholder/aria-label 优先,CSS 回退);fill(原生 setter+input/change React 兼容)/select(option 匹配)/waitFor(200ms 轮询≤60s)/dialog(Page.javascriptDialogOpening,action 武装,10s 超时)
   - 工具层:fill/select/dialog 入 HIGH_RISK_TOOLS,wait_for 只读;桥零改动(通配转发)
   - browser.test.ts 6 用例;496 passed
2. `8ddadb2` feat: run steps trajectory UI
   - chat.ts 新增 runSteps 状态机(tool_start/tool_end/tool_error 配对,done 折叠汇总,新运行/切会话重置,零新协议)
   - RunSteps.tsx 组件(会话头部,shadcn Badge+Loader2,水平胶囊,运行中 pulse/失败 destructive,结束 ✓ 完成(N 步));无步骤零侵入
   - 10 个 store 用例;498 passed;无 renderer 组件测试基建(跳过组件测试,store 兜底)

**验证**:make check EXIT 0;496 passed | 2 skipped;build 成功;已 push

## Round 4(2026-08-06):artifact 预览回灌 + 语义快照

**实施**:
1. `e86b029` feat: artifact preview and re-edit round-trip
   - artifact:read IPC(复用 isAllowed 目录校验,文本 1MB/图片 5MB 上限,按扩展名 kind: html/md/text/image/other,图片回 dataUrl)
   - ArtifactPreview.tsx(shadcn Dialog:HTML→sandbox iframe、图片→img、.md→Markdown.tsx、文本→pre)
   - 回灌:requestEditArtifact(path)→"请继续修改文件 {path}"走 sendMessage;ArtifactsPanel 预览+文件夹双按钮
   - 6 新测试;502 passed
2. `4e4a009` feat: semantic DOM snapshot for getContent
   - 插件 semanticSnapshot()(toString 注入零依赖):限深 6/300 节点/≤6000 字符截断;[H1]/[BUTTON]/[INPUT]/[LINK]/[IMG]/[TABLE] 语义标注,输入框标注 fill 定位提示;getContent 默认快照,{mode:'text'} 兼容
   - 新 browser-extension/snapshot.test.js(零依赖 node 测试 + 最小 DOM mock);503 passed

**验证**:make check EXIT 0;503 passed | 2 skipped;已 push

## Round 5(2026-08-06):服务端全功能审视 + 上下文健康显示

**服务端调研差距清单**(9 项,已入此日志备查):
1. 高:网关无多模型故障转移(同模型多 provider 不能容灾)+ 无流式读空闲超时
2. 中:网关审计缺失(usage 表无 latency/status)
3. 高:api_tokens 黑盒(管理员不可见/不可撤销)
4. 中:本地密码无策略(最小长度)
5. 低:技能包无签名/checksum 存而不验
6. 高:知识库只读不可改、授权不可撤销(无 revoke/编辑)
7. 中:知识库上传同步阻塞、扫描版 PDF 失败
8. 中:webadmin 无用户搜索/知识库分页/删除确认/审计页
9. 低:无优雅退出/healthz 不查 DB/无版本号

**实施**:
- `75b3f04` feat: context usage indicator
  - 新事件 context_usage {chars,budget};估算复用 compact.ts messageLength(与摘要触发同源);runCraftLoop/runAskLoop 每轮一次
  - ContextUsage.tsx(与 RunSteps 同区):12.4k/40k 字符 + 百分比;≥80% amber 提醒自动摘要;结束后清除
  - 505 passed

**验证**:make check EXIT 0;505 passed | 2 skipped;已 push

## Round 6(2026-08-06):网关容灾 + token 管理

**实施**:
1. `0a21fee` feat: gateway failover and stream idle timeout
   - MatchModels(同模型全部候选)→ 逐个 forward:连接错误/5xx/首字节超时转下一个,4xx 原样不转;单 provider 不重试(防重复计费)
   - STREAM_IDLE_TIMEOUT=90s(测试可注入):readLineWithIdle,超时写 SSE 错误 UPSTREAM_IDLE_TIMEOUT 终止;首字节 ResponseHeaderTimeout 120s
   - 流开始后不转移;usage 语义不变(失败不计费)
   - failover_test.go 7 用例
2. `621ae4b` feat: admin api token management
   - api_tokens 表已有 name/last_used_at/revoked(零迁移);ListTokensByUser(清空 TokenHash)/RevokeTokenByID(幂等)/TouchTokenLastUsed(VerifyToken 内自动更新)
   - GET /api/admin/users/:id/tokens + POST /api/admin/tokens/:id/revoke(AdminAuth+CSRF)
   - webadmin Users 页令牌对话框(名称/创建/过期/最后使用/状态 Badge+撤销 confirm)
   - 测试:serverstore 3 + serverauth AdminTokens 全场景

**验证**:make check EXIT 0;505 passed | 2 skipped;已 push

## Round 7(2026-08-06):知识库可写 + webadmin/运维完善

**实施**:
1. `89286db` feat: knowledge revoke and document edit
   - DELETE /api/admin/kb/folders/:id/grant(与 PUT grant 对称)+ GET grants;RevokeFolderUser/Group(幂等)+ ListKBFolderGrants;撤销即刻生效(查询时校验)+ kb_revoke 审计
   - PUT /api/admin/kb/documents/:id(标题必填/≤1MB)+ GET 取内容;UpdateKBDocument 重算 size,FTS 由 kb_au trigger 重索引(零迁移)+ kb_update 审计
   - webadmin 文档编辑对话框(新 textarea 组件)+ 授权列表带撤销
2. `e203f66` feat: webadmin UX and ops primitives
   - 优雅退出(signal.NotifyContext SIGINT/SIGTERM→Shutdown 10s);-version flag(ldflags 注入,默认 dev);/healthz 加 db.PingContext(3s,DB 挂 503)
   - Users 搜索(?q= LIKE 过滤);Knowledge 分页(20/页);删除确认补齐(商城下架 MCP/技能、网关删模型);新增 /audit 审计页(kb 操作,分页)
   - 测试:users 搜索/KB 分页与审计 HTTP 层/healthz 503

**验证**:make check EXIT 0;505 passed | 2 skipped;已 push(e203f66)
- 注意:两子代理并行曾发生提交交叉事故,已重建历史(89286db 只含 A 工作,e203f66 只含 B 工作,树无重叠),已核验

## Round 8 计划(待执行)

调研剩余项盘点:
- 中高:文档技能包(pdf 表格/xlsx;沙盒 python 依赖需评估,可选 JS 方案)
- 中:知识库上传异步化(差距 #7:大文件同步阻塞;扫描版 PDF OCR)
- 低:技能包签名/checksum 验签(差距 #5)
- 低:密码策略最小长度(差距 #4)
- 客户端与服务端联调冒烟(完整链路:登录→bootstrap→对话→浏览器→artifact;此前各轮分域验证,需要一次端到端)
- 下一轮应评估"是否已达完善标准"并给出收尾结论

## 验证基线(每轮后更新)

- make check(服务端 go test + 客户端 vitest + typecheck)EXIT 0
- 客户端:448 passed | 2 skipped(450)
- 构建:cd desktop && npm run build 成功
