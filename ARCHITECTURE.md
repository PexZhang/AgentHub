# AgentHub Architecture

## Product Position

AgentHub is the control plane for digital employees.

In this product model:

- `User` talks to AgentHub from phone or desktop
- `Hub` is the coordination center
- `Device` is a machine that can host one or more agent runtimes
- `Digital Employee` is an addressable agent instance with a name, capability set, and execution context
- `Conversation` is the human-facing thread
- `Run / Task` is the machine-facing unit of work

The key idea is that one machine may host multiple digital employees at the same time, for example `codex-dev`, `claude-review`, and `ops-agent`.

## Current MVP

Today the repository contains three concrete pieces:

- `server/`
  The Hub. Owns websocket connections, local persistence, and conversation snapshots.
- `agent/`
  A local runtime process. Receives routed messages, invokes a backing model or tool, and returns responses.
- `public/`
  The mobile-first web console for selecting a digital employee, switching threads, and chatting.

This is enough to validate message delivery and Codex session binding, but it is not yet the final target architecture.

## Target Architecture

The long-term architecture should move toward these bounded contexts:

### 1. Control Plane

Owns:

- identity of users, devices, and digital employees
- routing policy
- conversation state
- task state
- audit log

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

Conversations are for communication.
Tasks are for execution.
These should be related but not collapsed into the same model.

## AI-Friendly Repository Principles

This repository should be intentionally optimized for AI contributors.

### Protocol First

Before expanding features, define a contract for each websocket event and runtime message. AI agents work better when the interface is explicit and stable.

### Small, Replaceable Modules

Keep Hub, runtime adapters, UI, storage, and orchestration logic in separate modules. Avoid giant files that mix routing, persistence, and provider-specific behavior.

### Machine-Readable State

Persist conversation, task, and run state in simple, inspectable formats. AI systems reason better over explicit state than over implicit behavior hidden in control flow.

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

## Decision Direction

When a future change has multiple options, prefer the one that:

- reduces provider coupling
- keeps event contracts explicit
- makes the system easier for another AI agent to understand in one pass
- supports one device hosting multiple digital employees
- preserves clear separation between user conversation and execution state
