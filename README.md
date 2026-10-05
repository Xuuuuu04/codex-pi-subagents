# CodeX 子代理拓展

把本机 Pi 封装为 Codex 可调用的 MCP。Codex 负责拆分任务、选择模型和检查结果；Pi 会话执行开发包，使用自己已有的模型配置和凭据。

## 安装

需要 Node.js 22.19+、Pi 1.0.2+ 和支持 MCP 的 Codex。先在 Pi 配好需要的模型与登录。

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run install:codex
```

安装器只配置名为 `pi-subagents` 的本地 MCP，启动命令使用绝对路径。原 Codex 配置先保存到 `.agents/records/config-backups/`，权限为 600。安装后重新启动 Codex，在 MCP 列表检查 `pi-subagents`。安装目录需要保留；搬迁后在新目录重跑安装命令。

直接启动：`npm start`。卸载接入：`npm run uninstall:codex`；这不会删除源码、Pi 凭据、开发成果或保存的会话。恢复配置时优先移除本 MCP；完整配置备份只有在确认没有后续其他配置改动时才适合覆盖。

## 给 Codex 的使用示例

> 用 pi-subagents 创建两个国模子代理，分别负责订单查询包和商品查询包。先列出实际可用模型，给每个代理明确文件范围和验收样例。按消息记录处理提问，等两边真正结束，再检查代码和测试结果。复杂问题可以临时换模型，完成后恢复。

服务在 MCP 初始化时提供跨工具使用说明，不需要覆盖用户全局 AGENTS.md。

## 工具

| 工具 | 用途 |
| --- | --- |
| `list_models` | 从本机 Pi 获取已配置认证的模型，按服务和名称筛选；不返回凭据 |
| `spawn_agent` | 创建会话，指定模型、思考强度、目录、文件范围和任务；立即返回身份 |
| `list_agents` | 查看当前子代理；可额外列出以前保存的会话 |
| `read_agent` | 状态、消息、实际用量、最近结果；可显式读取有限长度的会话内容 |
| `send_message` | 追加任务、运行中指导，或等当前任务结束再执行 |
| `reply_question` | 明确回答一个正在等待的子代理问题 |
| `wait_agent` | 等待指定代理的新事件、完成或提问，最长 45 秒；支持取消 |
| `set_agent_model` | 空闲时换模型；`next_run` 在下一次工作结束后恢复原模型与思考强度 |
| `interrupt_agent` | 清空旧指令队列并停止当前运行；已修改文件保留 |
| `close_agent` | 停止并关闭进程，保留会话和工作目录 |
| `resume_agent` | 显式接手保存会话；不自动重复之前的任务 |

`send_message` 的 `steer` 在当前模型回答和工具执行结束后的合适位置接收；`follow_up` 等当前工作完成再接收。`ask_parent` 正在等待时必须调用 `reply_question`；普通消息不会替代问题答复。

每次 `wait_agent` 返回后，把各代理的 `nextSequence` 放入下一次的 `after[agentId]`，避免重复读取。工具执行进度也会使等待返回；继续检查 `status`，不要把一次工具返回当成开发包完成。

子代理拥有 `agent_message(recipient, message)` 和 `ask_parent(question)`。`recipient` 可为 `parent`，或父代理提供的兄弟代理身份。兄弟消息成为对方的新指令；父代理消息进入可读取的事件记录。

## 并行与会话

- Git 项目默认创建独立 worktree 和 `pi-agent/<身份>` 分支。源目录有未提交改动时，必须明确选择一个已提交的 `baseRef`，或者明确使用 `shared`。未提交内容不会自动复制。
- 非 Git 目录使用共享目录。每个代理必须声明 `ownedPaths`，活跃代理的文件范围不能重叠。此声明是协作规则，不是操作系统文件限制。
- 不自动合并代码、删除工作目录、发布或对外发送。Codex 检查后自行按用户授权处理 Git 合并。
- 默认最多同时打开 8 个 Pi 会话。可用 `PI_SUBAGENTS_MAX_AGENTS` 设置 1–32；打开但空闲的会话也计入，避免无限积累进程。
- 会话、状态、事件和工作目录默认保存在本项目 `.agents/runtime/`，不进入 Git。可用 `PI_SUBAGENTS_STATE_DIR` 指定其他本机目录。
- MCP 连接关闭时停止子代理，保留会话。新连接用 `list_agents(includeSaved=true)` 和 `resume_agent` 恢复；另一个活跃控制进程持有的会话不能同时接手。
- 模型切换只改变该会话，不改变 Pi 全局默认模型。历史通过 Pi 转成目标模型可接收的内容；不保证转移各服务的私有思考状态。

## 能力边界

外部 Pi 代理以 MCP 工具显示，不会变成 Codex 原生子代理界面。父代理调用等待或读取工具时才能接收事件；父代理结束本轮回答后，没有保证自动唤醒的入口。也不会自动继承 Codex 全部隐藏上下文，必要资料需要通过 `context` 或任务说明交付。

模型目录说明本机已配置，不代表每个模型都实际调用成功。状态 `completed` 说明 Pi 不会继续自动运行，不代表业务验收通过。`usage.reportedCost` 为 Pi 根据模型目录价格报告的金额，部分自定义模型为零；不是服务商的实际扣费记录，不能用它推断真实费用。

Pi 子进程使用当前用户权限。独立 worktree 隔离代码修改，不隔离凭据、网络和系统命令。需要限制文件与网络时，另外配置操作系统隔离环境。

## 验证与证据

```bash
npm test                 # 不调用模型的业务行为检查
npm run verify:live      # 真实调用 GLM、DeepSeek、MiniMax、OpenCode Go
node scripts/verify-codex.js  # 已安装后，由真实 Codex 调用 MCP 和 GLM
```

真实验证在系统临时目录执行演示开发包，不接触生产数据。原始会话和结果留在 `.agents/records/live-*/`、`.agents/records/codex-*/`。这些资料包含提示和模型回答，按私密本机资料处理；确认结果且不再需要复现后可以删除。当前验证结果见 [docs/verification.md](docs/verification.md)。

代码入口与维护要求见 [AGENTS.md](AGENTS.md)。
