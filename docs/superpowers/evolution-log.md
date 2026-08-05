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

## Round 2 计划(待执行)

调研建议"最值得先做"剩余项:
- 高:token 阈值触发 LLM 摘要压缩(替换 50 条硬截断;失败必须回退现状)
- 高:粘贴图片/拖拽文件进对话(易用性)
- 高:文档表格技能包(pdfplumber/openpyxl,需技能运行时 python 环境)
- 高:浏览器桥语义定位(fill/waitFor/dialog + 结构化快照,多端)
- 中:任务步骤卡片 UI + artifact 预览/回灌

## 验证基线(每轮后更新)

- make check(服务端 go test + 客户端 vitest + typecheck)EXIT 0
- 客户端:448 passed | 2 skipped(450)
- 构建:cd desktop && npm run build 成功
