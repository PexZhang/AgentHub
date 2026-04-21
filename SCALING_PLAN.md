# Scaling Plan

## Goal

This document defines the minimum engineering path for AgentHub to support:

- `10-20` human users
- each user owning up to `8` digital employees
- roughly `80-160` connected employees across devices

The target is not internet-scale SaaS.
The target is a stable internal production system that can support a small team using AgentHub every day.

## Capacity Assumption

Use these assumptions as the planning baseline:

- `80-160` online employees
- `10-20` active human sessions
- `10+` employee heartbeat updates per second at peak
- multiple concurrent manager questions
- multiple concurrent task progress updates
- task, approval, and employee state must remain durable across restarts

If the system can meet this target cleanly, it is good enough for the next stage.

## Current Bottlenecks

The current MVP can validate the product, but it should not be treated as the final scaling shape.

### 1. Single JSON persistence

Current state is stored in one JSON file and rewritten repeatedly.

This is acceptable for local validation, but weak for:

- concurrent task updates
- frequent heartbeat writes
- approval mutations
- restart recovery under load

### 2. In-memory connection registry

Online employee connections and app connections currently live in process memory.

This means:

- one Hub instance is the real ceiling
- websocket fanout cannot scale horizontally yet
- online state disappears with process restarts

### 3. Full snapshot fanout

The UI currently receives a rebuilt snapshot frequently.

This is simple for MVP, but inefficient once:

- more humans are connected
- more employees emit heartbeat and progress events
- more tasks exist in memory

### 4. Manager queue is effectively global

Manager requests should not become one global bottleneck across all users.

The system must allow:

- ordering within one manager conversation
- concurrency across different users or manager threads

### 5. Global token model

`APP_TOKEN` and `AGENT_TOKEN` are not enough for a multi-user internal platform.

The system needs real separation between:

- user identity
- device identity
- employee identity
- workspace ownership

## Non-Goals

Do not treat these as the next milestone:

- rewrite everything in React or Next.js
- split into microservices first
- build a heavy dashboard-first UI
- introduce a large infra stack before state and protocol are stable

The correct near-term path is:

`keep the Node control plane simple, but harden state, identity, and event flow`

## Target Shape

For the next serious version, AgentHub should become:

- `Nginx`
- `Node.js control plane`
- `PostgreSQL` for durable state
- `Redis` for online presence, fanout, and short-lived coordination
- `1 manager worker lane` or manager execution module that can scale independently later

This is still a compact architecture.
It is not overdesigned.

## Phase 0: Must

These items are required before treating AgentHub as a stable internal multi-user platform.

### 0.1 Replace JsonStore with PostgreSQL

Why:

- durable conversations, employees, workspaces, tasks, approvals
- safe concurrent writes
- easier recovery, audit, and querying

Repository impact:

- add `server/db/`
- add `server/repositories/`
- move persistence logic out of `server/index.js`

Suggested structure:

- `server/db/client.js`
- `server/db/migrations/`
- `server/repositories/conversations.js`
- `server/repositories/employees.js`
- `server/repositories/workspaces.js`
- `server/repositories/tasks.js`
- `server/repositories/approvals.js`
- `server/repositories/manager_messages.js`

Definition of done:

- JSON file no longer holds primary state
- Hub restart does not lose task or approval state
- snapshot rebuilds read from repositories, not in-memory truth

### 0.2 Introduce Redis for presence and realtime fanout

Why:

- online employee presence should not depend only on one process
- websocket fanout and short-lived state should not be mixed with durable storage

Repository impact:

- add `server/realtime/`
- add `server/presence/`

Suggested structure:

- `server/realtime/pubsub.js`
- `server/realtime/events.js`
- `server/presence/employee-presence.js`
- `server/presence/app-presence.js`

Definition of done:

- employee online/offline state lives in Redis-backed presence
- app clients can receive state updates without relying on one in-process map

### 0.3 Replace full snapshot broadcast with incremental events

Why:

- full snapshot push is simple but wasteful
- scale requires smaller event payloads

Repository impact:

- add `server/contracts/`
- add `server/read-models/`

Suggested structure:

- `server/contracts/events/`
- `server/contracts/schemas/`
- `server/read-models/snapshot.js`
- `server/read-models/manager-summary.js`

Required event families:

- `employee.updated`
- `workspace.updated`
- `task.updated`
- `approval.updated`
- `conversation.updated`
- `message.added`

Definition of done:

- app does one initial load
- later UI updates consume event deltas
- snapshot becomes a read model, not the default broadcast payload

### 0.4 Add real multi-user identity and authorization

Why:

- users must not see or command the wrong employees
- employees and devices need controlled registration

Repository impact:

- add `server/auth/`
- add `server/policies/`

Suggested structure:

- `server/auth/users.js`
- `server/auth/devices.js`
- `server/auth/employees.js`
- `server/policies/access.js`

Required objects:

- `user`
- `device`
- `employee`
- `workspace_membership`

Definition of done:

- every app request resolves to a user
- every employee resolves to a device and owner
- task and workspace reads are scoped by access policy

### 0.5 Remove global manager bottleneck

Why:

- one manager conversation should not block all users

Repository impact:

- add `server/manager/runtime.js`
- add `server/manager/queues.js`

Execution rule:

- serialize within one manager thread
- allow concurrency across separate manager threads or users

Definition of done:

- two users can ask the manager questions at the same time
- one slow manager response does not stall the whole platform

### 0.6 Add observability and operational health

Why:

- once multiple people rely on the platform, ssh-only debugging is too expensive

Repository impact:

- add `server/observability/`
- add `scripts/ops/`

Suggested structure:

- `server/observability/logger.js`
- `server/observability/metrics.js`
- `scripts/ops/check-health.js`

Minimum metrics:

- connected app count
- connected employee count
- heartbeat freshness
- manager request latency
- task counts by status
- approval counts by status

Definition of done:

- on-call debugging no longer starts by manually grepping random logs

## Phase 1: Should

These items are not strictly required for first internal rollout, but they are the right next step after Phase 0.

### 1.1 Make task the execution source of truth

Current rule:

- conversation and task are still too tightly coupled

Target rule:

- task is the durable execution object
- conversation is the communication surface

Repository impact:

- add `server/tasks/`
- add `server/runs/`

Suggested structure:

- `server/tasks/service.js`
- `server/tasks/transitions.js`
- `server/runs/service.js`
- `server/runs/events.js`

Definition of done:

- the system can answer task ownership, workspace binding, blocker, output, and approval without reading chat text as the primary truth

### 1.2 Add run and event history

Why:

- agents need resumable execution
- managers need auditability

Repository impact:

- add tables and services for:
  - `runs`
  - `task_events`
  - `handoffs`
  - `approval_events`

Definition of done:

- interruption and resume work from machine-readable history
- handoff is explicit and durable

### 1.3 Introduce a device supervisor

Why:

- one machine may host multiple digital employees
- startup, restart, crash recovery, and health reporting should not rely on hand-started terminals

Repository impact:

- add `supervisor/` or `agent/supervisor/`

Suggested structure:

- `agent/supervisor/index.js`
- `agent/supervisor/device-registry.js`
- `agent/supervisor/process-manager.js`

Definition of done:

- one device process can manage multiple employee runtimes cleanly

### 1.4 Formalize manager tools and knowledge boundaries

Why:

- manager quality should not depend on one giant prompt

Repository impact:

- continue expanding `server/manager/`
- continue using `knowledge/manager/`

Rule:

- live operational state -> tools
- stable platform guidance -> knowledge files
- routing or execution behavior -> contracts + task services

Definition of done:

- manager answers about onboarding, status, approvals, and routing are tool-backed or knowledge-backed, not vague summaries

## Phase 2: Can Wait

These items are useful, but should not block the first multi-user internal rollout.

### 2.1 Frontend framework rewrite

The current multi-page web UI can continue for now.

If rewritten later, it should be because:

- state complexity demands it
- shared components become painful
- event rendering becomes too hard in plain JS

Not because framework adoption feels cleaner.

### 2.2 Service decomposition

Do not split into many services before:

- state is in PostgreSQL
- presence is in Redis
- contracts are stable
- manager execution is isolated enough to separate safely

### 2.3 Rich dashboard surfaces

Do not expand the human console into a dashboard-first product.

Keep:

- manager conversation first
- detail pages second
- system topology hidden unless requested

## Suggested Repository Refactor Map

Use this as the target module map for the next stage:

- `server/index.js`
  keep only bootstrap and route wiring
- `server/auth/`
  identity and access resolution
- `server/contracts/`
  websocket and API payload definitions
- `server/db/`
  database client and migrations
- `server/repositories/`
  durable state access
- `server/realtime/`
  websocket fanout and pubsub
- `server/presence/`
  employee and app online state
- `server/tasks/`
  task lifecycle and assignment
- `server/runs/`
  run lifecycle, progress, and handoff
- `server/manager/`
  manager orchestration, knowledge, tools
- `agent/providers/`
  provider adapters only
- `agent/supervisor/`
  future multi-employee device runtime
- `public/`
  thin manager/task/direct UI
- `scripts/`
  smoke, migration, and ops scripts

## Recommended Build Order

This is the minimum-risk order:

1. PostgreSQL repositories
2. Redis presence + fanout
3. incremental UI events
4. user/device/employee auth
5. manager per-thread concurrency
6. task/run event history
7. device supervisor

## What Success Looks Like

AgentHub is ready for the next stage when:

- one user cannot see another user's employees by accident
- one Hub restart does not lose task truth
- one slow manager response does not block everyone
- online presence survives process churn
- app updates no longer require full snapshot rebroadcast
- a task can be resumed from durable run history

At that point, the platform can credibly support the target team size without abandoning the current product direction.
