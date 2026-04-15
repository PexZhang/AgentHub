# Task Model Blueprint

## Purpose

This document defines the next-step domain model for AgentHub.

It exists to move the product away from:

- conversation-first thinking
- device-first navigation
- agent chat as the only execution primitive

And toward:

- task-first orchestration
- workspace-aware execution
- explicit ownership, approval, and handoff

## Core Rule

`Conversation` is for communication.

`Task` is for execution.

One conversation may create many tasks over time.
One task may produce many runs, summaries, approvals, and handoffs.

Do not treat conversation messages as the only source of execution truth.

## Domain Objects

### 1. Task

The durable unit of requested work.

Required fields:

- `id`
- `title`
- `goal`
- `status`
- `priority`
- `workspaceId`
- `ownerEmployeeId`
- `requestedBy`
- `sourceConversationId`
- `createdAt`
- `updatedAt`
- `latestSummary`

Recommended fields:

- `blockedReason`
- `approvalState`
- `approvalReason`
- `outputRef`
- `labels`
- `candidateWorkspaceIds`
- `reviewerEmployeeIds`
- `parentTaskId`

### 2. Workspace

The execution target.

A workspace can represent:

- a repo
- a directory
- a document corpus
- a deployment surface
- a log or runtime surface

Required fields:

- `id`
- `name`
- `deviceId`
- `kind`
- `path`
- `runtimeHints`
- `capabilities`
- `online`
- `updatedAt`

Recommended fields:

- `defaultEmployeeId`
- `repoBranch`
- `tags`
- `description`

### 3. Employee

A user-facing digital worker identity.

Required fields:

- `id`
- `name`
- `deviceId`
- `runtime`
- `capabilities`
- `status`
- `updatedAt`

Recommended fields:

- `currentTaskId`
- `currentRunId`
- `health`
- `labels`

### 4. Run

The machine-facing execution attempt for a task step.

Required fields:

- `id`
- `taskId`
- `employeeId`
- `workspaceId`
- `status`
- `startedAt`
- `updatedAt`

Recommended fields:

- `endedAt`
- `stepName`
- `summary`
- `errorCode`
- `errorMessage`
- `providerSessionRef`

### 5. Approval

The explicit state for risky operations.

Required fields:

- `id`
- `taskId`
- `runId`
- `requestedByEmployeeId`
- `reason`
- `status`
- `createdAt`
- `updatedAt`

Recommended fields:

- `scope`
- `grantedBy`
- `grantedAt`
- `rejectedAt`
- `resolutionNote`

### 6. Handoff

The durable transfer record between employees.

Required fields:

- `id`
- `taskId`
- `fromEmployeeId`
- `toEmployeeId`
- `reason`
- `status`
- `createdAt`
- `updatedAt`

Recommended fields:

- `contextSummary`
- `acceptedAt`
- `rejectedAt`

## Task State Machine

Use this as the baseline task lifecycle:

1. `draft`
2. `queued`
3. `assigned`
4. `in_progress`
5. `waiting_approval`
6. `blocked`
7. `handoff_pending`
8. `completed`
9. `failed`
10. `cancelled`

### State Meanings

- `draft`
  The manager understands the request but has not committed it to execution.
- `queued`
  The task is accepted by the control plane and waiting for assignment.
- `assigned`
  An owner has been chosen, but execution has not started yet.
- `in_progress`
  An employee is actively executing.
- `waiting_approval`
  Work cannot continue until a human or policy decision is made.
- `blocked`
  Execution cannot continue for a non-approval reason.
- `handoff_pending`
  The task is being transferred to another employee.
- `completed`
  The requested outcome was produced.
- `failed`
  The execution path ended unsuccessfully.
- `cancelled`
  The task was intentionally stopped.

## Ownership Rules

At any given time, a task should have one primary owner.

If more than one employee contributes, model that through:

- subtasks
- reviewer lists
- run history
- handoff records

Do not make ownership implicit through chat participation.

## Workspace Binding Rules

A task should bind to one workspace as early as possible.

If the workspace is ambiguous:

- keep `workspaceId = null`
- fill `candidateWorkspaceIds`
- fill `latestSummary` with the ambiguity
- let the AI manager ask the human only when needed

Do not require humans to route every task manually before the system has tried.

## Approval Rules

Approvals are task state, not UI sugar.

Approval should answer:

- what action needs approval
- why it is risky
- who can approve it
- whether work is paused
- what happens after approval or rejection

Suggested approval states:

- `not_required`
- `pending`
- `granted`
- `rejected`
- `expired`

## Handoff Rules

Handoff should be explicit and traceable.

A handoff must record:

- which employee is giving up ownership
- which employee is being asked to take ownership
- why the handoff is happening
- what context is being transferred
- whether the receiving employee accepted it

A task in `handoff_pending` should not look `in_progress` at the same time.

## Manager Summary Rule

Every task must always be compressible into one manager-facing line:

`<title> · <owner> · <status> · <latestSummary>`

If this line cannot be generated, the task model is missing core state.

## Suggested JSON Shapes

### Example Task

```json
{
  "id": "task_01",
  "title": "修复移动端经理页滚动问题",
  "goal": "让经理页聊天区域固定高度并启用内部滚动",
  "status": "in_progress",
  "priority": "high",
  "workspaceId": "workspace_agenthub_mac",
  "ownerEmployeeId": "codex-main",
  "requestedBy": "human:zhangpeng",
  "sourceConversationId": "conversation_manager_main",
  "createdAt": "2026-04-14T10:00:00.000Z",
  "updatedAt": "2026-04-14T10:08:00.000Z",
  "latestSummary": "已定位到样式层问题，正在调整消息区和 composer 的高度约束。",
  "approvalState": "not_required"
}
```

### Example Workspace

```json
{
  "id": "workspace_agenthub_mac",
  "name": "AgentHub Mac Repo",
  "deviceId": "macbook-zhangpeng",
  "kind": "repo",
  "path": "/Users/zhangpeng/ai-chat-mvp",
  "runtimeHints": ["codex", "echo"],
  "capabilities": ["edit_code", "run_node", "read_files"],
  "online": true,
  "updatedAt": "2026-04-14T10:08:00.000Z",
  "defaultEmployeeId": "codex-main"
}
```

## Migration Direction

The current repository still stores most execution truth in:

- conversation metadata
- message status
- agent snapshots

The next step should introduce durable task objects without deleting the current conversation model.

Recommended path:

1. add `tasks` to persistent state
2. map new manager requests to both conversation + task
3. let agents read task payloads instead of inferring from plain messages alone
4. gradually move progress reporting from message-only to task/run events
