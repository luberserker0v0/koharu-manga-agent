# MangaTranslationAgent Architecture

## Overview
The official runtime is now a **process-trigger backend**.

The repository is split into two layers:
- `backend/`: the only formal runtime
- `.opencode/`: migration-era scripts and references that are being absorbed into backend modules

Primary runtime entrypoint:

```bash
node backend/server.js
```

## Runtime Layers

### API Server
The local HTTP API is the single control surface for future CLI and GUI clients.

Current endpoints:
- `POST /jobs/translation`
- `POST /jobs/reference-extraction`
- `POST /jobs/reference-ingestion`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/stream`
- `POST /jobs/:jobId/retry`
- `POST /jobs/:jobId/cancel`
- `GET /config`
- `GET /knowledge/:mangaId/glossary`
- `GET /knowledge/:mangaId/style-profile`
- `GET /knowledge/:mangaId/story-context`

### Job Manager
The job manager owns:
- job creation
- queueing and in-process execution
- cancellation and retry
- event fan-out for SSE clients
- persistence to SQLite

Persistence tables:
- `jobs`
- `job_events`
- `job_artifacts`
- `job_errors`

### Workflow Engine
The workflow engine owns all translation control flow.

Formal stage order:
1. setup project
2. upload pages
3. load LLM
4. resolve engines
5. start pipeline
6. monitor pipeline
7. optional quality review
8. optional knowledge-base update
9. export
10. close current project

### Agent SDK Adapter
The Agent SDK is no longer the orchestration layer.

It is reserved for:
- high-level quality review
- knowledge-base enrichment
- future semantic reasoning tasks

It must not own:
- worker routing
- retries
- timeout policy
- placeholder expansion
- export and close sequencing

The next integration target is `opencode` through an SDK adapter, not through prompt-only task orchestration.
See:
- `docs/AGENT_INTEGRATION.md`

Current implementation status:
- `opencode` already supports managed SDK runtime startup
- `quality_review` and `knowledge_enrichment` both support SDK-backed execution
- provider results are schema-validated before they are imported into workflow modules
- each agent stage records import/export manifests for backend-side auditing

### Koharu Client
`backend/src/koharu_client.js` is the formal low-level Koharu wrapper.

It owns:
- Koharu HTTP request helpers
- pipeline start
- operation polling
- scene access
- export
- current-project close

## Module Ownership

### Core Workflow Modules
- `backend/src/modules/project_setup.js`
  - wraps legacy `one_click_translate.js` orchestration for migration
- `backend/src/modules/pipeline_monitor.js`
  - replaces `pipeline-runner`
  - owns late-attach recovery and fast-finish handling
- `backend/src/modules/quality.js`
  - replaces `quality-checker`
  - owns read-only validation of the current translation against project knowledge assets
  - uses Agent SDK only for semantic review
- `backend/src/modules/knowledge.js`
  - replaces `knowledge-builder`
  - uses Agent SDK only for semantic enrichment
- `backend/src/modules/export.js`
  - owns export behavior
- `backend/src/modules/project_lifecycle.js`
  - owns close behavior

Current implementation note:
- the target architecture treats `quality` as read-only validation
- the current runtime now uses knowledge-driven validation and no longer performs quality-triggered rerender
- some legacy comparison helpers and historical artifacts still remain in the repository, but they are not part of the primary quality path

### Non-Workflow Modules
- `backend/src/modules/admin.js`
  - list projects
  - log maintenance

### Agent Integration Modules
- `backend/src/ao_client.js`
- `backend/src/ao_assets.js`
- `backend/src/ao_tasks.js`
- `backend/src/ao_contracts.js`

These now form the AO-only integration layer. The backend no longer keeps a
generic provider registry, SDK-loaded runtime adapter, or `agent_sdk`
compatibility abstraction.

Deferred utilities:
- `delete_page.js`
- `self_reflection.js`

These are not part of the first-class backend workflow.

## Runtime Policy
- `.opencode/koharu.json` remains the main config source
- request payloads may override config values
- default workflow never deletes stored Koharu projects
- `close project` always means `DELETE /projects/current`
- backend returns structured job status and error data
- `QQ` belongs to the outer agent response layer, not the backend transport layer
- agent providers must run inside isolated per-job stage workspaces

## Reference Comparison Layout
The quality workflow can consume a reference set through `referenceSetId`.

Reference assets live under:
- `references/other_images/<reference_set_id>/`
- `references/extracted/<reference_set_id>/`
- `references/comparisons/<reference_set_id>/` (legacy diagnostics only)
- `references/manifests/<reference_set_id>.json`

`references/comparisons/` is compatibility-only storage for transitional diagnostics.
It is not part of the primary quality-validation contract.

Process expectations:
1. user provides other-translation images under `other_images/`
2. Koharu extraction produces normalized `texts.json` under `extracted/`
3. the backend promotes extracted reference text into normalized project assets
4. any retained comparison outputs are transitional diagnostics only

## Knowledge Base Layout
Knowledge artifacts live under:
- `knowledge_base/self/my-manga.json`
- `knowledge_base/reports/extract_report.json`

Planned v2 design:
- `knowledge_base/self/my-manga.schema.example.json`
- `knowledge_base/reports/migration_plan_v2.md`

V2 separates:
- fact-layer `translation_pairs`
- inferred `terminology`
- inferred `characters`
- inferred `style_profile`
- inferred `style_examples`

Reference-promoted translation assets now also include:
- `knowledge_base/self/<mangaId>/canonical_glossary.json`
- `knowledge_base/self/<mangaId>/story_context.json`
- `knowledge_base/self/<mangaId>/style_profile.json`
- `knowledge_base/self/<mangaId>/translation_context.json`

## Agent Workspace Isolation
External agent communication must not operate directly in repo root.

Design target:
- `cache/workspaces/<jobId>/<stage>/input/`
- `cache/workspaces/<jobId>/<stage>/output/`
- `cache/workspaces/<jobId>/<stage>/artifacts/`

The backend remains the only writer for canonical storage:
- `knowledge_base/`
- `references/`
- job-selected `outputDir`

Current agent audit artifacts:
- `cache/workspaces/<jobId>/<stage>/artifacts/import_manifest.json`
- `cache/workspaces/<jobId>/<stage>/artifacts/export_manifest.json`

These manifests record:
- what the backend materialized into the isolated workspace
- what outputs were accepted
- what outputs were rejected and why

## GUI Contract
The GUI is now an explicit product target for the backend.

High-level GUI requirements are defined in:
- `docs/GUI_SPEC.md`

Important GUI-facing runtime rules:
- refreshing or closing the GUI must not interrupt backend jobs
- the GUI must restore state from backend snapshot plus live stream
- interaction history must remain reconstructible from SQLite and disk artifacts

## Repository Shape
```text
comics/1/
|- backend/
|  |- server.js
|  `- src/
|     |- ao_client.js
|     |- ao_assets.js
|     |- ao_tasks.js
|     |- ao_contracts.js
|     |- http/
|     |- modules/
|     |- storage/
|     |- config.js
|     |- job_manager.js
|     |- koharu_client.js
|     |- runtime.js
|     `- workflow_engine.js
|- docs/
|- tests/
|- references/
|- knowledge_base/
|- logs/
|- cache/
|- post_edit/
`- .opencode/
   |- koharu.json
   `- legacy migration assets
```
