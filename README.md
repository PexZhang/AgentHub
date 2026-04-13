# AgentHub

`AgentHub` 是这个项目的新名字。

当前本地目录仍然是 `/Users/zhangpeng/ai-chat-mvp`，这样不会打断你现有的启动方式；后面如果你要，我可以再帮你把目录名也一起迁过去。

## 愿景

AgentHub 不是普通聊天工具，而是一个面向 `多数字员工协作` 的控制中枢：

- `手机端 / 网页端` 是你的控制台
- `电脑` 是数字员工运行的宿主环境
- `Agent` 是具体的数字员工实例
- `Codex / Claude / OpenAI / 本地模型` 都是可接入的员工能力源

长期目标是：

- 一台电脑上可以运行多个数字员工
- 多台电脑上的数字员工都能被统一编排
- 用户通过 AgentHub 完成对话、任务派发、协作追踪和结果回收
- 项目本身也适合交给 AI 持续迭代开发

## 当前第一版

当前这版先只解决 `一台电脑上的多个数字员工`：

- 这个网页只管理当前这台电脑上的 Agent
- 每个 Agent 都是独立数字员工，有自己的名字、运行时和会话列表
- 一个 Agent 进程只对应一种运行时，例如 `Codex / OpenAI / Echo`
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

再启动本地 Agent：

```bash
npm run agent
```

如果你想在一台电脑上同时跑多个数字员工，直接多开几个终端：

```bash
npm run agent:codex
npm run agent:echo
```

如果你要自定义名称和身份，也可以自己传环境变量：

```bash
AGENT_ID=claude-review AGENT_NAME="Claude Review" AGENT_MODE=echo npm run agent
```

然后在手机和电脑浏览器打开：

```text
http://你的电脑局域网 IP:3000
```

## 配置示例

```env
PORT=3000
HUB_ORIGIN=http://localhost:3000
APP_TOKEN=给手机网页使用的访问令牌
AGENT_TOKEN=给本地 Agent 回连 Hub 使用的令牌
DATA_FILE=/absolute/path/to/state.json
AGENT_ID=codex-agent
AGENT_NAME=Codex Agent
AGENT_MODE=codex
AGENT_PROMPT=你是 AgentHub 里的一个数字员工，要用简洁、可靠、可执行的方式帮助用户推进任务。
CODEX_BIN=codex
CODEX_WORKDIR=/Users/zhangpeng
AGENT_WORKDIR_ROOTS=/Users/zhangpeng
CODEX_MODEL=
CODEX_SANDBOX=read-only
```

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
   - `DATA_FILE=/data/state.json`
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
- 会话目前还是文件存储，只是可以通过 `DATA_FILE` 放到持久盘
- 如果你部署的平台文件系统是临时的，又没有正确挂持久盘，重启或重部署后聊天记录会丢

所以当前更适合：

- 先用 `单实例 + 持久盘`
- 下一步再把状态迁到 `Postgres`

## 单机多 Agent 规则

AgentHub 当前的产品模型是：

- `一个 Agent 进程 = 一个数字员工`
- `一个数字员工 = 一个固定运行时`
- `一个会话 = 只属于一个数字员工`
- 当前页面只解决单机工作流，不处理多台电脑协作

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

## 冒烟测试

在 Hub 和 Agent 都启动后运行：

```bash
npm run smoke
```

成功时会输出：

```text
Smoke test passed.
```

## 下一步建议

- 把 `Codex / Claude / OpenAI` 做成真正独立的运行时 adapter
- 给单机 Agent 增加更清晰的身份、能力标签和任务视图
- 把 `conversation` 和 `task/run` 分离，准备支持多数字员工协作
- 等单机工作流稳定后，再设计“多电脑 -> 多 Agent”的协作层
