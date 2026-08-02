# PicoAide-Next

WorkBuddy 式桌面 AI 办公智能体:Electron 桌面客户端(本地 Agent 引擎)+ Go 服务端网关(认证/AI 网关/商城/知识库)。

- 员工零配置:安装客户端 → 登录 → 直接用;所有功能配置由管理员在服务端管理页完成
- 密钥不出服务端:LLM 调用全走服务端网关代理
- 高危操作人确认:删除/截屏/剪贴板读/命令/浏览器操作等引擎层审批门控
- 不可信代码本地受限沙盒执行(@ai-sdk/sandbox-just-bash)
- 消息即状态:任务中断标记 status,恢复 = 从最后一条 user 消息重跑

详见 `docs/` 与 `AGENTS.md`。
