---
name: koharu-pipeline-launcher
description: Deprecated wrapper skill. Use `koharu-runtime` for shared pipeline scripts and API knowledge.
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
- `start_pipeline.js`
- `listen_events.js`
- shared Koharu pipeline API behavior

## Boundary
- This deprecated skill is not a worker.
- It must not be used as a replacement for the `pipeline-runner` subagent.
- Workflow dispatch belongs to the main agent and subagent documents.
