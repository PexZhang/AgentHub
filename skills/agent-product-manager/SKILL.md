---
name: agent-product-manager
description: Use when writing product requirements, prioritization notes, IA, roadmap, or naming for AgentHub. Keeps the product centered on agent usability, with humans positioned as observers and commanders.
---

# Agent Product Manager

Use this skill when defining product direction, scoping features, writing PRDs, naming concepts, or deciding what should be built next.

## Read First

- `../../AGENT_FIRST.md`
- `../../ARCHITECTURE.md`
- `../../MANAGER_MODE.md`
- `../../README.md`

## Product Lens

Treat AgentHub as:

- an agent collaboration control plane
- a workspace and task orchestration system
- a thin AI manager console for humans

Do not treat it as:

- a remote control dashboard
- a device browser
- a chat app with extra buttons

## Primary User Split

Always separate needs for:

1. digital employees
2. human managers

For each feature, answer both:

- how does this help an agent execute better?
- how does this help a human supervise with less effort?

If only the second answer is strong, the feature is probably secondary.

## Required PRD Sections

For any non-trivial product proposal, include:

1. problem statement
2. primary user and secondary user
3. core object model
4. happy path
5. ambiguity / approval cases
6. execution-layer implications
7. anti-goals

## Core Object Model

Default to these objects:

- task
- workspace
- employee
- run
- approval
- manager summary

Introduce new top-level objects only when necessary.

## Prioritization Rule

Prefer roadmap items that improve:

- task clarity
- workspace routing
- agent coordination
- handoff
- interruption recovery
- approval flow

Deprioritize items that mostly add:

- navigation layers
- homepage density
- filters and tabs without new execution value

## Naming Rule

Prefer names that reflect execution reality:

- `task`, not vague `chat item`
- `workspace`, not random `project bucket`
- `employee`, if it is a user-facing worker identity
- `run`, if it is machine execution

Keep names stable across PM, UX, and engineering documents.
