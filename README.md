# CodeX 子代理拓展

把本机 Pi 封装为 Codex 和 Claude Code 可调用的 MCP。Codex 负责拆分任务、选择模型和检查结果；Pi 会话执行开发包，使用自己已有的模型配置和凭据。

## 安装

需要 Node.js 22.19+、Pi 1.0.2+ 和支持 MCP 的 Codex。先在 Pi 配好需要的模型与登录。

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run install:all      # 或 install:codex / install:claude
```

安装器只配置名为 `pi-subagents` 的本地 MCP（Codex 写 `~/.codex/config.toml`，Claude Code 写用户级 `~/.claude.json`），启动命令使用绝对路径。原配置先保存到 `.agents/records/config-backups/`，权限为 600。安装目录需要保留；搬迁后在新目录重跑安装命令。

升级只改客户端配置，不停止任何进程：已经打开的聊天继续使用旧桥接进程，独立管理进程和正在运行的 Pi 代理不受影响；新开的 Codex / Claude Code 会话加载新版本，并连接同一个管理进程接手自己的代理。

直接启动：`npm start`。卸载接入：`npm run uninstall:codex` 或 `npm run uninstall:claude`；这不会删除源码、Pi 凭据、开发成果或保存的会话。恢复配置时优先移除本 MCP；完整配置备份只有在确认没有后续其他配置改动时才适合覆盖。

## 给 Codex 的使用示例

> 用 pi-subagents 创建两个国模子代理，分别负责订单查询包和商品查询包。先列出实际可用模型，给每个代理明确文件范围和验收样例。按消息记录处理提问，等两边真正结束，再检查代码和测试结果。复杂问题可以临时换模型，完成后恢复。

服务在 MCP 初始化时提供跨工具使用说明，不需要覆盖用户全局 AGENTS.md。

这是对 Codex 能力的补充，可用于批量调用已配置的国产模型。Codex 必须先确认用户在对话里明确授权使用外部模型子代理，再按授权的任务、模型、并发和费用范围执行；普通开发请求或账户还有额度不能代替这项授权。已有授权范围内继续推进，不反复询问；超出范围再问用户。查看模型、会话和面板属于只读操作。授权范围由 Codex 根据对话判断；服务实际执行文件、网络、模型和用量限制。服务不能独立证明输入的授权说明来自真人。更新限制时，支持确认表单的客户端还会显示批准操作。

## 会话面板

在项目目录运行 `npm run dashboard`，直接打开 `http://127.0.0.1:3141/`。页面自动通过 HttpOnly、SameSite=Strict cookie 建立私密查看会话，无需 URL 令牌或旧标签页存储。面板服务重启后，已打开的新版页面会自动重新建立查看会话。

面板分为左侧会话列表和右侧详情。列表按需要处理、正在工作、已结束、已关闭分组，每行显示状态、当前工具或待答复问题、最近 30 分钟工具活跃度。详情包含进度轨道（工具调用、通信和生命周期按时间排列，悬停可看细节）、已用时、正在执行的工具和耗时、用量与缓存命中、最近报告、等待的问题，以及实时对话、工具统计、事件流、最近结果、会话信息五个页签。实时对话按时间顺序还原思考、回复和工具调用：命令显示为终端窗口，编辑显示为差异，向父代理的报告和提问单独标出，每轮结束汇总改动文件；模型返回的思考摘要可以展开，加密的推理内容不显示。新版管理进程还会把正在生成的思考、回复和命令输出写入私密 `live.json`，面板据此逐字更新；旧管理进程运行期间只显示已保存的每一步。每 2 秒更新，支持搜索、状态筛选、暂停、明暗主题、浏览器状态提醒和快捷键（`/` 搜索、`J`/`K` 切换、`P` 暂停）。上报费用来自模型服务返回值，不是真实扣费。

面板独立读取已有保存文件，不接手控制进程，不停止任务。当前已经运行的会话无需重启。后续默认 MCP 启动会自动启动或复用面板，`list_agents` 也返回面板链接。设置 `PI_DASHBOARD_AUTO=0` 可禁用自动启动；自定义运行目录使用 `PI_SUBAGENTS_STATE_DIR=/绝对路径 npm run dashboard` 单独打开，多个面板要通过 `PI_DASHBOARD_PORT` 指定不同端口。

面板仅绑定 `127.0.0.1`，读取接口需要查看 cookie 或内部令牌，且拒绝其他 Host、其他网站的读取请求和写请求。它只展示数据，提问答复、指导、中断和模型切换仍由所属 Codex 聊天通过 MCP 执行。模型尚未保存的逐字输出不显示。控制进程消失的运行中记录显示为控制进程已离线，不伪装为完成。

面板地址与进程身份保存在 `.agents/runtime/dashboard.json`，私密启动日志在 `dashboard.log`。面板关闭不影响子代理；重启电脑后下次 MCP 启动会重新打开服务。面板数据、截图和查看令牌不要发布到外部。

## 工具

| 工具 | 用途 |
| --- | --- |
| `get_quota` | 直接用 Pi 凭据查询各家套餐额度或余额；默认查询已配置的支持服务，不依赖 CodexBar |
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
| `resume_agent` | 显式接手保存会话或断线后仍在运行的会话；不重复之前的任务 |
| `read_messages` / `ack_messages` | 读取持久消息与送达状态，明确确认已读 |
| `update_agent_policy` | 经用户明确授权修改模型、网络和用量限制 |
| `get_client_capabilities` | 查看客户端实际声明的协议能力和限制 |
| `run_agent_task` | 支持 Tasks 的客户端使用标准异步任务协议 |
| `resume_task` | 前一个主会话断开后，显式接手同一个任务 |
| `set_agent_callback` | 设置或关闭回调：子代理结束、提问、失败、触发用量限制时唤醒主会话 |
| `get_agent_changes` | 只读查看子代理实际改动：Git 状态、提交和有限长度的 diff |

`send_message` 的 `steer` 在当前模型回答和工具执行结束后的合适位置接收；`follow_up` 等当前工作完成再接收。`ask_parent` 正在等待时必须调用 `reply_question`；普通消息不会替代问题答复。

每次 `wait_agent` 返回后，把各代理的 `nextSequence` 放入下一次的 `after[agentId]`，避免重复读取。工具执行进度也会使等待返回；继续检查 `status`，不要把一次工具返回当成开发包完成。

子代理拥有 `agent_message(recipient, message)` 和 `ask_parent(question)`。`recipient` 可为 `parent`，或父代理提供的兄弟代理身份。兄弟消息成为对方的新指令；父代理消息进入可读取的事件记录。

## 回调唤醒

`spawn_agent` 默认开启回调，事件为 `settled`、`question`、`process_failed`、`budget_limit`、`control_failed`；可加 `message`（子代理给主会话的进度报告）。回调只提醒主会话回来协调，不代表验收通过。已经发生过的历史事件不会重新回调，同一事件只发一次。

| 主会话 | 回调方式 |
| --- | --- |
| Codex | 先在 shell 运行 `echo $CODEX_THREAD_ID`，把结果作为 `callback.codexThreadId` 传给 `spawn_agent`（或之后用 `set_agent_callback`）。事件发生时桥接进程执行 `codex queue --thread <id> --message ...`，消息进入该聊天的队列。 |
| Claude Code（channel） | 服务声明 `claude/channel` 能力并发送 `notifications/claude/channel`。只有以 channel 方式启用本服务的会话才会被唤醒，例如 `claude --dangerously-load-development-channels server:pi-subagents`。 |
| Claude Code（通用） | 把 `npm run wait-events -- --agent <id>` 作为后台命令运行：事件到达时打印摘要并退出，Claude Code 随即被唤醒；配合 Monitor 可用 `--follow` 持续输出。只读保存文件，不需要 channel。 |

回调由所属主会话的桥接进程发出：主会话关闭后不再回调，用 `resume_agent` 接手后重新 `set_agent_callback`。最近一次投递结果记录在 `.agents/runtime/callbacks/<agentId>.json`。

## 并行与会话

- Git 项目默认创建独立 worktree 和 `pi-agent/<身份>` 分支。源目录有未提交改动时，必须明确选择一个已提交的 `baseRef`，或者明确使用 `shared`。未提交内容不会自动复制。
- 非 Git 目录使用共享目录。每个代理必须声明 `ownedPaths`，活跃代理的文件范围不能重叠。新会话的工具写入受操作系统限制，只允许声明范围；符号链接也要通过检查。
- 不自动合并代码、删除工作目录、发布或对外发送。Codex 检查后自行按用户授权处理 Git 合并。
- 默认最多同时打开 50 个 Pi 会话。可用 `PI_SUBAGENTS_MAX_AGENTS` 设置 1–50；`wait_agent` 一次最多等待 50 个；打开但空闲的会话也计入，避免无限积累进程。
- 会话、状态、事件和工作目录默认保存在本项目 `.agents/runtime/`，不进入 Git。可用 `PI_SUBAGENTS_STATE_DIR` 指定其他本机目录。
- MCP 连接关闭时仅断开主会话，独立管理进程继续运行 Pi 并保留等待的问题。新连接用 `list_agents(includeSaved=true)` 和 `resume_agent` 恢复；另一个仍连接的主会话持有的代理不能同时接手。重启电脑或管理进程实际退出后，显式恢复保存的 Pi 会话，旧任务不重发。
- 模型切换只改变该会话，不改变 Pi 全局默认模型。历史通过 Pi 转成目标模型可接收的内容；不保证转移各服务的私有思考状态。

## 能力边界

外部 Pi 代理以 MCP 工具显示，不会变成 Codex 原生子代理界面。父代理可以接收标准日志、资源订阅和进度通知，或使用等待和读取工具；结束本轮回答后的唤醒依赖上面的宿主专用回调，不是 MCP 通用能力。也不会自动继承 Codex 全部隐藏上下文，必要资料需要通过 `context` 或任务说明交付。

模型目录说明本机已配置，不代表每个模型都实际调用成功。状态 `completed` 说明 Pi 不会继续自动运行，不代表业务验收通过。`usage.reportedCost` 为 Pi 根据模型目录价格报告的金额，部分自定义模型为零；不是服务商的实际扣费记录，不能用它推断真实费用。

新会话明确加载通信和权限扩展，限制文件工具与 shell 子进程。当前使用 macOS Seatbelt；其他平台会拒绝启动受限制代理。模型调用由可信 Pi 主进程使用凭据，工具进程不继承凭据环境，拒绝读取 .pi、.codex、.ssh 和管理进程状态。shell 默认不能联网；依赖安装等操作需用户允许 allowNetwork。它不替代对 Pi 本身及安装扩展的信任，也不隔离 CPU、内存或磁盘容量。旧版本已经启动的代理保留旧行为，不能倒推成已获得新限制。

## 验证与证据

```bash
npm test                 # 不调用模型的业务行为检查
npm run verify:communication # 真实断线恢复、问题答复、受限工具与请求上限
npm run verify:live      # 真实调用 GLM、DeepSeek、MiniMax、OpenCode Go
node scripts/verify-codex.js  # 已安装后，由真实 Codex 调用 MCP 和 GLM
```

真实验证在系统临时目录执行演示开发包，不接触生产数据。原始会话和结果留在 `.agents/records/live-*/`、`.agents/records/codex-*/`。这些资料包含提示和模型回答，按私密本机资料处理；确认结果且不再需要复现后可以删除。当前验证结果见 [docs/verification.md](docs/verification.md)。

可靠通信、默认限制和协议支持见 [docs/communication.md](docs/communication.md)。

代码入口与维护要求见 [AGENTS.md](AGENTS.md)。

## 额度查询

调用 `get_quota()` 默认查询 Pi 已配置且支持的服务；用 `provider` 查询一家：`openai-codex`、`zhipu`、`zai`、`minimax-tokenplan`、`deepseek` 或 `opencode-go`。读取 `PI_CODING_AGENT_DIR/auth.json`；未设置时使用 `~/.pi/agent/auth.json`。不依赖 CodexBar、Codex CLI、浏览器 cookie 或额外库，不复制或改写凭据。

| 服务 | 查询结果 |
| --- | --- |
| Codex | 套餐、实际返回的 5 小时/每周窗口、credits 余额、重置卡 |
| GLM 国内 / Z.ai | Coding 套餐窗口、剩余百分比、重置时间；搜索/阅读工具次数单独返回 |
| MiniMax Token Plan | 按 general/video 等服务列出当前周期和每周百分比、剩余次数、状态、重置时间 |
| DeepSeek | 各币种余额、赠送余额与充值余额；不伪造套餐百分比 |
| OpenCode Go | rolling、每周、每月用量与重置时间 |

`all` 返回各家独立结果，一家失败不隐藏其他数据；未支持的 Pi 服务列入 `unsupportedProviders`。服务可能共用同一账号，不能相加。缺失字段为 `null`，不能当成 100% 或 0%。credits 与人民币/美元余额分别保留单位。工具不估算本任务未来消耗。MiniMax 的 `usage_count` 在 remains 接口里表示剩余次数；次数和百分比矛盾时给出警告，状态也保留。

额度可用不代表获得花费授权。Codex 仍须遵守用户明确允许的任务、模型和预算范围；额外付费或使用重置卡须另有授权。工具只查询，不购买、不兑换、不调用模型。Codex 凭据过期时通过 Pi 续期；查询工具不执行命令型 key、不改写认证文件。重置卡查询失败会保留有效套餐额度并返回警告。

查询方式参考 [CodexBar 官方实现说明](https://github.com/steipete/CodexBar/blob/main/docs/codex.md)和各服务接口；实现独立编写，没有引入或复制它的 Swift 工程。Codex、GLM 和部分套餐接口可能变化，接口失败或格式未知会明确报错。DeepSeek 余额接口见 [官方文档](https://api-docs.deepseek.com/api/get-user-balance/)。
