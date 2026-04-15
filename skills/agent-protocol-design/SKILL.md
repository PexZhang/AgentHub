---
name: agent-protocol-design
description: Use when defining task, workspace, employee, run, approval, handoff, or event contracts in AgentHub. Optimized for agent coordination, resumability, and explicit machine-readable state.
---

# Agent Protocol Design

Use this skill when designing or changing websocket events, runtime payloads, state schemas, lifecycle rules, or collaboration contracts.

## Read First

- `../../AGENT_FIRST.md`
- `../../ARCHITECTURE.md`
- `../../AGENTS.md`

## First Question

Before adding a field or event, answer:

- which object is this about?
- who owns it?
- who is allowed to update it?
- what lifecycle state does it move?
- how does another agent recover this state later?

## Core Objects

Default to these protocol objects:

- task
- workspace
- employee
- run
- approval
- handoff

Do not overload conversation messages to represent all of them.

## Contract Checklist

Every new contract should define:

1. producer
2. consumer
3. required fields
4. state transitions
5. error / timeout behavior
6. resume behavior
7. human-visible summary behavior

## Strong Defaults

Prefer contracts that are:

- explicit
- append-friendly
- resumable
- auditable
- provider-neutral

## Collaboration Requirements

Support these flows cleanly:

- assign task
- accept task
- start run
- report progress
- request approval
- escalate blocker
- hand off to another employee
- finish run

## Anti-Patterns

Avoid:

- provider-specific fields leaking into shared contracts
- untyped status strings scattered in multiple places
- silent transitions with no event
- state that only exists in UI memory
- message text being the only source of execution truth

## Validation

When possible, validate a new protocol with:

1. one happy path
2. one blocked path
3. one interruption / resume path
4. one handoff path
