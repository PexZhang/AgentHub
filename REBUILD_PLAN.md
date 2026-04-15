# Rebuild Plan

## Goal

This document translates the `Agent First` principles into a concrete rebuild path for:

1. human-facing UI
2. code structure
3. agent onboarding

It is intended to guide the next major iteration of AgentHub.

## Part 1: Interface Redesign

### Design Rule

The human console should become simpler while the execution layer becomes richer.

The default UI should no longer behave like:

- a device browser
- an agent directory
- a thread picker

It should behave like:

- a manager conversation
- a task monitor
- a drill-down surface

### New IA

Use these three surfaces:

1. `Manager`
   The default homepage.
2. `Tasks`
   Execution-first view of work in flight.
3. `Direct`
   Temporary employee-level drill-down.

The `Employees` or `Resources` view should exist, but it should not be a default first-class home surface.

### Manager Page

The manager page should contain only:

- one strong prompt area
- one compact manager summary
- one conversation/report stream
- one jump-card mechanism for drill-down

It should not contain:

- persistent device chooser
- persistent employee chooser
- persistent session chooser
- dense system dashboards on first load

### Tasks Page

The tasks page should become the main operational detail view.

It should show:

- title
- owner
- workspace
- status
- last progress
- approval state
- handoff state

It should support:

- filter by status
- open manager summary
- open direct employee detail

### Direct Page

The direct page should be explicitly secondary.

It should always show:

- employee identity
- current task
- current workspace
- last run summary
- return to manager

### Mobile Rule

On mobile:

- manager page is one-screen-first
- task cards are vertically stacked
- system structure stays hidden unless asked
- direct mode uses a dedicated page, not a crowded split layout

## Part 2: Code Refactor

### Current Problem

The current implementation still mixes too many concerns inside a few files:

- server state
- websocket routing
- manager logic
- provider logic
- conversation logic
- UI state logic

This makes the system harder for both humans and agents to extend.

### Target Server Structure

Move toward:

- `server/core/store.js`
- `server/core/snapshots.js`
- `server/core/router.js`
- `server/contracts/`
- `server/manager/`
- `server/tasks/`
- `server/runtimes/`

Suggested responsibilities:

- `core/store`
  persistence and state mutation
- `core/snapshots`
  read models for manager and UI
- `core/router`
  websocket and event routing
- `contracts`
  payload definitions and schema helpers
- `manager`
  manager prompts, tool binding, summary logic
- `tasks`
  task lifecycle, assignment, approval, handoff
- `runtimes`
  provider-neutral runtime registry and dispatch

### Target Agent Structure

Move toward:

- `agent/index.js`
  connection bootstrap only
- `agent/providers/codex.js`
- `agent/providers/openai.js`
- `agent/providers/echo.js`
- `agent/runtime.js`
- `agent/workspaces.js`

This keeps provider-specific behavior out of the generic runtime loop.

### Target Frontend Structure

Move toward:

- `public/manager.html`
- `public/tasks.html`
- `public/direct.html`
- `public/js/manager.js`
- `public/js/tasks.js`
- `public/js/direct.js`
- `public/js/client.js`
- `public/js/state.js`

The current homepage can still stay at `/`, but it should become a thin redirect or manager shell.

### Suggested Refactor Order

1. extract task objects into persistence
2. extract runtime registry
3. extract manager tool layer
4. separate manager/task/direct frontend code
5. introduce approval and handoff views

## Part 3: Agent Onboarding Definition

### Product Rule

An agent should join AgentHub by implementing a runtime contract, not by custom patching the UI.

### Minimum Onboarding Data

Every new agent integration should define:

- runtime name
- supported capabilities
- workspace access pattern
- session support
- approval behavior
- progress reporting behavior

### Onboarding Steps

For a new provider:

1. implement provider adapter
2. implement capability declaration
3. implement task acceptance
4. implement run progress events
5. implement approval/blocker events
6. implement direct chat bridge
7. add smoke coverage

### Example Agent Types

Examples of clean runtime categories:

- `coding-agent`
- `review-agent`
- `deploy-agent`
- `docs-agent`
- `log-agent`

Do not assume every employee is a generic chat bot.

## Recommended Next Milestone

The next milestone should not be "make the homepage prettier".

It should be:

`introduce durable task state and runtime contract v1`

That milestone unlocks:

- better manager summaries
- multi-agent orchestration
- approval flows
- cleaner UI simplification

## Concrete Next Build Steps

1. add `tasks` to persistent state
2. define runtime event contract v1
3. route manager requests into task creation
4. let employees execute tasks instead of raw conversation-only work
5. rebuild the UI around manager + tasks + direct drill-down
