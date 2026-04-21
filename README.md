# AgentHub

`AgentHub` 是这个项目的新名字。

当前本地目录仍然是 `/Users/zhangpeng/ai-chat-mvp`，这样不会打断你现有的启动方式；后面如果你要，我可以再帮你把目录名也一起迁过去。

## 愿景

AgentHub 不是普通聊天工具，也不应该继续演化成一个越来越复杂的人类控制台。

它首先应该是一个 `面向数字员工协作` 的控制平面，其次才是一个给人观察和指挥的管理台：

- `Agent` 是第一用户，也是实际执行者
- `AI经理` 是编排层，负责理解目标、分派员工、汇总进度
- `手机端 / 网页端` 是给人的观察与指挥入口
- `电脑` 是数字员工运行的宿主环境
- `Codex / Claude / OpenAI / 本地模型` 都是可接入的员工能力源

长期目标是：

- 一台电脑上可以运行多个数字员工
- 多台电脑上的数字员工都能被统一编排
- Agent 通过 AgentHub 完成任务领取、上下文恢复、协作交接和结果回收
- 人通过 AgentHub 完成目标下达、状态观察、授权确认和必要的直连干预
- 项目本身也适合交给 AI 持续迭代开发

## 当前这一版

当前这版已经开始从 `单机多 Agent` 往 `AI经理 + 多设备多 Agent` 演进，但新的正式方向是 `Agent First`：

- 首页新增了 `AI经理` 面板，优先回答“员工有哪些、他们在做什么、某个员工的进度、切到谁的直连”
- AI经理 通过可切换的 provider 调用 Hub 内部工具来盘点员工和任务；当前内置了 `OpenAI Responses API` 和 `智谱 Chat Completions`
- 如果还没配置经理层模型 key，AI经理 会先退回本地摘要模式
- 首页只保留 `AI经理` 对话这一件事；当你需要细节时，经理会给出 `任务详情页` 跳转卡片，而不是把设备、员工、线程全部堆在首页
- `任务详情页` 默认先展示任务目标、负责人、工作区、审批状态和关联会话；如果任务在等待审批，也可以直接在详情页里批准或拒绝
- `员工直连页` 继续保留，但明确降级为二级干预模式
- 每个 Agent 都是独立数字员工，有自己的名字、运行时和会话列表
- 一个 Agent 进程只对应一种运行时，例如 `Codex / OpenAI / Echo`
- 一台电脑上可以运行多个 Agent，它们共享同一个 `DEVICE_ID / DEVICE_NAME`
- 每个会话都严格归属于某一个 Agent，不再在页面里切换 mode
- Codex 类 Agent 的会话会自动绑定到底层 Codex session

## 启动方式

```bash
cd /Users/zhangpeng/ai-chat-mvp
npm install
cp .env.example .env
```

先启动 Hub：

```bash
npm run dev
```

如果你要把一台新设备上的 Codex 员工接进来，推荐先跑一次 onboarding：

```bash
npm run agent:onboard:codex -- \
  --hub http://你的Hub地址:3000 \
  --agent-token 你的AGENT_TOKEN \
  --device-name "Office Mac" \
  --agent-name "Codex Office" \
  --root ~/Codes \
  --root ~/Documents
```

这条命令会帮你做 4 件事：

1. 生成一份单文件员工配置
2. 自动扫描常用代码根目录，识别 Git 仓库和文档工作区
3. 输出后续启动和自检这个员工的标准命令
4. 让新设备的接入方式保持成一份稳定 JSON，而不是一串临时环境变量

如果你想先做一次员工体检，确认 Hub、工作区和运行时都没问题，再决定要不要启动，可以执行：

```bash
npm run agent:doctor -- --config ~/.agenthub/employees/codex-office.json
```

`agent:doctor` 会重点检查：

1. Hub 是否可达
2. `AGENT_TOKEN / 设备身份 / 员工身份` 是否齐全
3. 工作区根目录和默认工作目录是否存在
4. 声明的工作区会不会因为不在允许根目录内而被静默丢弃
5. 当前运行时依赖是否可用，例如 `codex --version`

如果你想生成完配置后立刻启动，也可以直接：

```bash
npm run agent:onboard:codex -- \
  --hub http://你的Hub地址:3000 \
  --agent-token 你的AGENT_TOKEN \
  --device-name "Office Mac" \
  --agent-name "Codex Office" \
  --root ~/Codes \
  --start
```

`--start` 现在会先自动跑一遍员工自检；如果自检没过，会直接阻止启动，避免“看起来启动了，实际上接不上 Hub”这种隐性故障。

如果你这台机器希望 `开机登录后自动接回 AgentHub`，推荐直接把这位员工安装成 macOS `launchd` 自启动：

```bash
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json
```

这条命令会：

1. 在 `~/Library/LaunchAgents` 写入一份 LaunchAgent plist
2. 立即加载它，让当前会话先自动拉起一次员工进程
3. 把日志写到 `~/.agenthub/logs`
4. 让这位员工在你下次开机登录后自动重新接入 Hub

如果你想在 onboarding 完成时顺手一起装好，也可以：

```bash
npm run agent:onboard:codex -- \
  --hub http://你的Hub地址:3000 \
  --agent-token 你的AGENT_TOKEN \
  --device-name "Office Mac" \
  --agent-name "Codex Office" \
  --root ~/Codes \
  --doctor \
  --autostart
```

常用维护命令：

```bash
# 查看当前自动接入状态
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json \
  --status

# 只写入启动项，不立即加载
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json \
  --write-only

# 移除自动接入
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json \
  --uninstall
```

如果你已经有员工配置文件，再启动本地 Agent 就简单很多：

```bash
npm run agent -- --config ~/.agenthub/employees/codex-office.json
```

如果你想在一台电脑上同时跑多个数字员工，直接多开几个终端：

```bash
npm run agent:codex
npm run agent:echo
```

如果你更喜欢继续沿用环境变量，也依然支持：

```bash
DEVICE_ID=macbook-zhangpeng DEVICE_NAME="Zhangpeng MacBook" AGENT_ID=claude-review AGENT_NAME="Claude Review" AGENT_MODE=echo npm run agent
```

如果你希望手工维护工作区清单，也仍然支持：

```bash
AGENT_WORKSPACES_FILE=/absolute/path/to/workspaces.json npm run agent:codex
```

配置示例见：

- [agent/workspaces.example.json](/Users/zhangpeng/ai-chat-mvp/agent/workspaces.example.json)
- [agent/employee.config.example.json](/Users/zhangpeng/ai-chat-mvp/agent/employee.config.example.json)

然后在手机和电脑浏览器打开：

```text
http://你的电脑局域网 IP:3000
```

## 第二台电脑怎么接进来

如果你再接一台电脑，不需要新建第二个 Hub，而是让第二台电脑上的 Agent 继续回连同一个 Hub。

核心规则是：

- `一台电脑 = 一个 DEVICE_ID / DEVICE_NAME`
- `一台电脑上的多个 Agent = 共享同一个 DEVICE_ID / DEVICE_NAME`
- `不同电脑 = 使用不同的 DEVICE_ID / DEVICE_NAME`

例如第一台电脑最推荐的接法：

```bash
npm run agent:onboard:codex -- \
  --hub http://你的Hub地址:3000 \
  --agent-token 你的AGENT_TOKEN \
  --device-name "Zhangpeng MacBook" \
  --agent-name "Codex Main" \
  --root ~/Codes \
  --start
```

第二台电脑：

```bash
npm run agent:onboard:codex -- \
  --hub http://你的Hub地址:3000 \
  --agent-token 你的AGENT_TOKEN \
  --device-name "Office PC" \
  --agent-name "Codex Office" \
  --root ~/Codes \
  --start
```

如果第二台电脑上还要再跑一个 Echo 或 OpenAI Agent，只要继续复用同一个 `DEVICE_ID / DEVICE_NAME`，换一个新的 `AGENT_ID / AGENT_NAME` 即可。

这样接进来以后，底层执行层会知道 `设备 -> 数字员工` 的归属关系；但长期产品形态不应该要求人先切设备，再切员工。

第一版要做到的“不同设备上的 Codex 无缝接入”，在 AgentHub 里具体指的是：

1. 每台设备上的 Codex 员工都用统一的注册方式接入
2. 每位 Codex 员工在接入时就声明自己的 `DEVICE_ID / DEVICE_NAME / AGENT_ID / AGENT_NAME`
3. 如果这台设备上有多个仓库或目录要长期处理，优先通过 onboarding 自动发现并写进单文件员工配置；必要时仍可手工指定 `AGENT_WORKSPACES_FILE`
4. Hub 会把这些工作区写进 `DATA_FILE`，设备临时离线后平台仍然记得“这位员工能处理什么”
5. 用户发给员工的每条新请求都会落成一个持久 `task`
6. Agent 会持续通过 `agent_heartbeat` 上报自己当前忙不忙、手上是谁的任务、最近摘要是什么
7. Agent 收到任务后，至少要通过 `task.assigned / task_progress / agent_message` 这条链路上报“已接单 / 执行中 / 已完成”
8. 如果 Agent 需要高风险操作，它可以主动发起 `approval.requested`；经理批准后，平台会把结果回推给 Agent
9. AI 经理和任务层优先根据工作区来理解“这位员工能处理什么”，而不是让人再去手工切目录
10. 当经理要把任务交给某位员工，而这位员工名下只有一个工作区时，平台会自动兜底绑定这个唯一工作区，避免任务卡在经理层

## 配置示例

```env
PORT=3000
HOST=
HUB_ORIGIN=http://localhost:3000
APP_TOKEN=给手机网页使用的访问令牌
AGENT_TOKEN=给本地 Agent 回连 Hub 使用的令牌
STORE_DRIVER=json
DATA_FILE=/absolute/path/to/state.json
DATABASE_URL=postgres://user:password@127.0.0.1:5432/agenthub
STORE_PG_SCHEMA=public
STORE_PG_STATE_TABLE=hub_state
STORE_PG_STATE_KEY=primary
AGENT_CONFIG_FILE=/absolute/path/to/employee.json
DEVICE_ID=macbook-zhangpeng
DEVICE_NAME=Zhangpeng MacBook
AGENT_ID=codex-agent
AGENT_NAME=Codex Agent
AGENT_MODE=codex
AGENT_WORKSPACES_FILE=/absolute/path/to/workspaces.json
AGENT_DEFAULT_WORKSPACE_KIND=repo
AGENT_HEARTBEAT_INTERVAL_MS=15000
AGENT_PROMPT=你是 AgentHub 里的一个数字员工，要用简洁、可靠、可执行的方式帮助用户推进任务。
MANAGER_OPENAI_API_KEY=
MANAGER_MODEL=gpt-5.4-mini
MANAGER_REASONING_EFFORT=low
MANAGER_TEXT_VERBOSITY=low
CODEX_BIN=codex
CODEX_WORKDIR=/Users/zhangpeng
AGENT_WORKDIR_ROOTS=/Users/zhangpeng
CODEX_MODEL=
CODEX_SANDBOX=read-only
```

### AI经理 怎么接大模型

AgentHub 当前把 `AI经理` 放在 Hub 这一层，而不是某个单独 Agent 里：

- 网页发给 `AI经理` 的消息会先到 Hub
- Hub 会按 provider 走不同的大模型接入层
- 模型会调用内部工具来读取当前员工、任务和直连入口
- 当用户说 `帮我切到和 XXX 的对话` 时，Hub 会把页面切到对应员工的直连会话

最小需要配置的环境变量：

```env
MANAGER_PROVIDER=zhipu
MANAGER_API_KEY=你的智谱 API Key
MANAGER_MODEL=glm-4.7-flash
MANAGER_REASONING_EFFORT=low
MANAGER_TEXT_VERBOSITY=low
```

如果你想继续使用 OpenAI，也可以改成：

```env
MANAGER_PROVIDER=openai
MANAGER_OPENAI_API_KEY=你的 OpenAI API Key
MANAGER_MODEL=gpt-5.4-mini
```

如果你把 AgentHub 部署到云服务器，并且前面放了 Nginx/Caddy 之类的反向代理，建议把 Hub 只绑定到回环地址，避免 `3000` 直接暴露到公网：

```env
PORT=3000
HOST=127.0.0.1
HUB_ORIGIN=http://你的公网域名或IP
```

推荐公网入口：

- `80/443` 由 Nginx 或 Caddy 对外监听
- 反向代理到 `127.0.0.1:3000`
- AgentHub 本体不再直接对公网监听 `3000`

### Hub 存储怎么切到 Postgres

默认情况下，AgentHub 仍然使用 `DATA_FILE` 对应的 JSON 文件存储，方便本地快速起步。

如果你要往多设备、多员工、多人共用演进，建议尽早切到 Postgres：

```env
STORE_DRIVER=postgres
DATABASE_URL=postgres://user:password@127.0.0.1:5432/agenthub
STORE_PG_SCHEMA=public
STORE_PG_STATE_TABLE=hub_state
STORE_PG_STATE_KEY=primary
```

然后先执行一次迁移：

```bash
npm run db:migrate
```

如果你之前已经在 `DATA_FILE` 里积累了会话、员工、任务状态，可以再执行一次导入：

```bash
npm run db:import-json
```

或者指定一个明确文件：

```bash
npm run db:import-json -- --file /absolute/path/to/state.json
```

这一版 Postgres 存储先保持和当前 JSON 状态模型一致，目标是先把存储边界抽出来，后续再继续把任务、员工、审批逐步拆成独立表和仓储层。

### AI经理知识库怎么扩

AI经理 现在不再只靠一段 prompt 硬记平台规则，而是会加载仓库里的经理知识条目。

知识入口在：

- [MANAGER_KNOWLEDGE.md](/Users/zhangpeng/ai-chat-mvp/MANAGER_KNOWLEDGE.md)
- `knowledge/manager/*.md`

推荐规则：

1. 平台规则、接入方式、职责边界、术语解释 -> 加知识条目
2. 在线状态、任务进度、审批列表 -> 加或改经理工具
3. 员工注册、任务流转、审批协议变化 -> 更新协议和架构文档

这能保证 AI经理 后续回答“别的 Agent 怎么接入平台”“平台是怎么工作的”“经理职责怎么扩”这类问题时，不需要把所有知识继续堆回 UI 或 prompt。

这一层现在已经支撑了几类经理动作：

1. 解释平台和接入方式
2. 盘点最该关注的异常和风险
3. 代表你催办、补充要求、提醒员工汇报
4. 诊断某位员工是离线、没工作区、心跳过旧，还是任务本身阻塞

### Codex onboarding 现在推荐什么

对多设备 Codex 来说，我现在最推荐的接入方式已经不再是“抄一串环境变量”，而是：

1. 用 `npm run agent:onboard:codex` 生成单文件员工配置
2. 让 onboarding 自动发现常用代码仓库和文档目录
3. 用 `npm run agent:doctor -- --config /path/to/employee.json` 先做员工自检
4. 后续只用 `npm run agent -- --config /path/to/employee.json` 启动

这样做的好处是：

- 设备身份、员工身份、工作区清单会稳定保存在一份 JSON 里
- 新设备第一次接入时不用手写那么多环境变量
- 接入前可以先查出 Hub、工作区、Codex CLI 到底卡在哪一层
- 协议层和文档现在都统一按 `employee.register` 来理解员工注册
- 同一台设备上后续再开第二个 Codex 员工时，只要生成第二份配置即可

如果你不配置经理层 key，首页里的 `AI经理` 仍然能工作，但只会使用本地摘要能力，不会真正调用大模型。

### 运行时闭环现在包含什么

对第一版多设备 Codex 来说，当前最关键的不是花哨 UI，而是这条执行闭环已经成立：

1. 设备上的 Codex 员工注册自己和工作区
2. Hub 把工作区持久化成平台资产
3. 用户请求被落成持久 `task`
4. `task.assigned` 分派给对应员工
5. 员工通过 `agent_heartbeat` 和 `task_progress` 上报自己当前状态
6. 如果需要高风险权限，员工发 `approval.requested`
7. 经理批准或拒绝后，Hub 会把 `approval_resolved` 回推给员工

这条链路目前已经能支撑“我通过平台去和不同设备上的 Codex 协作完成任务”这个第一目标。

## 公网部署

如果你的目标是 `手机不和电脑在同一个网络，也能远程和本机 Agent 沟通`，推荐把 Hub 部署到公网，再让各台电脑上的 Agent 主动回连公网 Hub。

当前项目已经补了最小可用的公网能力：

- 网页端通过 `APP_TOKEN` 鉴权
- Agent 通过 `AGENT_TOKEN` 鉴权
- 提供了 `render.yaml`，可以直接用于 Render Blueprint 部署

### 用 Render 部署 Hub

1. 把仓库推到 GitHub
2. 在 Render 里用 `Blueprint` 或 `Web Service` 导入仓库
3. 使用仓库里的 [render.yaml](/Users/zhangpeng/ai-chat-mvp/render.yaml)
4. 确认环境变量里有：
   - `APP_TOKEN`
   - `AGENT_TOKEN`
   - 如果继续走文件存储：`STORE_DRIVER=json` 与 `DATA_FILE=/data/state.json`
   - 如果切到 Postgres：`STORE_DRIVER=postgres` 与 `DATABASE_URL=...`
5. 部署完成后，你会拿到一个公网地址，例如：
   - `https://agenthub-example.onrender.com`

这个 `render.yaml` 还会帮你挂一个持久盘到 `/data`，并把状态文件写到 `/data/state.json`。

### 手机怎么连

- 手机浏览器直接打开公网地址
- 第一次进入时，页面会弹出访问令牌输入框
- 输入 `APP_TOKEN` 后，网页才会真正连上 Hub

### 电脑上的 Agent 怎么连

每台电脑上的 Agent 都要把 `HUB_ORIGIN` 指向公网 Hub，并带上 `AGENT_TOKEN`：

```bash
HUB_ORIGIN=https://agenthub-example.onrender.com AGENT_TOKEN=你的AGENT_TOKEN npm run agent:codex
```

或者：

```bash
HUB_ORIGIN=https://agenthub-example.onrender.com AGENT_TOKEN=你的AGENT_TOKEN npm run agent:echo
```

### 当前公网版的限制

- 这版 Hub 仍然是 `单实例`
- 默认仍然是文件存储，只是可以通过 `DATA_FILE` 放到持久盘
- 现在已经支持切到 `Postgres`，但状态模型还是单体文档，后续还要继续拆仓储和事件流
- 如果你部署的平台文件系统是临时的，又没有正确挂持久盘，重启或重部署后聊天记录会丢

所以当前更适合：

- 先用 `单实例 + 持久盘` 或 `单实例 + Postgres`
- 下一步再把任务、员工、审批继续从单体状态里拆出来

## 设备与 Agent 规则

AgentHub 当前的产品模型是：

- `一个 Agent 进程 = 一个数字员工`
- `一个数字员工 = 一个固定运行时`
- `一台电脑 = 一个设备`
- `一个设备上可以有多个数字员工`
- `一个会话 = 只属于一个数字员工`
- `设备 / 数字员工 / 会话` 属于执行结构，不应继续成为人的默认导航主路径

这也是为什么推荐你把 `Codex / Echo / OpenAI` 分别跑成不同进程，而不是在同一个 Agent 里来回切。

## Codex 会话规则

对于 `Codex Agent`，页面里的每个会话都会绑定一个底层 Codex session：

- 新会话第一次收到 Codex 回复时，会自动创建真实 session
- 新建 Codex 会话时，网页会先弹出目录选择框，让你选工作目录
- 导入历史 session 时，AgentHub 会为它打开独立会话
- 工作目录跟着会话走，后续同一会话会继续使用这个目录

### 工作目录怎么选

- 网页里的目录选择器浏览的是 `目标数字员工所在电脑` 上的目录
- 这不是浏览器原生文件选择器，而是 AgentHub 通过目标数字员工列目录后显示出来的远程目录浏览器
- 可浏览范围由 `AGENT_WORKDIR_ROOTS` 控制，多个根目录可以用英文逗号分隔
- 新线程绑定的 `workdir` 会跟着线程走，后续同线程的 Codex 回复会继续使用这个目录

### Codex 工作区怎么声明

如果你希望 AI 经理后面能直接说“去 AgentHub 仓库处理”或者“去 Office PC 上那个文档目录整理材料”，第一版最稳的方式是让每台设备上的 Codex 员工在启动时声明自己的工作区清单。

做法：

1. 复制一份 [agent/workspaces.example.json](/Users/zhangpeng/ai-chat-mvp/agent/workspaces.example.json)
2. 把其中的 `path / name / kind / tags` 改成这台设备上的真实仓库或目录
3. 启动该设备上的 Codex 时带上：

```bash
AGENT_WORKSPACES_FILE=/absolute/path/to/workspaces.json npm run agent:codex
```

如果你暂时不配这个文件，AgentHub 也能工作，只是会默认只把 `CODEX_WORKDIR` 当成这位员工的一个默认工作区。

## AI-Friendly 架构

这个项目后续要支持 AI 持续参与开发，所以仓库需要尽量做到：

- `边界清晰`：Hub、运行时适配器、前端、协议层尽量解耦
- `协议优先`：先定义消息事件和数据结构，再做实现
- `模块可替换`：Codex、Claude、OpenAI、Ollama 都应通过统一接口接入
- `上下文可恢复`：会话、任务、运行日志都能被 AI 快速理解
- `文档靠近代码`：关键架构约束要留在仓库里，而不是只存在口头共识

已经补充的文档：

- [ARCHITECTURE.md](/Users/zhangpeng/ai-chat-mvp/ARCHITECTURE.md)
- [AGENTS.md](/Users/zhangpeng/ai-chat-mvp/AGENTS.md)
- [MANAGER_MODE.md](/Users/zhangpeng/ai-chat-mvp/MANAGER_MODE.md)
- [AGENT_FIRST.md](/Users/zhangpeng/ai-chat-mvp/AGENT_FIRST.md)
- [TASK_MODEL.md](/Users/zhangpeng/ai-chat-mvp/TASK_MODEL.md)
- [AGENT_RUNTIME_CONTRACT.md](/Users/zhangpeng/ai-chat-mvp/AGENT_RUNTIME_CONTRACT.md)
- [REBUILD_PLAN.md](/Users/zhangpeng/ai-chat-mvp/REBUILD_PLAN.md)
- [SCALING_PLAN.md](/Users/zhangpeng/ai-chat-mvp/SCALING_PLAN.md)

已经补充的 repo skills：

- `skills/agent-first-engineering`
- `skills/agent-product-manager`
- `skills/manager-console-interaction`
- `skills/agent-protocol-design`
- `skills/agent-task-modeling`

## 冒烟测试

在 Hub 和 Agent 都启动后运行：

```bash
npm run smoke
```

成功时会输出：

```text
Smoke test passed.
```

如果你要验证 `AI经理 -> 员工 -> 任务` 这条最小闭环，再运行：

```bash
npm run smoke:manager
```

如果你不想先手工起 Hub 和 Agent，而是想直接验证一整条 `临时 Hub -> 临时员工 -> AI经理委派` 闭环，可以直接运行：

```bash
npm run smoke:manager:stack
```

这条测试会自动做三件事：

1. 等在线员工出现
2. 让 `AI经理` 把一个临时任务交给这位员工
3. 验证经理回复、任务落库、会话创建三件事都成立

成功时会输出：

```text
Manager smoke test passed.
```

自带栈版本成功时会输出：

```text
Manager stack smoke test passed.
```

如果你已经准备好了 `DATABASE_URL`，想直接验证整条 `JSON 样本生成 -> Postgres 迁移 -> JSON 导入 -> Postgres Hub 启动 -> 员工上线 -> 消息回路`，可以运行：

```bash
DATABASE_URL=postgres://user:password@127.0.0.1:5432/agenthub npm run smoke:store:postgres
```

成功时会输出：

```text
Postgres stack smoke test passed.
```

如果你要验证“新设备 onboarding -> 员工自检 -> 员工上线 -> 收发消息”这一整条接入链路，可以直接运行：

```bash
npm run smoke:onboard
```

成功时会输出：

```text
Onboarding smoke test passed.
```

## 下一步建议

- 把 `Codex / Claude / OpenAI` 做成真正独立的运行时 adapter
- 把 `conversation` 和 `task/run` 分离，准备支持多数字员工协作
- 明确 `任务 / 工作区 / 员工 / run` 的协议，让 Agent 更容易协作
- 继续压缩人类 UI，把复杂度移到 `AI经理 + Agent 协议` 一侧
