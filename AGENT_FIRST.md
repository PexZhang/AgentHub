# Agent-First Product Notes

## Core Premise

AgentHub should not be designed first as a human control console.

It should be designed first as a platform that digital employees can use well:

- to receive work
- to understand context
- to collaborate with other digital employees
- to report progress
- to request approvals
- to recover from interruption

Humans are still important, but they sit one layer above execution.

In this model:

- `Agent` is the primary operator
- `AI Manager` is the orchestration layer
- `Human` is the observer, commander, and approver

If agents do not find the platform usable, the product has little long-term value.

## Product Definition

AgentHub is an `agent collaboration control plane` with a thin human manager console.

That means the most important product questions are no longer:

- Which page should be first?
- Which button should be bigger?
- How many filters should the homepage have?

The most important questions become:

- Can an agent quickly find the right workspace?
- Can an agent understand who owns a task?
- Can an agent ask another agent for help?
- Can an agent hand off work without losing context?
- Can an agent surface risk early without blocking the whole system?

## Primary Users

### 1. Digital Employees

They are the primary users of the platform.

They need:

- explicit task contracts
- stable workspace references
- execution permissions
- progress reporting primitives
- interruption and resume support
- handoff and escalation channels

### 2. Human Managers

Humans are not the primary operators of the execution layer.

They need:

- one place to issue goals
- one place to inspect current status
- one place to approve risky actions
- one place to drill into a specific employee when necessary

The human console should stay thin because it is not the center of gravity.

## Design Principles

### 1. More Protocol, Less Page

Value should live in contracts and orchestration, not in dense dashboards.

The platform should invest first in:

- task schema
- agent state schema
- workspace schema
- events
- approvals
- collaboration rules

UI should reveal these concepts only when needed.

### 2. Agent Ergonomics Before Human Ergonomics

Before adding a human-facing control surface, ask:

- does this make it easier for an agent to execute?
- does this reduce ambiguity for an agent?
- does this help one agent coordinate with another?

If not, it is probably secondary.

### 3. Human UI Should Be Intent-First

Humans should speak in goals, not in system topology.

Good:

- "帮我看看 Office Codex 现在做到哪了"
- "让 Linux 上那个部署员工继续处理发布问题"
- "切到和 Codex Main 的直连，我要补充要求"

Bad:

- forcing the user to select device, runtime, thread, and workdir before saying the task

### 4. Manager Is a Translation Layer

The AI manager exists to translate between:

- human goals
- agent execution
- system state

The manager should:

- inspect available employees
- summarize what they are doing
- route tasks
- ask for clarification only when necessary
- open a direct line to a specific employee when requested

### 5. Direct Control Is a Secondary Mode

Direct employee chat is still important, but it is not the default.

The default flow is:

`Human -> AI Manager -> Agent System`

The secondary flow is:

`Human -> Direct Employee Chat`

Direct mode should feel like a drill-down, not the main home screen.

## Core Domain Objects

The product should optimize these objects first:

### Task

The unit of requested work.

A task should have:

- goal
- owner
- current status
- current workspace
- current employee
- dependencies
- approvals
- output

### Workspace

The place where work happens.

A workspace may be:

- a repo
- a directory
- a document collection
- a deployment target
- a log surface

### Employee

A user-facing digital worker identity.

An employee should have:

- name
- device
- runtime
- capabilities
- current task
- current state

### Run

The execution instance of a task step.

Runs are for machines.
Tasks are for managers.

### Manager Summary

The human-readable compression layer over all of the above.

## Agent-Native UX Requirements

An agent-native platform should make these flows first-class:

1. `claim task`
2. `inspect workspace`
3. `report progress`
4. `request approval`
5. `escalate blocker`
6. `handoff to another employee`
7. `resume after interruption`

If these flows are weak, the product is weak, even if the human UI looks polished.

## Human Console Requirements

The human console should focus on only four jobs:

1. `issue goals`
2. `observe execution`
3. `approve or redirect`
4. `drill into one employee`

This is why the human home screen should remain simple.

The default screen should be a manager conversation, not a systems dashboard.

## Implications For Implementation

This product direction implies a few concrete engineering priorities:

### 1. Strong Contracts

The websocket and runtime protocol must be clear enough for agents to rely on.

### 2. Task-Centric State

Conversation state alone is not enough.

We need durable task state that agents can inspect and update.

### 3. Workspace Addressability

Every meaningful work target should become addressable in a stable way.

### 4. Multi-Agent Coordination

The platform should eventually support:

- assignment
- delegation
- handoff
- review
- escalation

### 5. Thin Human Pages

The UI should become simpler over time, not denser.

Complexity belongs in orchestration, not in navigation.

## Decision Rule

When choosing between two roadmap options, prefer the one that:

- makes agents easier to orchestrate
- makes context easier to recover
- makes task ownership clearer
- reduces required human clicking
- keeps the manager console thinner

## One-Sentence Direction

AgentHub should evolve into:

`an agent-first collaboration operating layer with a thin AI manager console for humans`
