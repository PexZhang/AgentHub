---
name: agent-task-modeling
description: Use when defining task structure, task lifecycle, workspace binding, ownership, approvals, and handoff rules in AgentHub. Keeps task design centered on agent execution rather than chat threads.
---

# Agent Task Modeling

Use this skill when introducing or changing task objects, task status, assignment rules, approval gates, handoff behavior, or workspace binding.

## Read First

- `../../AGENT_FIRST.md`
- `../../ARCHITECTURE.md`
- `../../README.md`

If the change affects the human manager flow, also read:

- `../../MANAGER_MODE.md`

## Modeling Premise

In AgentHub, a task is not just a chat message.

A task is the durable unit of requested work that agents can:

- claim
- execute
- pause
- resume
- escalate
- hand off
- complete

Do not collapse task truth into conversation history.

## Task Must Answer

A good task model lets the system answer:

- what is the goal?
- who currently owns it?
- which workspace is it bound to?
- what state is it in?
- what blocked it?
- what approvals are pending?
- what output was produced?

## Minimum Task Fields

Default to these fields unless there is a clear reason not to:

- `id`
- `title`
- `goal`
- `status`
- `workspaceId`
- `ownerEmployeeId`
- `requestedBy`
- `createdAt`
- `updatedAt`
- `blockedReason`
- `approvalState`
- `latestSummary`
- `outputRef`

## Recommended State Machine

Use this as the starting point:

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

Add states sparingly. Prefer clearer transition rules over more statuses.

## Ownership Rules

At any moment, a task should have exactly one primary owner unless the feature is explicitly multi-owner.

If multiple employees contribute, model that through:

- subtasks
- reviewers
- handoff records
- linked runs

Do not make ownership ambiguous by default.

## Workspace Binding Rules

A task should bind to a workspace as early as possible.

If the workspace is unknown, the system may keep it unbound temporarily, but should record:

- candidate workspace
- ambiguity reason
- clarification needed

Do not make the human manually route every task up front unless ambiguity is real.

## Approval Rules

Approval should be part of task state, not an afterthought.

A task model should support:

- whether approval is required
- why approval is required
- who can approve
- what happens while waiting
- what happens after approval or rejection

## Handoff Rules

Handoff should be explicit and durable.

A handoff should record:

- from which employee
- to which employee
- why the handoff happened
- what context was transferred
- whether the receiving employee accepted it

## Human Summary Rule

Every task should be reducible to one manager-friendly summary line.

If a model produces rich machine state but no usable summary for the manager layer, the task model is incomplete.

## Anti-Patterns

Avoid:

- using conversation id as the real task id
- hiding task status only in message text
- letting multiple employees mutate ownership implicitly
- making workspace optional forever
- treating approvals as UI-only prompts

## Deliverable Checklist

When proposing a task model, include:

1. core fields
2. lifecycle states
3. ownership rule
4. workspace rule
5. approval rule
6. handoff rule
7. manager summary rule
8. one example task object
