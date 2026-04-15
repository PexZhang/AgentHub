---
name: manager-console-interaction
description: Use when designing AgentHub's human-facing interaction and UI. Keeps the manager console minimal, intent-first, and detail-on-demand, with drill-down links instead of homepage clutter.
---

# Manager Console Interaction

Use this skill for IA, flows, mobile design, interaction patterns, wireframes, page composition, and UI simplification in AgentHub.

## Read First

- `../../AGENT_FIRST.md`
- `../../MANAGER_MODE.md`
- `../../README.md`

## Interaction Premise

The human home screen should be a manager conversation, not a control dashboard.

Humans should primarily:

- issue goals
- inspect status
- approve or redirect
- drill into one employee when needed

## Default Interaction Pattern

Use this order:

1. manager conversation
2. manager summary
3. drill-down card or link
4. dedicated detail page only when needed

## Preferred UI Moves

Prefer:

- one strong input area
- manager answers in human language
- detail cards with clear jump actions
- direct employee chat as a secondary mode
- separate detail pages instead of homepage clutter

## Avoid

Avoid these by default:

- forcing device / agent / thread selection up front
- showing all structure all the time
- multiple equal-weight panels on mobile
- dashboard-first homepages
- requiring manual routing before intent is known

## Mobile Rules

On mobile:

- one screen should do one main job
- manager input should stay obvious
- detail belongs behind a tap
- long status should collapse into cards or summaries
- direct mode should have a clear return path back to manager mode

## When To Expose System Structure

Only expose device, workspace, or employee structure when:

1. the user asks
2. the manager needs confirmation
3. the user drills into a detail page

Otherwise, keep the structure implicit.

## Deliverable Checklist

A good interaction spec should include:

1. manager-mode happy path
2. direct-chat drill-down path
3. approval path
4. ambiguity resolution path
5. mobile behavior
6. what stays hidden by default
