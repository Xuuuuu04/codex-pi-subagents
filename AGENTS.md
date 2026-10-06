# CodeX 子代理拓展

## 这个项目是什么
为 Codex 提供 Pi 多模型子代理 MCP。每个会话独立保存，支持任务、双向消息、提问、等待、停止、恢复和临时模型切换。

## 怎么运行
- Node.js 22.19+，本机 Pi 1.0.2+、Codex 和有效模型配置。
- `npm ci --ignore-scripts` 安装固定依赖；`npm start` 启动 stdio MCP。
- `npm run check` 检查 JavaScript；`npm test` 检查行为，不调用真实模型。
- `npm run install:codex` 接入本机 Codex；`npm run uninstall:codex` 移除接入。
- `npm run dashboard` 启动或复用本机只读会话面板；默认 MCP 启动时自动启动。
- `npm run verify:live` 真实国模验证；`node scripts/verify-codex.js` 真实 Codex 接入验证。

## 目录地图
- `src/server.js`：MCP 工具定义与启动。
- `src/quota*.js`：读取 Pi 凭据，查询 Codex、GLM、MiniMax、DeepSeek 和 OpenCode Go 额度；固定服务地址，只返回明确字段。
- `src/manager.js`：Pi 会话、模型、生命周期和等待。
- `src/rpc-client.js`：Pi 子进程 JSONL 命令与事件。
- `src/messages.js`：本机消息接收、问题等待与答复。
- `src/storage.js`：私密状态和事件保存。
- `src/workspace.js`：文件范围、独立 Git 工作目录。
- `src/dashboard*.js`、`dashboard/`：只读数据、私密本机服务、独立启动与页面。
- `extensions/communication.ts`：子代理可调用的报告和提问工具。
- `scripts/`：检查、安装、真实验收。
- `tests/`：按功能组织的行为检查；`tests/helpers/` 为隔离 Pi 模拟进程。
- `docs/`：安装后验证结果与协议说明。
- `.agents/`：本机任务、证据、配置备份和运行数据；由 `.gitignore` 排除。

## 去哪里找
- 使用步骤、工具参数含义与限制：`README.md`。
- 实际 MCP 参数：`src/server.js`；Pi 对接命令：`src/rpc-client.js`。
- 当前验证结果：`docs/verification.md`；原始证据：`.agents/records/`。
- 恢复入口：`list_agents(includeSaved=true)` 后 `resume_agent`。

## 数据怎么流动
Codex 调用 MCP → 管理器创建或控制 Pi → Pi RPC 输出事件 → 记录状态与有限消息 → Codex 等待或读取。子代理调用报告或提问工具，通过带独立会话令牌的本机 HTTP 请求交给所属管理器；明确答复后提问工具返回。

## 本项目的约定
- 模型调用由 Pi 读取凭据；额度查询只在内存读取 Pi 凭据并发出固定域名 GET，不复制 key，不将凭据、账号身份或卡片身份返回到工具结果。
- prompt 接受、工具结束、Pi 整体工作结束、业务检查通过分别处理。
- 等待使用代理身份和递增事件序号；读取有长度限制，完整资料保存在会话中。
- 并行 Git 开发默认独立 worktree；共享目录必须声明不重叠的文件范围。
- 临时模型切换在一次工作完全结束后恢复；运行中换模型须先明确停止。
- 关闭进程保留会话和代码；恢复不重复旧任务。
- 面板只读现有文件，不调用代理控制命令；缺少活跃控制进程的工作状态明确显示离线。

## 不要做的事
- 不承诺 MCP 可以自动唤醒已经结束的 Codex 父会话或复制原生子代理界面。
- 不把目录里的价格当成真实扣费记录。
- 不靠 stdout 打印日志；stdout 只用于 MCP 协议。
- 不吞掉 Pi 命令错误，不把工具接受任务当成完成。
- 不自动合并、删除工作目录或部署；模型声明文件范围不等于系统权限限制。

## 已知的坑
- 额度窗口按返回时长分类，缺失窗口表示未知；凭据续期由 Pi 负责，额度工具不改认证文件。
- `agent_end` 后可能继续重试，最终结束要看 `agent_settled`。
- Pi stdout 按 LF 切 JSONL；Unicode 分隔符可以出现在合法字符串里。
- `ask_parent` 等待期间要用 `reply_question`，普通消息只进入指令队列。
- 新增 MCP 后当前已运行的 Codex 聊天可能尚未加载；重启客户端。
- 安装使用绝对 Node/Pi 路径；移动项目或移除对应 Node 版本后重跑安装。
- 配置备份可能包含其他服务的凭据，仅留本机；不进入提交或报告。
- 面板普通地址自动建立 HttpOnly、SameSite=Strict 查看 cookie，内部令牌仅存本机；不允许其他网站读取、任意路径读取、远程绑定或 HTML 执行日志内容。
