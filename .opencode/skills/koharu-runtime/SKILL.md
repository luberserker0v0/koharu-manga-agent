---
name: koharu-runtime
description: Shared Koharu runtime skill for low-level API and script operations.
license: MIT
compatibility: opencode
metadata:
  audience: manga-translators
  language: zh-TW
  tools: nodejs
---

## Purpose
This skill is the shared Koharu tool layer.
Use it for low-level operational knowledge, not for workflow dispatch.

It covers:
- project listing and project state operations
- pipeline start and event listening scripts
- scene access, export, and history-related scripts
- shared Koharu API conventions used by the main agent and subagents

## Use This Skill When
- You need to know which script talks to which Koharu API endpoint
- You need to run or understand `start_pipeline.js`, `listen_events.js`, `list-projects.js`, `export_project.js`, or scene-based helper scripts
- You need shared Koharu request and path conventions

## This Skill Does Not Do
- It is not a worker identity.
- It must not be used as a replacement for `pipeline-runner`, `quality-checker`, or `knowledge-builder`.
- It must not describe when the main agent should dispatch subagents.

## Common Scripts
- `koharu-pipeline-launcher/scripts/start_pipeline.js`
- `koharu-pipeline-launcher/scripts/listen_events.js`
- `koharu-project-lister/scripts/list-projects.js`
- `manga-translate-zhtw/scripts/export_project.js`
- `manga-translate-zhtw/scripts/quality_check.js`

## Runtime Rules
- Low-level script output may be raw JSON or progress text.
- Subagent contracts are defined at the agent layer, not the skill layer.
- Workflow routing belongs to `AGENTS.md` and `.opencode/agents/*.md`.
