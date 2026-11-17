# Unify

把同一个问题发送给多个模型，并排查看回答，匿名汇总，再选择一个方案实施。运行在本地终端，使用 TypeScript、模型 CLI 和文件记录，不需要数据库服务。

## 启动

需要 Node.js 20+。安装并登录要使用的模型 CLI，然后：

```sh
npm ci
npm run build
node dist/cli.js
```

也可以使用脚本入口：

```sh
node dist/cli.js doctor
node dist/cli.js ask "分析这个项目的模块划分" --models codex,gemini
node dist/cli.js ask -c "进一步说明取消与资源清理"
node dist/cli.js exec --with codex
```

`exec` 会显示来源记录、方案目标、执行模型和目录，确认后才开始实施。非交互环境需要 `--yes`。单模型回答可以直接实施；多个回答没有成功汇总时，用 `--from <目标id>` 指定方案。实施不会由 Unify 自动提交或推送。

## 模型配置

用户配置放在 `~/.unify/config.json`，项目配置放在 `./unify.config.json`。项目覆盖用户配置，`models` 和 `targets` 按键合并。以下两个例外固定生效：

- `custom` 只从用户配置加载，项目不能配置新的命令或服务器。
- 任一配置设置 `disableClaude: true`，都会完全禁用内置 Claude Code，包括版本检测和基于 Claude 的目标。

配置在启动调用前校验：未知字段、未知引用、重复目标、错误类型、不合理的超时或并发数都会报错。`timeoutSec`、`decisionTimeoutSec`、`execTimeoutSec` 必须是有限正数，最大 2147483 秒；`concurrency` 是 1–64 的整数。

### 同一个 CLI 比较多个模型

`provider` 是协议适配器，`target` 是用户选择的模型配置。内置 `claude`、`codex`、`gemini` 各自也有同名默认目标。

```json
{
  "disableClaude": true,
  "targets": {
    "fast": { "provider": "codex", "model": "<已支持的模型名>", "label": "快速模型" },
    "deep": { "provider": "codex", "model": "<另一个模型名>", "label": "深度模型" }
  },
  "providers": ["fast", "deep"],
  "synthesizer": "deep",
  "executor": "deep",
  "timeoutSec": 600,
  "decisionTimeoutSec": 60,
  "execTimeoutSec": 3600,
  "concurrency": 3
}
```

替换示例中的模型名后使用。`providers`、`synthesizer`、`executor` 和 `decider` 引用目标 id；`--models fast,deep` 与 TUI `/models fast,deep` 使用相同 id。重复选择同一个 id 会报错。两个不同目标可以共用一个 provider，各自拥有独立的调用 id、结果和面板。

旧的 `"models": {"codex": "<模型名>"}` 配置仍可用。`models.<目标id>` 显式覆盖该目标的 `model`。未配置 `providers` 时，使用所有可用目标，排除 `decider` 本身；需要控制调用数量时，请明确列出 `providers`。

### OpenAI 兼容端点和自定义命令

仅在用户配置中填写：

```json
{
  "custom": {
    "local": {
      "type": "openai",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "model": "local-model",
      "apiKeyEnv": "LOCAL_MODEL_API_KEY",
      "system": "请用中文回答。"
    },
    "script": {
      "type": "command",
      "command": "/absolute/path/to/model-wrapper",
      "args": ["--profile", "answer"]
    }
  },
  "providers": ["local", "script"]
}
```

无需鉴权的端点可以省略 `apiKeyEnv`。密钥值仅从环境读取，不保存到记录。OpenAI 端点使用 `/chat/completions` 流式协议；命令从 stdin 读取问题，以 stdout 输出正文，stderr 输出诊断，只有退出码 0 才能成功。POSIX 参数直接传递，支持空格；Windows `.cmd` 经 shell 启动，只支持受限参数字符，问题始终通过 stdin 传入。

`decider` 可指定任意问答目标，决定本轮选择哪些目标以及是否汇总。无效决策、决策失败和决策超时都回退到全部选中目标；用户手动选择目标优先。总取消不会触发回退调用。汇总目标不可用时，使用按选择顺序排列的第一个成功目标。

### 能力与实际输入

| Provider | 问答策略 | 支持实施 |
| --- | --- | --- |
| Claude | 限定 Read/Glob/Grep/WebSearch/WebFetch 工具 | 是 |
| Codex | CLI `read-only` sandbox | 是 |
| Gemini | CLI `plan` approval mode | 是 |
| OpenAI 端点 | 只发送 messages，不运行本地工具 | 否 |
| 自定义命令 | 任意受信任命令，无内置隔离 | 否 |

Gemini 必须支持 `--approval-mode plan`。该模式允许写计划文件，且受本地策略影响，不能视为操作系统级只读沙箱。协议与模式参考 [headless](https://geminicli.com/docs/cli/headless/) 和 [plan mode](https://geminicli.com/docs/cli/plan-mode/)。不支持的 CLI 版本会报错，不回退到权限更大的模式。

所有回答目标收到相同的公共问题与历史；CLI 仍可能加载自己的系统提示、项目文件、工具和设置。运行记录保存 Unify 传入的输入及已声明配置，不能复现外部 CLI 内部的完整模型上下文。因此，这适合多模型协作；单凭结果不能做严格的等算力模型评测。

## 交互与重试

TUI 支持并排阅读、思考过程切换、复制、滚动和放大。`Ctrl+C` 取消当前整轮；空闲且输入为空时退出。退出会等待已启动调用清理并保存记录。`/exit` 与 `/quit` 等效。

| 操作 | 含义 |
| --- | --- |
| `/models a,b` | 后续问题手动选择目标 |
| `/synth a` | 设置后续汇总目标 |
| `/cancel b` | 取消正在回答或排队的目标 b，其余继续 |
| `/cancel` | 取消本轮，包括决策或汇总 |
| `/retry b` | 使用原轮输入和模型，仅重新调用 b |
| `/retry` | 重试所有失败、取消或尚未开始的目标 |
| `Tab` 后 `Ctrl+E` | 按聚焦回答实施，需确认 |
| `/exec [目标]` | 使用汇总或唯一成功答案实施 |
| `/new` | 开始独立会话 |
| `/copy` | 复制当前结果 |

CLI 对应命令：

```sh
node dist/cli.js retry <记录id> --target deep
node dist/cli.js show <记录id>
node dist/cli.js list
```

每次重试创建新记录，只包含所选目标，原记录不变。重试不会重复计入原轮历史；它记录 `retryOf` 并保留原始 prompt 和模型选择。自定义传输配置改变时拒绝重试，需重新提问。实施可能已产生文件修改，所以没有自动重试实施的入口。

## 状态、上下文与记录

问答轮次的正常阶段为 `created → deciding（可选）→ answering → synthesizing（可选）`。最终状态为 `completed`、`partial`、`failed` 或 `cancelled`。单次调用有独立的 `succeeded`、`failed`、`cancelled`、`timed_out` 状态；部分输出会随失败保留，但不会进入汇总或成为可实施方案。

成功要求“协议成功终态 + 传输正常结束”。CLI 的终态后非零退出、缺少终态、重复终态均失败。OpenAI SSE 遇到 `[DONE]` 或正常 `finish_reason=stop` 才能完成；上游 error、JSON 错误、token 截断、工具调用结束或异常 EOF 都不能当作完整回答。

取消和超时会停止新的排队调用，清理已启动调用。POSIX 使用独立进程组，先发送 SIGTERM，400ms 后 SIGKILL，并有界等待管道关闭；Windows 使用 `taskkill /T /F`。刻意脱离进程组的外部守护进程不在这一保证内。内核对不响应取消的第三方 generator 有 2.5 秒等待上限，但 JavaScript 无法强行终止第三方进程内代码。

每轮保存在 `.unify/runs/<id>/`：

```text
run.json          # 带 schemaVersion: 2 的权威记录
question.md       # 可读问题
answer-<target-id>.md  # 成功回答或失败及部分输出
synthesis.md      # 汇总输出（如有）
```

记录包括：

- `id`：一次问答或实施记录；`sessionId`：连续会话；`parentTurnId`：上游轮次。
- `calls[].id`：一次模型调用；`target.id`、`target.provider`、`target.model` 分别标识目标、适配器和模型。
- `input.history`、各调用的 `input.prompt/cwd/mode/timeoutMs`、能力和自定义传输配置。
- 决策、匿名标签到目标的映射、完整结果和错误。
- 实施的 `planSource`：来源轮次、调用、目标和 answer/synthesis 类型。

开始、阶段切换和每个调用结束都会保存。流式进度以最多每 250ms 一次的频率保存。JSON 通过同目录临时文件、文件 fsync 和原子 rename 替换，避免留下半截 JSON。强制杀进程可能丢失最后一小段流式输出；下次读取时，没有存活拥有者的未完成记录标为 `interrupted`，不会自动续跑。拥有者以主机名和 PID 判断。可读 Markdown 是派生导出；中断时优先使用 `show` 查看 JSON 中的进度。

保存失败会取消剩余调用并报错，不继续汇总或报告成功。UI/事件订阅者错误会单独记入 `observerErrors`，不会改变模型结果。CLI 允许部分目标成功时返回 0，全失败返回 1，SIGINT 返回 130，SIGTERM 返回 143。

连续追问累积公共历史：成功汇总优先，否则取按选择顺序的第一个成功回答。决策、回答和汇总都能看到这份历史。没有成功回答的轮次不会进入公共历史；已成功的部分回答可以成为后续上下文。当前不自动压缩或截断历史，长会话可用 `/new` 开始新上下文。

旧格式记录保持可读，`show`、`exec` 和继续追问会在内存中补齐必要字段，不重写原文件。旧记录没有完整输入与目标快照，不能承诺精确重试；可重新提问。新的记录 id 带时间和 UUID，不会因为同秒调用而覆盖。

### JSONL 接入

```sh
node dist/cli.js ask "问题" --models fast,deep --json
```

每行都是 JSON，包含 `schemaVersion: 2` 和 `turnId`。事件有 `stage`、`call`、`provider`、`notice`、`end`；`provider` 事件携带 `callId`、`targetId`、`scope` 及嵌套的标准事件 `event`。stdout 仅输出事件，参数或存储错误写 stderr。消费者应以 `(turnId, callId)` 关联内容，以终态确认结果；旧 JSONL 消费者需要适配此版本。

## 代码结构与扩展

```text
CLI / TUI
    └── core/workflow       决策、问答、汇总、实施、上下文与来源
          ├── core/store    记录校验、原子保存、旧格式读取
          ├── core/synth    纯提示构造与匿名化
          └── core/orchestrator
                └── ProviderAdapter
                      ├── CLI → core/proc
                      └── HTTP → providers/sse
```

`ModelTarget` 组合适配器与模型配置。新增相同协议的模型只需配置；新增协议实现 `ProviderAdapter` 并注册。适配器负责翻译事件、声明能力、响应取消、释放资源，并在正常结束前输出一个终态。调度器负责并发限额、状态分类和对外唯一终态。界面只消费 `WorkflowEvent` 和发出操作，不自行拼接实施 prompt。

运行记录会包含问题、回答、system 配置和命令参数。不要把凭证写进 prompt、system 或命令参数；通过环境引用传递。`.unify/` 已被 Git 忽略。

## 验证

```sh
npm test
```

测试先执行 TypeScript 编译，再用 Node 内置测试框架运行。覆盖终态错误、取消与超时、有界并发、真实子进程回收、本地 SSE 服务、配置验证、记录及上下文、三个假 CLI 协议、CLI JSONL 和 TUI 键盘操作后的屏幕内容。测试不会访问真实模型或使用模型凭证。

真实 CLI 的登录、版本兼容性和供应商行为需要在使用环境验证。Linux 进程清理已通过回归；Windows 的 `taskkill` 分支尚未在 Windows 主机验证。
