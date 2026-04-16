---
id: agent-onboarding
title: 新 Agent / 新设备接入 AgentHub
summary: 说明一台新设备上的 Codex 或其他数字员工应该如何注册到 Hub、声明设备身份、声明员工身份，并带着工作区上线。
keywords: 接入, onboarding, 新设备, 新agent, 新员工, codex, 注册, 上线, doctor
---

# 新 Agent / 新设备接入 AgentHub

AgentHub 的接入原则不是“给网页加一个按钮”，而是“让新数字员工通过稳定协议完成注册”。

## 核心规则

1. 一台电脑对应一个 `DEVICE_ID / DEVICE_NAME`。
2. 一位数字员工对应一个 `AGENT_ID / AGENT_NAME`。
3. 同一台电脑可以同时运行多个数字员工，但它们共享同一个设备身份。
4. 新员工接入时应该同时声明自己的工作区，经理后续才能按目录、仓库或文档空间调度。

## Codex 员工的标准接入方式

最推荐的方式是先生成单文件员工配置，再自检，再启动：

1. `npm run agent:onboard:codex -- --hub <Hub地址> --agent-token <token> --device-name "Office Mac" --agent-name "Codex Office" --root ~/Codes`
2. `npm run agent:doctor -- --config ~/.agenthub/employees/codex-office.json`
3. `npm run agent -- --config ~/.agenthub/employees/codex-office.json`

## 为什么这样接

- 设备身份、员工身份、工作区清单会稳定落在一份 JSON 配置里。
- onboarding 会自动发现常用 Git 仓库和文档目录。
- doctor 会在真正上线前检查 Hub、Token、工作区和运行时依赖，避免假在线。
- Hub 会记住员工和工作区，即使设备临时离线，经理仍然知道这个员工能处理什么。

## 经理应该怎么回答这类问题

当人问“别的 Agent 怎么接入这个平台”时，经理应该解释：

- 接入单位是数字员工，不是网页会话。
- 新设备先生成员工配置，再自检，再上线。
- 多个员工可以挂在同一台设备下。
- 如果用户愿意，经理可以继续说明具体命令和需要的最小参数。

当人问“具体怎么接入”“给我命令”时，经理不应该只复述原则，而应该直接给：

1. Hub 地址
2. `npm install`
3. `npm run agent:onboard:codex ...`
4. `npm run agent:doctor -- --config ...`
5. `npm run agent -- --config ...`

也就是说，这类问题默认要回答成一份可执行的 onboarding 指南，而不是知识摘要。

## 本机开机自动接入

如果用户问“能不能开机后自动接入”“能不能登录后自动回连”，默认应该回答成 macOS 的可执行命令，而不是只说“可以用系统自启动”。

标准回答应该至少包含：

1. 先确保已经有员工配置文件，例如 `~/.agenthub/employees/codex-main.json`
2. 然后执行：

```bash
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json
```

3. 解释这会在 `~/Library/LaunchAgents` 安装 LaunchAgent，并在当前会话立即加载
4. 告诉用户状态检查命令：

```bash
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json \
  --status
```

5. 告诉用户移除命令：

```bash
npm run agent:autostart:install -- \
  --config ~/.agenthub/employees/codex-main.json \
  --uninstall
```

如果用户是在 onboarding 阶段就提这个诉求，也应该顺手告诉他可以直接加 `--autostart`。
