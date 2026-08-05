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

## Round 4 计划(待执行)

剩余项(按价值):
- 高:artifact 预览/回灌(HTML/图片 iframe sandbox 预览 + 继续修改回灌上下文)——易用性大项
- 中高:文档技能包(pdf 表格/xlsx;需评估沙盒 python 依赖,风险后置)
- 中:浏览器结构化快照(getContent 输出 accessibility 式语义树,省 token)
- 中:跨会话记忆(AGENTS.md 已有;自动记忆提取性价比低,暂缓)
- 低:上下文健康显示(上下文占用进度条)

## 验证基线(每轮后更新)

- make check(服务端 go test + 客户端 vitest + typecheck)EXIT 0
- 客户端:448 passed | 2 skipped(450)
- 构建:cd desktop && npm run build 成功
