---
name: manga-translate-zhtw
description: Pre-pipeline setup skill for Traditional Chinese manga translation on top of the Koharu HTTP API.
license: MIT
compatibility: opencode
metadata:
  audience: manga-translators
  language: zh-TW
  tools: nodejs
---

## Purpose
This skill owns pre-pipeline setup and shared translation rules:
- create a project
- open the project
- upload source pages
- load the default LLM
- resolve engines
- start the pipeline

Primary entrypoint:

```bash
node .opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js --target "zh-TW"
```

Post-pipeline orchestration belongs to the main agent and subagents.

## Use This Skill When
- You need to start a new translation run from a selected `sourceFolder`
- You need config precedence, path rules, or engine / LLM setup behavior for pre-pipeline work
- You need to understand how `one_click_translate.js` prepares a Koharu project

## This Skill Does Not Do
- It does not dispatch workers.
- It does not replace `pipeline-runner`, `quality-checker`, or `knowledge-builder`.
- It does not decide post-pipeline routing.

## Config Sources
Priority:
1. CLI arguments
2. `.opencode/koharu.json`
3. `manga-translate-zhtw/lib/config.js`

Important fields:
- `api.baseUrl`
- `defaults.targetLanguage`
- `defaults.exportFormat`
- `defaults.tolerance`
- `workflow.qualityCheck.enabled`
- `workflow.knowledgeBuilder.enabled`
- `engines.*`

Compatibility note:
- `defaults.autoDeleteProject` may still exist in config, but it does not change the official default lifecycle policy: the workflow closes the current project and does not delete stored project data.

## Shared Runtime Rules
- Pre-pipeline failures stop the workflow and return `QQ`.
- `one_click_translate.js` remains the only formal setup entrypoint.
- Low-level script output is not the same thing as a subagent contract.

## Local Runtime Modules
- `lib/config.js`
- `lib/api.js`
- `lib/workflow_policy.js`
