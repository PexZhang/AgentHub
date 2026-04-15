# AgentHub Architecture

## Product Position

AgentHub is an agent-first collaboration control plane.

In this product model:

- `Agent` is the primary operator of the execution layer
- `Human` is the observer, commander, and approver
- `Hub` is the coordination center
- `AI Manager` is the translation layer between human intent and agent execution
- `Device` is a machine that can host one or more agent runtimes
- `Digital Employee` is an addressable agent instance with a name, capability set, and execution context
- `Conversation` is the human-facing thread
- `Run / Task` is the machine-facing unit of work

The key idea is that one machine may host multiple digital employees at the same time, for example `codex-dev`, `claude-review`, and `ops-agent`.

The second key idea is that the platform should be judged first by whether agents can execute and collaborate well inside it, not by how feature-rich the human console looks.

## Current MVP

Today the repository contains three concrete pieces:

- `server/`
  The Hub. Owns websocket connections, local persistence, and conversation snapshots.
- `agent/`
  A local runtime process. Receives routed messages, invokes a backing model or tool, and returns responses.
- `public/`
  The mobile-first web console for selecting a digital employee, switching threads, and chatting.

Inside `agent/`, the runtime execution branch has started moving into `agent/providers/`, so `Codex / OpenAI / Echo` can evolve as replaceable adapters instead of continuing to accumulate branches in one file.

This is enough to validate message delivery and Codex session binding, but it is not yet the final target architecture.

The current repository still contains some human-console-first assumptions. The long-term direction should continue moving those assumptions out of the default UI and into the orchestration layer.

## Target Architecture

The long-term architecture should move toward these bounded contexts:

### 1. Control Plane

Owns:

- identity of users, devices, and digital employees
- routing policy
- conversation state
- task state
- audit log
- approval state
- handoff state

Should expose:

- websocket events for realtime UI updates
- http endpoints for administration and automation
- versioned contracts for app and runtimes

### 2. Runtime Adapters

Each adapter wraps one execution provider:

- `codex-adapter`
- `claude-adapter`
- `openai-adapter`
- `ollama-adapter`

Each adapter should implement the same runtime contract:

- `listCapabilities()`
- `listSessions()`
- `browseDirectories(path)`
- `createSession()`
- `resumeSession(sessionId, input)`
- `startRun(task)`
- `cancelRun(runId)`

This is important because the UI and Hub should not care whether the worker behind a digital employee is Codex, Claude, or another model.

The repository has already started this direction with:

- `agent/providers/codex.js`
- `agent/providers/openai.js`
- `agent/providers/echo.js`
- `agent/providers/index.js`

### 3. Device Supervisor

Each machine should eventually run a small supervisor process that:

- registers the device with AgentHub
- starts and stops local digital employees
- reports health, sessions, and capability metadata
- multiplexes multiple local agents through one secure device connection

This is the piece that will let one computer host multiple digital employees safely.

### 4. Collaboration Layer

Human chat is not enough for multi-agent work. We also need task-level coordination:

- assign a task to one or more digital employees
- track owner, status, dependencies, and output
- collect summaries and final deliverables
- support handoff between employees on different devices
- let one employee escalate to another employee
- let employees request manager approval without losing execution context

Conversations are for communication.
Tasks are for execution.
These should be related but not collapsed into the same model.

### 5. Human Manager Console

The human-facing UI should stay intentionally thin.

Its job is not to expose system topology by default.
Its job is to let a human:

- express goals
- inspect current execution
- approve risky actions
- drill into one employee when needed

This implies that the default human flow should be:

`Human -> AI Manager -> Agent System`

And not:

`Human -> Device -> Agent -> Thread`

## AI-Friendly Repository Principles

This repository should be intentionally optimized for AI contributors.

### Protocol First

Before expanding features, define a contract for each websocket event and runtime message. AI agents work better when the interface is explicit and stable.

This matters even more in an agent-first system because the protocol is the real product surface for the primary user.

### Small, Replaceable Modules

Keep Hub, runtime adapters, UI, storage, and orchestration logic in separate modules. Avoid giant files that mix routing, persistence, and provider-specific behavior.

### Machine-Readable State

Persist conversation, task, and run state in simple, inspectable formats. AI systems reason better over explicit state than over implicit behavior hidden in control flow.

The system should eventually make it easy for an agent to answer:

- what task am I currently responsible for?
- which workspace am I operating in?
- what blocked me?
- who should I hand off to?

### Docs Live in the Repo

Important product vocabulary, invariants, ownership boundaries, and operational rules should be written in tracked docs, not only discussed in chat.

### Deterministic Local Workflows

Every major flow should have a reproducible local test or smoke script. AI contributors should be able to verify changes without guessing hidden setup.

### Adapters, Not Branches

Do not spread provider-specific logic across the whole codebase. Put it behind adapters so AI contributors can make targeted changes without accidental regressions.

## Suggested Near-Term Refactor

The next meaningful refactor should split the current codebase like this:

- `server/core/`
  Conversation state, task state, snapshots, and event routing.
- `server/contracts/`
  Shared payload definitions and schema files.
- `server/runtimes/`
  Runtime registry and provider-neutral interfaces.
- `agent/providers/`
  Concrete provider adapters for Codex, Claude, and others.
- `public/`
  UI only. No provider-specific assumptions outside presentation.

## Vocabulary Rules

Use these names consistently:

- `AgentHub`
  The product and control plane.
- `Device`
  The host machine.
- `Digital Employee`
  A user-facing worker identity.
- `Runtime`
  The actual adapter or process that talks to a model/tool.
- `Conversation`
  A user-visible thread.
- `Task / Run`
  An execution unit.
- `Session`
  Provider-specific context, such as a Codex session.
- `Workdir`
  A per-thread execution directory selected on the target device.
- `AI Manager`
  The orchestration and summary layer for humans, not the primary executor.

## Product Priority Rules

When deciding what to build next, prefer:

1. better agent execution ergonomics
2. better task and workspace clarity
3. better multi-agent coordination
4. thinner human UI
5. richer dashboards only when truly necessary

In practice, this means:

- more protocol, less page
- more task state, less navigation state
- more delegation and handoff support, less manual clicking

## Decision Direction

When a future change has multiple options, prefer the one that:

- reduces provider coupling
- keeps event contracts explicit
- makes the system easier for another AI agent to understand in one pass
- supports one device hosting multiple digital employees
- preserves clear separation between user conversation and execution state
- makes the platform easier for agents to operate inside
