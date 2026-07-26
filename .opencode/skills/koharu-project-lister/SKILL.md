---
name: koharu-project-lister
description: Deprecated wrapper skill. Use `koharu-runtime` for shared project listing and project-state knowledge.
license: MIT
compatibility: opencode
metadata:
  audience: manga-translators
  language: zh-TW
  tools: nodejs
---

## Status
This skill is deprecated.

Use `koharu-runtime` instead for:
- `list-projects.js`
- project list discovery
- shared project-state API behavior

## Boundary
- This deprecated skill is not a worker.
- It must not be used as a replacement for any subagent.
- Workflow dispatch belongs to the main agent and subagent documents.
