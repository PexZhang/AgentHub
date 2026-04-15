# AgentHub AI Contributor Guide

This repository is intended to be evolved by both humans and AI agents.

## Before You Change Anything

Read these files first:

- [README.md](/Users/zhangpeng/ai-chat-mvp/README.md)
- [ARCHITECTURE.md](/Users/zhangpeng/ai-chat-mvp/ARCHITECTURE.md)
- [AGENT_FIRST.md](/Users/zhangpeng/ai-chat-mvp/AGENT_FIRST.md)

## Working Rules

### 1. Preserve Product Vocabulary

Use the canonical terms from `ARCHITECTURE.md`:

- AgentHub
- Device
- Digital Employee
- Runtime
- Conversation
- Task / Run
- Session

Do not invent overlapping names like `bot`, `worker`, `assistant`, and `agent` interchangeably in the same feature unless there is a real domain difference.

Also preserve the product priority from `AGENT_FIRST.md`:

- Agent is the primary user of the execution layer
- AI Manager is a thin orchestration layer for humans
- Human UI should stay simpler than the underlying system

### 2. Respect Boundaries

- `server/` owns routing, persistence, and shared state
- `agent/` owns runtime execution and provider-specific behavior
- `public/` owns presentation and user interaction

If a change needs to cross these boundaries, update the contract deliberately rather than smuggling assumptions across layers.

### 3. Prefer Contracts Over Implicit Coupling

When adding a new capability:

- define the event or payload shape first
- then update the sender
- then update the receiver
- then update docs and smoke coverage

### 4. Keep Provider Logic Contained

Provider-specific code for Codex, Claude, OpenAI, or local models should stay inside adapter-like modules. Do not spread provider branches through the UI or Hub without a very strong reason.

### 5. Make AI Verification Cheap

Whenever practical:

- add or update a smoke test
- keep fixtures small
- keep state files easy to inspect
- keep errors explicit and user-readable

If you touch employee bootstrap, onboarding, or runtime registration, prefer verifying with:

- `npm run smoke:onboard`
- `npm run smoke`

If you touch manager routing, task delegation, or approval handling, prefer verifying with:

- `npm run smoke:manager:stack`

## Good Change Pattern

For most non-trivial features, use this order:

1. Update architecture or contract docs if the concept is new
2. Update shared state or message contracts
3. Update runtime behavior
4. Update UI
5. Verify with a local smoke or integration check

## Avoid

- giant multi-purpose files growing without clear ownership
- mixing conversation state and task orchestration state without naming the boundary
- hard-coding one provider's session model as the system-wide abstraction
- hiding important product decisions only in chat history

## Definition of Done

A change is in good shape when:

- another AI agent can understand the feature boundary quickly
- the contracts are visible in code and docs
- the user-facing naming matches the product vocabulary
- the behavior can be reproduced locally without tribal knowledge
- the change improves or at least preserves agent execution ergonomics
