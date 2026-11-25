# Unify

把同一个问题发送给多个模型，并排查看回答，匿名汇总，再选择一个方案实施。运行在本地终端，使用 TypeScript、模型 CLI 和文件记录，不需要数据库服务。

## 启动

需要 Node.js 20+。使用官方 API 可以直接启动，在 TUI 中输入 `/settings` 接入。使用模型 CLI 时请先安装并登录对应工具。

```sh
npm ci
npm run build
node dist/cli.js
```

也可以使用脚本入口：

```sh
node dist/cli.js doctor
node dist/cli.js ask "分析这个项目的模块划分" --models codex,gemini-pro
node dist/cli.js ask -c "进一步说明取消与资源清理"
node dist/cli.js exec --with codex
```

`exec` 会显示来源记录、方案目标、执行模型和目录，确认后才开始实施。非交互环境需要 `--yes`。单模型回答可以直接实施；多个回答没有成功汇总时，用 `--from <目标id>` 指定方案。实施不会由 Unify 自动提交或推送。

## 桌面端

`desktop/` 是基于 Electron 的桌面应用，与 CLI、TUI 共用 `src/core` 的同一套流程：决策、并排回答、匿名汇总、实施、记录和配置都由同样的代码处理，记录也写进同一个 `.unify/runs/`，三种界面可以互相查看。

点击桌面端汇总正文中的模型引用，可以查看该轮回答，并高亮被引用的原文段落。按 Esc 返回汇总的原阅读位置。旧汇总中只标明模型的引用会打开完整回答。

**手机接着聊**。在桌面打开已有对话，点标题栏「手机共享」，选择电脑的网络地址，再点「共享当前会话」。手机相机扫码后可在浏览器里看历史、各模型正在生成的回答和汇总。点输入框旁的「取消本轮」可停止生成，随后可以继续追问。手机发送的追问也会出现在桌面的同一段对话里。模型需要交互时，手机会显示「等待电脑端确认」。手机锁屏或临时断网后，回到该页面会自动补齐进度。

电脑需保持唤醒并运行 Unify。局域网连接使用 HTTP，请选择可信 Wi-Fi。外出时，如果手机和电脑已接入同一私有 VPN（例如 Tailscale），共享时选电脑的 VPN IPv4 地址，手机也可以用蜂窝网络连接。链接包含这段会话的访问凭证。桌面点「共享中 → 停止共享」或退出应用后，链接失效。

汇总会对齐各回答讨论的输入、处理阶段和适用条件，并说明分歧何时会改变最终结果。能查阅仓库的汇总模型直接沿实际路径核实关键判断。纯文本汇总模型遇到本轮有成功回答的只读工具模型时，会先做一次分歧判断，必要时把一个具体问题交给其中一个模型取证。Unify 按项目相对路径、行号和原文逐行匹配，把匹配的片段交给最终汇总，并保存在本轮记录里。桌面端可在汇总卡的「源码证据」中查看。证据不足时，汇总应说明成立条件和待核实之处。

- **对话**：问题同时发给所选模型，每个模型一列实时流式输出，可展开思考过程、放大阅读、复制、单独取消或重试某个模型。多个回答成功后在下方显示汇总。同一对话里继续提问会带上之前的上下文。
- **实施**：在一轮结束后选择「实施方案…」或某个回答上的实施按钮，确认来源与执行模型后才开始，执行过程中的工具调用逐条显示。
- **组合模版**：打开「设置 → 组合模版」，点「新建模版」创建自己的模型组合。拖节点调整位置，拖空白处平移画布，点「自动排列」按执行顺序整理布局。点模型节点换人，点「＋ 并行」添加方案分支，点连线的「＋」增加复核。分工和布局自动保存到当前项目，也可以另存为模版。在输入框选择模版即可使用。方案就绪后可以继续修改、终止或确认实施。纯文本复核模型依据方案和实施报告评审，支持读取仓库的模型还可查阅实际改动。实施结束或停止后，点「带回方案讨论」可以把已采纳方案和实施记录交还给方案模型。
- **侧栏**按工作区展示对话。点「工作区」旁的 ＋ 添加文件夹，当前对话会留在原处。展开文件夹可查看置顶和近期对话，点文件夹旁的 ＋ 可在该目录新建对话。搜索框可按标题查找所有工作区的对话。侧栏也可打开套餐额度、记忆管理和设置。
- **项目**：可从标题栏切换项目文件夹，点击分支名可切换本地 Git 分支。配置按项目读取。快捷键 `Ctrl/⌘+N` 新对话，`Ctrl/⌘+,` 设置，`Ctrl/⌘+B` 侧栏，`Esc` 停止当前轮。

桌面端需要 Node.js 22.12+（Electron 安装脚本的要求），并且先在仓库根目录安装依赖：

```sh
npm ci                 # 仓库根目录
cd desktop
npm install
npm start              # 构建并打开窗口
npm run dist           # 打包安装程序到 desktop/release/
```

主进程由 esbuild 直接打包 `../src` 的 TypeScript 源码，不依赖根目录的 `dist/`。窗口在沙箱中运行，渲染进程只能通过预加载脚本调用主进程中列出的方法；模型输出的 Markdown 在渲染前经过清理，链接一律在系统浏览器中打开。退出时会取消所有进行中的调用并等待记录保存。从 macOS Dock 或 Linux 启动器打开时，会读取登录 shell 的 `PATH`，以便找到 npm、Homebrew 安装的模型 CLI。

## 从一次失败构造项目评测题

在桌面端点回答上的 **留题**，在 TUI 聚焦回答后按 `b`，或输入 `/bench 重试时应该保留成功目标的结果`。这一步只在项目内保存已有轮次与回答的引用、短标题和可选备注。平时提问、实施和重试都不会触发评测存储。桌面端侧栏的 **评测集** 可以完成后续流程。

1. 在失败线索中选一条，填入预期行为，或采用它的下一轮追问。点 **生成草稿** 后才调用所选出题模型。第一次调用只拿到原始任务上下文，第二次调用用错答和纠正构造私有验收材料。缺少关键材料时保留线索，可以补齐后重试。
2. 审阅考生能看到的题面和文件，检查它是否保留了原来的难点。评审侧展示要测的能力、代表性错解、参考解和判分依据。草稿允许编辑。代表性错解可以是为新接口改写的复现，它的失败不代表原模型在每次重跑时都会失败。
3. 发布前 Harness 要求错解得到有效的失败判定、参考解通过。每份发布内容有独立 ID。参评目标分别从新临时目录接收题面和公开文件，判分发生在答卷提交之后。结果按题、目标和模型配置展示，包含通过、未通过或运行错误。

**试一道非技术题。** 打开桌面端的 **评测集**，点 **会议纪要** 卡片。如果库里已有案例或线索，先点 **从场景示例新建**。题目给出一段会议记录，其中“争取周五上线”还要等法务确认。你可以编辑题面、代表性错答、参考答案和每一条评审标准。选择评审模型，点 **对照校验并收录**，再点 **运行本题对照**，即可并排阅读各模型的纪要，查看它们在文案交付、上线前提和跟进人这三项上的表现及理由。另有客服回复、用户研究和品牌文案示例。创建示例草稿在本地完成，校验和运行开放题时才调用模型，均无需 Docker。

**管理案例集。** 在侧栏打开 **评测集**，点 **新建案例集**，输入名称并勾选已有案例。一个案例可以加入多个集合。通过首页下拉框切换集合，点 **编辑案例集** 可改名、增减成员或删除集合。删除集合会保留库中案例。在集合内点 **案例集模型对照** 只运行该集合的成员。

**管理单条案例。** 点 **新建案例** 可从空白题面开始，也可以沿用场景示例或收藏线索。草稿可反复保存，收录时可选择目标集合。首页可按名称、标题、线索备注或 ID 搜索。打开已收录案例，点 **编辑案例** 后修改题面或评审标准，再点 **校验并更新案例**。通过校验后，所属集合会一起引用新版。详情页的删除按钮会要求确认。删除已收录案例会将它从项目题库和所有集合移除，已有评测输出中的版本 ID 仍能查看或重跑。

也可以在 CLI 中试用：

```sh
unify bench example                            # 列出可用示例
unify bench example meeting-notes              # 创建草稿，打印其 ID
unify bench publish <草稿ID> --judge gemini-pro
unify bench run <题目ID> --models codex --judge gemini-pro
```

CLI 可以走同一流程。以下命令中的 ID 替换成前一步输出的值：

```sh
unify bench add --note "只应重试超时的目标"
unify bench list
unify bench draft <候选ID> --with codex
unify bench check <草稿ID>
unify bench publish <草稿ID>
unify bench run <题目ID> --models fast,deep --json
```

管理命令也支持离线使用，按集合运行可用以下方式：

```sh
unify bench collection create 客服回归 <案例ID>               # 打印集合 ID
unify bench list --search 客服 --json
unify bench collection update <集合ID> --name 交付回归 --cases <案例ID1>,<案例ID2>
unify bench run --collection <集合ID> --models fast,deep --judge gemini-pro
unify bench publish --file revised.json --replace <旧案例ID> --judge gemini-pro
unify bench show <案例版本ID>
unify bench collection delete <集合ID>
unify bench remove case <案例ID>
```

可以编辑 `draft` 输出路径下的 JSON，也可以手写题目，用 `check --file case.json` 和 `publish --file case.json` 校验和发布。省略 `run` 的题目 ID 会运行整个题集。开放题在校验、发布和运行时都用 `--judge <目标ID>` 指定评审模型。`run` 有未通过或运行错误时退出码为 1。`--json` 包含各份答卷，可以重定向留作对比。

| 判分方式 | 适用的任务和输出 |
|---|---|
| `exact` | 具有唯一文本结果的任务，比较时忽略首尾空白 |
| `javascript` | 纯函数 Coding 题。模型提交 `solve(input)`，内置 QuickJS WebAssembly 逐例执行，在宿主侧核对 JSON 结果，无需安装 Docker |
| `patch` | 多文件或其他语言的 Coding 题。模型提交 unified diff，在临时文件树应用后，用用户审阅过的测试和本机已有的 Docker 镜像评分。镜像用 digest 固定，容器关闭网络。测试文件挂载到 `/checks`，工作目录含打过补丁的公开文件。测试命令退出 0 为通过，1 为未通过，其他值为运行错误。镜像需包含 `/bin/sh`、`mkdir`、`cp` 和任务需要的依赖 |
| `rubric` | 开放题按语义评审。新生成的草稿带有 `perCriterion: true`，逐项给出通过与否及理由；手写题目也可以启用该字段。原有整体判分题仍按原方式运行 |

**存储与复用。** 线索和草稿在 `.unify/bench/`。已收录的内容保存在 `unify-bench/`，命名案例集与当前版本记录在 `catalog.json`，修订内容可在 `versions/` 中找到。共享案例集时将整个 `unify-bench/` 目录随项目纳入版本控制，原会话删除后仍可运行。每道题只保存构造出来的材料和验收依据。若需要已有源码，出题时可加 `--commit <完整SHA> --files src/a.ts,src/b.ts`，运行时从本地 Git 对象读取指定版本的 UTF-8 文本文件，按原相对路径还原。题集使用者需能取得该提交；未提交内容可以作为显式 fixture 放入题目。引用失效时该题报告运行错误。

题库文件包含参考解和测试，应留在评审侧。Harness 给参评模型的目录与请求只包含公开材料。接入的本地 CLI 仍使用其自身的文件访问权限；需要对不受信任的参评程序实施访问控制时，可使用独立账号或远程纯文本目标。

## 模型配置

用户配置放在 `~/.unify/config.json`，项目配置放在 `./unify.config.json`。项目覆盖用户配置，`models`、`targets` 和 `reasoningEffort` 按键合并。以下两个例外固定生效：

- `custom` 和 `quotaCommands` 只从用户配置加载，项目不能配置新的命令或服务器。
- `disableClaude` 只从用户配置加载，默认关闭。设为 `true` 后，所有项目都会禁用内置 Claude Code、它的版本检测和使用它的目标别名。

配置在启动调用前校验：未知字段、未知引用、重复目标、错误类型、不合理的超时或并发数都会报错。`timeoutSec`、`decisionTimeoutSec`、`execTimeoutSec` 必须是有限正数，最大 2147483 秒；`concurrency` 是 1–64 的整数。

### 同一个 CLI 比较多个模型

`provider` 是协议适配器，`target` 是用户选择的模型配置。内置 `claude`、`codex`、`gemini-pro`、`deepseek` 各自也有同名目标。

```json
{
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

旧的 `"models": {"codex": "<模型名>"}` 配置仍可用。`models.<目标id>` 显式覆盖该目标的 `model`。未配置 `providers` 时，使用所有可用目标，排除 `decider` 本身；需要控制调用数量时，请明确列出 `providers`。旧配置中的内置 `gemini` 及其目标别名会在加载时跳过。如果回答目标全部被跳过，Unify 会恢复自动选择。

### 设置与思考强度

输入 `/settings` 打开设置。方向键选择，Enter 保存，Esc 返回。常用设置写入当前项目的 `unify.config.json`，从下一次调用生效。官方 API 凭证、自定义端点和额度查询命令保存在用户目录。

- **模型与思考强度**可逐个选择目标，从对应服务商的列表选择模型和思考档位。「默认」让底层服务或 CLI 决定强度。回答、决策、汇总和实施均使用实际调用目标的设置，重试回答沿用原轮的模型与强度。
- 在模型设置中选择 **测试可用性**，会按已保存的配置单独向该目标发送一次简短提问。收到有效回答后显示耗时，失败时显示错误原因。
- **回答、汇总与执行**设置默认回答目标、汇总模型、执行模型和决策模型。**并发与超时**设置并发数和各阶段超时。**高级配置**支持目标别名、自定义端点或命令、额度查询命令及禁用 Claude Code。
- **显示思考过程**与**鼠标滚动**设置界面默认行为。鼠标模式也控制拖选和路径点击。`Ctrl+R` 和 `/mouse` 仍可在当前会话临时切换。

以下配置让两个目标使用相同的 DeepSeek 模型，以不同强度独立回答，并用高强度目标汇总：

```json
{
  "targets": {
    "quick": { "provider": "deepseek", "reasoningEffort": "low" },
    "review": { "provider": "deepseek", "reasoningEffort": "high" }
  },
  "providers": ["quick", "review"],
  "synthesizer": "review"
}
```

Gemini Pro 订阅通道从 `agy models` 读取当前账号的型号及可用档位。选择 Gemini 4 Neon 的 `high` 后，界面会把完整型号 `gemini-4-neon-high` 写入 `models.<目标 ID>`。其他通道的档位保存在 `reasoningEffort.<目标 ID>`，优先于该目标别名中的 `reasoningEffort`。Codex CLI 使用 `model_reasoning_effort`，Claude Code 使用 `--effort`。

DeepSeek 区分关闭思考和设置思考强度。Gemini API 和兼容推理模型使用 `reasoning_effort`。Anthropic 的兼容接口使用思考预算，界面对支持手动预算的 Claude 4 系列提供 1024、4096、8192 token 三档。具体可用档位还取决于模型及客户端版本。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) · [Gemini API](https://ai.google.dev/gemini-api/docs/openai) · [Anthropic 兼容接口](https://platform.claude.com/docs/en/api/openai-sdk)

### 在 TUI 中接入官方 API

1. 输入 `/settings`，进入「官方 API 接入」，用方向键选择 DeepSeek、OpenAI、Anthropic 或 Gemini API，按 Enter。
2. 用方向键选择模型，按 Enter 确认。
3. 在隐藏输入框粘贴 API Key，按 Enter 保存并选用该服务商。现在可以直接提问。Esc 可取消设置。

| 服务商 | 目标 ID | 可选密钥环境变量 |
| --- | --- | --- |
| [DeepSeek](https://api-docs.deepseek.com/) | `deepseek` | `DEEPSEEK_API_KEY` |
| [OpenAI](https://developers.openai.com/api/docs/models/gpt-4.1-mini) | `openai` | `OPENAI_API_KEY` |
| [Anthropic](https://platform.claude.com/docs/en/api/openai-sdk) | `anthropic` | `ANTHROPIC_API_KEY` |
| [Gemini API](https://ai.google.dev/gemini-api/docs/openai) | `gemini-api` | `GEMINI_API_KEY` |

设置保存在 `~/.unify/api/<目标 ID>.json`。粘贴的密钥以明文存放在此文件中（POSIX 权限 `0600`）。如果希望只从环境取密钥，首次配置时设置表中的环境变量，密钥框留空即可。再次打开 `/settings` 可以更换模型或密钥，留空会沿用已保存的密钥。删除对应文件即可移除保存的设置。聊天记录和运行快照只包含模型和端点配置。

保存后，当前会话的下一个问题只发给刚选用的服务商。要并排比较，输入例如 `/models codex,deepseek`。下次启动沿用已有的默认目标选择规则，CLI 的 `--models` 也能使用已接入的目标。用户或项目配置中的 `models.<目标 ID>` 优先于在 TUI 设置的默认模型。

### DeepSeek 示例

在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key。可以通过上面的 TUI 接入，也可以直接从环境启用内置 DeepSeek 目标。

```sh
export DEEPSEEK_API_KEY=sk-...
node dist/cli.js doctor
node dist/cli.js ask "比较这两种缓存失效策略" --models codex,deepseek
```

默认模型是 `deepseek-flash`。换模型或同时比较多个模型用 `models` / `targets`，项目配置和用户配置都可以写：

```json
{
  "models": { "deepseek": "deepseek-flash" },
  "targets": {
    "deepseek-pro": { "provider": "deepseek", "model": "deepseek-v4-pro", "label": "DeepSeek Pro" }
  },
  "providers": ["codex", "deepseek", "deepseek-pro"]
}
```

模型名以 [DeepSeek 文档](https://api-docs.deepseek.com/) 为准。提供密钥后，未配置 `providers` 的项目会把它计入默认目标。DeepSeek 按 API 用量计费，与网页版/App 的账号无关。它只回答，不运行本地工具，也不能作为实施目标；思考过程（`reasoning_content`）会显示在思考面板。需要走网关或代理时，在用户配置的 `custom.deepseek` 中写一个 `openai` 端点即可替换内置目标。

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

无需鉴权的端点可以省略 `apiKeyEnv`。自定义端点的密钥从指定环境变量读取。OpenAI 端点使用 `/chat/completions` 流式协议；命令从 stdin 读取问题，以 stdout 输出正文，stderr 输出诊断，只有退出码 0 才能成功。POSIX 参数直接传递，支持空格；Windows `.cmd` 经 shell 启动，只支持受限参数字符，问题始终通过 stdin 传入。

`decider` 可指定任意问答目标，决定本轮选择哪些目标以及是否汇总。无效决策、决策失败和决策超时都回退到全部选中目标；用户手动选择目标优先。总取消不会触发回退调用。汇总目标不可用时，使用按选择顺序排列的第一个成功目标。

### 能力与实际输入

| Provider | 问答策略 | 支持实施 |
| --- | --- | --- |
| Claude | 限定 Read/Glob/Grep/WebSearch/WebFetch 工具 | 是 |
| Codex | CLI `read-only` sandbox | 是 |
| Gemini Pro（Google AI 订阅） | Antigravity CLI `plan` 模式 | 否 |
| 官方 API | 只发送 messages，不运行本地工具 | 否 |
| OpenAI 端点 | 只发送 messages，不运行本地工具 | 否 |
| 自定义命令 | 任意受信任命令，无内置隔离 | 否 |

所有回答目标收到相同的公共问题与历史；CLI 仍可能加载自己的系统提示、项目文件、工具和设置。运行记录保存 Unify 传入的输入及已声明配置，不能复现外部 CLI 内部的完整模型上下文。因此，这适合多模型协作；单凭结果不能做严格的等算力模型评测。

个人 Google AI Pro 订阅使用 `gemini-pro`。首次在终端运行 `agy`，用订阅对应的 Google 账号登录。打开 Unify 后输入 `/models gemini-pro`，即可在同一对话里连续追问。桌面端可以在模型选择器里选择 Gemini Pro。可用型号用 `agy models` 查看，通过 `models.gemini-pro` 指定。[Google 登录指南](https://antigravity.google/docs/cli/install/)

桌面端和 TUI 都通过 Antigravity 的 ACP 在计划模式下处理权限请求。TUI 在发起请求的模型面板底部显示命令或访问路径及审批选项。编辑草稿时可继续输入，按 `Ctrl+G` 聚焦审批框，按 `Tab` 返回。旧版 CLI 若无法初始化 ACP，会使用无交互模式，并在工具记录中标明被拦截的操作。[Antigravity ACP](https://antigravity.google/docs/cli/acp/)

## 交互与重试

### 缓存监控

打开桌面侧栏的「缓存监控」，或运行 `unify cache`。加上 `--json` 可取得每次调用的模型、阶段、会话 ID、对照调用 ID、匹配字节数和供应商读数。监控自动覆盖问答、协作、评测、模型检查和记忆提炼。

追问和重试会在发送前检查应当保留的消息前缀。同一轮的分歧判断和汇总会核对共同材料。出现变化时，提示会标出首个不同的消息和字节位置。原生线程恢复失败并回退到公共历史时也会提醒。原生 CLI 内部拼接的系统消息和工具历史对 Unify 不可见。

返回后，监控单独记录供应商上报的缓存读取 token。对可比 HTTP 调用，上次至少读到 1024 个缓存 token、本次降至一半或更少时会提醒。长输入的前缀一致而读数为零时也会提示。模型切换、首次调用和缺少读数单独显示。服务端缓存过期或路由变化也能导致读数降低。

全局记录从启用后的下一次调用开始，保存在本机 `~/.unify/cache-monitor/`。界面展示近 7 个 UTC 日期内最近有活动的 100 次调用。日志只保存调用标识、项目路径、计数和诊断信息。提示词、回答和工具输出不写入监控日志。

### 查看套餐剩余额度

打开交互界面后，每个模型名称旁都会显示剩余额度。开始问答后，额度固定在各自的面板底边，汇总和实施面板也会显示实际使用模型的额度。每 60 秒自动刷新，有足够空间时会显示重置时间。`+N` 表示还有 N 项额度，输入 `/quota` 可查看完整列表，按 `r` 立即刷新，按 `Esc` 返回。

```sh
node dist/cli.js quota            # 查看一次
node dist/cli.js quota --watch    # 持续监控，Ctrl+C 退出
node dist/cli.js quota --json     # 输出 JSON，配合 --watch 时每行一轮快照
```

| 接入方式 | 显示内容 |
| --- | --- |
| Codex | 当前 CLI 账号返回的用量窗口、剩余百分比和重置时间 |
| Claude Code | 当前订阅返回的用量窗口、剩余百分比和重置时间，需要支持额度查询的 CLI 版本 |
| Gemini Pro（Antigravity CLI） | 使用已登录的 `agy` 1.1.11 或更新版本查询各模型组的套餐剩余额度和重置时间 |
| DeepSeek 官方 API | 当前 API Key 对应账户按币种显示的可用余额 |
| 自定义命令和 OpenAI 兼容网关 | 通过用户配置的 `quotaCommands` 读取该服务的额度 |

同一 provider 下的模型别名共用一次查询。每个别名都会展示该 provider 返回的额度，重复出现的账户余额只计一份。禁用的目标、缺少凭证和查询失败都有单独的状态，真实的零余额会显示为 0。

自定义网关可以在 `~/.unify/config.json` 中用 provider id 指定额度命令。例如，为上面的 `local` 端点配置查询脚本：

```json
{
  "quotaCommands": {
    "local": { "command": "/absolute/path/to/gateway-quota", "args": ["--json"] }
  }
}
```

命令在项目目录运行，从标准输出返回一个 JSON 对象并以 0 退出。每项填写 `label`、数值型 `remaining` 和 `unit`。`total` 和 ISO 8601 格式的 `resetsAt` 可选。读取缓存时可以用顶层 `observedAt` 标注数据时间。

```json
{"limits":[{"label":"月请求包","remaining":420,"total":1000,"unit":"次","resetsAt":"2027-01-01T00:00:00+08:00"}]}
```

### 终端交互

**用纯 TUI 共享给手机**。运行 `unify`，先提问或用 `/resume` 打开会话，再输入 `/share`。电脑有多个网络地址时，选择手机可达的可信 Wi-Fi 或私有 VPN 地址。手机扫码后可以看实时回答和汇总、点「取消本轮」停止生成，也可以在本轮结束后追问。手机提交的消息会出现在同一个 TUI 里，模型交互请求也在该终端处理。

二维码页面按 `Esc` 返回对话并保持共享，按 `L` 查看链接，按 `C` 复制。终端需要保持运行。`/share off`、新建对话、切换到另一段会话或退出终端都会使旧链接失效。

TUI 支持并排阅读、思考过程切换、复制、滚动和放大，输入区的操作习惯与 Codex、Pi 等终端工具一致：

- **命令补全**：输入 `/` 弹出命令列表，继续输入过滤，`↑↓` 选择，`Tab` 补全，`Enter` 补全并执行；`/models`、`/synth`、`/exec`、`/retry`、`/cancel` 的参数会补全目标 id。
- **文件引用**：输入 `@` 模糊搜索项目文件（`git ls-files`，非 Git 目录则有界遍历），选中后以 `@路径` 写入问题。本地 CLI 可直接查阅仓库；对于只发送 messages 的纯文本 HTTP 目标（及纯文本汇总目标），Unify 会自动读取当前项目内显式 `@` 引用的文本文件（自动跳过二进制、越界路径并做有界截断）一并附带，拉齐上下文质量。
- **多行编辑**：`Shift+Enter`、`Alt+Enter` 或 `Ctrl+J` 换行；`Ctrl+A/E` 行首行尾，`Alt+←/→`（或 `Ctrl+←/→`）按词移动，`Ctrl+W` 删词，`Ctrl+U/K` 删到行首/行尾。`↑↓` 先在多行内移动，到首末行再翻阅历史，未发送的草稿会保留。`Shift+Enter` 需要终端支持 kitty 键盘协议或 xterm modifyOtherKeys。在 tmux 中还需允许转发扩展按键，可运行 `tmux set -s extended-keys on`。如果终端无法发送 `Shift+Enter`，可以用 `Ctrl+J`。
- **排队发送**：生成过程中可以继续输入并发送，消息排在输入框上方，本轮结束后依次发出。
- **拖选与复制**：鼠标模式下按住左键拖选，按 `Ctrl+C` 或 `Ctrl+Y` 复制。也可用 `/mouse` 切换到终端原生选区。
- **文件跳转**：单击回答或审批里带下划线的文件引用，打开 TUI 内的只读预览。支持相对路径、绝对路径和行号，例如 `src/app.ts:42` 或 `src/app.ts#L42`。按 `Esc` 回到对话。
- **中断与退出**：有选区时，`Esc` 清除选区，`Ctrl+C` 复制。其余情况下，同样的键用于中断当前整轮。空闲时 `Ctrl+C` 先清空输入，输入为空时连按两次退出。`Ctrl+D`、`/exit`、`/quit` 直接退出。退出会等待已启动调用清理并保存记录。
- **状态栏**：输入框上方显示当前阶段、已用时间和排队数；底部显示目录与分支、当前目标与汇总目标、本次会话累计的输入/输出 token（由各 provider 上报，不上报的不计）。

| 操作 | 含义 |
| --- | --- |
| `/settings` | 设置 API、模型、思考强度、工作流和界面 |
| `/models a,b` | 后续问题手动选择目标 |
| `/graph` | 选择项目已保存的协作模版，输入任务后按模版分工运行。也可用 `/graph <模版ID>` 直接选择，`/graph off` 恢复普通问答 |
| `/revise 修改要求` | 沿用原模版和模型修改方案，也可在实施后带着结果继续讨论 |
| `/close-plan` | 终止当前待实施的协作方案 |
| `/resume` | 按置顶和更新时间列出当前项目的历史会话，包括桌面端记录。用 ↑↓ 选择，Enter 恢复最近一轮并继续追问，也可直接输入 `/resume <会话ID>` |
| `/share` | 开启当前会话的手机共享，或再次显示二维码。用 `/share off` 停止共享 |
| `Ctrl+G` | 聚焦模型面板内的授权或提问，重复按键切换待处理请求。Enter 提交，Esc 取消该项，Tab 返回，Ctrl+C 中断本轮 |
| `/quota` | 查看所有目标的套餐剩余额度 |
| `/cache` | 查看全局缓存读数覆盖情况及预警摘要 |
| `/branch` | 查看当前分支和本地 Git 分支列表 |
| `/branch 分支名` | 切换到指定的本地 Git 分支 |
| `/synth a` | 设置后续汇总目标 |
| `/cancel b` | 取消正在回答或排队的目标 b，其余继续 |
| `/cancel` | 取消本轮，包括决策或汇总 |
| `/retry b` | 使用原轮输入和模型，仅重新调用 b |
| `/retry` | 重试所有失败、取消或尚未开始的目标 |
| `Tab` 后 `Ctrl+E` | 按聚焦回答实施，需确认 |
| `/exec [目标]` | 使用汇总或唯一成功答案实施 |
| `/use [目标]` | 下轮追问沿用指定目标的回答（不带参数恢复默认；聚焦回答面板时按 `u` 也可切换） |
| `/new` | 开始独立会话 |
| `/copy` | 复制当前结果 |
| `/help` | 快捷键与命令一览 |

输入框有内容时 `Ctrl+E` 是行尾；输入为空或焦点在面板上时才是实施。

CLI 对应命令：

```sh
node dist/cli.js retry <记录id> --target deep
node dist/cli.js show <记录id>
node dist/cli.js list
```

每次重试创建新记录，只包含所选目标，原记录不变。重试不会重复计入原轮历史；它记录 `retryOf` 并保留原始 prompt 和模型选择。自定义传输配置改变时拒绝重试，需重新提问。实施可能已产生文件修改，所以没有自动重试实施的入口。

## 记忆管理

通过本地模型工具回答、汇总或实施时，Unify 会请模型标注实际采用的持久记忆。在桌面端展开回答卡片上的「记忆依据」，可以查看模型报告的来源、记忆摘要和受影响的判断。终端输出、`unify show` 和 Markdown 导出也会显示这些条目。记录保留当时的摘要，之后可以在记忆管理中按路径核对原文。缺少标注的回答仍有可能受记忆影响。

Claude Code、Codex、Gemini CLI 和 Pi 各有一套“记忆”：启动时自动载入的指令文件，以及模型自己写下的笔记。它们分散在系统目录、用户目录、仓库各级目录里，规则各不相同。`unify memory` 按每个工具自己的分层把它们摆出来，并可以直接修改：

```sh
node dist/cli.js memory              # 启动本机网页界面，打印带令牌的链接
node dist/cli.js memory --tui        # 终端内的交互界面
node dist/cli.js memory --list       # 只在终端打印分层结构
node dist/cli.js memory --effective claude   # 打印某个工具启动时拼接后的记忆
node dist/cli.js memory --json       # 扫描结果，供脚本使用
```

终端里也有同样的界面：`node dist/cli.js memory --tui`，或在 TUI 中输入 `/memory`（`/memory web` 启动网页）。左侧按载入顺序列出各层与文件，右侧是所选文件的逐条记忆和来历。

| 键 | 作用 |
| --- | --- |
| `Tab` / `1`–`4` | 切换工具 |
| `↑↓`、`→` / `Enter`、`←` | 选择文件，进入右侧选择记忆，返回 |
| `e` `a` `d` | 编辑、新增、删除所选记忆（`a` 在尚未创建的文件上会创建它） |
| `c` `m` | 复制、移动到另一层或另一个工具 |
| `u` | 撤销最近一次修改 |
| `x` `i` `/` | 查看启动时拼接的上下文、问题列表、搜索 |
| `w` `r` `q` | 打开网页界面、重新扫描、返回 |

编辑全文、新建规则文件、查看提交历史和恢复任意旧版本目前只在网页里。

| 工具 | 分层（按载入顺序，越靠后越优先） |
| --- | --- |
| Claude Code | 组织策略（只读）→ 用户 `~/.claude/CLAUDE.md` 与 `rules/` → 项目各级 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/` → `CLAUDE.local.md` → 子目录 `CLAUDE.md`（按需）→ 自动记忆 `~/.claude/projects/<项目>/memory/` → 子代理记忆 |
| Codex | 全局 `~/.codex/AGENTS.md` → 项目根到当前目录逐级的 `AGENTS.md`（同目录 `AGENTS.override.md` 优先）→ 子目录（不参与本次运行）→ `~/.codex/memories/` |
| Gemini CLI | 全局 `~/.gemini/GEMINI.md`（含 `save_memory` 写入的小节）→ 项目各级 `GEMINI.md` → 子目录（按需）；文件名跟随 `settings.json` 的 `context.fileName` |
| Pi | 全局 `~/.pi/agent/AGENTS.md` → 上级目录到当前目录逐级的 `AGENTS.md`（没有时取 `CLAUDE.md`） |

界面里能做的事：

- **看分层**：每层标明作用范围、启动时载入还是按需载入、由人维护还是模型写入；尚未创建的位置也会列出，可以直接创建。被同目录更高优先级文件取代的、由 `@导入` 引入的、只对某些路径生效的规则、被多个工具共用的文件（例如 Codex 与 Pi 共用 `AGENTS.md`）都有标记。
- **看每条记忆和它的来历**：文件按标题拆成条目（列表项、段落、代码块）。纳入 Git 的文件逐条显示最后修改它的提交、作者和时间，未提交的改动单独标出；模型自己写入的内容（Claude 自动记忆、Gemini 的 `save_memory`）有标签。“来历”里可以看文件的提交历史和在这里做过的每次修改。未纳入 Git 的文件只能追溯到最后修改时间。
- **修改**：单条编辑、删除、新增到指定小节，或编辑全文、新建和删除文件。还可以把一条记忆复制或移动到另一层或另一个工具，例如把项目里的个人习惯上移到用户层，或把 Claude 的约定同步给 Codex。
- **看模型实际收到什么**：按载入顺序拼接的启动上下文、估算的 token 数和各层占比。token 数按字符估算，不是各家分词器的精确值。
- **发现问题**：失效的 `@导入`、重复的记忆、`MEMORY.md` 超出启动载入上限的部分、Codex 项目指令超过 32 KiB、被取代而不会读取的文件。
- **搜索** 所有工具的全部记忆。界面每几秒重新扫描，工具自己写入的新记忆会自动出现。

每次修改前的版本保存在 `~/.unify/memory-backups/`（保留最近 200 个），可以查看和恢复。保存时会校验文件自读取后没有被别处改过，冲突时不覆盖。只有扫描列出的记忆文件位置可以写入，组织策略只读；符号链接（如 `CLAUDE.md → AGENTS.md`）会写入其目标而不是替换链接。

服务只监听 `127.0.0.1`，所有接口都需要链接里的随机令牌并校验 Host，其他网站或本机其他用户无法读写。分层规则按各工具的公开文档实现，工具升级后可能变化；规则集中在 `src/memory/scan.ts` 的四个函数里，新增工具只需再写一个。

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
CLI / TUI / desktop（Electron 主进程）
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
