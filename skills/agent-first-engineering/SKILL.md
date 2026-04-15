---
name: agent-first-engineering
description: Use when implementing or refactoring AgentHub features so agent execution ergonomics stay primary, task/workspace/employee boundaries stay clear, and the human console remains thin.
---

# Agent-First Engineering

Use this skill when changing backend, runtime, state, contracts, orchestration, or UI in AgentHub.

## Read First

Open these files before making a non-trivial change:

- `../../AGENT_FIRST.md`
- `../../ARCHITECTURE.md`
- `../../README.md`
- `../../AGENTS.md`

If the change touches the human manager console, also read:

- `../../MANAGER_MODE.md`

## Product Priority

Assume these are true unless the user explicitly says otherwise:

- Agent is the primary user of the execution layer
- AI Manager is a thin human-facing orchestration layer
- Human UI is not the center of product complexity
- Task/workspace/employee/run contracts matter more than rich dashboards

## Default Change Order

For most features, work in this order:

1. define or update the domain object
2. define or update the event / payload contract
3. update server or runtime behavior
4. update UI only as needed
5. update docs if the boundary changed
6. run the lightest useful verification

## What Good Changes Optimize For

Prefer changes that improve:

- task ownership clarity
- workspace addressability
- agent handoff or escalation
- approval visibility
- interruption and resume support
- explicit machine-readable state

## What To Avoid

Avoid changes that:

- add human navigation before defining agent contract
- expose device / agent / thread topology as the default user path
- mix conversation state and task state without naming the boundary
- hard-code one provider's session model as the whole system model
- spread provider-specific branches through unrelated modules

## UI Rule

If a UI change is proposed, ask:

- does this help the human issue goals, observe execution, approve, or drill down?

If not, it is probably not worth adding.

## Output Shape

When you finish a design or implementation task, summarize it in this order:

1. what changed in the execution model
2. what changed in the human console
3. what contract or state shape changed
4. how it was verified
