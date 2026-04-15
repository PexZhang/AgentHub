# Agent Runtime Contract

## Purpose

This document defines how an execution-side agent should plug into AgentHub.

The goal is to make agent onboarding:

- provider-neutral
- easy to reason about
- durable across Codex, Claude, OpenAI, Ollama, and future runtimes

## Product Position

An AgentHub runtime is not just a chatbot connector.

It is a digital employee endpoint that can:

- register itself
- advertise capabilities
- accept work
- report progress
- request approvals
- escalate blockers
- hand off work
- resume state

## Layers

### Device

The host machine.

One device may run many employees.

### Employee

The user-facing worker identity.

Examples:

- `codex-main`
- `claude-review`
- `deploy-agent`

### Runtime Adapter

The implementation behind the employee.

Examples:

- Codex CLI adapter
- Claude adapter
- OpenAI adapter
- Ollama adapter

## Required Runtime Capabilities

Every runtime should support these minimum operations:

1. `register`
2. `heartbeat`
3. `listCapabilities`
4. `acceptTask`
5. `startRun`
6. `reportProgress`
7. `requestApproval`
8. `reportBlocker`
9. `completeRun`
10. `failRun`

Recommended advanced operations:

1. `handoffTask`
2. `resumeRun`
3. `cancelRun`
4. `browseWorkspace`
5. `listSessions`
6. `openDirectConversation`

## Registration Contract

When a runtime connects, it should register:

- `deviceId`
- `deviceName`
- `employeeId`
- `employeeName`
- `runtime`
- `capabilities`
- `workspaces`
- `version`
- `online`

Example:

```json
{
  "type": "employee.register",
  "deviceId": "macbook-zhangpeng",
  "deviceName": "Zhangpeng MacBook",
  "employeeId": "codex-main",
  "employeeName": "Codex Main",
  "runtime": "codex",
  "capabilities": [
    "edit_code",
    "run_commands",
    "browse_directories",
    "resume_session"
  ],
  "workspaces": [
    {
      "id": "workspace_agenthub_mac",
      "name": "AgentHub 仓库",
      "path": "/Users/zhangpeng/ai-chat-mvp",
      "kind": "repo",
      "runtimeHints": ["codex"]
    }
  ],
  "version": "1.0.0"
}
```

For Codex in the first release, this workspace list is the minimum onboarding contract.

If a new device can register:

- who it is
- which Codex employee it hosts
- which concrete workspaces that employee can operate in

then the AI manager can route work without forcing the human to click through device and directory selectors first.

The Hub should persist these workspaces as durable assets.

That means a temporary disconnect should change `online`, but should not erase the workspace inventory from platform state.

## Runtime Config File

For Codex onboarding, AgentHub now supports a single employee config file as the preferred bootstrap surface.

Example shape:

```json
{
  "schemaVersion": "agenthub.employee-config.v1",
  "hubOrigin": "http://localhost:3000",
  "agentToken": "replace-with-agent-token",
  "deviceId": "office-mac",
  "deviceName": "Office Mac",
  "agentId": "codex-office",
  "agentName": "Codex Office",
  "agentMode": "codex",
  "workdirRoots": [
    "/Users/zhangpeng/Codes",
    "/Users/zhangpeng/Documents"
  ],
  "codex": {
    "bin": "codex",
    "workdir": "/Users/zhangpeng/Codes/AgentHub",
    "sandbox": "read-only"
  },
  "workspaces": [
    {
      "id": "workspace-office-agenthub",
      "name": "AgentHub 仓库",
      "path": "/Users/zhangpeng/Codes/AgentHub",
      "kind": "repo",
      "runtimeHints": ["codex"]
    }
  ]
}
```

This matters because “one runtime = many environment variables” is workable for developers, but it is not a good long-term onboarding surface for digital employees.

The config file should be the durable bootstrap object for a single employee instance.

## Local Adapter Interface

Inside the local runtime process, provider-specific behavior should stay behind a small adapter boundary.

Current implementation direction:

- `agent/providers/codex.js`
- `agent/providers/openai.js`
- `agent/providers/echo.js`
- `agent/providers/index.js`

The minimal local adapter contract should be:

1. `id`
2. `capabilities[]`
3. `getRegistrationContext()`
4. `reply({ conversation, message })`

The intent is:

- `agent/index.js` owns websocket connection, task lifecycle, heartbeat, and progress events
- each provider adapter owns only provider-specific execution details

Example shape:

```js
{
  id: "codex",
  capabilities: ["resume_session"],
  async getRegistrationContext() {
    return {
      recentCodexSessions: [],
      defaultCodexWorkdir: "/Users/zhangpeng/Codes/AgentHub"
    };
  },
  async reply({ conversation, message }) {
    return {
      text: "任务已完成",
      codexSessionId: "session_123"
    };
  }
}
```

This matters because future employees should be able to add `claude.js` or `ollama.js` without reopening the whole runtime orchestration file.

## Heartbeat Contract

Every runtime should report liveness regularly.

Minimum fields:

- `employeeId`
- `deviceId`
- `status`
- `currentTaskId`
- `currentRunId`
- `updatedAt`

This should be enough for the AI manager to answer:

- who is online
- who is busy
- who looks stalled

For the first release, `agent_heartbeat` should also be the place where a runtime reports:

- `currentTaskId`
- `currentRunId`
- `status`
- `summary`

so the platform can still understand runtime state even when no new chat message is being produced.

## Task Assignment Contract

When the control plane assigns work, the runtime should receive a structured payload.

Required fields:

- `taskId`
- `title`
- `goal`
- `workspace`
- `constraints`
- `approvalPolicy`
- `directConversationId`

Example:

```json
{
  "type": "task.assigned",
  "taskId": "task_01",
  "title": "修复移动端经理页滚动问题",
  "goal": "让经理页聊天区恢复固定高度并支持内部滚动",
  "workspace": {
    "id": "workspace_agenthub_mac",
    "path": "/Users/zhangpeng/ai-chat-mvp",
    "kind": "repo"
  },
  "constraints": {
    "sandbox": "read-write",
    "humanApprovalRequiredFor": []
  },
  "approvalPolicy": {
    "mode": "explicit-risk-only"
  },
  "directConversationId": "conversation_codex_main_01"
}
```

## Approval Resolution Contract

When a manager approves or rejects a pending approval, the control plane should push a structured result back to the runtime.

Minimum fields:

- `approvalId`
- `taskId`
- `runId`
- `decision`
- `note`

Example:

```json
{
  "type": "approval_resolved",
  "approvalId": "approval_01",
  "taskId": "task_01",
  "runId": "run_01",
  "decision": "approved",
  "note": "可以继续，但只修改测试环境配置。"
}
```

This matters because an agent-native platform should not force the runtime to infer approval outcome from human chat text.

## Progress Contract

Agents should not report progress only through free text chat.

They should emit structured progress:

- `taskId`
- `runId`
- `status`
- `summary`
- `percent`
- `updatedAt`

Suggested run statuses:

- `accepted`
- `starting`
- `running`
- `waiting_approval`
- `blocked`
- `handoff_pending`
- `completed`
- `failed`

For the first release, Hub may still keep direct conversation messages for human readability, but `task_progress` should become the source of execution truth for task state whenever it is available.

## Approval Contract

When a runtime needs approval, it should send:

- `taskId`
- `runId`
- `reason`
- `scope`
- `requestedAction`
- `riskLevel`

Example:

```json
{
  "type": "approval.requested",
  "taskId": "task_01",
  "runId": "run_01",
  "reason": "需要修改生产环境配置文件",
  "scope": "filesystem:/etc/nginx/nginx.conf",
  "requestedAction": "edit_production_config",
  "riskLevel": "high"
}
```

## Blocker Contract

When blocked, a runtime should not just stop replying.

It should emit:

- `taskId`
- `runId`
- `blockerCode`
- `summary`
- `needs`

Suggested blocker codes:

- `workspace_not_found`
- `permission_denied`
- `dependency_missing`
- `tests_failing`
- `ambiguous_goal`
- `external_service_unavailable`

## Handoff Contract

When handing off, the runtime should provide:

- `taskId`
- `fromEmployeeId`
- `toEmployeeId`
- `reason`
- `contextSummary`
- `artifacts`

The receiving runtime should explicitly accept or reject handoff.

## Direct Chat Contract

Direct chat is secondary mode, but it still matters.

The runtime should support:

- receiving manager-routed direct guidance
- attaching direct guidance to the active task/run
- distinguishing between `task execution` and `chat-only context`

Direct chat should never silently replace task state.

## Recommended Server Refactor

The current codebase mixes:

- registration
- agent websocket identity
- conversation delivery
- provider execution

The next refactor should split runtime integration into:

- `server/contracts/runtime.js`
- `server/runtimes/registry.js`
- `server/runtimes/dispatcher.js`
- `agent/providers/*.js`

## Compatibility Rule

A provider-specific session, like a Codex session, should remain provider-specific.

Do not make:

- Codex session id
- Claude thread id
- OpenAI response id

the system-wide source of truth for task identity.

System truth should remain:

- task
- run
- employee
- workspace

Provider sessions should be attached references.
