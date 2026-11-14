# 安装与验证记录

日期：2026-10-06，Asia/Shanghai。本次使用 Node.js 22.22.2、Pi 1.0.2、Codex CLI 0.159.0。

## 已安装

本机 Codex 的全局配置已加入 `pi-subagents`，使用绝对 Node、Pi 和源码路径。真实 Codex CLI 已从此配置启动 MCP，调用模型列表、创建 GLM 子代理、等待实际结果并关闭代理，最终返回 `PASS`。工具结果包含子代理的 `CODEX-PI-READY`。

原配置已私密备份。比较配置内容后，其他配置保持相同；Codex CLI 省略了原 `node_repl` 的空 `args = []`，其含义不变。没有修改其他服务的模型、凭据或启动参数。

当前已经打开的桌面聊天尚未验证刷新后工具显示，需要重启 Codex 客户端使其加载新增 MCP。真实 CLI 接入成功与桌面当前聊天刷新分别记录。

## 真实模型协作

首次版本的真实 stdio MCP 发现 11 个工具，完成以下隔离演示：

| 场景 | 实际结果 |
| --- | --- |
| GLM `glm-5.3` 与 DeepSeek `deepseek-flash` 并行开发 | 两个模型分别修改自己的开发包；父代理独立运行生成代码，分页参数为 41，空列表求和为 0，2 与 3 求和为 5 |
| 子代理向父代理提问 | GLM 等待页数参数，明确收到父代理答复 41 后继续 |
| 兄弟代理与父代理通信 | GLM 要求 DeepSeek 写入 `PEER-41`，实际文件内容一致，GLM 另向父代理报告 |
| 临时升级模型 | 同一 Pi 会话改用 MiniMax `MiniMax-M3.1-Flash-Preview`，读取先前文件并写入 `UPGRADED-41`；工作结束后恢复 GLM |
| 关闭后恢复会话 | 恢复同一个 Pi 会话，读取前次成果并报告，无重复执行旧任务 |
| OpenCode Go `deepseek-v4.1-flash` | 实际返回 `GO-READY` |

这证明上述四个服务的指定模型可用；其他目录模型没有逐个真实调用。没有凭据进入源码或 MCP 工具参数。Pi 的目录金额没有用于报告实际费用。

## 自动检查

首次版本的 12 个行为检查全部通过，包括任务接受与真正完成的区别、模型错误、显式提问答复、兄弟消息、会话身份验证、消息分页不丢失、中断清空队列、容量与文件范围、临时模型恢复、保存会话接手、真实 MCP SDK 协议和 Git 工作目录隔离。

Git 版本缺少目标子目录时，会在创建分支前报错。源目录未提交改动需要明确选择版本或共享模式。独立工作目录检查使用隔离 Git 仓库，真实模型开发演示使用非 Git 共享目录。

最后的消息分页和子目录提前检查改动通过上述回归检查；真实模型协作与 Codex 接入运行完成于这些收尾改动之前，未为纯本地修正重复付费调用。

## 证据与恢复

- 国模结果、私密会话和生成代码：`.agents/records/live-1791227307746/`。
- Codex 真实工具调用及结果：`.agents/records/codex-1791227343838/`。
- 修改前 Codex 配置：`.agents/records/config-backups/`。

演示临时工作目录已删除；保留生成代码副本和会话用于检查当次结果，这些演示会话不作为继续开发的工作目录。确认验收且不再需要复现时，可删除这些演示证据；配置备份按恢复需要保留。正常使用的会话另存于 `.agents/runtime/`。

## 保留的限制

父代理在等待或读取 MCP 时接收消息，不能保证在回答结束后自动唤醒。Pi 子代理也不会显示为 Codex 原生子代理界面。开发成果仍需父代理实际验收。工作目录与文件范围声明不限制当前用户的系统权限。

## 会话面板增补

2026-10-06 增加本机只读面板，已启动在 `127.0.0.1:4317`。默认 MCP 后续启动会自动复用面板；已运行会话不需要重启。

浏览器实际读取到 9 个真实会话，并看到多个会话从运行中转为已完成。已操作搜索、无匹配结果、完成状态筛选、详情切换、通信与执行记录、暂停更新、2 秒自动更新、工具输出展开后刷新保留。390px 窄屏检查页面宽度为 390px，详情宽度为 358px，无整页横向溢出；表格在自己的区域内滚动。

新增 3 个行为检查，全部 15 项检查通过。新增检查覆盖只读数据不更改会话归属、等待问题与当前工具、离线控制进程、坏记录不影响其他会话、缺少令牌、错误 Host、拒绝写请求、会话文件范围、隐藏思考内容不展示和正在写入的 JSONL 尾行。没有为面板重复调用收费模型。

真实 stdio MCP 启动复用同一个面板进程，`list_agents(includeSaved=true)` 返回面板链接与 9 个保存会话，新连接关闭后原控制进程继续工作。

私密桌面与窄屏截图保存在 `.agents/records/dashboard/`，用于检查这次布局。确认界面后可删除截图；正常运行文件继续保留在 `.agents/runtime/`。面板仅显示保存内容，不能查看尚未保存的逐字输出或通过页面控制代理。

### 普通地址访问修复

用户实际打开普通地址时缺少 URL 查看令牌，接口返回 401。已改为页面自动建立 HttpOnly、SameSite=Strict cookie；内部健康检查仍使用私密令牌。修复后浏览器直接打开不带 fragment 的地址，实际读取会话，旧令牌存储为空，页面 JavaScript 不能读取查看 cookie；重新刷新也成功。检查覆盖普通页面 cookie 读取、无凭据拒绝、其他网站读取和写请求拒绝。新版页面遇到服务重启后的过期 cookie 会重新建立查看会话。

## 多服务额度查询增补

2026-10-06 08:59 CST，通过真实 stdio MCP 调用默认 `get_quota()`，发现 12 个工具，全部六个 Pi 配置返回成功：Codex、zhipu、zai、MiniMax Token Plan、DeepSeek、OpenCode Go。查询直接使用 Pi auth.json 中对应凭据，没有执行 CodexBar、Codex CLI、模型请求、购买或兑换操作。调用前后凭据文件的 SHA-256 相同。

当次结果：Codex 每周剩 71%，5 小时窗口未返回；GLM 两个配置均为 5 小时剩 10%；MiniMax general 当前周期剩 99%、每周剩 93%；DeepSeek 余额 0.23 CNY；OpenCode Go rolling/每周/每月分别剩 93%/52%/64%。这是查询时快照，其他正在执行的任务会改变用量；GLM 两个配置可能属于同一账号，不能相加。

MiniMax video 同时返回剩余次数 0 和剩余百分比 100%，工具保留这两项并给出警告，未把它解释成视频服务可用。Codex 返回 1 张可用重置卡，工具没有兑换。额度结果不代表用户授权额外付费。

全部 24 项行为检查通过，包括新增的窗口分类、金额单位、Pi 凭据缺失/过期、HTTP 错误、隐私字段移除、认证文件不变、多服务部分失败、MiniMax 剩余次数语义和默认全部查询。JavaScript 检查、项目说明检查与改动检查通过。

安全字段组成的真实结果保存在 `.agents/records/quota/live.json`，用于复现当次服务返回与检查查询行为；确认后可删除。源码已被全局 MCP 启动路径引用，下次连接即可加载新增工具；本次未中断其他正在运行的 Pi 会话，也未确认当前桌面聊天工具列表已刷新。

## 1.1.0 可靠通信与限制

2026-10-06 更新为 18 个主会话工具。32 项自动检查通过，使用安装器指定的 Node.js 22.22.2。新增检查覆盖消息重复发送、冲突内容、已读确认、超过内存尾部的事件分页、损坏末尾恢复、独立管理进程、主会话权限、模型范围、请求/运行限制、macOS 文件与 shell 权限、符号链接、网络拒绝、后代停止、批准/拒绝表单和标准 MCP Tasks。

真实 OpenCode Go `deepseek-v4.1-flash` 通过 stdio MCP 完成：提出问题 → 关闭 MCP 连接 → 新连接接手同一代理和问题 → 主会话回答 41 → 受限制 write 创建文件 → bash 读取检查 → 向主会话报告。父进程独立读取文件，内容为 41，消息记录包含 consumed 状态。

第二个真实 Pi 会话设置 maxModelRequests=1；模型先读取文件，第二次模型请求前被拒绝，记录显示计数1、request count 限制和失败。没有将这项计数解释为服务商实际费用。最近证据为 `.agents/records/communication-1791249985376/result.json`，可用 `npm run verify:communication` 重跑。

真实 Codex CLI 调用了能力报告、模型列表、创建 GLM、读取/等待和关闭，实际返回 CODEX-PI-READY，整体 PASS。首次该版本验证里 Codex 曾把等待时间写成60000，参数检查拒绝；随后改为45000正常完成。这是调用参数错误，未放宽45秒限制。客户端0.159.0声明 elicitation.form/url，没有声明 Tasks；SDK客户端已实际验证标准任务创建、input_required、结果、取消、TTL、资源订阅、日志级别和递增进度。

MCP配置继续指向当前源码，无需复制凭据或另装 CodexBar。旧版本活跃代理未被重启；新连接启用独立管理进程和新工具限制。桌面旧聊天是否已刷新工具仍取决于客户端重连。

不能由服务单独保证的部分明确保留：结束后的 Codex 自动唤醒、原生子代理界面、隐藏上下文、真人授权来源和精确人民币账单。token阈值是已报告用量，正在运行的请求可能超出；macOS工具权限不提供CPU/内存/磁盘配额，也不隔离受信任Pi主进程本身。协议及恢复说明见 `docs/communication.md`。

最终 Codex 验证证据：`.agents/records/codex-1791250202574/result.json`，actualCompletion=true，全部6次工具调用成功，PASS。这里直接检查了 MCP 返回的 completed 状态和 CODEX-PI-READY，没有只相信主模型的最终文字。

## 面板重新设计

2026-10-13 面板改为 Pi 调度台：分组会话列表、30 分钟工具活跃度、进度轨道、工具统计、事件流、明暗主题、浏览器提醒和快捷键。默认端口改为 `127.0.0.1:3141`（本机 4001、4301、4310 被 QQ 占用）；新面板启动后自动退出旧端口上的只读面板，不影响代理。全部 37 项检查通过，并用真实会话数据检查了桌面、暗色与 375px 窄屏布局。

2026-10-13 增加实时对话：按时间顺序显示思考、回复、终端窗口、编辑差异、报告与提问和每轮改动汇总；管理进程新增 `live.json` 逐字镜像（需管理进程自然重启后生效）。全部 38 项检查通过，并用真实会话检查了明暗主题与窄屏。

## 1.6.0 稳定性优化、面板重构与 Antigravity 插件接入

2026-11-14 完成核心稳定性加固、Antigravity 原生插件接入、Web 面板模块化与两轮代码结构审查修复：

- 稳定性与控制进程：配置与运行状态文件全部改为临时文件原子写入（`atomicWriteJson`）；严格区分 `readTail` 非正限制和损坏末尾；`read_head` 支持长度为 0 且在宿主与沙箱端校验非负整数参数；新桥接在检测到空闲旧控制进程脚本路径变化时自动替换；`npm run check`、`npm test`（79 条全过）与严格插件校验通过；`npm run verify:communication` 通过真实 stdio 校验了 22 个工具和能力信息，随后在调用 OpenCode Go 模型时因本机账号缺少有效订阅返回 HTTP 403（退出码 1，记录见 `.agents/records/communication-1794627522407`）。
- Antigravity 接入与去重：新增 `bind_session`、`get_subagent_health` 与 `scripts/antigravity-hook.js`（`PreInvocation` 幂等注入待处理事件、`Stop` 在存在活跃或等答复子代理且缺少活跃 `wait-events` 监听器时拦截过早收尾）；`callbacks/<id>.json` 通过 `antigravityDeliveredSeq` 在钩子、`wait-events --session`、`read_agent`、`wait_agent` 间单调递增去重，并在只监听部分事件类型时保留未投递默认事件不被跳过；`npm run install:antigravity` 生成插件并用 `agy plugin validate --strict` 严格校验通过。
- 模块化 Web 面板：后端拆出 `/api/events` SSE 实时推送（含 2 秒轮询兜底）、`/api/system`（控制进程状态、活跃监听器与计数）、60 秒缓存 `/api/quota` 与 `dashboard.lock` 并发锁，前端拆分为 `dashboard/*.js` 7 个模块并增加宿主/状态筛选、对话内搜索、五页详情栏、异常自动重认证和 375px 窄屏抽屉交互；实测页面 `http://127.0.0.1:3141/` 显示实时推送正常、零控制台异常且 375px 宽度无横向溢出。
- 自动化测试：包含新增的 SSE 断线安全、端口校验、`readTail`/`read_head` 边界、`scanAgentEvents` 多批排干与游标去重、`bind_session`/`reply_question`/`read_agent` 协作和模块化行数/无注释规则检查在内，`npm run check` 与 `npm test` 全部 79 项测试通过。

### 设置中心、模型画像与 GPT 实测

- 自动化检查：新增与补充设置、鉴权防护与 Codex 同步测试（覆盖凭据脱敏与 0600 备份、`sync_codex` 导入 JWT 校验与权限检查、`__proto__` 原型污染拒绝、写前参数与 `models.json` 前置校验、接口字段白名单、`baseContextWindow`/`baseMaxTokens` 恢复基线保留、`loadSkills`/`loadContextFiles` 会话固化、`get_model_profiles`/`list_models` MCP 返回无明文泄漏，以及 `/api/settings*` 鉴权）；`npm run check`、`npm test`（85 项测试全部通过）与 `agy plugin validate ~/.gemini/config/plugins/pi-subagents --strict` 通过；真实 stdio MCP（`node src/server.js`）确认列出 23 个工具且 `get_model_profiles` 返回当前启用的 2 款 GPT 模型、6 个内置 Pi 工具和零明文凭据。
- 本机 Codex 登录导入与双模型配置：经用户授权通过 `sync_codex` 从 `~/.codex/auth.json` 导入 `openai-codex` OAuth 凭据后，`pi auth check --provider openai-codex --json` 返回 `status: "ready"`；保留启用 `openai-codex` 下的 `gpt-6-astra`（科研与核心重大决策刹车视角）与 `gpt-6.1-sol`（高效准确编码 review/debug/推理核验，约束禁写防御性兜底和多余文档），关闭其余 11 个 Codex 模型与其余 11 家服务商。
- 真机 GPT（`openai-codex` / `gpt-6.1-sol`）回调与 3141 面板实测：创建绑定当前 Antigravity 会话的临时演示代理（外部临时工作目录，测试结束后已关闭并删除目录），实测完成 `agent_message` 进度上报、`ask_parent` 阻塞等待、`reply_question` 答复唤醒、`reply.txt` 写入、`settled (completed)`、`send_message` 二轮追加修改与 `PreInvocation` 钩子自动注入回调（`sequence=25`）；随后使用 `ego-browser` 打开 `http://127.0.0.1:3141/`，确认左侧 Antigravity 分组、对话详情、左下角设置弹窗内 `openai-codex`（`OAuth 正常`、`2/13 模型`、“同步本机 Codex 登录”按钮及两款模型能力描述）均渲染正常，无控制台报错且无横向溢出。
